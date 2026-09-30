//! Forme canonique JCS (RFC 8785) et empreintes.

use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn canonical_bytes(value: &Value) -> Vec<u8> {
    // Une `Value` issue de l’analyse stricte ne contient que des nombres finis :
    // la sérialisation canonique ne peut pas échouer.
    serde_json_canonicalizer::to_vec(value).expect("valeur JSON sérialisable")
}

pub fn canonical_string(value: &Value) -> String {
    String::from_utf8(canonical_bytes(value)).expect("JCS produit de l’UTF-8")
}

/// SHA-256 hexadécimal de la forme canonique (ex. `payload_hash` d’un manifest).
pub fn canonical_sha256(value: &Value) -> String {
    let digest = Sha256::digest(canonical_bytes(value));
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
