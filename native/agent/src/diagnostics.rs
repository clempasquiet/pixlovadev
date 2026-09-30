//! Rapport local `pixlova-agent diagnose` : JSON sans secret (ni graine, ni jeton, ni
//! secret de suivi, ni URL signée), lisible par le support sur la machine.

use crate::config::AgentConfig;
use crate::identity::DeviceIdentity;
use crate::platform::{detect_outputs, disk_space};
use crate::store::Store;
use serde_json::{Value, json};

pub fn report(config: &AgentConfig) -> Value {
    let store = Store::open(&config.db_path());
    let identity = std::fs::metadata(config.identity_dir().join("device.key"))
        .ok()
        .and_then(|_| DeviceIdentity::load_or_create(&config.identity_dir()).ok());
    let status: Value = std::fs::read_to_string(config.data_dir.join("state").join("status.json"))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let health: Value = std::fs::read_to_string(config.health_marker())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let launcher: Value =
        std::fs::read_to_string(config.data_dir.join("state").join("launcher.json"))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null);
    let database = match &store {
        Ok(store) => {
            let association = store.association().ok();
            let blobs = store.blobs_by_age().unwrap_or_default();
            let displays: Vec<Value> = store
                .displays()
                .unwrap_or_default()
                .into_iter()
                .map(|d| {
                    let version = |id: &Option<String>| {
                        id.as_deref()
                            .and_then(|id| store.manifest(id).ok().flatten())
                            .map(|m| m.version)
                    };
                    json!({
                        "display_id": d.display_id,
                        "name": d.name,
                        "output_key": d.output_key,
                        "assigned": d.assigned,
                        "assignment_generation": d.assignment_generation,
                        "current": { "manifest_id": d.current_manifest, "version": version(&d.current_manifest) },
                        "previous": { "manifest_id": d.previous_manifest, "version": version(&d.previous_manifest) },
                        "staging": { "manifest_id": d.staging_manifest, "version": version(&d.staging_manifest) },
                        "highest_version": d.highest_version,
                        "last_error": d.last_error,
                    })
                })
                .collect();
            json!({
                "schema_version": store.schema_version().ok(),
                "association": association.map(|a| json!({
                    "paired": a.paired().is_some(),
                    "organization_id": a.organization_id,
                    "player_id": a.player_id,
                    "revoked_at": a.revoked_at,
                    "pairing_pending": a.poll_secret.as_deref().is_some_and(|s| !s.is_empty()),
                })),
                "displays": displays,
                "open_intents": store.intents().map(|i| i.len()).ok(),
                "pending_deliveries": store.outbox(1000).map(|o| o.len()).ok(),
                "blobs": { "count": blobs.len(), "bytes": blobs.iter().map(|(_, s)| s).sum::<u64>() },
                "clock_offset": store.clock_offset().ok().flatten().map(|(ms, at)| json!({ "offset_ms": ms, "observed_at": at })),
                "updates": store.updates().unwrap_or_default().into_iter().map(|(id, version, state, detail)| json!({
                    "release_id": id, "version": version, "state": state, "detail": detail,
                })).collect::<Vec<_>>(),
            })
        }
        Err(error) => json!({ "error": error.to_string() }),
    };
    json!({
        "agent_version": crate::AGENT_VERSION,
        "generated_at": crate::clock::format_instant(crate::clock::Clock::now_millis(&crate::clock::SystemClock)),
        "clock_plausible": crate::clock::clock_is_plausible(crate::clock::Clock::now_millis(&crate::clock::SystemClock)),
        "platform": { "os": crate::platform::os_family(), "arch": crate::platform::architecture() },
        "paths": {
            "data_dir": config.data_dir,
            "trust_dir": config.trust_dir,
            "socket": config.socket_path(),
        },
        "api_url": config.api_url,
        "disk": disk_space(&config.data_dir),
        "reserve_bytes": config.reserve_bytes,
        "identity": identity.map(|i| json!({ "public_key": i.public_key_b64u() })),
        "outputs": detect_outputs(config.virtual_outputs.as_deref()),
        "database": database,
        "runtime": status,
        "health_marker": health,
        "launcher": launcher,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::CliOverrides;

    #[test]
    fn ne_revele_aucun_secret() {
        let dir = tempfile::tempdir().unwrap();
        let config = AgentConfig::load(Some(dir.path().into()), &CliOverrides::default()).unwrap();
        let identity = DeviceIdentity::load_or_create(&config.identity_dir()).unwrap();
        let store = Store::open(&config.db_path()).unwrap();
        let secret = "s".repeat(43);
        store
            .save_registration("r", &secret, "ABCD-EFGH", "2099-01-01T00:00:00Z")
            .unwrap();
        let text = report(&config).to_string();
        assert!(!text.contains(&secret));
        let seed: String = identity
            .signing_key()
            .to_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert!(!text.contains(&seed));
        assert!(text.contains(&identity.public_key_b64u()));
        assert!(text.contains("\"pairing_pending\":true"));
    }
}
