//! Identité de l’appareil (PROTO-002, NAT-005) : graine Ed25519 créée au premier démarrage,
//! jamais transmise. Chaque clone d’image disque crée sa propre clé au premier lancement
//! puisque le fichier n’est pas livré avec l’image.

use ed25519_dalek::SigningKey;
use rand_core::OsRng;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("clé d’appareil illisible ({0}) : fichier corrompu, intervention requise")]
    Corrupt(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

pub struct DeviceIdentity {
    key: SigningKey,
    path: PathBuf,
}

impl std::fmt::Debug for DeviceIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Jamais la graine dans un journal ou un rapport.
        f.debug_struct("DeviceIdentity")
            .field("public_key", &self.public_key_b64u())
            .finish()
    }
}

impl DeviceIdentity {
    /// Charge `device.key`, ou la crée (écriture dans un fichier temporaire `0600`, `fsync`,
    /// puis renommage atomique). Une clé corrompue n’est jamais remplacée silencieusement :
    /// elle porte l’association au compte.
    pub fn load_or_create(dir: &Path) -> Result<Self, IdentityError> {
        std::fs::create_dir_all(dir)?;
        restrict_dir(dir);
        let path = dir.join("device.key");
        match std::fs::read(&path) {
            Ok(bytes) => {
                let seed = <[u8; 32]>::try_from(bytes.as_slice())
                    .map_err(|_| IdentityError::Corrupt(format!("{} octets", bytes.len())))?;
                return Ok(Self {
                    key: SigningKey::from_bytes(&seed),
                    path,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let key = SigningKey::generate(&mut OsRng);
        let tmp = dir.join("device.key.tmp");
        {
            let mut file = create_private(&tmp)?;
            file.write_all(&key.to_bytes())?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, &path)?;
        sync_dir(dir);
        Ok(Self { key, path })
    }

    pub fn signing_key(&self) -> &SigningKey {
        &self.key
    }

    pub fn public_key_b64u(&self) -> String {
        pixlova_contracts::player_auth::public_key_b64u(&self.key)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(unix)]
fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    // Windows : ACL héritée du dossier ; protection DPAPI prévue avec le portage (ADR-012).
    std::fs::File::create(path)
}

#[cfg(unix)]
fn restrict_dir(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn restrict_dir(_dir: &Path) {}

/// Rend durable un renommage dans `dir` (coupure de courant, NAT-008).
pub fn sync_dir(dir: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = std::fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = dir;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cree_une_seule_fois_puis_relit_la_meme_cle() {
        let dir = tempfile::tempdir().unwrap();
        let first = DeviceIdentity::load_or_create(dir.path()).unwrap();
        let again = DeviceIdentity::load_or_create(dir.path()).unwrap();
        assert_eq!(first.public_key_b64u(), again.public_key_b64u());
        assert!(!format!("{first:?}").contains(&format!("{:?}", first.key.to_bytes())));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(first.path())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn deux_installations_ont_des_identites_distinctes() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        assert_ne!(
            DeviceIdentity::load_or_create(a.path())
                .unwrap()
                .public_key_b64u(),
            DeviceIdentity::load_or_create(b.path())
                .unwrap()
                .public_key_b64u()
        );
    }

    #[test]
    fn refuse_une_cle_corrompue_sans_la_remplacer() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("device.key"), b"court").unwrap();
        assert!(matches!(
            DeviceIdentity::load_or_create(dir.path()),
            Err(IdentityError::Corrupt(_))
        ));
        assert_eq!(
            std::fs::read(dir.path().join("device.key")).unwrap(),
            b"court"
        );
    }
}
