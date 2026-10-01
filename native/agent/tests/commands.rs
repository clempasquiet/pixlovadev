//! Commandes distantes, capture et événements de l’agent complet contre l’API simulée
//! (SUP-004, SUP-005, PROTO-007, PROTO-008, PROTO-019, ADR-014).

mod support;

use pixlova_agent::config::{AgentConfig, CliOverrides};
use pixlova_agent::runtime::Runtime;
use pixlova_agent::store::{CommandRow, Store};
use serde_json::json;
use std::time::Duration;
use support::*;

async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    for _ in 0..300 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("délai dépassé : {what}");
}

fn id(n: u32) -> String {
    format!("77777777-7777-4777-8777-{n:012}")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn commandes_verifiees_dedupliquees_et_reprises() {
    let dir = tempfile::tempdir().unwrap();
    let api = MockApi::start().await;
    let trust_dir = dir.path().join("trust");
    std::fs::create_dir_all(&trust_dir).unwrap();
    let key = |kid: &str, key: &ed25519_dalek::SigningKey| {
        json!({ "keys": [{ "kid": kid, "public_key": pixlova_contracts::player_auth::public_key_b64u(key) }] })
            .to_string()
    };
    std::fs::write(
        trust_dir.join("manifest-keys.json"),
        key(MANIFEST_KID, &manifest_key()),
    )
    .unwrap();
    std::fs::write(
        trust_dir.join("command-keys.json"),
        key(COMMAND_KID, &command_key()),
    )
    .unwrap();
    let config = AgentConfig::load(
        Some(dir.path().join("data")),
        &CliOverrides {
            api_url: Some(api.url.clone()),
            trust_dir: Some(trust_dir),
            sync_interval_seconds: Some(1),
            virtual_outputs: vec!["SIM-1:1920x1080".into()],
            ..Default::default()
        },
    )
    .unwrap();

    // Commande lancée avant un arrêt brutal, sans résultat enregistré : effet inconnu.
    {
        let store = Store::open(&config.db_path()).unwrap();
        store
            .record_command(
                &CommandRow {
                    command_id: id(90),
                    command_hash: "h".into(),
                    kind: "RESTART_RENDERER".into(),
                    state: "received".into(),
                    ack_sent: false,
                    result: None,
                    result_sent: false,
                    expires_at: "2099-01-01T00:00:00Z".into(),
                },
                "2026-01-01T00:00:00Z",
            )
            .unwrap();
        store.mark_command_ack(&id(90)).unwrap();
        store
            .set_command_running(&id(90), "2026-01-01T00:00:00Z")
            .unwrap();
    }

    let socket = config.socket_path();
    let blobs = config.cache_dir().join("blobs");
    let (agent, server) = Runtime::new(config).unwrap();
    let shutdown = agent.shutdown_handle();
    let task = tokio::spawn(agent.run(server));
    let renderer = Behavior::default();
    fake_renderer(socket, blobs, renderer.clone()).await;
    api.assign(DISPLAY, "2");

    eventually("résultat inconnu après redémarrage", || {
        api.result(&id(90))
            .is_some_and(|r| r["status"] == "unknown" && r["code"] == "INTERRUPTED")
    })
    .await;
    eventually("heartbeat", || !api.state().heartbeats.is_empty()).await;

    // 1. Statut à la demande : ACK (reçue) puis résultat, jamais confondus.
    api.queue_command(&command_payload(&id(1), "GET_STATUS", None, json!({})));
    eventually("résultat GET_STATUS", || api.result(&id(1)).is_some()).await;
    assert_eq!(api.result(&id(1)).unwrap()["status"], "success");
    assert!(api.state().acks.contains(&id(1)));
    let status = api.state().status_reports.last().cloned().unwrap();
    assert_eq!(status["renderer"], "ok");
    assert!(status["metrics"]["disk_total_bytes"].as_u64().unwrap() > 0);
    assert!(
        status["metrics"]["cpu_percent"].is_null(),
        "non mesuré : null"
    );

    // 2. Capture du Display par le renderer, envoyée puis confirmée.
    let screenshot = "88888888-8888-4888-8888-000000000001";
    api.queue_command(&command_payload(
        &id(2),
        "TAKE_SCREENSHOT",
        Some((DISPLAY, "2")),
        json!({ "screenshot_id": screenshot }),
    ));
    eventually("capture confirmée", || {
        api.result(&id(2)).is_some_and(|r| r["status"] == "success")
    })
    .await;
    assert_eq!(api.state().completed_screenshots, [screenshot]);
    let expected = TestAsset::png(1).bytes;
    assert_eq!(api.state().uploads[screenshot], expected);

    // 3. Refus avant tout effet : génération périmée, expirée, signature invalide.
    api.queue_command(&command_payload(
        &id(3),
        "RELOAD_CONTENT",
        Some((DISPLAY, "1")),
        json!({}),
    ));
    let mut expired = command_payload(&id(4), "FORCE_SYNC", None, json!({}));
    expired["issued_at"] = json!("2026-01-01T00:00:00Z");
    expired["expires_at"] = json!("2026-01-01T00:10:00Z");
    api.queue_command(&expired);
    let forged = sign_command(&command_payload(&id(5), "FORCE_SYNC", None, json!({})))
        .replace("FORCE_SYNC", "CLEAR_UNUSED_CACHE");
    api.queue_raw_command(&id(5), forged);
    api.queue_command(&command_payload(
        &id(6),
        "UPDATE_PLAYER",
        None,
        json!({ "release_id": id(60) }),
    ));
    eventually("refus déclarés", || {
        [3, 4, 5, 6].iter().all(|n| api.result(&id(*n)).is_some())
    })
    .await;
    let code = |n| {
        api.result(&id(n)).unwrap()["code"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert_eq!(code(3), "STALE_ASSIGNMENT");
    assert_eq!(code(4), "COMMAND_EXPIRED");
    assert_eq!(code(5), "SIGNATURE_INVALID");
    // Mise à jour hors du lanceur A/B : exécutée, mais impossible (ADR-019).
    assert_eq!(code(6), "LAUNCHER_ABSENT");
    assert_eq!(api.result(&id(6)).unwrap()["status"], "failed");
    for n in [3, 4, 5] {
        assert_eq!(api.result(&id(n)).unwrap()["status"], "rejected");
    }
    for n in [3, 4, 5] {
        assert!(
            !api.state().acks.contains(&id(n)),
            "aucun ACK pour un refus"
        );
    }

    // 4. Doublon redistribué : jamais ré-exécuté.
    let before = renderer
        .lock()
        .unwrap()
        .received
        .iter()
        .filter(|e| e.kind == pixlova_contracts::ipc::MessageType::Screenshot)
        .count();
    api.queue_command(&command_payload(
        &id(2),
        "TAKE_SCREENSHOT",
        Some((DISPLAY, "2")),
        json!({ "screenshot_id": screenshot }),
    ));
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let after = renderer
        .lock()
        .unwrap()
        .received
        .iter()
        .filter(|e| e.kind == pixlova_contracts::ipc::MessageType::Screenshot)
        .count();
    assert_eq!(before, after, "doublon non ré-exécuté");
    assert_eq!(
        api.state()
            .results
            .iter()
            .filter(|r| r["command_id"] == id(2).as_str())
            .count(),
        1
    );

    // 5. Événements transmis, accusés, sans perte.
    eventually("événements reçus", || {
        let s = api.state();
        ["AGENT_STARTED", "RENDERER_CONNECTED"]
            .iter()
            .all(|kind| s.events.iter().any(|e| e["type"] == *kind))
    })
    .await;
    {
        let s = api.state();
        let started = s
            .events
            .iter()
            .find(|e| e["type"] == "AGENT_STARTED")
            .unwrap();
        assert_eq!(started["severity"], "info");
        assert!(s.dropped_reported.iter().all(|d| *d == 0));
    }

    shutdown.notify_waiters();
    let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn evenements_conserves_pendant_une_coupure() {
    let dir = tempfile::tempdir().unwrap();
    let api = MockApi::start().await;
    let config = AgentConfig::load(
        Some(dir.path().join("data")),
        &CliOverrides {
            api_url: Some(api.url.clone()),
            trust_dir: Some(dir.path().join("trust")),
            sync_interval_seconds: Some(1),
            virtual_outputs: vec!["SIM-1:1920x1080".into()],
            ..Default::default()
        },
    )
    .unwrap();
    let db = config.db_path();
    let socket = config.socket_path();
    let blobs = config.cache_dir().join("blobs");
    api.state().reject_events = true;
    let (agent, server) = Runtime::new(config).unwrap();
    let shutdown = agent.shutdown_handle();
    let task = tokio::spawn(agent.run(server));
    fake_renderer(socket, blobs, Behavior::default()).await;
    eventually("heartbeat", || api.state().heartbeats.len() >= 2).await;
    // Non accusés : conservés localement.
    let queued = Store::open(&db).unwrap().event_count().unwrap();
    assert!(queued >= 2, "{queued} événements en file");
    assert!(api.state().events.is_empty());
    api.state().reject_events = false;
    eventually("événements rattrapés", || {
        api.state().events.len() as u64 >= queued
    })
    .await;
    eventually("file vidée", || {
        Store::open(&db).unwrap().event_count().unwrap() == 0
    })
    .await;
    shutdown.notify_waiters();
    let _ = tokio::time::timeout(Duration::from_secs(5), task).await;
}
