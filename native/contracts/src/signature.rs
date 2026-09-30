//! Enveloppes signées `{protected, payload, signature}` (PROTO-011).

use crate::canonical::{canonical_bytes, canonical_sha256};
use crate::strict_json::parse_strict_json;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::{Map, Value, json};
use std::collections::HashMap;

/// Clés publiques de confiance par `kid`. Une notification réseau ne peut pas y ajouter de clé.
pub type TrustStore = HashMap<String, VerifyingKey>;

pub const DEFAULT_MAX_ENVELOPE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnvelopeErrorCode {
    MalformedJson,
    EnvelopeInvalid,
    UnknownKey,
    SignatureInvalid,
}

impl EnvelopeErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MalformedJson => "MALFORMED_JSON",
            Self::EnvelopeInvalid => "ENVELOPE_INVALID",
            Self::UnknownKey => "UNKNOWN_KEY",
            Self::SignatureInvalid => "SIGNATURE_INVALID",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeError {
    pub code: EnvelopeErrorCode,
    pub detail: String,
}

fn fail<T>(code: EnvelopeErrorCode, detail: impl Into<String>) -> Result<T, EnvelopeError> {
    Err(EnvelopeError {
        code,
        detail: detail.into(),
    })
}

#[derive(Debug, Clone)]
pub struct VerifiedEnvelope {
    pub kid: String,
    pub payload: Map<String, Value>,
    /// SHA-256 de la forme canonique du payload seul.
    pub payload_hash: String,
}

fn has_exact_keys(object: &Map<String, Value>, expected: &[&str]) -> bool {
    object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
}

fn is_valid_kid(kid: &str) -> bool {
    let bytes = kid.as_bytes();
    (3..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// Vérifie dans cet ordre : taille, JSON strict, forme de l’enveloppe et type attendu,
/// clé connue, signature stricte. Le schéma du payload est contrôlé par l’appelant.
pub fn verify_envelope(
    raw: &str,
    expected_type: &str,
    trust: &TrustStore,
    max_bytes: usize,
) -> Result<VerifiedEnvelope, EnvelopeError> {
    use EnvelopeErrorCode::*;
    if raw.len() > max_bytes {
        return fail(MalformedJson, "taille maximale dépassée");
    }
    let document = match parse_strict_json(raw) {
        Ok(value) => value,
        Err(error) => return fail(MalformedJson, error.0),
    };
    let Value::Object(mut envelope) = document else {
        return fail(EnvelopeInvalid, "membres de l’enveloppe invalides");
    };
    if !has_exact_keys(&envelope, &["payload", "protected", "signature"]) {
        return fail(EnvelopeInvalid, "membres de l’enveloppe invalides");
    }
    let header = envelope.remove("protected").unwrap_or_default();
    let payload = envelope.remove("payload").unwrap_or_default();
    let signature = envelope.remove("signature").unwrap_or_default();
    let (Value::Object(header_map), Value::Object(payload_map)) = (&header, &payload) else {
        return fail(EnvelopeInvalid, "en-tête ou payload invalide");
    };
    if !has_exact_keys(header_map, &["alg", "kid", "type"]) {
        return fail(EnvelopeInvalid, "en-tête ou payload invalide");
    }
    if header_map.get("type").and_then(Value::as_str) != Some(expected_type) {
        return fail(EnvelopeInvalid, "type d’enveloppe inattendu");
    }
    if header_map.get("alg").and_then(Value::as_str) != Some("Ed25519") {
        return fail(EnvelopeInvalid, "algorithme non accepté");
    }
    let kid = match header_map.get("kid").and_then(Value::as_str) {
        Some(kid) if is_valid_kid(kid) => kid.to_owned(),
        _ => return fail(EnvelopeInvalid, "kid invalide"),
    };
    let signature_bytes = signature
        .as_str()
        .and_then(|text| URL_SAFE_NO_PAD.decode(text).ok())
        .and_then(|bytes| <[u8; 64]>::try_from(bytes).ok());
    let Some(signature_bytes) = signature_bytes else {
        return fail(EnvelopeInvalid, "signature mal encodée");
    };
    let Some(key) = trust.get(&kid) else {
        return fail(UnknownKey, format!("clé inconnue {kid}"));
    };
    let input = canonical_bytes(&json!({ "protected": header, "payload": payload }));
    let signature = Signature::from_bytes(&signature_bytes);
    // `verify_strict` : refuse S non réduit et clés de petit ordre, comme la
    // vérification noble `zip215: false` côté TypeScript.
    if key.verify_strict(&input, &signature).is_err() {
        return fail(SignatureInvalid, "signature invalide");
    }
    Ok(VerifiedEnvelope {
        kid,
        payload_hash: canonical_sha256(&payload),
        payload: payload_map.clone(),
    })
}
