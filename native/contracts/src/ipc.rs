//! Protocole local agent ↔ renderer (NAT-006, ADR-012).
//!
//! Messages JSON d’une ligne, 16 Mio au plus, sur un socket local réservé au compte du
//! Player. Le renderer ne reçoit que des manifests déjà vérifiés et la correspondance
//! `asset_id → sha256` ; jamais de jeton, de clé ni d’URL cloud.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const IPC_PROTOCOL_VERSION: u32 = 1;
/// Taille maximale d’une ligne, saut de ligne exclu.
pub const IPC_MAX_MESSAGE_BYTES: usize = 16 * 1024 * 1024;
/// Intervalle des `STATUS` spontanés du renderer.
pub const IPC_STATUS_INTERVAL_SECONDS: u64 = 5;

/// Types échangés. Tout autre type est refusé.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MessageType {
    // Agent → renderer
    Configure,
    Prepare,
    Activate,
    GetStatus,
    Reload,
    // Renderer → agent
    Hello,
    Ready,
    Status,
    Error,
    FramePresented,
}

impl MessageType {
    pub fn from_agent(self) -> bool {
        matches!(
            self,
            Self::Configure | Self::Prepare | Self::Activate | Self::GetStatus | Self::Reload
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub protocol_version: u32,
    pub message_id: String,
    #[serde(rename = "type")]
    pub kind: MessageType,
    pub correlation_id: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    TooLarge,
    Malformed(String),
    UnknownType(String),
    UnsupportedVersion(u32),
}

impl DecodeError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::TooLarge => "MESSAGE_TOO_LARGE",
            Self::Malformed(_) => "MALFORMED_MESSAGE",
            Self::UnknownType(_) => "UNKNOWN_TYPE",
            Self::UnsupportedVersion(_) => "UNSUPPORTED_PROTOCOL",
        }
    }
}

impl Envelope {
    pub fn new(
        kind: MessageType,
        message_id: String,
        correlation_id: Option<String>,
        payload: Value,
    ) -> Self {
        Self {
            protocol_version: IPC_PROTOCOL_VERSION,
            message_id,
            kind,
            correlation_id,
            payload,
        }
    }

    /// Ligne JSON, sans saut de ligne final.
    pub fn encode(&self) -> String {
        serde_json::to_string(self).expect("enveloppe sérialisable")
    }

    pub fn decode(line: &str) -> Result<Self, DecodeError> {
        if line.len() > IPC_MAX_MESSAGE_BYTES {
            return Err(DecodeError::TooLarge);
        }
        let value: Value =
            serde_json::from_str(line).map_err(|e| DecodeError::Malformed(e.to_string()))?;
        if let Some(kind) = value.get("type").and_then(Value::as_str)
            && serde_json::from_value::<MessageType>(Value::String(kind.to_owned())).is_err()
        {
            return Err(DecodeError::UnknownType(kind.chars().take(64).collect()));
        }
        let envelope: Self =
            serde_json::from_value(value).map_err(|e| DecodeError::Malformed(e.to_string()))?;
        if envelope.protocol_version != IPC_PROTOCOL_VERSION {
            return Err(DecodeError::UnsupportedVersion(envelope.protocol_version));
        }
        Ok(envelope)
    }
}

/// Display à ouvrir par le renderer (`CONFIGURE`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisplaySurface {
    pub display_id: String,
    pub output_key: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub orientation: u32,
    pub timezone: String,
}

/// Écran d’information affiché hors diffusion (appairage, révocation, attente).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Notice {
    Pairing {
        pairing_code: String,
        expires_at: String,
    },
    Revoked,
    Waiting,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConfigurePayload {
    pub displays: Vec<DisplaySurface>,
    /// Affiché sur toutes les sorties quand aucun Display n’est affecté.
    pub notice: Option<Notice>,
}

/// `PREPARE` : manifest vérifié et assets déjà présents dans `cache/blobs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreparePayload {
    pub display_id: String,
    pub manifest_id: String,
    /// Payload du manifest, tel que vérifié par l’agent.
    pub manifest: Value,
    /// `asset_id → sha256`.
    pub assets: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivatePayload {
    pub display_id: String,
    pub manifest_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HelloPayload {
    pub renderer_version: String,
    /// Moteur WebView et sa version, si connus.
    pub engine: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorPayload {
    pub code: String,
    pub detail: String,
}

/// Première image présentée pour un manifest (ou pour l’écran d’information si `None`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FramePresentedPayload {
    pub display_id: Option<String>,
    pub manifest_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Playback {
    Playing,
    Fallback,
    Standby,
    Error,
    Unknown,
}

impl Playback {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Playing => "playing",
            Self::Fallback => "fallback",
            Self::Standby => "standby",
            Self::Error => "error",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisplayStatus {
    pub display_id: String,
    pub manifest_id: Option<String>,
    pub playback: Playback,
    pub content_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusPayload {
    pub displays: Vec<DisplayStatus>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn aller_retour_et_refus() {
        let envelope = Envelope::new(
            MessageType::FramePresented,
            "m1".into(),
            None,
            json!({ "display_id": "d", "manifest_id": "x" }),
        );
        let line = envelope.encode();
        assert!(line.contains("\"FRAME_PRESENTED\""));
        assert_eq!(Envelope::decode(&line).unwrap(), envelope);
        assert_eq!(
            Envelope::decode(r#"{"protocol_version":1,"message_id":"a","type":"EXEC","correlation_id":null,"payload":{}}"#)
                .unwrap_err()
                .code(),
            "UNKNOWN_TYPE"
        );
        assert_eq!(
            Envelope::decode(r#"{"protocol_version":2,"message_id":"a","type":"HELLO","correlation_id":null,"payload":{}}"#)
                .unwrap_err()
                .code(),
            "UNSUPPORTED_PROTOCOL"
        );
        assert_eq!(
            Envelope::decode(r#"{"protocol_version":1,"message_id":"a","type":"HELLO","correlation_id":null,"payload":{},"token":"x"}"#)
                .unwrap_err()
                .code(),
            "MALFORMED_MESSAGE"
        );
        assert!(MessageType::Prepare.from_agent() && !MessageType::Ready.from_agent());
    }
}
