//! Agent + vrai binaire `pixlova-renderer` lancé en mode `spawn`, contre l’API simulée.
//!
//! Exécuté seulement si `PIXLOVA_TEST_RENDERER` désigne le binaire construit
//! (`cargo build -p pixlova-renderer`). Le mode WebView exige en plus
//! `PIXLOVA_TEST_SHELL_DIR` (page construite) et un affichage (`xvfb-run`).

mod support;

use pixlova_agent::config::{AgentConfig, CliOverrides};
use pixlova_agent::runtime::Runtime;
use std::path::PathBuf;
use std::time::Duration;
use support::*;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

async fn eventually(what: &str, seconds: u64, mut check: impl FnMut() -> bool) {
    for _ in 0..seconds * 10 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("délai dépassé : {what}");
}

struct Running {
    _dir: tempfile::TempDir,
    data: PathBuf,
    api: MockApi,
    shutdown: std::sync::Arc<tokio::sync::Notify>,
    task: tokio::task::JoinHandle<Result<(), pixlova_agent::runtime::RuntimeError>>,
}

async fn start(renderer: &str, args: Vec<String>, watchdog: Duration) -> Running {
    let dir = tempfile::tempdir().unwrap();
    let api = MockApi::start().await;
    let trust_dir = dir.path().join("trust");
    std::fs::create_dir_all(&trust_dir).unwrap();
    std::fs::write(
        trust_dir.join("manifest-keys.json"),
        serde_json::json!({ "keys": [{ "kid": MANIFEST_KID, "public_key": pixlova_contracts::player_auth::public_key_b64u(&manifest_key()) }] }).to_string(),
    )
    .unwrap();
    std::fs::write(
        trust_dir.join("command-keys.json"),
        serde_json::json!({ "keys": [{ "kid": COMMAND_KID, "public_key": pixlova_contracts::player_auth::public_key_b64u(&command_key()) }] }).to_string(),
    )
    .unwrap();
    let data = dir.path().join("data");
    let mut config = AgentConfig::load(
        Some(data.clone()),
        &CliOverrides {
            api_url: Some(api.url.clone()),
            trust_dir: Some(trust_dir),
            sync_interval_seconds: Some(1),
            virtual_outputs: vec!["SIM-1:1280x720".into()],
            renderer_program: Some(renderer.into()),
            renderer_args: Some(args),
            ..Default::default()
        },
    )
    .unwrap();
    config.renderer_watchdog = watchdog;
    config.activation_timeout = Duration::from_secs(20);
    let asset = TestAsset::png(30);
    api.assign(DISPLAY, "2");
    let now = pixlova_agent::clock::Clock::now_millis(&pixlova_agent::clock::SystemClock);
    api.publish(
        &manifest_payload(
            "44444444-4444-4444-8444-000000000030",
            "1",
            "2",
            PLAYER,
            std::slice::from_ref(&asset),
            now,
        ),
        std::slice::from_ref(&asset),
    );
    let (agent, server) = Runtime::new(config).unwrap();
    let shutdown = agent.shutdown_handle();
    let task = tokio::spawn(agent.run(server));
    Running {
        _dir: dir,
        data,
        api,
        shutdown,
        task,
    }
}

impl Running {
    fn status(&self) -> serde_json::Value {
        std::fs::read_to_string(self.data.join("state/status.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }
    async fn stop(self) {
        self.shutdown.notify_waiters();
        tokio::time::timeout(Duration::from_secs(10), self.task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn renderer_sans_affichage_et_watchdog() {
    let Some(renderer) = env("PIXLOVA_TEST_RENDERER") else {
        eprintln!("PIXLOVA_TEST_RENDERER absent : test ignoré");
        return;
    };
    let running = start(&renderer, vec!["--headless".into()], Duration::from_secs(3)).await;
    eventually("manifest appliqué par le renderer", 30, || {
        running.api.statuses().iter().any(|(s, _)| s == "applied")
    })
    .await;
    assert!(running.data.join("state/healthy").exists());
    // Renderer figé (SIGSTOP) : arrêt forcé par le watchdog puis relance et restauration.
    // L’état local est réécrit à la fin de chaque tour de synchronisation.
    eventually("pid du renderer publié", 30, || {
        running.status()["renderer"]["pid"].as_i64().is_some()
    })
    .await;
    let pid = running.status()["renderer"]["pid"].as_i64().unwrap();
    assert!(
        std::process::Command::new("kill")
            .args(["-STOP", &pid.to_string()])
            .status()
            .unwrap()
            .success()
    );
    eventually("renderer relancé après watchdog", 30, || {
        let status = running.status();
        status["renderer"]["restarts_5min"].as_u64().unwrap_or(0) >= 1
            && status["renderer"]["connected"] == true
            && status["renderer"]["pid"].as_i64().is_some_and(|p| p != pid)
    })
    .await;
    running.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn renderer_webkitgtk_premiere_image() {
    let (Some(renderer), Some(shell)) =
        (env("PIXLOVA_TEST_RENDERER"), env("PIXLOVA_TEST_SHELL_DIR"))
    else {
        eprintln!("PIXLOVA_TEST_RENDERER ou PIXLOVA_TEST_SHELL_DIR absent : test ignoré");
        return;
    };
    if env("DISPLAY").is_none() && env("WAYLAND_DISPLAY").is_none() {
        eprintln!("aucun affichage : test ignoré");
        return;
    }
    let running = start(
        &renderer,
        vec!["--shell-dir".into(), shell, "--windowed".into()],
        Duration::from_secs(30),
    )
    .await;
    eventually("première image WebKitGTK confirmée", 60, || {
        running.api.statuses().iter().any(|(s, _)| s == "applied")
    })
    .await;
    assert_eq!(
        running
            .api
            .statuses()
            .iter()
            .map(|(s, _)| s.as_str())
            .collect::<Vec<_>>(),
        ["downloading", "ready", "applied"]
    );
    eventually("statut de lecture remonté", 30, || {
        running.status()["renderer"]["status"]["displays"][0]["playback"] == "playing"
    })
    .await;
    // Capture réelle de la vue WebKitGTK (SUP-004), envoyée au stockage simulé.
    let screenshot = "88888888-8888-4888-8888-000000000030";
    let command = "77777777-7777-4777-8777-000000000030";
    running.api.queue_command(&command_payload(
        command,
        "TAKE_SCREENSHOT",
        Some((DISPLAY, "2")),
        serde_json::json!({ "screenshot_id": screenshot }),
    ));
    eventually("capture WebKitGTK envoyée", 60, || {
        running.api.result(command).is_some()
    })
    .await;
    assert_eq!(
        running.api.result(command).unwrap()["status"],
        "success",
        "{:?}",
        running.api.result(command)
    );
    let png = running.api.state().uploads[screenshot].clone();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(png[20..24].try_into().unwrap());
    assert!(width >= 320 && height >= 180, "{width}x{height}");
    if let Some(out) = env("PIXLOVA_TEST_SCREENSHOT_OUT") {
        std::fs::write(out, &png).unwrap();
    }
    running.stop().await;
}
