//! Mêmes vecteurs que `packages/contracts/test/player-auth.test.ts`.

use ed25519_dalek::SigningKey;
use pixlova_contracts::player_auth::{
    public_key_b64u, sign_player_challenge, verify_player_challenge,
};
use serde::Deserialize;
use serde_json::Value;
use std::path::PathBuf;

#[derive(Deserialize)]
struct Vector {
    name: String,
    challenge: Value,
    signature: String,
    valid: bool,
}

#[derive(Deserialize)]
struct File {
    device_seed_hex: String,
    public_key_b64u: String,
    vectors: Vec<Vector>,
}

fn seed(hex: &str) -> [u8; 32] {
    let bytes: Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect();
    bytes.try_into().unwrap()
}

#[test]
fn signature_rust_identique_et_verification_croisee() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/contracts/fixtures/player-auth-vectors.json");
    let file: File = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let key = SigningKey::from_bytes(&seed(&file.device_seed_hex));
    assert_eq!(public_key_b64u(&key), file.public_key_b64u);
    let verifying = key.verifying_key();
    for vector in &file.vectors {
        assert_eq!(
            verify_player_challenge(&verifying, &vector.challenge, &vector.signature),
            vector.valid,
            "{}",
            vector.name
        );
        if vector.name == "valid" {
            // Ed25519 est déterministe : Rust produit exactement la signature TypeScript.
            assert_eq!(
                sign_player_challenge(&key, &vector.challenge).unwrap(),
                vector.signature
            );
        }
    }
    let mut foreign = file.vectors[0].challenge.clone();
    foreign["type"] = Value::from("SIGNAGE_MANIFEST_V1");
    assert!(sign_player_challenge(&key, &foreign).is_err());
}
