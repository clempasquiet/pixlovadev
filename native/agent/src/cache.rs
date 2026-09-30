//! Cache adressé par SHA-256 (NAT-008 étapes 3 à 5, NAT-009, NAT-010).
//!
//! Un fichier n’entre dans `blobs/` qu’après vérification complète de sa taille et de son
//! empreinte, par renommage atomique : le renderer ne peut jamais lire un contenu partiel
//! ou corrompu. Les téléchargements partiels restent dans `tmp/` et ne sont repris que
//! pour la même empreinte et la même taille attendues.

use crate::cloud::{Cloud, CloudError};
use crate::identity::sync_dir;
use crate::store::{AssetRow, Store, StoreError};
use futures_util::StreamExt;
use reqwest::StatusCode;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Debug, thiserror::Error)]
pub enum CacheError {
    #[error("espace disque insuffisant : {needed} octets requis, {available} disponibles")]
    DiskFull { needed: u64, available: u64 },
    #[error("empreinte ou taille incorrecte pour {0}")]
    ChecksumMismatch(String),
    #[error("asset {0} : description différente de celle du manifest")]
    AssetMismatch(String),
    #[error("téléchargement de {asset} impossible : {detail}")]
    Download { asset: String, detail: String },
    #[error(transparent)]
    Cloud(#[from] CloudError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl CacheError {
    /// Code déclaré au cloud pour une livraison en échec.
    pub fn code(&self) -> &str {
        match self {
            Self::DiskFull { .. } => "DISK_FULL",
            Self::ChecksumMismatch(_) => "CHECKSUM_MISMATCH",
            Self::AssetMismatch(_) => "ASSET_MISMATCH",
            Self::Download { .. } => "ASSET_DOWNLOAD_FAILED",
            Self::Cloud(error) => error.code(),
            Self::Store(_) | Self::Io(_) => "LOCAL_STORAGE_ERROR",
        }
    }

    /// Réessayable plus tard sans intervention (réseau, URL expirée, espace libéré).
    pub fn is_transient(&self) -> bool {
        match self {
            Self::Cloud(error) => error.is_transient(),
            Self::Download { .. } | Self::DiskFull { .. } | Self::ChecksumMismatch(_) => true,
            _ => false,
        }
    }
}

/// Espace disque disponible, injectable pour les tests de disque plein.
pub type SpaceProbe = Arc<dyn Fn(&Path) -> Option<u64> + Send + Sync>;

#[derive(Clone)]
pub struct Cache {
    root: PathBuf,
    store: Store,
    budget_bytes: u64,
    reserve_bytes: u64,
    probe: SpaceProbe,
    /// Blobs dont l’empreinte a été recontrôlée depuis le démarrage.
    verified: Arc<Mutex<HashSet<String>>>,
}

pub fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn now_text() -> String {
    crate::clock::format_instant(crate::clock::Clock::now_millis(&crate::clock::SystemClock))
}

impl Cache {
    pub fn open(
        root: &Path,
        store: Store,
        budget_bytes: u64,
        reserve_bytes: u64,
    ) -> std::io::Result<Self> {
        Self::with_probe(
            root,
            store,
            budget_bytes,
            reserve_bytes,
            Arc::new(|path: &Path| fs4::available_space(path).ok()),
        )
    }

    pub fn with_probe(
        root: &Path,
        store: Store,
        budget_bytes: u64,
        reserve_bytes: u64,
        probe: SpaceProbe,
    ) -> std::io::Result<Self> {
        std::fs::create_dir_all(root.join("blobs"))?;
        std::fs::create_dir_all(root.join("tmp"))?;
        Ok(Self {
            root: root.to_path_buf(),
            store,
            budget_bytes,
            reserve_bytes,
            probe,
            verified: Arc::new(Mutex::new(HashSet::new())),
        })
    }

    pub fn blobs_dir(&self) -> PathBuf {
        self.root.join("blobs")
    }

    pub fn blob_path(&self, sha256: &str) -> PathBuf {
        self.root.join("blobs").join(sha256)
    }

    fn part_path(&self, sha256: &str) -> PathBuf {
        self.root.join("tmp").join(format!("{sha256}.part"))
    }

    fn present(&self, asset: &AssetRow) -> bool {
        std::fs::metadata(self.blob_path(&asset.sha256))
            .is_ok_and(|m| m.is_file() && m.len() == asset.size_bytes)
    }

    /// Octets encore à télécharger pour ces assets.
    pub fn missing_bytes(&self, assets: &[AssetRow]) -> u64 {
        let mut seen = HashSet::new();
        assets
            .iter()
            .filter(|a| seen.insert(a.sha256.clone()) && !self.present(a))
            .map(|a| a.size_bytes)
            .sum()
    }

    /// Vérifie l’espace pour `needed` octets plus la réserve, après éviction des blobs non
    /// épinglés. L’actif n’est jamais supprimé pour faire de la place (NAT-010).
    pub fn ensure_space(&self, needed: u64) -> Result<(), CacheError> {
        if needed == 0 {
            return Ok(());
        }
        let required = needed.saturating_add(self.reserve_bytes);
        let available = || (self.probe)(&self.root).unwrap_or(u64::MAX);
        if available() >= required {
            return Ok(());
        }
        let pinned: HashSet<String> = self.store.pinned_blobs()?.into_iter().collect();
        for (sha, _) in self.store.blobs_by_age()? {
            if available() >= required {
                break;
            }
            if !pinned.contains(&sha) {
                self.remove_blob(&sha)?;
            }
        }
        let available = available();
        if available >= required {
            Ok(())
        } else {
            Err(CacheError::DiskFull {
                needed: required,
                available,
            })
        }
    }

    fn remove_blob(&self, sha: &str) -> Result<(), CacheError> {
        match std::fs::remove_file(self.blob_path(sha)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        self.store.forget_blob(sha)?;
        self.verified_set().remove(sha);
        Ok(())
    }

    fn verified_set(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.verified.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Éviction au-delà du budget, des blobs non épinglés du plus ancien usage au plus récent.
    /// Supprime aussi les fichiers de `blobs/` inconnus de la base.
    pub fn collect_garbage(&self) -> Result<u64, CacheError> {
        let pinned: HashSet<String> = self.store.pinned_blobs()?.into_iter().collect();
        let known = self.store.blobs_by_age()?;
        let known_set: HashSet<&str> = known.iter().map(|(sha, _)| sha.as_str()).collect();
        let mut freed = 0;
        for entry in std::fs::read_dir(self.blobs_dir())?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !known_set.contains(name.as_str()) {
                freed += entry.metadata().map(|m| m.len()).unwrap_or(0);
                let _ = std::fs::remove_file(entry.path());
            }
        }
        let mut total: u64 = known.iter().map(|(_, size)| size).sum();
        for (sha, size) in known {
            if total <= self.budget_bytes {
                break;
            }
            if !pinned.contains(&sha) {
                self.remove_blob(&sha)?;
                total -= size;
                freed += size;
            }
        }
        Ok(freed)
    }

    /// Recontrôle complet d’un blob avant sa première présentation depuis le démarrage.
    /// Un blob altéré sur disque est supprimé : il sera retéléchargé, jamais lu.
    pub fn verify_blob(&self, asset: &AssetRow) -> Result<bool, CacheError> {
        if self.verified_set().contains(&asset.sha256) {
            return Ok(self.present(asset));
        }
        let path = self.blob_path(&asset.sha256);
        let ok = match std::fs::File::open(&path) {
            Ok(file) => {
                file.metadata()?.len() == asset.size_bytes && hash_reader(file)? == asset.sha256
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.into()),
        };
        if ok {
            self.verified_set().insert(asset.sha256.clone());
        } else {
            self.remove_blob(&asset.sha256)?;
        }
        Ok(ok)
    }

    /// Télécharge un asset du manifest s’il manque, puis l’inscrit dans le cache.
    pub async fn fetch(
        &self,
        cloud: &Cloud,
        manifest_id: &str,
        asset: &AssetRow,
    ) -> Result<(), CacheError> {
        if !is_sha256(&asset.sha256) {
            return Err(CacheError::AssetMismatch(asset.asset_id.clone()));
        }
        if self.present(asset) {
            self.store
                .record_blob(&asset.sha256, asset.size_bytes, &now_text())?;
            return Ok(());
        }
        let url = cloud.asset_url(&asset.asset_id, manifest_id).await?;
        // Le manifest signé fait foi : le cloud ne peut pas substituer un autre fichier.
        if url.sha256 != asset.sha256 || url.size_bytes != asset.size_bytes {
            return Err(CacheError::AssetMismatch(asset.asset_id.clone()));
        }
        let Some(address) = cloud.absolute_url(&url.url) else {
            return Err(CacheError::Download {
                asset: asset.asset_id.clone(),
                detail: "URL de téléchargement invalide".into(),
            });
        };
        self.download(&cloud.downloader(), &address, asset, url.range_supported)
            .await
    }

    async fn download(
        &self,
        http: &reqwest::Client,
        url: &str,
        asset: &AssetRow,
        range_supported: bool,
    ) -> Result<(), CacheError> {
        let part = self.part_path(&asset.sha256);
        let failed = |detail: String| CacheError::Download {
            asset: asset.asset_id.clone(),
            detail,
        };
        let mut offset = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if offset > asset.size_bytes {
            std::fs::remove_file(&part)?;
            offset = 0;
        }
        if offset < asset.size_bytes {
            let mut request = http.get(url);
            if offset > 0 && range_supported {
                request = request.header("range", format!("bytes={offset}-"));
            }
            let response = request
                .send()
                .await
                .map_err(|e| failed(e.without_url().to_string()))?;
            let status = response.status();
            let append = match status {
                StatusCode::PARTIAL_CONTENT if offset > 0 => true,
                StatusCode::OK => false,
                StatusCode::RANGE_NOT_SATISFIABLE => {
                    // Fichier partiel incohérent avec le serveur : on repart de zéro.
                    let _ = std::fs::remove_file(&part);
                    return Err(failed("reprise refusée".into()));
                }
                other => return Err(failed(format!("HTTP {}", other.as_u16()))),
            };
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .append(append)
                .truncate(!append)
                .open(&part)?;
            let mut written = if append { offset } else { 0 };
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| failed(e.without_url().to_string()))?;
                written += chunk.len() as u64;
                if written > asset.size_bytes {
                    drop(file);
                    let _ = std::fs::remove_file(&part);
                    return Err(CacheError::ChecksumMismatch(asset.asset_id.clone()));
                }
                file.write_all(&chunk)?;
            }
            file.sync_all()?;
            if written != asset.size_bytes {
                // Coupure : le partiel est conservé pour une reprise.
                return Err(failed(format!(
                    "{written} octets reçus sur {}",
                    asset.size_bytes
                )));
            }
        }
        let digest = hash_reader(std::fs::File::open(&part)?)?;
        if digest != asset.sha256 {
            let _ = std::fs::remove_file(&part);
            return Err(CacheError::ChecksumMismatch(asset.asset_id.clone()));
        }
        std::fs::rename(&part, self.blob_path(&asset.sha256))?;
        sync_dir(&self.blobs_dir());
        self.verified_set().insert(asset.sha256.clone());
        self.store
            .record_blob(&asset.sha256, asset.size_bytes, &now_text())?;
        Ok(())
    }

    /// Marque l’usage des blobs d’un manifest présenté (ordre d’éviction).
    pub fn touch(&self, assets: &[AssetRow]) -> Result<(), CacheError> {
        let now = now_text();
        for asset in assets {
            if self.present(asset) {
                self.store
                    .record_blob(&asset.sha256, asset.size_bytes, &now)?;
            }
        }
        Ok(())
    }
}

fn hash_reader(mut reader: impl Read) -> std::io::Result<String> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
