//! Agent complet en processus contre l’API simulée : appairage, heartbeat réel, manifest
//! appliqué, marqueur de santé, cloud coupé puis révocation (TST-052).

mod support;

use pixlova_agent::config::{AgentConfig, CliOverrides};
use pixlova_agent::runtime::Runtime;
use pixlova_contracts::ipc::MessageType;
use std::time::Duration;
use support::*;

async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("délai dépassé : {what}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn appairage_diffusion_hors_ligne_et_revocation() {
    let dir = tempfile::tempdir().unwrap();
    let api = MockApi::start().await;
    api.state().pending_polls = 1;
    // Clés de confiance installées « avec le paquet ».
    let trust_dir = dir.path().join("trust");
    std::fs::create_dir_all(&trust_dir).unwrap();
    std::fs::write(
        trust_dir.join("manifest-keys.json"),
        serde_json::json!({ "keys": [{ "kid": MANIFEST_KID, "public_key": pixlova_contracts::player_auth::public_key_b64u(&manifest_key()) }] }).to_string(),
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
    let socket = config.socket_path();
    let blobs = config.cache_dir().join("blobs");
    let marker = config.health_marker();
    let (agent, server) = Runtime::new(config).unwrap();
    let shutdown = agent.shutdown_handle();
    let task = tokio::spawn(agent.run(server));
    let renderer = Behavior::default();
    fake_renderer(socket.clone(), blobs.clone(), renderer.clone()).await;

    // 1. Enregistrement : le code est envoyé au renderer pour affichage.
    eventually("code d’appairage affiché", || {
        renderer.lock().unwrap().received.iter().any(|e| {
            e.kind == MessageType::Configure && e.payload["notice"]["pairing_code"] == "ABCD-EFGH"
        })
    })
    .await;
    assert_eq!(api.state().outputs.len(), 0);

    // 2. Appairage, affectation et premier manifest.
    let asset = TestAsset::new(20, 64_000);
    api.assign(DISPLAY, "2");
    let now = pixlova_agent::clock::Clock::now_millis(&pixlova_agent::clock::SystemClock);
    api.publish(
        &manifest_payload(
            "44444444-4444-4444-8444-000000000010",
            "1",
            "2",
            PLAYER,
            std::slice::from_ref(&asset),
            now,
        ),
        std::slice::from_ref(&asset),
    );
    eventually("manifest appliqué et déclaré", || {
        api.statuses().iter().any(|(s, _)| s == "applied")
    })
    .await;
    assert_eq!(
        api.statuses()
            .iter()
            .map(|(s, _)| s.as_str())
            .collect::<Vec<_>>(),
        ["downloading", "ready", "applied"]
    );
    assert_eq!(api.state().outputs[0]["outputs"][0]["output_key"], "SIM-1");
    eventually("heartbeat avec version appliquée", || {
        api.state()
            .heartbeats
            .iter()
            .any(|h| h["displays"][0]["manifest_applied_version"] == "1" && h["renderer"] == "ok")
    })
    .await;
    assert!(
        marker.exists(),
        "marqueur de santé posé après la première image"
    );
    assert!(renderer.lock().unwrap().received.iter().any(|e| {
        e.kind == MessageType::Configure && e.payload["displays"][0]["display_id"] == DISPLAY
    }));

    // 3. Cloud coupé : la diffusion continue, rien n’est retiré localement.
    api.state().faults.offline = true;
    let before = renderer.lock().unwrap().received.len();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    let received = renderer.lock().unwrap().received.clone();
    assert!(
        received[before..]
            .iter()
            .all(|e| e.kind != MessageType::Configure),
        "aucune reconfiguration hors ligne"
    );
    let report = pixlova_agent::diagnostics::report(
        &AgentConfig::load(
            Some(dir.path().join("data")),
            &CliOverrides {
                api_url: Some(api.url.clone()),
                ..Default::default()
            },
        )
        .unwrap(),
    );
    assert_eq!(report["database"]["displays"][0]["current"]["version"], "1");
    assert_eq!(report["runtime"]["online"], false);

    // 4. Révocation explicite : contenus retirés de l’écran, nouvel appairage proposé.
    {
        let mut s = api.state();
        s.faults.offline = false;
        s.faults.revoked = true;
        s.token = None;
    }
    eventually("révocation appliquée", || {
        renderer.lock().unwrap().received.iter().any(|e| {
            e.kind == MessageType::Configure
                && e.payload["displays"]
                    .as_array()
                    .is_some_and(|d| d.is_empty())
        })
    })
    .await;
    eventually("nouvel enregistrement", || api.state().registrations >= 2).await;

    shutdown.notify_waiters();
    tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(!socket.exists());
}
