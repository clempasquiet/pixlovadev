//! Supervision locale (ADR-014) : journal d’événements borné, rattrapé après coupure, et
//! statut complet du Player. Une mesure indisponible est `null`, jamais zéro.

use crate::clock::{Clock, format_instant};
use crate::store::{NewEvent, Store};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// Événements conservés localement au plus [à valider] ; au-delà, les mesures répétitives
/// puis les plus anciens sont éliminés et comptés.
pub const MAX_QUEUED_EVENTS: u64 = 10_000;
/// Lot maximal accepté par l’API.
pub const EVENT_BATCH: u32 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Info,
    Warning,
    Error,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Error => "error",
        }
    }
}

/// Journal d’événements de cette exécution : `boot_id` aléatoire, séquence croissante.
#[derive(Clone)]
pub struct EventLog {
    store: Store,
    clock: Arc<dyn Clock>,
    boot_id: String,
    seq: Arc<AtomicU64>,
}

impl EventLog {
    pub fn new(store: Store, clock: Arc<dyn Clock>) -> Self {
        Self {
            store,
            clock,
            boot_id: uuid::Uuid::new_v4().to_string(),
            seq: Arc::default(),
        }
    }

    pub fn boot_id(&self) -> &str {
        &self.boot_id
    }

    /// Inscrit un événement ; une erreur de base locale est journalisée, jamais bloquante.
    pub fn record(
        &self,
        kind: &str,
        severity: Severity,
        display: Option<(&str, &str)>,
        payload: Value,
    ) {
        let event = NewEvent {
            event_id: uuid::Uuid::new_v4().to_string(),
            boot_id: self.boot_id.clone(),
            seq: self.seq.fetch_add(1, Ordering::Relaxed),
            observed_at: format_instant(self.clock.now_millis()),
            kind: kind.to_owned(),
            severity: severity.as_str(),
            display_id: display.map(|(id, _)| id.to_owned()),
            assignment_generation: display.map(|(_, generation)| generation.to_owned()),
            payload: bounded(payload),
            droppable: false,
        };
        if let Err(error) = self.store.push_event(&event, MAX_QUEUED_EVENTS) {
            tracing::warn!(%error, kind, "événement non enregistré");
        }
    }
}

/// Payload borné comme le contrat `PlayerEvent` : 32 clés, textes de 500 caractères,
/// valeurs scalaires seulement.
fn bounded(payload: Value) -> Value {
    let Value::Object(map) = payload else {
        return json!({});
    };
    let entries = map
        .into_iter()
        .filter(|(key, _)| {
            key.len() <= 64
                && key.starts_with(|c: char| c.is_ascii_lowercase())
                && key
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        })
        .filter_map(|(key, value)| match value {
            Value::String(text) => Some((key, Value::String(text.chars().take(500).collect()))),
            Value::Number(_) | Value::Bool(_) | Value::Null => Some((key, value)),
            _ => None,
        })
        .take(32);
    Value::Object(entries.collect())
}

/// Mémoire utilisée et totale (`/proc/meminfo`) ; `None` hors Linux ou illisible.
pub fn memory() -> Option<(u64, u64)> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    let field = |name: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(name))
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|kb| kb.parse::<u64>().ok())
            .map(|kb| kb * 1024)
    };
    let total = field("MemTotal:")?;
    let available = field("MemAvailable:")?;
    Some((total.saturating_sub(available), total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn borne_le_payload_au_contrat() {
        let long = "x".repeat(600);
        let payload = bounded(json!({
            "reason": long, "Bad": 1, "nested": { "a": 1 }, "ok": true, "n": 3,
        }));
        assert_eq!(payload["reason"].as_str().unwrap().len(), 500);
        assert!(payload.get("Bad").is_none() && payload.get("nested").is_none());
        assert_eq!(payload["ok"], true);
        assert_eq!(bounded(json!([1])), json!({}));
    }

    #[test]
    fn sequence_croissante_par_demarrage() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        let log = EventLog::new(store.clone(), Arc::new(crate::clock::SystemClock));
        log.record("AGENT_STARTED", Severity::Info, None, json!({}));
        log.record(
            "PLAYBACK_ERROR",
            Severity::Error,
            Some(("d1", "2")),
            json!({ "reason": "x" }),
        );
        let events = store.pending_events(10).unwrap();
        assert_eq!(events[0]["seq"], 0);
        assert_eq!(events[1]["seq"], 1);
        assert_eq!(events[1]["boot_id"], log.boot_id());
        assert_eq!(events[1]["display_id"], "d1");
        assert_eq!(events[1]["assignment_generation"], "2");
    }
}
