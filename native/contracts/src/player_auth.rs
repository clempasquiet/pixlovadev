//! Preuve de possession de la clé Player (PROTO-002), identique à
//! `packages/contracts/src/player-auth.ts` : signature Ed25519 du JCS du challenge.

use crate::canonical::canonical_bytes;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use serde_json::Value;

pub const PLAYER_AUTH_TYPE: &str = "PIXLOVA_PLAYER_AUTH_V1";
pub const PLAYER_AUTH_AUDIENCE: &str = "pixlova-player-api";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlayerAuthError {
    /// Type ou audience inattendus : le challenge n’appartient pas à ce domaine.
    WrongDomain,
}

fn signing_input(challenge: &Value) -> Result<Vec<u8>, PlayerAuthError> {
    let field = |name: &str| challenge.get(name).and_then(Value::as_str);
    if field("type") != Some(PLAYER_AUTH_TYPE) || field("audience") != Some(PLAYER_AUTH_AUDIENCE) {
        return Err(PlayerAuthError::WrongDomain);
    }
    Ok(canonical_bytes(challenge))
}

/// Signe un challenge reçu du cloud avec la clé privée locale de l’appareil.
pub fn sign_player_challenge(
    key: &SigningKey,
    challenge: &Value,
) -> Result<String, PlayerAuthError> {
    let signature = key.sign(&signing_input(challenge)?);
    Ok(URL_SAFE_NO_PAD.encode(signature.to_bytes()))
}

pub fn verify_player_challenge(
    public_key: &VerifyingKey,
    challenge: &Value,
    signature: &str,
) -> bool {
    let Ok(input) = signing_input(challenge) else {
        return false;
    };
    let Some(bytes) = URL_SAFE_NO_PAD
        .decode(signature)
        .ok()
        .and_then(|bytes| <[u8; 64]>::try_from(bytes).ok())
    else {
        return false;
    };
    public_key
        .verify_strict(&input, &Signature::from_bytes(&bytes))
        .is_ok()
}

/// Clé publique brute en base64url, telle qu’envoyée à `POST /player/v1/register`.
pub fn public_key_b64u(key: &SigningKey) -> String {
    URL_SAFE_NO_PAD.encode(key.verifying_key().to_bytes())
}
