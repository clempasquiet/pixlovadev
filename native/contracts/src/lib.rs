//! Contrats pixlova côté Rust.
//!
//! Cette crate applique aux documents reçus par le Player natif **les mêmes règles**
//! que `@pixlova/contracts` en TypeScript : JSON strict, JCS (RFC 8785), signatures
//! Ed25519, schémas JSON publiés dans `packages/contracts/schemas` et règles
//! d’acceptation des manifests et commandes. Les deux implémentations sont testées
//! sur les mêmes vecteurs (`packages/contracts/fixtures`, PROTO-021).

pub mod canonical;
pub mod command;
pub mod instant;
pub mod manifest;
pub mod player_auth;
pub mod schema;
pub mod signature;
pub mod strict_json;

pub use command::{
    CommandContext, CommandDecision, CommandRejection, CommandVerification, evaluate_command,
    verify_command,
};
pub use manifest::{
    LocalAssociation, LocalDisplayState, ManifestDecision, ManifestRejection, ManifestVerification,
    evaluate_manifest_candidate, verify_manifest,
};
pub use signature::{
    EnvelopeError, EnvelopeErrorCode, TrustStore, VerifiedEnvelope, verify_envelope,
};
