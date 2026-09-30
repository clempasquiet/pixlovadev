//! Mode sans affichage (`--headless`) : même protocole que le renderer réel, sans WebView.
//! Sert aux parcours de bout en bout sans écran (CI) : il vérifie que chaque asset d’un
//! manifest préparé est présent dans le cache avec la bonne empreinte, puis confirme la
//! « première image ». Il ne qualifie aucun rendu.

use crate::agent_link::{AgentWriter, connect, is_sha256};
use pixlova_contracts::ipc::{MessageType, PreparePayload};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn verify(blobs: &Path, sha: &str) -> Result<(), &'static str> {
    if !is_sha256(sha) {
        return Err("ASSET_MISSING");
    }
    let bytes = std::fs::read(blobs.join(sha)).map_err(|_| "ASSET_MISSING")?;
    let digest: String = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if digest == sha {
        Ok(())
    } else {
        Err("CHECKSUM_MISMATCH")
    }
}

pub fn run(socket: PathBuf, blobs: PathBuf) -> ! {
    let (mut reader, writer) = connect(&socket, "headless");
    // display_id → (manifest actif, préparés)
    let active: Arc<Mutex<BTreeMap<String, String>>> = Arc::default();
    spawn_status(writer.clone(), active.clone());
    let mut prepared: BTreeMap<String, Vec<String>> = BTreeMap::new();
    while let Some(message) = reader.next() {
        let Ok(envelope) = message else {
            continue;
        };
        match envelope.kind {
            MessageType::Configure => {
                if envelope.payload["displays"]
                    .as_array()
                    .is_some_and(|d| d.is_empty())
                {
                    writer.send(
                        MessageType::FramePresented,
                        None,
                        json!({ "display_id": null, "manifest_id": null }),
                    );
                }
            }
            MessageType::Prepare => {
                match serde_json::from_value::<PreparePayload>(envelope.payload.clone()) {
                    Ok(prepare) => {
                        let failure = prepare
                            .assets
                            .values()
                            .find_map(|sha| verify(&blobs, sha).err());
                        match failure {
                            Some(code) => {
                                writer.error(&envelope, code, "asset absent ou altéré");
                            }
                            None => {
                                let list = prepared.entry(prepare.display_id).or_default();
                                list.push(prepare.manifest_id);
                                if list.len() > 3 {
                                    list.remove(0);
                                }
                                writer.reply(&envelope, MessageType::Ready, json!({}));
                            }
                        }
                    }
                    Err(error) => {
                        writer.error(&envelope, "MALFORMED_MESSAGE", &error.to_string());
                    }
                }
            }
            MessageType::Activate => {
                let display = envelope.payload["display_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                let manifest = envelope.payload["manifest_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                if !prepared
                    .get(&display)
                    .is_some_and(|l| l.contains(&manifest))
                {
                    writer.error(&envelope, "NOT_PREPARED", &manifest);
                    continue;
                }
                writer.reply(&envelope, MessageType::Ready, json!({}));
                active
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .insert(display.clone(), manifest.clone());
                writer.send(
                    MessageType::FramePresented,
                    None,
                    json!({ "display_id": display, "manifest_id": manifest }),
                );
            }
            MessageType::GetStatus => {
                writer.reply(&envelope, MessageType::Status, status(&active));
            }
            _ => {}
        }
    }
    eprintln!("pixlova-renderer : connexion à l’agent perdue");
    std::process::exit(1);
}

fn status(active: &Mutex<BTreeMap<String, String>>) -> Value {
    let active = active.lock().unwrap_or_else(|p| p.into_inner());
    json!({ "displays": active.iter().map(|(display, manifest)| json!({
        "display_id": display, "manifest_id": manifest, "playback": "playing", "content_ref": null,
    })).collect::<Vec<_>>() })
}

fn spawn_status(writer: AgentWriter, active: Arc<Mutex<BTreeMap<String, String>>>) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(
                pixlova_contracts::ipc::IPC_STATUS_INTERVAL_SECONDS,
            ));
            if !writer.send(MessageType::Status, None, status(&active)) {
                return;
            }
        }
    });
}
