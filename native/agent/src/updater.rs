//! Mises à jour signées (PLY-005, NAT-013, SEC-011) : vérification des métadonnées de
//! release, du paquet (taille, SHA-256), extraction sûre dans un emplacement distinct,
//! puis inscription comme version `pending` du lanceur A/B. Rien n’est exécuté ici.

use crate::cache::is_sha256;
use crate::identity::sync_dir;
use pixlova_contracts::TrustStore;
use pixlova_contracts::release::{ReleasePayload, parse_version, verify_release};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

/// Taille maximale d’un paquet extrait (binaires, page de lecture, polices).
pub const MAX_EXTRACTED_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 10_000;
/// Fichiers exigés dans chaque version installée.
pub const REQUIRED_FILES: &[&str] = &[
    "pixlova-agent",
    "pixlova-renderer",
    "player-shell/index.html",
];
pub const RELEASE_FILE: &str = "release.json";

#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("métadonnées de release refusées : {0}")]
    Release(String),
    #[error("release pour {0} : plateforme différente")]
    WrongPlatform(String),
    #[error("version {candidate} non postérieure à la version en service {current}")]
    NotNewer { candidate: String, current: String },
    #[error("release {0} bloquée localement après un retour arrière")]
    Blocked(String),
    #[error("protocole Player non pris en charge par cette release")]
    Protocol,
    #[error("paquet différent des métadonnées signées : {0}")]
    PackageMismatch(String),
    #[error("paquet refusé : {0}")]
    UnsafePackage(String),
    #[error("paquet incomplet : {0} absent")]
    Incomplete(String),
    #[error("version {0} déjà installée")]
    AlreadyInstalled(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl UpdateError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Release(_) => "RELEASE_INVALID",
            Self::WrongPlatform(_) => "WRONG_PLATFORM",
            Self::NotNewer { .. } => "RELEASE_NOT_NEWER",
            Self::Blocked(_) => "RELEASE_BLOCKED",
            Self::Protocol => "PROTOCOL_UNSUPPORTED",
            Self::PackageMismatch(_) => "PACKAGE_MISMATCH",
            Self::UnsafePackage(_) => "PACKAGE_UNSAFE",
            Self::Incomplete(_) => "PACKAGE_INCOMPLETE",
            Self::AlreadyInstalled(_) => "ALREADY_INSTALLED",
            Self::Io(_) => "LOCAL_STORAGE_ERROR",
        }
    }
}

// --- État du lanceur A/B ----------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub version: String,
    pub release_id: Option<String>,
    /// `installed`, `promoted`, `rolled_back`.
    pub result: String,
    pub reason: Option<String>,
    pub at: String,
}

/// `state/launcher.json`, écrit atomiquement par l’agent (installation) et le lanceur.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LauncherState {
    pub current: Option<String>,
    pub previous: Option<String>,
    pub pending: Option<String>,
    #[serde(default)]
    pub pending_attempts: u32,
    /// Versions bloquées après retour arrière : jamais réinstallées automatiquement.
    #[serde(default)]
    pub blocked: Vec<String>,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
}

pub fn versions_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("versions")
}

pub fn launcher_state_path(data_dir: &Path) -> PathBuf {
    data_dir.join("state").join("launcher.json")
}

impl LauncherState {
    pub fn load(data_dir: &Path) -> std::io::Result<Self> {
        match std::fs::read_to_string(launcher_state_path(data_dir)) {
            Ok(text) => serde_json::from_str(&text)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error),
        }
    }

    /// Écriture atomique et durable (coupure de courant pendant une mise à jour).
    pub fn save(&self, data_dir: &Path) -> std::io::Result<()> {
        let path = launcher_state_path(data_dir);
        let dir = path.parent().expect("dossier d’état");
        std::fs::create_dir_all(dir)?;
        let tmp = path.with_extension("json.tmp");
        {
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(serde_json::to_string_pretty(self)?.as_bytes())?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &path)?;
        sync_dir(dir);
        Ok(())
    }

    pub fn record(
        &mut self,
        version: &str,
        release_id: Option<String>,
        result: &str,
        reason: Option<String>,
        at: &str,
    ) {
        self.history.push(HistoryEntry {
            version: version.to_owned(),
            release_id,
            result: result.to_owned(),
            reason,
            at: at.to_owned(),
        });
        // Historique borné.
        let excess = self.history.len().saturating_sub(50);
        self.history.drain(..excess);
    }
}

/// Métadonnées vérifiées d’une version installée (`versions/<v>/release.json`).
pub fn installed_release(
    data_dir: &Path,
    version: &str,
    trust: &TrustStore,
) -> Option<ReleasePayload> {
    let raw =
        std::fs::read_to_string(versions_dir(data_dir).join(version).join(RELEASE_FILE)).ok()?;
    verify_release(&raw, trust).ok().map(|v| v.release)
}

// --- Installation -------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Installed {
    pub release: ReleasePayload,
    pub directory: PathBuf,
}

fn sha256_file(path: &Path) -> std::io::Result<(String, u64)> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    let mut total = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        hasher.update(&buffer[..read]);
    }
    Ok((
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
        total,
    ))
}

/// Vérifie la release et le paquet, extrait dans `versions/<v>` et inscrit la version
/// comme `pending`. La version en service n’est pas modifiée ; le lanceur l’essaiera au
/// prochain démarrage et reviendra en arrière sans marqueur de santé.
pub fn apply(
    data_dir: &Path,
    trust: &TrustStore,
    release_raw: &str,
    package: &Path,
    running_version: &str,
    now: &str,
) -> Result<Installed, UpdateError> {
    let verified =
        verify_release(release_raw, trust).map_err(|e| UpdateError::Release(e.to_string()))?;
    let release = verified.release;
    let (os, arch) = (
        crate::platform::os_family(),
        crate::platform::architecture(),
    );
    if release.os != os || release.arch != arch {
        return Err(UpdateError::WrongPlatform(format!(
            "{}/{}",
            release.os, release.arch
        )));
    }
    if !(release.protocol_min..=release.protocol_max).contains(&1) {
        return Err(UpdateError::Protocol);
    }
    let mut state = LauncherState::load(data_dir)?;
    if state.blocked.contains(&release.version) {
        return Err(UpdateError::Blocked(release.version));
    }
    // Pas de retour à une version antérieure par ce chemin : c’est le rôle du lanceur.
    let current = state
        .current
        .clone()
        .unwrap_or_else(|| running_version.to_owned());
    if parse_version(&release.version) <= parse_version(&current) {
        return Err(UpdateError::NotNewer {
            candidate: release.version,
            current,
        });
    }
    if !is_sha256(&release.package.sha256) {
        return Err(UpdateError::PackageMismatch("empreinte".into()));
    }
    let (digest, size) = sha256_file(package)?;
    if size != release.package.size_bytes || digest != release.package.sha256 {
        return Err(UpdateError::PackageMismatch(format!(
            "{size} octets, {digest}"
        )));
    }
    let versions = versions_dir(data_dir);
    std::fs::create_dir_all(&versions)?;
    let target = versions.join(&release.version);
    if target.exists() {
        return Err(UpdateError::AlreadyInstalled(release.version));
    }
    let staging = versions.join(format!("{}.tmp", release.version));
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    std::fs::create_dir_all(&staging)?;
    let extracted = extract(package, &staging).and_then(|()| {
        for required in REQUIRED_FILES {
            if !staging.join(required).is_file() {
                return Err(UpdateError::Incomplete((*required).to_owned()));
            }
        }
        std::fs::write(staging.join(RELEASE_FILE), release_raw)?;
        Ok(())
    });
    if let Err(error) = extracted {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    std::fs::rename(&staging, &target)?;
    sync_dir(&versions);
    if state.current.is_none() {
        state.current = Some(running_version.to_owned());
    }
    // Une version en attente non essayée est remplacée par la plus récente.
    state.pending = Some(release.version.clone());
    state.pending_attempts = 0;
    state.record(
        &release.version,
        Some(release.release_id.clone()),
        "installed",
        None,
        now,
    );
    state.save(data_dir)?;
    Ok(Installed {
        release,
        directory: target,
    })
}

/// Extraction d’une archive tar : fichiers et dossiers seulement, chemins relatifs sans
/// `..`, sans liens, taille et nombre d’entrées bornés.
pub fn extract(package: &Path, destination: &Path) -> Result<(), UpdateError> {
    let unsafe_package = |detail: String| UpdateError::UnsafePackage(detail);
    let mut archive = tar::Archive::new(std::fs::File::open(package)?);
    let mut total = 0u64;
    for (count, entry) in archive.entries()?.enumerate() {
        if count >= MAX_ENTRIES {
            return Err(unsafe_package("trop d’entrées".into()));
        }
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let display = path.display().to_string();
        if path.as_os_str().is_empty()
            || !path
                .components()
                .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
        {
            return Err(unsafe_package(format!("chemin {display}")));
        }
        let relative: PathBuf = path
            .components()
            .filter(|c| matches!(c, Component::Normal(_)))
            .collect();
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = destination.join(&relative);
        match entry.header().entry_type() {
            tar::EntryType::Directory => std::fs::create_dir_all(&target)?,
            tar::EntryType::Regular | tar::EntryType::Continuous => {
                total = total.saturating_add(entry.size());
                if total > MAX_EXTRACTED_BYTES {
                    return Err(unsafe_package("taille extraite excessive".into()));
                }
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                let executable = entry.header().mode().is_ok_and(|mode| mode & 0o111 != 0);
                let size = entry.size();
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&target)?;
                let copied = std::io::copy(&mut (&mut entry).take(size), &mut file)?;
                if copied != size {
                    return Err(unsafe_package(format!("{display} tronqué")));
                }
                file.sync_all()?;
                set_mode(&target, if executable { 0o755 } else { 0o644 })?;
            }
            other => return Err(unsafe_package(format!("{display} : type {other:?} refusé"))),
        }
    }
    Ok(())
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}
