//! Vérification et décision d’exécution des commandes signées (PROTO-007, PROTO-008, SEC-010).

use crate::instant::parse_instant_micros;
use crate::schema::RootSchema;
use crate::signature::{EnvelopeErrorCode, TrustStore, verify_envelope};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

pub const COMMAND_ENVELOPE_TYPE: &str = "SIGNAGE_COMMAND_V1";
pub const MAX_COMMAND_BYTES: usize = 64 * 1024;
/// Durée de validité maximale d’une commande.
pub const MAX_COMMAND_LIFETIME_MICROS: i64 = 24 * 3_600 * 1_000_000;

#[derive(Debug, Clone, Deserialize)]
pub struct CommandPayload {
    pub command_id: String,
    pub organization_id: String,
    pub player_id: String,
    pub display_id: Option<String>,
    pub assignment_generation: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub issued_at: String,
    pub expires_at: String,
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommandVerificationError {
    Envelope(EnvelopeErrorCode, String),
    SchemaInvalid(String),
    WindowInvalid,
}

impl CommandVerificationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Envelope(code, _) => code.as_str(),
            Self::SchemaInvalid(_) => "SCHEMA_INVALID",
            Self::WindowInvalid => "SEMANTIC_INVALID",
        }
    }

    pub fn reason(&self) -> Option<&'static str> {
        matches!(self, Self::WindowInvalid).then_some("COMMAND_WINDOW_INVALID")
    }
}

#[derive(Debug, Clone)]
pub struct VerifiedCommand {
    pub command: CommandPayload,
    pub command_hash: String,
}

pub type CommandVerification = Result<VerifiedCommand, CommandVerificationError>;

pub fn verify_command(raw: &str, trust: &TrustStore) -> CommandVerification {
    let envelope = verify_envelope(raw, COMMAND_ENVELOPE_TYPE, trust, MAX_COMMAND_BYTES)
        .map_err(|error| CommandVerificationError::Envelope(error.code, error.detail))?;
    let document = Value::Object(envelope.payload);
    RootSchema::CommandPayload
        .validate(&document)
        .map_err(CommandVerificationError::SchemaInvalid)?;
    let command: CommandPayload = serde_json::from_value(document)
        .map_err(|error| CommandVerificationError::SchemaInvalid(error.to_string()))?;
    match (
        parse_instant_micros(&command.issued_at),
        parse_instant_micros(&command.expires_at),
    ) {
        (Some(issued), Some(expires))
            if issued < expires && expires - issued <= MAX_COMMAND_LIFETIME_MICROS => {}
        _ => return Err(CommandVerificationError::WindowInvalid),
    }
    Ok(VerifiedCommand {
        command,
        command_hash: envelope.payload_hash,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Support {
    Supported,
    Unsupported,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandContext {
    pub organization_id: String,
    pub player_id: String,
    /// Génération d’affectation courante par Display.
    pub assignments: HashMap<String, String>,
    /// Commandes déjà inscrites durablement : identifiant → empreinte.
    pub seen: HashMap<String, String>,
    pub reboot_host: Support,
    pub screenshot: Support,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandRejection {
    WrongOrganization,
    WrongPlayer,
    CommandConflict,
    CommandExpired,
    WrongDisplay,
    StaleAssignment,
    CapabilityUnsupported,
}

impl CommandRejection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WrongOrganization => "WRONG_ORGANIZATION",
            Self::WrongPlayer => "WRONG_PLAYER",
            Self::CommandConflict => "COMMAND_CONFLICT",
            Self::CommandExpired => "COMMAND_EXPIRED",
            Self::WrongDisplay => "WRONG_DISPLAY",
            Self::StaleAssignment => "STALE_ASSIGNMENT",
            Self::CapabilityUnsupported => "CAPABILITY_UNSUPPORTED",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandDecision {
    Execute,
    /// Doublon : renvoyer le résultat connu sans ré-exécuter.
    Duplicate,
    Reject(CommandRejection),
}

pub fn evaluate_command(
    command: &CommandPayload,
    command_hash: &str,
    context: &CommandContext,
    now: &str,
) -> CommandDecision {
    use CommandRejection::*;
    if command.organization_id != context.organization_id {
        return CommandDecision::Reject(WrongOrganization);
    }
    if command.player_id != context.player_id {
        return CommandDecision::Reject(WrongPlayer);
    }
    if let Some(known) = context.seen.get(&command.command_id) {
        return if known == command_hash {
            CommandDecision::Duplicate
        } else {
            CommandDecision::Reject(CommandConflict)
        };
    }
    let now = parse_instant_micros(now).expect("instant courant valide");
    let expires = parse_instant_micros(&command.expires_at).expect("instant validé");
    if now >= expires {
        return CommandDecision::Reject(CommandExpired);
    }
    if let Some(display_id) = &command.display_id {
        match context.assignments.get(display_id) {
            None => return CommandDecision::Reject(WrongDisplay),
            Some(generation) if Some(generation) != command.assignment_generation.as_ref() => {
                return CommandDecision::Reject(StaleAssignment);
            }
            Some(_) => {}
        }
    }
    let unsupported = match command.kind.as_str() {
        "REBOOT_HOST" => context.reboot_host != Support::Supported,
        "TAKE_SCREENSHOT" => context.screenshot != Support::Supported,
        _ => false,
    };
    if unsupported {
        return CommandDecision::Reject(CapabilityUnsupported);
    }
    CommandDecision::Execute
}
