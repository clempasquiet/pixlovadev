//! Réception, cache et activation atomique contre une API simulée et un renderer factice
//! (NAT-008 à NAT-010, PROTO-013, TST-052).

mod support;

use pixlova_agent::cache::Cache;
use pixlova_agent::clock::format_instant;
use pixlova_agent::cloud::Cloud;
use pixlova_agent::identity::DeviceIdentity;
use pixlova_agent::ipc::{IpcServer, RendererLink};
use pixlova_agent::pipeline::{Outcome, Pipeline};
use pixlova_agent::store::Store;
use std::sync::Arc;
use std::time::Duration;
use support::*;

struct Harness {
    _dir: tempfile::TempDir,
    api: MockApi,
    store: Store,
    cache: Cache,
    pipeline: Pipeline,
    clock: Arc<TestClock>,
    behavior: Behavior,
    blobs: std::path::PathBuf,
    socket: std::path::PathBuf,
}

async fn harness_with_space(free: Option<u64>) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let api = MockApi::start().await;
    let clock = TestClock::real();
    let store = Store::open(&dir.path().join("pixlova.db")).unwrap();
    let now = format_instant(pixlova_agent::clock::Clock::now_millis(&*clock));
    store.installation_id(&now).unwrap();
    store
        .save_registration("r", "s", "ABCD-EFGH", &now)
        .unwrap();
    store.save_pairing(ORG, PLAYER, &now).unwrap();
    store
        .upsert_display(
            DISPLAY,
            "2",
            "SIM-1",
            "Vitrine",
            1920,
            1080,
            0,
            "Europe/Paris",
            &now,
        )
        .unwrap();
    let probe: pixlova_agent::cache::SpaceProbe = Arc::new(move |_| free);
    let cache = Cache::with_probe(
        &dir.path().join("cache"),
        store.clone(),
        1 << 30,
        1000,
        probe,
    )
    .unwrap();
    let cloud = Cloud::new(&api.url).unwrap();
    // Jeton obtenu par le vrai challenge signé.
    let identity = DeviceIdentity::load_or_create(&dir.path().join("identity")).unwrap();
    cloud
        .register(
            "11111111-1111-4111-8111-111111111111",
            &identity,
            pixlova_agent::platform::capabilities("0.1.0", None),
            &pixlova_agent::platform::detect_outputs(None),
        )
        .await
        .unwrap();
    cloud.authenticate(PLAYER, &identity).await.unwrap();
    let socket = dir.path().join("run/agent.sock");
    let link = RendererLink::new();
    tokio::spawn(IpcServer::bind(&socket).unwrap().serve(link.clone()));
    let behavior = Behavior::default();
    let blobs = dir.path().join("cache/blobs");
    fake_renderer(socket.clone(), blobs.clone(), behavior.clone()).await;
    for _ in 0..100 {
        if link.is_connected() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let pipeline = Pipeline::new(
        store.clone(),
        cache.clone(),
        cloud,
        trust(),
        link,
        clock.clone(),
        Duration::from_millis(500),
    );
    Harness {
        _dir: dir,
        api,
        store,
        cache,
        pipeline,
        clock,
        behavior,
        blobs,
        socket,
    }
}

async fn harness() -> Harness {
    harness_with_space(None).await
}

impl Harness {
    fn now(&self) -> i64 {
        pixlova_agent::clock::Clock::now_millis(&*self.clock)
    }
    fn publish(&self, id: &str, version: &str, assets: &[TestAsset]) -> serde_json::Value {
        let payload = manifest_payload(id, version, "2", PLAYER, assets, self.now());
        self.api.publish(&payload, assets);
        payload
    }
    async fn sync(&self) -> Outcome {
        let display = self.store.display(DISPLAY).unwrap().unwrap();
        self.pipeline
            .fetch_candidate(ORG, PLAYER, &display)
            .await
            .unwrap();
        self.pipeline.advance(DISPLAY).await.unwrap()
    }
    fn current(&self) -> Option<String> {
        self.store
            .display(DISPLAY)
            .unwrap()
            .unwrap()
            .current_manifest
    }
    fn outbox(&self) -> Vec<(String, Option<String>)> {
        self.store
            .outbox(100)
            .unwrap()
            .into_iter()
            .map(|e| (e.state, e.error_code))
            .collect()
    }
}

const M1: &str = "44444444-4444-4444-8444-000000000001";
const M2: &str = "44444444-4444-4444-8444-000000000002";

fn st(state: &str) -> (String, Option<String>) {
    (state.into(), None)
}
fn failed(code: &str) -> (String, Option<String>) {
    ("failed".into(), Some(code.into()))
}

#[tokio::test]
async fn applique_un_manifest_apres_telechargement_verifie_et_premiere_image() {
    let h = harness().await;
    let asset = TestAsset::new(1, 200_000);
    h.publish(M1, "1", std::slice::from_ref(&asset));
    assert_eq!(h.sync().await, Outcome::Applied(M1.into()));
    assert_eq!(h.current().as_deref(), Some(M1));
    assert_eq!(
        std::fs::read(h.blobs.join(asset.sha())).unwrap(),
        asset.bytes
    );
    assert_eq!(h.outbox(), [st("downloading"), st("ready"), st("applied")]);
    // Une seconde synchronisation n’apporte rien : 304 sur l’empreinte connue.
    assert_eq!(h.sync().await, Outcome::Idle);
    // Le renderer n’a reçu que le manifest vérifié et des empreintes, aucune URL.
    let received = &h.behavior.lock().unwrap().received;
    let prepare = received
        .iter()
        .find(|e| e.kind == pixlova_contracts::ipc::MessageType::Prepare)
        .unwrap();
    assert!(!prepare.payload.to_string().contains("storage"));
    assert_eq!(prepare.payload["assets"][&asset.id], asset.sha());
}

#[tokio::test]
async fn reprend_un_telechargement_coupe_sans_jamais_lire_un_partiel() {
    let h = harness().await;
    let asset = TestAsset::new(2, 300_000);
    h.publish(M1, "1", std::slice::from_ref(&asset));
    h.api.state().faults.truncate_once.insert(asset.id.clone());
    assert_eq!(
        h.sync().await,
        Outcome::Retrying("ASSET_DOWNLOAD_FAILED".into())
    );
    assert!(!h.blobs.join(asset.sha()).exists());
    let part = h
        .blobs
        .parent()
        .unwrap()
        .join("tmp")
        .join(format!("{}.part", asset.sha()));
    assert_eq!(std::fs::metadata(&part).unwrap().len(), 150_000);
    assert_eq!(h.current(), None);
    // Nouvel essai après le délai : reprise par Range à partir du fichier partiel.
    h.clock.advance(60_000);
    assert_eq!(
        h.pipeline.advance(DISPLAY).await.unwrap(),
        Outcome::Applied(M1.into())
    );
    assert_eq!(
        h.api.state().range_requests,
        std::slice::from_ref(&asset.id)
    );
    assert_eq!(
        std::fs::read(h.blobs.join(asset.sha())).unwrap(),
        asset.bytes
    );
}

#[tokio::test]
async fn refuse_un_asset_au_checksum_faux_et_garde_l_ancien_contenu() {
    let h = harness().await;
    let good = TestAsset::new(3, 50_000);
    h.publish(M1, "1", std::slice::from_ref(&good));
    assert_eq!(h.sync().await, Outcome::Applied(M1.into()));
    let bad = TestAsset::new(4, 50_000);
    h.publish(M2, "2", std::slice::from_ref(&bad));
    h.api.state().faults.corrupt.insert(bad.id.clone());
    assert_eq!(
        h.sync().await,
        Outcome::Retrying("CHECKSUM_MISMATCH".into())
    );
    assert!(!h.blobs.join(bad.sha()).exists());
    assert_eq!(h.current().as_deref(), Some(M1));
    assert_eq!(h.outbox().last().unwrap(), &failed("CHECKSUM_MISMATCH"));
}

#[tokio::test]
async fn refuse_les_manifests_falsifies_d_un_autre_player_ou_rejoues() {
    let h = harness().await;
    let asset = TestAsset::new(5, 10_000);
    // Signature par une clé non installée.
    let payload = manifest_payload(M1, "1", "2", PLAYER, std::slice::from_ref(&asset), h.now());
    let untrusted = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    h.api
        .publish_raw(DISPLAY, sign(&payload, &untrusted, MANIFEST_KID));
    assert_eq!(h.sync().await, Outcome::Idle);
    assert_eq!(
        h.store
            .display(DISPLAY)
            .unwrap()
            .unwrap()
            .last_error
            .as_deref(),
        Some("SIGNATURE_INVALID")
    );
    // Payload modifié après signature.
    let mut raw: serde_json::Value =
        serde_json::from_str(&sign(&payload, &manifest_key(), MANIFEST_KID)).unwrap();
    raw["payload"]["version"] = "9".into();
    h.api.publish_raw(DISPLAY, raw.to_string());
    assert_eq!(h.sync().await, Outcome::Idle);
    // Manifest authentique mais destiné à un autre Player.
    let other = manifest_payload(
        M1,
        "1",
        "2",
        "66666666-6666-4666-8666-000000000009",
        std::slice::from_ref(&asset),
        h.now(),
    );
    h.api.publish(&other, std::slice::from_ref(&asset));
    assert_eq!(h.sync().await, Outcome::Idle);
    assert_eq!(h.outbox(), [failed("WRONG_PLAYER")]);
    // Génération d’affectation périmée.
    let stale = manifest_payload(M1, "1", "1", PLAYER, std::slice::from_ref(&asset), h.now());
    h.api.publish(&stale, std::slice::from_ref(&asset));
    assert_eq!(h.sync().await, Outcome::Idle);
    assert_eq!(h.current(), None);
    // Version valide puis rejeu d’une version plus ancienne.
    h.publish(M2, "5", std::slice::from_ref(&asset));
    assert_eq!(h.sync().await, Outcome::Applied(M2.into()));
    h.publish(M1, "4", std::slice::from_ref(&asset));
    assert_eq!(h.sync().await, Outcome::Idle);
    assert_eq!(h.current().as_deref(), Some(M2));
}

#[tokio::test]
async fn disque_plein_n_evince_jamais_le_contenu_actif() {
    let h = harness_with_space(Some(60_000)).await;
    let first = TestAsset::new(6, 50_000);
    h.publish(M1, "1", std::slice::from_ref(&first));
    assert_eq!(h.sync().await, Outcome::Applied(M1.into()));
    let big = TestAsset::new(7, 100_000);
    h.publish(M2, "2", std::slice::from_ref(&big));
    assert_eq!(h.sync().await, Outcome::Retrying("DISK_FULL".into()));
    assert!(
        h.blobs.join(first.sha()).exists(),
        "le blob actif est épinglé"
    );
    assert_eq!(h.current().as_deref(), Some(M1));
    assert_eq!(h.outbox().last().unwrap(), &failed("DISK_FULL"));
    // Le candidat reste en attente : une nouvelle tentative ne redéclare pas l’échec.
    h.clock.advance(60_000);
    assert_eq!(
        h.pipeline.advance(DISPLAY).await.unwrap(),
        Outcome::Retrying("DISK_FULL".into())
    );
    assert_eq!(
        h.outbox()
            .iter()
            .filter(|e| e.1.as_deref() == Some("DISK_FULL"))
            .count(),
        1
    );
}

#[tokio::test]
async fn un_echec_de_preparation_laisse_l_ancien_manifest() {
    let h = harness().await;
    let asset = TestAsset::new(8, 10_000);
    h.publish(M1, "1", std::slice::from_ref(&asset));
    assert_eq!(h.sync().await, Outcome::Applied(M1.into()));
    h.behavior.lock().unwrap().fail_prepare = Some("DECODE_FAILED".into());
    h.publish(M2, "2", std::slice::from_ref(&asset));
    assert_eq!(h.sync().await, Outcome::Failed("DECODE_FAILED".into()));
    let row = h.store.display(DISPLAY).unwrap().unwrap();
    assert_eq!(
        (row.current_manifest.as_deref(), row.staging_manifest),
        (Some(M1), None)
    );
    assert!(h.store.intents().unwrap().is_empty());
}

#[tokio::test]
async fn sans_premiere_image_l_activation_est_annulee() {
    let h = harness().await;
    let asset = TestAsset::new(9, 10_000);
    h.publish(M1, "1", std::slice::from_ref(&asset));
    assert_eq!(h.sync().await, Outcome::Applied(M1.into()));
    h.behavior.lock().unwrap().no_frame = true;
    h.publish(M2, "2", std::slice::from_ref(&asset));
    assert_eq!(h.sync().await, Outcome::Failed("ACTIVATION_TIMEOUT".into()));
    assert_eq!(h.current().as_deref(), Some(M1));
    assert!(h.store.intents().unwrap().is_empty());
    assert_eq!(h.outbox().last().unwrap(), &failed("ACTIVATION_TIMEOUT"));
    // L’ancien manifest a été réactivé dans le renderer.
    let received = &h.behavior.lock().unwrap().received;
    let last_activate = received
        .iter()
        .rev()
        .find(|e| e.kind == pixlova_contracts::ipc::MessageType::Activate)
        .unwrap();
    assert_eq!(last_activate.payload["manifest_id"], M1);
}

#[tokio::test]
async fn reprise_d_une_activation_interrompue_par_une_coupure() {
    let h = harness().await;
    let asset = TestAsset::new(10, 10_000);
    h.publish(M1, "1", std::slice::from_ref(&asset));
    assert_eq!(h.sync().await, Outcome::Applied(M1.into()));
    // Coupure simulée : candidat accepté, intention écrite, jamais confirmé.
    h.publish(M2, "2", std::slice::from_ref(&asset));
    let display = h.store.display(DISPLAY).unwrap().unwrap();
    h.pipeline
        .fetch_candidate(ORG, PLAYER, &display)
        .await
        .unwrap();
    h.store
        .begin_intent(DISPLAY, M2, "2026-10-01T00:00:00Z")
        .unwrap();
    assert_eq!(h.pipeline.recover_intents().unwrap(), 1);
    let row = h.store.display(DISPLAY).unwrap().unwrap();
    assert_eq!(
        (
            row.current_manifest.as_deref(),
            row.staging_manifest.as_deref()
        ),
        (Some(M1), Some(M2))
    );
    assert_eq!(
        h.outbox().last().unwrap(),
        &failed("ACTIVATION_INTERRUPTED")
    );
    // Le candidat est repris et activé proprement.
    assert_eq!(
        h.pipeline.advance(DISPLAY).await.unwrap(),
        Outcome::Applied(M2.into())
    );
    assert_eq!(
        h.store
            .display(DISPLAY)
            .unwrap()
            .unwrap()
            .previous_manifest
            .as_deref(),
        Some(M1)
    );
}

#[tokio::test]
async fn un_renderer_relance_retrouve_son_contenu_sans_le_cloud() {
    let h = harness().await;
    let asset = TestAsset::new(11, 10_000);
    h.publish(M1, "1", std::slice::from_ref(&asset));
    assert_eq!(h.sync().await, Outcome::Applied(M1.into()));
    h.api.state().faults.offline = true;
    let behavior = Behavior::default();
    fake_renderer(h.socket.clone(), h.blobs.clone(), behavior.clone()).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    h.pipeline.restore_all().await.unwrap();
    let received = behavior.lock().unwrap().received.clone();
    let kinds: Vec<_> = received.iter().map(|e| e.kind).collect();
    use pixlova_contracts::ipc::MessageType::*;
    assert_eq!(kinds, [Prepare, Activate]);
    assert_eq!(received[1].payload["manifest_id"], M1);
    // Hors ligne, la synchronisation échoue sans toucher à l’état local.
    let display = h.store.display(DISPLAY).unwrap().unwrap();
    assert!(
        h.pipeline
            .fetch_candidate(ORG, PLAYER, &display)
            .await
            .is_err()
    );
    assert_eq!(h.current().as_deref(), Some(M1));
}

#[tokio::test]
async fn un_blob_altere_sur_disque_n_est_pas_restaure() {
    let h = harness().await;
    let asset = TestAsset::new(12, 10_000);
    h.publish(M1, "1", std::slice::from_ref(&asset));
    assert_eq!(h.sync().await, Outcome::Applied(M1.into()));
    // Nouveau démarrage (cache relu) avec un blob altéré après coup.
    std::fs::write(h.blobs.join(asset.sha()), b"altere").unwrap();
    let fresh = Cache::open(h.blobs.parent().unwrap(), h.store.clone(), 1 << 30, 0).unwrap();
    let row = pixlova_agent::store::AssetRow {
        asset_id: asset.id.clone(),
        sha256: asset.sha(),
        size_bytes: asset.bytes.len() as u64,
        mime_type: "image/png".into(),
    };
    assert!(!fresh.verify_blob(&row).unwrap());
    assert!(!h.blobs.join(asset.sha()).exists());
    let _ = &h.cache;
}
