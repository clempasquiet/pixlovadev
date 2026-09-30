//! Clés publiques de confiance (PROTO-012, NAT-013), installées avec le paquet signé.
//! Aucune route ni commande ne peut en ajouter : ce module ne fait que lire des fichiers.
//!
//! Format : `{"keys": [{"kid": "manifest-2026-a", "public_key": "<32 octets base64url>"}]}`.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::VerifyingKey;
use pixlova_contracts::TrustStore;
use serde::Deserialize;
use std::path::{Path, PathBuf};

pub const MANIFEST_KEYS_FILE: &str = "manifest-keys.json";
pub const RELEASE_KEYS_FILE: &str = "release-keys.json";
pub const COMMAND_KEYS_FILE: &str = "command-keys.json";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyFile {
    keys: Vec<KeyEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyEntry {
    kid: String,
    public_key: String,
}

#[derive(Debug, thiserror::Error)]
pub enum TrustError {
    #[error("{path} : {detail}")]
    Invalid { path: PathBuf, detail: String },
}

/// Clés de manifest, de release et de commande, distinctes (NAT-013, ADR-014).
#[derive(Debug, Clone, Default)]
pub struct TrustAnchors {
    pub manifests: TrustStore,
    pub releases: TrustStore,
    pub commands: TrustStore,
}

impl TrustAnchors {
    pub fn load(dir: &Path) -> Result<Self, TrustError> {
        let anchors = Self {
            manifests: load_file(&dir.join(MANIFEST_KEYS_FILE))?,
            releases: load_file(&dir.join(RELEASE_KEYS_FILE))?,
            commands: load_file(&dir.join(COMMAND_KEYS_FILE))?,
        };
        let sets = [&anchors.manifests, &anchors.releases, &anchors.commands];
        let shared = sets.iter().enumerate().any(|(i, a)| {
            sets[i + 1..].iter().any(|b| {
                a.iter()
                    .any(|(kid, key)| b.contains_key(kid) || b.values().any(|other| other == key))
            })
        });
        if shared {
            return Err(TrustError::Invalid {
                path: dir.to_path_buf(),
                detail: "une même clé ne peut signer deux types de documents".into(),
            });
        }
        Ok(anchors)
    }
}

/// Fichier absent : ensemble vide (tout manifest sera refusé `UNKNOWN_KEY`).
fn load_file(path: &Path) -> Result<TrustStore, TrustError> {
    let invalid = |detail: String| TrustError::Invalid {
        path: path.to_path_buf(),
        detail,
    };
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TrustStore::new());
        }
        Err(error) => return Err(invalid(error.to_string())),
    };
    let file: KeyFile = serde_json::from_str(&text).map_err(|e| invalid(e.to_string()))?;
    let mut store = TrustStore::new();
    for entry in file.keys {
        let bytes = URL_SAFE_NO_PAD
            .decode(&entry.public_key)
            .ok()
            .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
            .ok_or_else(|| invalid(format!("clé {} mal encodée", entry.kid)))?;
        let key = VerifyingKey::from_bytes(&bytes)
            .map_err(|_| invalid(format!("clé {} invalide", entry.kid)))?;
        if key.is_weak() {
            return Err(invalid(format!("clé {} de petit ordre", entry.kid)));
        }
        if store.insert(entry.kid.clone(), key).is_some() {
            return Err(invalid(format!("kid {} en double", entry.kid)));
        }
    }
    Ok(store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    fn public(seed: u8) -> String {
        URL_SAFE_NO_PAD.encode(
            SigningKey::from_bytes(&[seed; 32])
                .verifying_key()
                .to_bytes(),
        )
    }

    #[test]
    fn charge_les_deux_ensembles() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(MANIFEST_KEYS_FILE),
            format!(
                r#"{{"keys":[{{"kid":"manifest-a","public_key":"{}"}}]}}"#,
                public(1)
            ),
        )
        .unwrap();
        let anchors = TrustAnchors::load(dir.path()).unwrap();
        assert!(anchors.manifests.contains_key("manifest-a"));
        assert!(anchors.releases.is_empty());
        assert!(anchors.commands.is_empty());
        std::fs::write(
            dir.path().join(COMMAND_KEYS_FILE),
            format!(
                r#"{{"keys":[{{"kid":"command-a","public_key":"{}"}}]}}"#,
                public(1)
            ),
        )
        .unwrap();
        assert!(
            TrustAnchors::load(dir.path()).is_err(),
            "clé de manifest réutilisée pour les commandes"
        );
        std::fs::write(
            dir.path().join(COMMAND_KEYS_FILE),
            format!(
                r#"{{"keys":[{{"kid":"command-a","public_key":"{}"}}]}}"#,
                public(2)
            ),
        )
        .unwrap();
        assert!(
            TrustAnchors::load(dir.path())
                .unwrap()
                .commands
                .contains_key("command-a")
        );
    }

    #[test]
    fn refuse_une_cle_partagee_ou_mal_formee() {
        let dir = tempfile::tempdir().unwrap();
        let body = format!(
            r#"{{"keys":[{{"kid":"k-1","public_key":"{}"}}]}}"#,
            public(1)
        );
        std::fs::write(dir.path().join(MANIFEST_KEYS_FILE), &body).unwrap();
        std::fs::write(dir.path().join(RELEASE_KEYS_FILE), &body).unwrap();
        assert!(TrustAnchors::load(dir.path()).is_err());
        std::fs::write(
            dir.path().join(RELEASE_KEYS_FILE),
            r#"{"keys":[{"kid":"r-1","public_key":"AAAA"}]}"#,
        )
        .unwrap();
        assert!(TrustAnchors::load(dir.path()).is_err());
    }
}
