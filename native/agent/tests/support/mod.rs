//! Outils de test : API Player simulée (axum) avec injection de pannes, signature de
//! manifests par une clé de test et renderer factice parlant le vrai protocole IPC.
#![allow(dead_code)]

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use pixlova_agent::clock::{Clock, format_instant};
use pixlova_contracts::TrustStore;
use pixlova_contracts::canonical::{canonical_bytes, canonical_sha256};
use pixlova_contracts::ipc::{Envelope, MessageType};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

pub const ORG: &str = "55555555-5555-4555-8555-555555555555";
pub const PLAYER: &str = "66666666-6666-4666-8666-666666666666";
pub const DISPLAY: &str = "33333333-3333-4333-8333-333333333333";
pub const MANIFEST_KID: &str = "test-manifest-a";

/// Graine publique de `packages/contracts/fixtures/keys.json` (tests uniquement).
pub fn manifest_key() -> SigningKey {
    let hex = "d26fd7d5f0f517cd5810da682d02b2c03d3d4d8beb26dd102c4c3f23510aafda";
    let bytes: Vec<u8> = (0..32)
        .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
        .collect();
    SigningKey::from_bytes(&bytes.try_into().unwrap())
}

pub fn trust() -> TrustStore {
    TrustStore::from([(MANIFEST_KID.to_owned(), manifest_key().verifying_key())])
}

pub fn sign(payload: &Value, key: &SigningKey, kid: &str) -> String {
    let protected = json!({ "type": "SIGNAGE_MANIFEST_V1", "alg": "Ed25519", "kid": kid });
    let input = canonical_bytes(&json!({ "protected": protected, "payload": payload }));
    let signature = URL_SAFE_NO_PAD.encode(key.sign(&input).to_bytes());
    json!({ "protected": protected, "payload": payload, "signature": signature }).to_string()
}

pub fn payload_hash(payload: &Value) -> String {
    canonical_sha256(payload)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    pixlova_agent::cache::sha256_hex(bytes)
}

#[derive(Clone)]
pub struct TestAsset {
    pub id: String,
    pub bytes: Vec<u8>,
}

impl TestAsset {
    pub fn new(n: u32, size: usize) -> Self {
        let bytes: Vec<u8> = (0..size)
            .map(|i| ((i as u32 * 31 + n) % 251) as u8)
            .collect();
        Self {
            id: format!("77777777-7777-4777-8777-{n:012}"),
            bytes,
        }
    }
    /// Image PNG 1×1 décodable par un vrai moteur de rendu.
    pub fn png(n: u32) -> Self {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
            .unwrap();
        Self {
            id: format!("77777777-7777-4777-8777-{n:012}"),
            bytes,
        }
    }
    pub fn sha(&self) -> String {
        sha256_hex(&self.bytes)
    }
}

/// Manifest valide d’une image plein écran, fenêtre [now - 1 h, now + 1 j].
pub fn manifest_payload(
    manifest_id: &str,
    version: &str,
    generation: &str,
    player_id: &str,
    assets: &[TestAsset],
    now_millis: i64,
) -> Value {
    let from = format_instant(now_millis - 3_600_000);
    let until = format_instant(now_millis + 86_400_000);
    let contents: Vec<Value> = assets
        .iter()
        .enumerate()
        .map(|(i, a)| {
            json!({ "id": format!("image-{i}"), "type": "media", "media_kind": "image",
                    "asset_id": a.id, "duration_ms": 10000, "fit": "contain", "muted": true })
        })
        .collect();
    json!({
        "schema_version": 1,
        "manifest_id": manifest_id,
        "organization_id": ORG,
        "display_id": DISPLAY,
        "player_id": player_id,
        "version": version,
        "assignment_generation": generation,
        "config_revision": version,
        "generated_at": from,
        "valid_from": from,
        "activate_before": until,
        "schedule_until": until,
        "display": { "width": 1920, "height": 1080, "orientation": 0, "fit": "contain", "timezone": "Europe/Paris" },
        "required_capabilities": { "render_schema": 1, "image_types": ["image/png"], "video_profiles": [] },
        "assets": assets.iter().map(|a| json!({
            "id": a.id, "variant": "display-image", "mime_type": "image/png",
            "size_bytes": a.bytes.len(), "sha256": a.sha(),
        })).collect::<Vec<_>>(),
        "contents": contents,
        "timeline": [{
            "starts_at": from, "ends_at": until, "content_ref": "image-0",
            "source": { "type": "schedule", "id": "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", "priority": 10, "revision": "1" }
        }],
        "fallback": { "content_ref": "image-0", "after_schedule": "play_fallback" },
    })
}

pub struct TestClock(pub AtomicI64);

impl TestClock {
    pub fn real() -> Arc<Self> {
        Arc::new(Self(AtomicI64::new(
            pixlova_agent::clock::SystemClock.now_millis(),
        )))
    }
    pub fn advance(&self, millis: i64) {
        self.0.fetch_add(millis, Ordering::SeqCst);
    }
}

impl Clock for TestClock {
    fn now_millis(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

// --- API simulée ------------------------------------------------------------------------

#[derive(Default)]
pub struct Faults {
    /// Assets servis tronqués (coupure) à leur prochaine requête.
    pub truncate_once: HashSet<String>,
    /// Assets servis avec un octet modifié.
    pub corrupt: HashSet<String>,
    /// Toute l’API répond 503 (cloud indisponible).
    pub offline: bool,
    pub revoked: bool,
}

#[derive(Default)]
pub struct MockState {
    pub base_url: String,
    pub public_key: Option<String>,
    pub installation_id: Option<String>,
    pub pending_polls: u32,
    pub registrations: u32,
    pub challenges: HashMap<String, Value>,
    pub token: Option<String>,
    pub assignments: Vec<Value>,
    pub manifests: HashMap<String, (String, String)>,
    pub blobs: HashMap<String, Vec<u8>>,
    pub faults: Faults,
    pub statuses: Vec<(String, String, Option<String>)>,
    pub heartbeats: Vec<Value>,
    pub outputs: Vec<Value>,
    pub range_requests: Vec<String>,
    pub asset_requests: u32,
}

pub type Shared = Arc<Mutex<MockState>>;

fn error(status: StatusCode, code: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "code": code, "message": code, "request_id": "t", "retryable": status.is_server_error() } })),
    )
        .into_response()
}

#[allow(clippy::result_large_err)]
fn guard(state: &Shared, headers: &HeaderMap) -> Result<(), Response> {
    let s = state.lock().unwrap();
    if s.faults.offline {
        return Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "SERVICE_UNAVAILABLE",
        ));
    }
    if s.faults.revoked {
        return Err(error(StatusCode::FORBIDDEN, "PLAYER_REVOKED"));
    }
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    if bearer.is_none() || bearer != s.token.as_deref() {
        return Err(error(StatusCode::UNAUTHORIZED, "UNAUTHORIZED"));
    }
    Ok(())
}

async fn register(State(state): State<Shared>, Json(body): Json<Value>) -> Response {
    let mut s = state.lock().unwrap();
    if s.faults.offline {
        return error(StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE");
    }
    assert_eq!(body["capabilities"]["player_type"], "native");
    assert!(!body["outputs"].as_array().unwrap().is_empty());
    s.public_key = body["public_key"].as_str().map(str::to_owned);
    s.installation_id = body["installation_id"].as_str().map(str::to_owned);
    s.registrations += 1;
    (
        StatusCode::CREATED,
        Json(json!({
            "registration_id": "99999999-0000-4000-8000-000000000001",
            "pairing_code": "ABCD-EFGH",
            "expires_at": "2099-01-01T00:00:00Z",
            "poll_secret": "p".repeat(43),
            "poll_interval_s": 1,
        })),
    )
        .into_response()
}

async fn pair(State(state): State<Shared>, Json(_): Json<Value>) -> Response {
    let mut s = state.lock().unwrap();
    if s.pending_polls > 0 {
        s.pending_polls -= 1;
        return Json(json!({ "status": "pending", "expires_at": "2099-01-01T00:00:00Z" }))
            .into_response();
    }
    Json(json!({ "status": "paired", "player_id": PLAYER, "organization_id": ORG })).into_response()
}

async fn challenge(State(state): State<Shared>, Json(body): Json<Value>) -> Response {
    let mut s = state.lock().unwrap();
    if s.faults.offline {
        return error(StatusCode::SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE");
    }
    if s.faults.revoked {
        return error(StatusCode::FORBIDDEN, "PLAYER_REVOKED");
    }
    let id = uuid::Uuid::new_v4().to_string();
    let challenge = json!({
        "type": "PIXLOVA_PLAYER_AUTH_V1", "audience": "pixlova-player-api",
        "challenge_id": id, "nonce": "n".repeat(43), "player_id": body["player_id"],
        "installation_id": s.installation_id.clone().unwrap_or_default(),
        "issued_at": "2026-01-01T00:00:00Z", "expires_at": "2099-01-01T00:00:00Z",
    });
    s.challenges.insert(id, challenge.clone());
    Json(json!({ "challenge": challenge })).into_response()
}

async fn refresh(State(state): State<Shared>, Json(body): Json<Value>) -> Response {
    let mut s = state.lock().unwrap();
    let Some(challenge) = s
        .challenges
        .remove(body["challenge_id"].as_str().unwrap_or_default())
    else {
        return error(StatusCode::UNAUTHORIZED, "UNAUTHORIZED");
    };
    let key_bytes: [u8; 32] = URL_SAFE_NO_PAD
        .decode(s.public_key.as_deref().unwrap_or_default())
        .unwrap()
        .try_into()
        .unwrap();
    let key = VerifyingKey::from_bytes(&key_bytes).unwrap();
    if !pixlova_contracts::player_auth::verify_player_challenge(
        &key,
        &challenge,
        body["signature"].as_str().unwrap_or_default(),
    ) {
        return error(StatusCode::UNAUTHORIZED, "UNAUTHORIZED");
    }
    let token = "t".repeat(42) + &s.challenges.len().to_string()[..1];
    s.token = Some(token.clone());
    Json(json!({ "access_token": token, "token_type": "Bearer", "expires_at": "2099-01-01T00:00:00Z", "credential_generation": "1" })).into_response()
}

async fn config(State(state): State<Shared>, headers: HeaderMap) -> Response {
    if let Err(response) = guard(&state, &headers) {
        return response;
    }
    let s = state.lock().unwrap();
    Json(json!({
        "player_id": PLAYER, "organization_id": ORG, "heartbeat_interval_s": 30, "presence_timeout_s": 90,
        "assignments": s.assignments,
    }))
    .into_response()
}

async fn outputs(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(response) = guard(&state, &headers) {
        return response;
    }
    state.lock().unwrap().outputs.push(body);
    StatusCode::NO_CONTENT.into_response()
}

async fn heartbeat(
    State(state): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(response) = guard(&state, &headers) {
        return response;
    }
    state.lock().unwrap().heartbeats.push(body);
    Json(json!({ "server_time": format_instant(pixlova_agent::clock::SystemClock.now_millis()), "stale_displays": [] })).into_response()
}

async fn manifest(
    State(state): State<Shared>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if let Err(response) = guard(&state, &headers) {
        return response;
    }
    let s = state.lock().unwrap();
    let Some((raw, hash)) = s.manifests.get(
        query
            .get("display_id")
            .map(String::as_str)
            .unwrap_or_default(),
    ) else {
        return error(StatusCode::NOT_FOUND, "MANIFEST_NOT_FOUND");
    };
    let etag = format!("\"{hash}\"");
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(etag.as_str())
    {
        return StatusCode::NOT_MODIFIED.into_response();
    }
    ([(header::ETAG, etag)], raw.clone()).into_response()
}

async fn asset_url(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = guard(&state, &headers) {
        return response;
    }
    let mut s = state.lock().unwrap();
    s.asset_requests += 1;
    let Some(bytes) = s.blobs.get(&id) else {
        return error(StatusCode::NOT_FOUND, "ASSET_NOT_FOUND");
    };
    Json(json!({
        "asset_id": id, "url": format!("{}/storage/{id}?signature=secret", s.base_url),
        "expires_at": "2099-01-01T00:00:00Z", "size_bytes": bytes.len(), "sha256": sha256_hex(bytes),
        "range_supported": true,
    }))
    .into_response()
}

async fn storage(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let mut s = state.lock().unwrap();
    let Some(mut bytes) = s.blobs.get(&id).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if s.faults.corrupt.contains(&id) {
        bytes[0] ^= 0xff;
    }
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
        .and_then(|v| v.strip_suffix('-'))
        .and_then(|v| v.parse::<usize>().ok());
    if let Some(start) = range {
        s.range_requests.push(id.clone());
        if start >= bytes.len() {
            return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
        }
        return (
            StatusCode::PARTIAL_CONTENT,
            Body::from(bytes[start..].to_vec()),
        )
            .into_response();
    }
    if s.faults.truncate_once.remove(&id) {
        // Réponse annoncée complète mais coupée à mi-parcours.
        let half = bytes.len() / 2;
        let first = axum::body::Bytes::from(bytes[..half].to_vec());
        let stream = futures_util::stream::unfold(0u8, move |step| {
            let first = first.clone();
            async move {
                match step {
                    0 => Some((Ok::<_, std::io::Error>(first), 1)),
                    1 => {
                        // Laisse le premier morceau atteindre le client avant la coupure.
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        Some((Err(std::io::Error::other("coupure")), 2))
                    }
                    _ => None,
                }
            }
        });
        return Response::builder()
            .header(header::CONTENT_LENGTH, bytes.len())
            .body(Body::from_stream(stream))
            .unwrap();
    }
    Body::from(bytes).into_response()
}

async fn status(
    State(state): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    if let Err(response) = guard(&state, &headers) {
        return response;
    }
    let mut s = state.lock().unwrap();
    let state_name = body["state"].as_str().unwrap_or_default().to_owned();
    s.statuses.push((
        id,
        state_name.clone(),
        body["error_code"].as_str().map(str::to_owned),
    ));
    Json(json!({ "state": state_name })).into_response()
}

pub struct MockApi {
    pub url: String,
    pub state: Shared,
}

impl MockApi {
    pub async fn start() -> Self {
        let state: Shared = Arc::default();
        let app = Router::new()
            .route("/player/v1/register", post(register))
            .route("/player/v1/pair", post(pair))
            .route("/player/v1/token/challenge", post(challenge))
            .route("/player/v1/token/refresh", post(refresh))
            .route("/player/v1/config", get(config))
            .route("/player/v1/outputs", post(outputs))
            .route("/player/v1/heartbeat", post(heartbeat))
            .route("/player/v1/manifest", get(manifest))
            .route("/player/v1/assets/{id}/url", get(asset_url))
            .route("/player/v1/manifests/{id}/status", post(status))
            .route("/storage/{id}", get(storage))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        state.lock().unwrap().base_url = url.clone();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { url, state }
    }

    pub fn state(&self) -> std::sync::MutexGuard<'_, MockState> {
        self.state.lock().unwrap()
    }

    pub fn assign(&self, display_id: &str, generation: &str) {
        self.state().assignments = vec![json!({
            "display_id": display_id, "assignment_generation": generation, "output_key": "SIM-1",
            "manifest_version": null,
            "display": { "name": "Vitrine", "width": 1920, "height": 1080, "orientation": 0, "timezone": "Europe/Paris" },
        })];
    }

    /// Publie un manifest signé et ses assets pour le Display de test.
    pub fn publish(&self, payload: &Value, assets: &[TestAsset]) {
        let raw = sign(payload, &manifest_key(), MANIFEST_KID);
        let mut s = self.state();
        for asset in assets {
            s.blobs.insert(asset.id.clone(), asset.bytes.clone());
        }
        s.manifests.insert(
            payload["display_id"].as_str().unwrap().to_owned(),
            (raw, payload_hash(payload)),
        );
    }

    pub fn publish_raw(&self, display_id: &str, raw: String) {
        self.state()
            .manifests
            .insert(display_id.to_owned(), (raw, "autre".into()));
    }

    pub fn statuses(&self) -> Vec<(String, Option<String>)> {
        self.state()
            .statuses
            .iter()
            .map(|(_, s, c)| (s.clone(), c.clone()))
            .collect()
    }
}

// --- Renderer factice -------------------------------------------------------------------

#[derive(Default)]
pub struct RendererBehavior {
    pub fail_prepare: Option<String>,
    pub no_frame: bool,
    pub received: Vec<Envelope>,
}

pub type Behavior = Arc<Mutex<RendererBehavior>>;

/// Se connecte au socket de l’agent et répond comme un renderer : `PREPARE` vérifie la
/// présence des blobs, `ACTIVATE` confirme puis présente une image.
pub async fn fake_renderer(
    socket: std::path::PathBuf,
    blobs: std::path::PathBuf,
    behavior: Behavior,
) -> tokio::task::JoinHandle<()> {
    let stream = loop {
        match UnixStream::connect(&socket).await {
            Ok(stream) => break stream,
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(20)).await,
        }
    };
    let (read, mut write) = stream.into_split();
    let hello = Envelope::new(
        MessageType::Hello,
        "h".into(),
        None,
        json!({ "renderer_version": "test", "engine": "test" }),
    );
    write
        .write_all(format!("{}\n", hello.encode()).as_bytes())
        .await
        .unwrap();
    tokio::spawn(async move {
        let mut reader = BufReader::new(read);
        while let Ok(Some(Ok(line))) = pixlova_agent::ipc::read_line(&mut reader).await {
            let envelope = Envelope::decode(&line).unwrap();
            let reply = |kind, payload: Value| {
                Envelope::new(
                    kind,
                    uuid::Uuid::new_v4().to_string(),
                    Some(envelope.message_id.clone()),
                    payload,
                )
                .encode()
            };
            let mut out = Vec::new();
            {
                let mut b = behavior.lock().unwrap();
                b.received.push(envelope.clone());
                match envelope.kind {
                    MessageType::Prepare => {
                        let missing = envelope.payload["assets"]
                            .as_object()
                            .unwrap()
                            .values()
                            .any(|sha| !blobs.join(sha.as_str().unwrap()).exists());
                        if let Some(code) = b.fail_prepare.clone() {
                            out.push(reply(
                                MessageType::Error,
                                json!({ "code": code, "detail": "échec simulé" }),
                            ));
                        } else if missing {
                            out.push(reply(
                                MessageType::Error,
                                json!({ "code": "ASSET_MISSING", "detail": "" }),
                            ));
                        } else {
                            out.push(reply(MessageType::Ready, json!({})));
                        }
                    }
                    MessageType::Activate => {
                        out.push(reply(MessageType::Ready, json!({})));
                        if !b.no_frame {
                            out.push(Envelope::new(MessageType::FramePresented, uuid::Uuid::new_v4().to_string(), None, json!({
                                "display_id": envelope.payload["display_id"], "manifest_id": envelope.payload["manifest_id"],
                            })).encode());
                        }
                    }
                    MessageType::GetStatus => {
                        out.push(reply(MessageType::Status, json!({ "displays": [] })))
                    }
                    _ => {}
                }
            }
            for line in out {
                if write
                    .write_all(format!("{line}\n").as_bytes())
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }
    })
}
