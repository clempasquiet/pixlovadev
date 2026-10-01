//! Mises à jour distribuées par le cloud (PLY-005, NAT-013, ADR-019) : l’agent complet,
//! lancé comme par le lanceur A/B, récupère la release souhaitée, vérifie signature et
//! paquet, l’installe en attente, déclare son état puis s’arrête pour être relancé ; une
//! release bloquée déclenche une demande de retour arrière exécutée par le lanceur.

mod support;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use pixlova_agent::config::{AgentConfig, CliOverrides};
use pixlova_agent::runtime::Runtime;
use pixlova_agent::updater::{LauncherState, versions_dir};
use pixlova_contracts::canonical::canonical_bytes;
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;
use support::*;

const RELEASE_KID: &str = "test-release-a";

fn release_key() -> SigningKey {
    SigningKey::from_bytes(&[42; 32])
}

fn sign_release(payload: &Value) -> String {
    let protected = json!({ "type": "SIGNAGE_RELEASE_V1", "alg": "Ed25519", "kid": RELEASE_KID });
    let input = canonical_bytes(&json!({ "protected": protected, "payload": payload }));
    let signature = URL_SAFE_NO_PAD.encode(release_key().sign(&input).to_bytes());
    json!({ "protected": protected, "payload": payload, "signature": signature }).to_string()
}

fn package(version: &str) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for (path, body, mode) in [
        (
            "pixlova-agent",
            format!("#!/bin/sh\necho {version}\n"),
            0o755,
        ),
        ("pixlova-renderer", "#!/bin/sh\n".to_owned(), 0o755),
        (
            "player-shell/index.html",
            "<!doctype html>".to_owned(),
            0o644,
        ),
    ] {
        let mut header = tar::Header::new_gnu();
        header.set_mode(mode);
        header.set_size(body.len() as u64);
        header.set_cksum();
        builder
            .append_data(&mut header, path, body.as_bytes())
            .unwrap();
    }
    builder.into_inner().unwrap()
}

/// Agent configuré avec les trois jeux de clés distincts, comme sous le lanceur.
fn configure(dir: &Path, api: &MockApi) -> AgentConfig {
    let trust_dir = dir.join("trust");
    std::fs::create_dir_all(&trust_dir).unwrap();
    let key = |kid: &str, key: &SigningKey| {
        json!({ "keys": [{ "kid": kid, "public_key": pixlova_contracts::player_auth::public_key_b64u(key) }] })
            .to_string()
    };
    for (file, kid, signing) in [
        ("manifest-keys.json", MANIFEST_KID, manifest_key()),
        ("command-keys.json", COMMAND_KID, command_key()),
        ("release-keys.json", RELEASE_KID, release_key()),
    ] {
        std::fs::write(trust_dir.join(file), key(kid, &signing)).unwrap();
    }
    AgentConfig::load(
        Some(dir.join("data")),
        &CliOverrides {
            api_url: Some(api.url.clone()),
            trust_dir: Some(trust_dir),
            sync_interval_seconds: Some(1),
            virtual_outputs: vec!["SIM-1:1920x1080".into()],
            ..Default::default()
        },
    )
    .unwrap()
}

async fn run_until_restart(config: AgentConfig) {
    let socket = config.socket_path();
    let blobs = config.cache_dir().join("blobs");
    let (agent, server) = Runtime::new(config).unwrap();
    let task = tokio::spawn(agent.run(server));
    fake_renderer(socket, blobs, Behavior::default()).await;
    // L’agent s’arrête de lui-même : le lanceur (systemd) le relance.
    tokio::time::timeout(Duration::from_secs(20), task)
        .await
        .expect("arrêt pour redémarrage")
        .unwrap()
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn installe_la_release_souhaitee_puis_revient_en_arriere_si_elle_est_bloquee() {
    let dir = tempfile::tempdir().unwrap();
    let api = MockApi::start().await;
    let mut config = configure(dir.path(), &api);
    // Agent lancé par le lanceur A/B (variable `PIXLOVA_VERSION_DIR` du lanceur).
    config.under_launcher = true;
    let data = config.data_dir.clone();

    // 1. Release annoncée avec un paquet altéré : refusée, échec déclaré, rien installé.
    let bytes = package("0.2.0");
    let payload = json!({
        "schema_version": 1, "release_id": "12345678-1234-4234-8234-000000000020",
        "version": "0.2.0", "os": pixlova_agent::platform::os_family(),
        "arch": pixlova_agent::platform::architecture(),
        "package": { "sha256": sha256_hex(&bytes), "size_bytes": bytes.len() },
        "protocol_min": 1, "protocol_max": 1, "sqlite_schema": 3, "sqlite_reader_level": 1,
        "renderer_build": "0.2.0", "published_at": "2026-10-01T00:00:00Z",
    });
    let mut corrupted = bytes.clone();
    let last = corrupted.len() - 1;
    corrupted[last] ^= 0xff;
    let desired = |sha: String| {
        json!({
            "release": sign_release(&payload),
            "package": { "url": "/storage/paquet", "expires_at": "2099-01-01T00:00:00Z",
                          "size_bytes": bytes.len(), "sha256": sha },
            "rollback": false,
        })
    };
    {
        let mut s = api.state();
        s.blobs.insert("paquet".into(), corrupted);
        s.desired_release = Some(desired(sha256_hex(&bytes)));
    }
    let socket = config.socket_path();
    let blobs = config.cache_dir().join("blobs");
    let (agent, server) = Runtime::new(config.clone()).unwrap();
    let shutdown = agent.shutdown_handle();
    let task = tokio::spawn(agent.run(server));
    fake_renderer(socket, blobs, Behavior::default()).await;
    for _ in 0..200 {
        if !api.state().update_reports.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let (release_id, report) = api
        .state()
        .update_reports
        .first()
        .cloned()
        .expect("échec déclaré");
    assert_eq!(release_id, "12345678-1234-4234-8234-000000000020");
    assert_eq!(report["state"], "failed");
    assert_eq!(report["code"], "PACKAGE_MISMATCH");
    assert!(!versions_dir(&data).join("0.2.0").exists());
    assert_eq!(
        api.state().desired_requests[0].as_deref(),
        Some(pixlova_agent::AGENT_VERSION)
    );
    shutdown.notify_waiters();
    let _ = tokio::time::timeout(Duration::from_secs(5), task).await;

    // 2. Paquet conforme : installé en attente, déclaré, puis arrêt pour être essayé.
    {
        let mut s = api.state();
        s.blobs.insert("paquet".into(), bytes.clone());
        s.update_reports.clear();
    }
    run_until_restart(config.clone()).await;
    let state = LauncherState::load(&data).unwrap();
    assert_eq!(state.pending.as_deref(), Some("0.2.0"));
    assert!(versions_dir(&data).join("0.2.0/pixlova-agent").is_file());
    let reports = api.state().update_reports.clone();
    assert_eq!(reports.last().unwrap().1["state"], "installed");
    assert!(
        !config
            .downloads_dir()
            .join("12345678-1234-4234-8234-000000000020.tar")
            .exists(),
        "paquet téléchargé supprimé après installation"
    );

    // 3. Version promue par le lanceur, puis bloquée par la plateforme : retour arrière
    //    inscrit pour le lanceur, qui l’exécute au redémarrage.
    let mut promoted = LauncherState::load(&data).unwrap();
    promoted.previous = promoted.current.replace("0.2.0".into());
    promoted.pending = None;
    promoted.save(&data).unwrap();
    std::fs::create_dir_all(versions_dir(&data).join(pixlova_agent::AGENT_VERSION)).unwrap();
    std::fs::write(
        versions_dir(&data)
            .join(pixlova_agent::AGENT_VERSION)
            .join("pixlova-agent"),
        "#!/bin/sh\n",
    )
    .unwrap();
    api.state().desired_release =
        Some(json!({ "release": null, "package": null, "rollback": true }));
    run_until_restart(config.clone()).await;
    let state = LauncherState::load(&data).unwrap();
    assert_eq!(
        state.rollback_requested.as_deref(),
        Some("release bloquée par la plateforme")
    );
    assert_eq!(state.current.as_deref(), Some("0.2.0"));
}
