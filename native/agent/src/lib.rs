//! Agent natif pixlova (ADR-012).
//!
//! L’agent détient l’identité de l’appareil, dialogue avec l’API Player, tient la base
//! SQLite et le cache adressé par SHA-256, applique les manifests de manière atomique,
//! supervise le renderer par IPC local et installe les mises à jour signées. Il ne décide
//! jamais du contenu : la sélection est compilée au cloud et exécutée par la page de
//! lecture partagée.

#[cfg(not(unix))]
compile_error!(
    "pixlova-agent cible Linux en V1 : le portage Windows (Named Pipe, DPAPI, service) est décrit dans l’ADR-012"
);

pub mod cache;
pub mod clock;
pub mod cloud;
pub mod config;
pub mod diagnostics;
pub mod identity;
pub mod ipc;
pub mod pipeline;
pub mod platform;
pub mod runtime;
pub mod store;
pub mod supervisor;
pub mod trust;

/// Version de l’agent, publiée dans les capacités et les rapports.
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
