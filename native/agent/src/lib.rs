//! Agent natif pixlova (ADR-012).
//!
//! L’agent détient l’identité de l’appareil, dialogue avec l’API Player, tient la base
//! SQLite et le cache adressé par SHA-256, applique les manifests de manière atomique,
//! supervise le renderer par IPC local et installe les mises à jour signées. Il ne décide
//! jamais du contenu : la sélection est compilée au cloud et exécutée par la page de
//! lecture partagée.

pub mod clock;
pub mod config;
pub mod identity;
pub mod store;
pub mod trust;

/// Version de l’agent, publiée dans les capacités et les rapports.
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
