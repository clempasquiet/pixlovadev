//! Validation par les schémas JSON publiés par `@pixlova/contracts`.
//!
//! Les fichiers sont intégrés à la compilation : le Player n’en télécharge jamais.

use jsonschema::Validator;
use serde_json::Value;
use std::sync::OnceLock;

macro_rules! schema {
    ($file:literal) => {
        include_str!(concat!("../../../packages/contracts/schemas/", $file))
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootSchema {
    ManifestPayload,
    CommandPayload,
    WsMessage,
    PlayerEventBatch,
    PlayerCapabilities,
}

impl RootSchema {
    fn source(self) -> &'static str {
        match self {
            RootSchema::ManifestPayload => schema!("manifest-payload.json"),
            RootSchema::CommandPayload => schema!("command-payload.json"),
            RootSchema::WsMessage => schema!("ws-message.json"),
            RootSchema::PlayerEventBatch => schema!("player-event-batch.json"),
            RootSchema::PlayerCapabilities => schema!("player-capabilities.json"),
        }
    }

    fn cell(self) -> &'static OnceLock<Validator> {
        static MANIFEST: OnceLock<Validator> = OnceLock::new();
        static COMMAND: OnceLock<Validator> = OnceLock::new();
        static WS: OnceLock<Validator> = OnceLock::new();
        static EVENTS: OnceLock<Validator> = OnceLock::new();
        static CAPABILITIES: OnceLock<Validator> = OnceLock::new();
        match self {
            RootSchema::ManifestPayload => &MANIFEST,
            RootSchema::CommandPayload => &COMMAND,
            RootSchema::WsMessage => &WS,
            RootSchema::PlayerEventBatch => &EVENTS,
            RootSchema::PlayerCapabilities => &CAPABILITIES,
        }
    }

    pub fn validator(self) -> &'static Validator {
        self.cell().get_or_init(|| {
            let schema: Value =
                serde_json::from_str(self.source()).expect("schéma JSON intégré valide");
            jsonschema::validator_for(&schema).expect("schéma compilable")
        })
    }

    /// `Err` porte un diagnostic court (chemin et message du premier écart).
    pub fn validate(self, instance: &Value) -> Result<(), String> {
        self.validator()
            .validate(instance)
            .map_err(|error| format!("{} {}", error.instance_path(), error))
    }
}
