//! Vérification et acceptation des manifests (PROTO-009 à PROTO-014, NAT-008 étape 1).

use crate::instant::parse_instant_micros;
use crate::schema::RootSchema;
use crate::signature::{
    DEFAULT_MAX_ENVELOPE_BYTES, EnvelopeErrorCode, TrustStore, verify_envelope,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub const MANIFEST_SCHEMA_VERSION: u64 = 1;
pub const MANIFEST_ENVELOPE_TYPE: &str = "SIGNAGE_MANIFEST_V1";

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestPayload {
    pub manifest_id: String,
    pub organization_id: String,
    pub display_id: String,
    pub player_id: String,
    pub version: String,
    pub assignment_generation: String,
    pub generated_at: String,
    pub valid_from: String,
    pub activate_before: String,
    pub schedule_until: String,
    pub assets: Vec<Asset>,
    pub contents: Vec<Content>,
    pub timeline: Vec<TimelineEntry>,
    pub fallback: Fallback,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Asset {
    pub id: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind {
    Image,
    Video,
}

impl MediaKind {
    fn family(self) -> &'static str {
        match self {
            MediaKind::Image => "image",
            MediaKind::Video => "video",
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Content {
    Media {
        id: String,
        media_kind: MediaKind,
        asset_id: String,
    },
    Composition {
        id: String,
        document: CompositionDocument,
    },
    Playlist {
        id: String,
        items: Vec<PlaylistItem>,
    },
}

impl Content {
    pub fn id(&self) -> &str {
        match self {
            Content::Media { id, .. }
            | Content::Composition { id, .. }
            | Content::Playlist { id, .. } => id,
        }
    }

    fn kind(&self) -> ContentKind {
        match self {
            Content::Media { .. } => ContentKind::Media,
            Content::Composition { .. } => ContentKind::Composition,
            Content::Playlist { .. } => ContentKind::Playlist,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContentKind {
    Media,
    Composition,
    Playlist,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlaylistItem {
    pub content_ref: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CompositionDocument {
    pub elements: Vec<Element>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Element {
    pub id: String,
    #[serde(flatten)]
    pub kind: ElementKind,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", content = "props", rename_all = "snake_case")]
pub enum ElementKind {
    Image {
        asset_id: String,
    },
    Video {
        asset_id: String,
        start_ms: Option<u64>,
        end_ms: Option<u64>,
    },
    Text {},
    Shape {},
    Qr {},
    Clock {},
    MediaZone {
        content_ref: String,
    },
    PlaylistZone {
        content_ref: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct TimelineEntry {
    pub starts_at: String,
    pub ends_at: String,
    pub content_ref: String,
    pub source: Source,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Source {
    #[serde(rename = "type")]
    pub kind: SourceType,
    pub id: String,
    pub priority: u8,
    pub revision: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceType {
    Schedule,
    Campaign,
    Override,
    Emergency,
}

impl SourceType {
    /// Bandes de priorité partagées (PLN-008).
    pub fn band(self) -> (u8, u8) {
        match self {
            SourceType::Schedule => (0, 19),
            SourceType::Campaign => (20, 79),
            SourceType::Override => (80, 99),
            SourceType::Emergency => (100, 100),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Fallback {
    pub content_ref: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SemanticReason {
    WindowInvalid,
    DuplicateAssetId,
    DuplicateContentId,
    DuplicateElementId,
    UnknownAsset,
    AssetKindMismatch,
    UnknownContent,
    InvalidReference,
    VideoRangeInvalid,
    ContentCycle,
    TimelineIntervalInvalid,
    TimelineOverlap,
    PriorityOutOfBand,
}

impl SemanticReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WindowInvalid => "WINDOW_INVALID",
            Self::DuplicateAssetId => "DUPLICATE_ASSET_ID",
            Self::DuplicateContentId => "DUPLICATE_CONTENT_ID",
            Self::DuplicateElementId => "DUPLICATE_ELEMENT_ID",
            Self::UnknownAsset => "UNKNOWN_ASSET",
            Self::AssetKindMismatch => "ASSET_KIND_MISMATCH",
            Self::UnknownContent => "UNKNOWN_CONTENT",
            Self::InvalidReference => "INVALID_REFERENCE",
            Self::VideoRangeInvalid => "VIDEO_RANGE_INVALID",
            Self::ContentCycle => "CONTENT_CYCLE",
            Self::TimelineIntervalInvalid => "TIMELINE_INTERVAL_INVALID",
            Self::TimelineOverlap => "TIMELINE_OVERLAP",
            Self::PriorityOutOfBand => "PRIORITY_OUT_OF_BAND",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestVerificationError {
    Envelope(EnvelopeErrorCode, String),
    UnsupportedSchema,
    SchemaInvalid(String),
    SemanticInvalid(SemanticReason, String),
}

impl ManifestVerificationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Envelope(code, _) => code.as_str(),
            Self::UnsupportedSchema => "UNSUPPORTED_SCHEMA",
            Self::SchemaInvalid(_) => "SCHEMA_INVALID",
            Self::SemanticInvalid(..) => "SEMANTIC_INVALID",
        }
    }

    pub fn reason(&self) -> Option<&'static str> {
        match self {
            Self::SemanticInvalid(reason, _) => Some(reason.as_str()),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct VerifiedManifest {
    pub manifest: ManifestPayload,
    /// Payload complet validé, conservé pour la préparation et le rendu.
    pub document: Value,
    pub manifest_hash: String,
    pub kid: String,
}

pub type ManifestVerification = Result<VerifiedManifest, ManifestVerificationError>;

type SemanticResult = Result<(), (SemanticReason, String)>;

fn micros(value: &str) -> Result<i64, (SemanticReason, String)> {
    parse_instant_micros(value).ok_or_else(|| {
        (
            SemanticReason::WindowInvalid,
            format!("instant invalide {value}"),
        )
    })
}

fn mime_family(mime: &str) -> &str {
    mime.split('/').next().unwrap_or_default()
}

/// Contrôles de cohérence, dans le même ordre que l’implémentation TypeScript.
pub fn check_manifest_semantics(manifest: &ManifestPayload) -> SemanticResult {
    use SemanticReason::*;
    let generated = micros(&manifest.generated_at)?;
    let valid_from = micros(&manifest.valid_from)?;
    let activate_before = micros(&manifest.activate_before)?;
    let until = micros(&manifest.schedule_until)?;
    if !(valid_from < until && valid_from <= activate_before && activate_before <= until) {
        return Err((
            WindowInvalid,
            "fenêtre valid_from/activate_before/schedule_until".into(),
        ));
    }
    if generated > activate_before {
        return Err((
            WindowInvalid,
            "generated_at postérieur à activate_before".into(),
        ));
    }

    let mut assets: HashMap<&str, &str> = HashMap::new();
    for asset in &manifest.assets {
        if assets
            .insert(&asset.id, mime_family(&asset.mime_type))
            .is_some()
        {
            return Err((DuplicateAssetId, asset.id.clone()));
        }
    }
    let mut contents: HashMap<&str, &Content> = HashMap::new();
    for content in &manifest.contents {
        if contents.insert(content.id(), content).is_some() {
            return Err((DuplicateContentId, content.id().to_owned()));
        }
    }

    let require_asset = |id: &str, family: &str| -> SemanticResult {
        match assets.get(id) {
            None => Err((UnknownAsset, id.to_owned())),
            Some(actual) if *actual != family => Err((AssetKindMismatch, id.to_owned())),
            Some(_) => Ok(()),
        }
    };
    let require_content = |reference: &str, allowed: &[ContentKind]| -> SemanticResult {
        match contents.get(reference) {
            None => Err((UnknownContent, reference.to_owned())),
            Some(target) if !allowed.contains(&target.kind()) => {
                Err((InvalidReference, reference.to_owned()))
            }
            Some(_) => Ok(()),
        }
    };

    let mut edges: HashMap<&str, Vec<&str>> = HashMap::new();
    for content in &manifest.contents {
        let mut children = Vec::new();
        match content {
            Content::Media {
                media_kind,
                asset_id,
                ..
            } => require_asset(asset_id, media_kind.family())?,
            Content::Playlist { items, .. } => {
                for item in items {
                    require_content(
                        &item.content_ref,
                        &[ContentKind::Media, ContentKind::Composition],
                    )?;
                    children.push(item.content_ref.as_str());
                }
            }
            Content::Composition { document, .. } => {
                let mut ids = HashSet::new();
                for element in &document.elements {
                    if !ids.insert(element.id.as_str()) {
                        return Err((DuplicateElementId, element.id.clone()));
                    }
                    match &element.kind {
                        ElementKind::Image { asset_id } => require_asset(asset_id, "image")?,
                        ElementKind::Video {
                            asset_id,
                            start_ms,
                            end_ms,
                        } => {
                            require_asset(asset_id, "video")?;
                            if let Some(end) = end_ms
                                && *end <= start_ms.unwrap_or(0)
                            {
                                return Err((VideoRangeInvalid, element.id.clone()));
                            }
                        }
                        ElementKind::MediaZone { content_ref } => {
                            require_content(content_ref, &[ContentKind::Media])?;
                            children.push(content_ref.as_str());
                        }
                        ElementKind::PlaylistZone { content_ref } => {
                            require_content(content_ref, &[ContentKind::Playlist])?;
                            children.push(content_ref.as_str());
                        }
                        _ => {}
                    }
                }
            }
        }
        edges.insert(content.id(), children);
    }

    // Détection de cycle (CMP-005, PROTO-016) : parcours en profondeur itératif.
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Mark {
        Visiting,
        Done,
    }
    let mut marks: HashMap<&str, Mark> = HashMap::new();
    for root in &manifest.contents {
        if marks.get(root.id()) == Some(&Mark::Done) {
            continue;
        }
        let mut stack: Vec<(&str, usize)> = vec![(root.id(), 0)];
        marks.insert(root.id(), Mark::Visiting);
        while let Some(frame) = stack.last_mut() {
            let children = edges.get(frame.0).map(Vec::as_slice).unwrap_or_default();
            if frame.1 < children.len() {
                let child = children[frame.1];
                frame.1 += 1;
                match marks.get(child) {
                    Some(Mark::Visiting) => return Err((ContentCycle, child.to_owned())),
                    Some(Mark::Done) => {}
                    None => {
                        marks.insert(child, Mark::Visiting);
                        stack.push((child, 0));
                    }
                }
            } else {
                marks.insert(frame.0, Mark::Done);
                stack.pop();
            }
        }
    }

    let mut previous_end = valid_from;
    for (index, entry) in manifest.timeline.iter().enumerate() {
        let start = micros(&entry.starts_at)?;
        let end = micros(&entry.ends_at)?;
        if start >= end || start < valid_from || end > until {
            return Err((TimelineIntervalInvalid, format!("timeline[{index}]")));
        }
        if start < previous_end {
            return Err((TimelineOverlap, format!("timeline[{index}]")));
        }
        previous_end = end;
        if !contents.contains_key(entry.content_ref.as_str()) {
            return Err((UnknownContent, entry.content_ref.clone()));
        }
        let (min, max) = entry.source.kind.band();
        if entry.source.priority < min || entry.source.priority > max {
            return Err((PriorityOutOfBand, format!("timeline[{index}]")));
        }
    }

    if let Some(reference) = &manifest.fallback.content_ref
        && !contents.contains_key(reference.as_str())
    {
        return Err((UnknownContent, reference.clone()));
    }
    Ok(())
}

/// Vérification complète : enveloppe, version de schéma, schéma JSON puis cohérence.
pub fn verify_manifest(raw: &str, trust: &TrustStore) -> ManifestVerification {
    let envelope = verify_envelope(
        raw,
        MANIFEST_ENVELOPE_TYPE,
        trust,
        DEFAULT_MAX_ENVELOPE_BYTES,
    )
    .map_err(|error| ManifestVerificationError::Envelope(error.code, error.detail))?;
    if envelope
        .payload
        .get("schema_version")
        .and_then(Value::as_u64)
        != Some(MANIFEST_SCHEMA_VERSION)
    {
        return Err(ManifestVerificationError::UnsupportedSchema);
    }
    let document = Value::Object(envelope.payload);
    RootSchema::ManifestPayload
        .validate(&document)
        .map_err(ManifestVerificationError::SchemaInvalid)?;
    let manifest: ManifestPayload = serde_json::from_value(document.clone())
        .map_err(|error| ManifestVerificationError::SchemaInvalid(error.to_string()))?;
    check_manifest_semantics(&manifest)
        .map_err(|(reason, detail)| ManifestVerificationError::SemanticInvalid(reason, detail))?;
    Ok(VerifiedManifest {
        manifest,
        document,
        manifest_hash: envelope.payload_hash,
        kid: envelope.kid,
    })
}

/// État local d’un Display affecté (NAT-007).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalDisplayState {
    pub assignment_generation: String,
    pub highest_version: Option<String>,
    pub highest_version_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalAssociation {
    pub organization_id: String,
    pub player_id: String,
    pub displays: HashMap<String, LocalDisplayState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestRejection {
    WrongOrganization,
    WrongPlayer,
    WrongDisplay,
    StaleAssignment,
    AssignmentAhead,
    VersionReplayed,
    VersionConflict,
    ActivationWindowExpired,
}

impl ManifestRejection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::WrongOrganization => "WRONG_ORGANIZATION",
            Self::WrongPlayer => "WRONG_PLAYER",
            Self::WrongDisplay => "WRONG_DISPLAY",
            Self::StaleAssignment => "STALE_ASSIGNMENT",
            Self::AssignmentAhead => "ASSIGNMENT_AHEAD",
            Self::VersionReplayed => "VERSION_REPLAYED",
            Self::VersionConflict => "VERSION_CONFLICT",
            Self::ActivationWindowExpired => "ACTIVATION_WINDOW_EXPIRED",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestDecision {
    Accept { activate_not_before: String },
    Duplicate,
    Reject(ManifestRejection),
}

fn version(value: &str) -> u64 {
    // Le schéma garantit au plus 19 chiffres décimaux : la valeur tient dans un u64.
    value
        .parse()
        .expect("version décimale validée par le schéma")
}

/// Décide si un manifest vérifié peut être préparé (PROTO-013).
pub fn evaluate_manifest_candidate(
    manifest: &ManifestPayload,
    manifest_hash: &str,
    local: &LocalAssociation,
    now: &str,
) -> ManifestDecision {
    use ManifestRejection::*;
    if manifest.organization_id != local.organization_id {
        return ManifestDecision::Reject(WrongOrganization);
    }
    if manifest.player_id != local.player_id {
        return ManifestDecision::Reject(WrongPlayer);
    }
    let Some(display) = local.displays.get(&manifest.display_id) else {
        return ManifestDecision::Reject(WrongDisplay);
    };
    let generation = version(&manifest.assignment_generation);
    let local_generation = version(&display.assignment_generation);
    if generation < local_generation {
        return ManifestDecision::Reject(StaleAssignment);
    }
    if generation > local_generation {
        return ManifestDecision::Reject(AssignmentAhead);
    }
    if let Some(highest) = &display.highest_version {
        let (candidate, highest) = (version(&manifest.version), version(highest));
        if candidate < highest {
            return ManifestDecision::Reject(VersionReplayed);
        }
        if candidate == highest {
            return if display.highest_version_hash.as_deref() == Some(manifest_hash) {
                ManifestDecision::Duplicate
            } else {
                ManifestDecision::Reject(VersionConflict)
            };
        }
    }
    let now = parse_instant_micros(now).expect("instant courant valide");
    let activate_before =
        parse_instant_micros(&manifest.activate_before).expect("instant validé par le schéma");
    if now >= activate_before {
        return ManifestDecision::Reject(ActivationWindowExpired);
    }
    ManifestDecision::Accept {
        activate_not_before: manifest.valid_from.clone(),
    }
}
