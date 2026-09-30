//! Métadonnées signées des releases du Player natif (`SIGNAGE_RELEASE_V1`, NAT-013),
//! vérifiées avec les clés de release seulement, avant tout téléchargement ou extraction.

use crate::schema::RootSchema;
use crate::signature::{EnvelopeErrorCode, TrustStore, verify_envelope};
use serde::Deserialize;
use serde_json::Value;

pub const RELEASE_ENVELOPE_TYPE: &str = "SIGNAGE_RELEASE_V1";
/// Les métadonnées sont petites : une enveloppe plus grande est suspecte.
pub const MAX_RELEASE_ENVELOPE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleasePackage {
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReleasePayload {
    pub schema_version: u64,
    pub release_id: String,
    pub version: String,
    pub os: String,
    pub arch: String,
    pub package: ReleasePackage,
    pub protocol_min: u32,
    pub protocol_max: u32,
    pub sqlite_schema: i64,
    pub sqlite_reader_level: i64,
    pub renderer_build: String,
    pub published_at: String,
}

#[derive(Debug, Clone)]
pub struct VerifiedRelease {
    pub release: ReleasePayload,
    pub kid: String,
    pub payload_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReleaseError {
    Envelope(EnvelopeErrorCode, String),
    SchemaInvalid(String),
}

impl ReleaseError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Envelope(code, _) => code.as_str(),
            Self::SchemaInvalid(_) => "SCHEMA_INVALID",
        }
    }
}

impl std::fmt::Display for ReleaseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Envelope(code, detail) => write!(f, "{} : {detail}", code.as_str()),
            Self::SchemaInvalid(detail) => write!(f, "SCHEMA_INVALID : {detail}"),
        }
    }
}

/// Version SemVer `a.b.c` → triplet comparable.
pub fn parse_version(version: &str) -> Option<(u32, u32, u32)> {
    let mut parts = version.split('.').map(|p| p.parse::<u32>().ok());
    let triple = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(triple)
}

pub fn verify_release(raw: &str, trust: &TrustStore) -> Result<VerifiedRelease, ReleaseError> {
    let envelope = verify_envelope(
        raw,
        RELEASE_ENVELOPE_TYPE,
        trust,
        MAX_RELEASE_ENVELOPE_BYTES,
    )
    .map_err(|e| ReleaseError::Envelope(e.code, e.detail))?;
    let document = Value::Object(envelope.payload);
    RootSchema::ReleasePayload
        .validate(&document)
        .map_err(ReleaseError::SchemaInvalid)?;
    let release: ReleasePayload =
        serde_json::from_value(document).map_err(|e| ReleaseError::SchemaInvalid(e.to_string()))?;
    if release.protocol_min > release.protocol_max {
        return Err(ReleaseError::SchemaInvalid(
            "plage de protocole vide".into(),
        ));
    }
    Ok(VerifiedRelease {
        release,
        kid: envelope.kid,
        payload_hash: envelope.payload_hash,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canonical::canonical_bytes;
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use ed25519_dalek::{Signer, SigningKey};
    use serde_json::json;

    fn sign(payload: &Value, key: &SigningKey, kind: &str) -> String {
        let protected = json!({ "type": kind, "alg": "Ed25519", "kid": "release-a" });
        let input = canonical_bytes(&json!({ "protected": protected, "payload": payload }));
        let signature = URL_SAFE_NO_PAD.encode(key.sign(&input).to_bytes());
        json!({ "protected": protected, "payload": payload, "signature": signature }).to_string()
    }

    fn payload() -> Value {
        json!({
            "schema_version": 1, "release_id": "12345678-1234-4234-8234-123456789abc",
            "version": "0.2.0", "os": "linux", "arch": "x86_64",
            "package": { "sha256": "a".repeat(64), "size_bytes": 1024 },
            "protocol_min": 1, "protocol_max": 1, "sqlite_schema": 1, "sqlite_reader_level": 1,
            "renderer_build": "0.2.0", "published_at": "2026-10-01T00:00:00Z",
        })
    }

    #[test]
    fn verifie_une_release_signee_par_une_cle_de_release() {
        let key = SigningKey::from_bytes(&[3; 32]);
        let trust = TrustStore::from([("release-a".to_owned(), key.verifying_key())]);
        let verified =
            verify_release(&sign(&payload(), &key, RELEASE_ENVELOPE_TYPE), &trust).unwrap();
        assert_eq!(verified.release.version, "0.2.0");
        assert_eq!(parse_version("0.2.0"), Some((0, 2, 0)));
        assert_eq!(parse_version("0.2"), None);
    }

    #[test]
    fn refuse_type_cle_ou_champ_inattendus() {
        let key = SigningKey::from_bytes(&[3; 32]);
        let trust = TrustStore::from([("release-a".to_owned(), key.verifying_key())]);
        // Un manifest signé avec la même forme n’est pas une release.
        assert_eq!(
            verify_release(&sign(&payload(), &key, "SIGNAGE_MANIFEST_V1"), &trust)
                .unwrap_err()
                .code(),
            "ENVELOPE_INVALID"
        );
        let other = SigningKey::from_bytes(&[4; 32]);
        assert_eq!(
            verify_release(&sign(&payload(), &other, RELEASE_ENVELOPE_TYPE), &trust)
                .unwrap_err()
                .code(),
            "SIGNATURE_INVALID"
        );
        let mut extra = payload();
        extra["install_script"] = json!("curl | sh");
        assert_eq!(
            verify_release(&sign(&extra, &key, RELEASE_ENVELOPE_TYPE), &trust)
                .unwrap_err()
                .code(),
            "SCHEMA_INVALID"
        );
    }
}
