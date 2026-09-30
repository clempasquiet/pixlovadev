//! Client de l’API Player `/player/v1` (PROTO-001 à PROTO-004).
//!
//! Le jeton d’accès reste en mémoire : l’agent se réauthentifie par challenge signé avec
//! la clé de l’appareil après un redémarrage ou une expiration (PROTO-002). Aucune URL
//! d’asset ni aucun jeton n’est journalisé.

use crate::clock::{format_instant, parse_instant_millis};
use crate::identity::DeviceIdentity;
use crate::platform::OutputReport;
use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

#[derive(Debug, thiserror::Error)]
pub enum CloudError {
    /// Cloud injoignable : la diffusion continue sur l’état local (NAT-011).
    #[error("réseau : {0}")]
    Network(String),
    #[error("HTTP {status} {code} : {message}")]
    Api {
        status: u16,
        code: String,
        message: String,
        retryable: bool,
    },
    /// Révocation explicite (SEC-007) : plus aucune synchronisation.
    #[error("Player révoqué ou désactivé")]
    Revoked,
    #[error("réponse invalide : {0}")]
    Protocol(String),
}

impl CloudError {
    pub fn code(&self) -> &str {
        match self {
            Self::Network(_) => "NETWORK_UNAVAILABLE",
            Self::Api { code, .. } => code,
            Self::Revoked => "PLAYER_REVOKED",
            Self::Protocol(_) => "PROTOCOL_ERROR",
        }
    }

    /// Erreur transitoire : réessayer plus tard sans rien changer localement.
    pub fn is_transient(&self) -> bool {
        match self {
            Self::Network(_) => true,
            Self::Api {
                status, retryable, ..
            } => *retryable || *status == 429 || *status >= 500,
            _ => false,
        }
    }
}

pub type CloudResult<T> = Result<T, CloudError>;

#[derive(Debug, Clone, Deserialize)]
pub struct Registration {
    pub registration_id: String,
    pub pairing_code: String,
    pub expires_at: String,
    pub poll_secret: String,
    pub poll_interval_s: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PairStatus {
    Pending {
        expires_at: String,
    },
    Paired {
        player_id: String,
        organization_id: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlayerConfig {
    pub player_id: String,
    pub organization_id: String,
    pub heartbeat_interval_s: u64,
    pub presence_timeout_s: u64,
    pub assignments: Vec<Assignment>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Assignment {
    pub display_id: String,
    pub assignment_generation: String,
    pub output_key: String,
    pub manifest_version: Option<String>,
    pub display: AssignedDisplay,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssignedDisplay {
    pub name: String,
    pub width: i64,
    pub height: i64,
    pub orientation: i64,
    pub timezone: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Heartbeat {
    pub uptime_seconds: u64,
    pub renderer: &'static str,
    pub displays: Vec<HeartbeatDisplay>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HeartbeatDisplay {
    pub display_id: String,
    pub assignment_generation: String,
    pub manifest_applied_version: Option<String>,
    pub playback: &'static str,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HeartbeatAck {
    pub server_time: String,
    pub stale_displays: Vec<String>,
    /// Absent d’un serveur antérieur à L07 : aucune commande annoncée.
    #[serde(default)]
    pub pending_commands: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EventsAck {
    pub accepted: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UploadTarget {
    pub url: String,
    pub headers: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ScreenshotSession {
    pub upload: UploadTarget,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssetUrl {
    pub asset_id: String,
    pub url: String,
    pub expires_at: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub range_supported: bool,
}

/// Réponse de `GET /manifest` : l’enveloppe brute, jamais réinterprétée avant vérification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestFetch {
    Envelope(String),
    NotModified,
    None,
}

#[derive(Clone)]
struct AccessToken {
    value: String,
    expires_millis: i64,
}

/// Client partagé ; le jeton est protégé par un verrou pour qu’une seule
/// réauthentification ait lieu à la fois.
#[derive(Clone)]
pub struct Cloud {
    http: reqwest::Client,
    /// Origine de l’API (`https://hôte[:port]`), pour les URLs de stockage relatives.
    origin: String,
    base: String,
    token: Arc<Mutex<Option<AccessToken>>>,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Deserialize)]
struct ErrorDetail {
    code: String,
    message: String,
    #[serde(default)]
    retryable: bool,
}

fn network(error: reqwest::Error) -> CloudError {
    // Sans l’URL : une URL d’asset signée ne doit pas finir dans un journal.
    CloudError::Network(error.without_url().to_string())
}

async fn error_from(response: reqwest::Response) -> CloudError {
    let status = response.status();
    let body: Option<ErrorBody> = response.json().await.ok();
    let (code, message, retryable) = body.map_or_else(
        || (format!("HTTP_{}", status.as_u16()), String::new(), false),
        |b| (b.error.code, b.error.message, b.error.retryable),
    );
    if code == "PLAYER_REVOKED" {
        return CloudError::Revoked;
    }
    CloudError::Api {
        status: status.as_u16(),
        code,
        message,
        retryable,
    }
}

impl Cloud {
    pub fn new(api_url: &str) -> CloudResult<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent(format!("pixlova-agent/{}", crate::AGENT_VERSION))
            .https_only(!is_local(api_url))
            .build()
            .map_err(|e| CloudError::Protocol(e.to_string()))?;
        let trimmed = api_url.trim_end_matches('/');
        let origin = trimmed
            .find("://")
            .and_then(|scheme| {
                trimmed[scheme + 3..]
                    .find('/')
                    .map(|path| &trimmed[..scheme + 3 + path])
            })
            .unwrap_or(trimmed)
            .to_owned();
        Ok(Self {
            http,
            origin,
            base: format!("{trimmed}/player/v1"),
            token: Arc::new(Mutex::new(None)),
        })
    }

    /// URL de téléchargement absolue : une URL relative désigne l’origine de l’API
    /// (stockage local signé) ; toute autre forme est refusée.
    pub fn absolute_url(&self, url: &str) -> Option<String> {
        if url.starts_with("https://") || url.starts_with("http://") {
            Some(url.to_owned())
        } else if url.starts_with('/') && !url.starts_with("//") {
            Some(format!("{}{url}", self.origin))
        } else {
            None
        }
    }

    /// Client HTTP pour les téléchargements (URLs de stockage signées, sans jeton Player).
    pub fn downloader(&self) -> reqwest::Client {
        self.http.clone()
    }

    async fn anonymous<T: DeserializeOwned>(&self, path: &str, body: &Value) -> CloudResult<T> {
        let response = self
            .http
            .post(format!("{}{path}", self.base))
            .json(body)
            .send()
            .await
            .map_err(network)?;
        if !response.status().is_success() {
            return Err(error_from(response).await);
        }
        response
            .json()
            .await
            .map_err(|e| CloudError::Protocol(e.to_string()))
    }

    /// Enregistrement d’une installation (PROTO-001 étape 2).
    pub async fn register(
        &self,
        installation_id: &str,
        identity: &DeviceIdentity,
        capabilities: Value,
        outputs: &[OutputReport],
    ) -> CloudResult<Registration> {
        self.anonymous(
            "/register",
            &json!({
                "installation_id": installation_id,
                "public_key": identity.public_key_b64u(),
                "capabilities": capabilities,
                "outputs": outputs,
                "machine_fingerprint": null,
            }),
        )
        .await
    }

    /// Suivi de l’appairage ; `PAIRING_EXPIRED` impose un nouvel enregistrement.
    pub async fn pair(&self, registration_id: &str, poll_secret: &str) -> CloudResult<PairStatus> {
        self.anonymous(
            "/pair",
            &json!({ "registration_id": registration_id, "poll_secret": poll_secret }),
        )
        .await
    }

    /// Challenge puis jeton (PROTO-002). `now_millis` sert à anticiper l’expiration.
    pub async fn authenticate(
        &self,
        player_id: &str,
        identity: &DeviceIdentity,
    ) -> CloudResult<()> {
        #[derive(Deserialize)]
        struct Challenge {
            challenge: Value,
        }
        #[derive(Deserialize)]
        struct Token {
            access_token: String,
            expires_at: String,
        }
        let Challenge { challenge } = self
            .anonymous("/token/challenge", &json!({ "player_id": player_id }))
            .await?;
        let challenge_id = challenge
            .get("challenge_id")
            .and_then(Value::as_str)
            .ok_or_else(|| CloudError::Protocol("challenge sans identifiant".into()))?
            .to_owned();
        if challenge.get("player_id").and_then(Value::as_str) != Some(player_id) {
            return Err(CloudError::Protocol("challenge d’un autre Player".into()));
        }
        let signature = pixlova_contracts::player_auth::sign_player_challenge(
            identity.signing_key(),
            &challenge,
        )
        .map_err(|_| CloudError::Protocol("challenge hors domaine Player".into()))?;
        let token: Token = self
            .anonymous(
                "/token/refresh",
                &json!({ "challenge_id": challenge_id, "signature": signature }),
            )
            .await?;
        let expires_millis = parse_instant_millis(&token.expires_at)
            .ok_or_else(|| CloudError::Protocol("expiration de jeton invalide".into()))?;
        *self.token.lock().await = Some(AccessToken {
            value: token.access_token,
            expires_millis,
        });
        Ok(())
    }

    /// Jeton courant s’il reste valable plus d’une minute selon l’horloge fournie.
    pub async fn has_token(&self, now_millis: i64) -> bool {
        self.token
            .lock()
            .await
            .as_ref()
            .is_some_and(|t| t.expires_millis - 60_000 > now_millis)
    }

    pub async fn forget_token(&self) {
        *self.token.lock().await = None;
    }

    async fn bearer(&self) -> CloudResult<String> {
        self.token
            .lock()
            .await
            .as_ref()
            .map(|t| t.value.clone())
            .ok_or(CloudError::Api {
                status: 401,
                code: "UNAUTHORIZED".into(),
                message: "aucun jeton".into(),
                retryable: false,
            })
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> CloudResult<reqwest::Response> {
        let response = request
            .bearer_auth(self.bearer().await?)
            .send()
            .await
            .map_err(network)?;
        if response.status() == StatusCode::UNAUTHORIZED {
            // Jeton expiré ou révoqué côté serveur : l’appelant se réauthentifie.
            self.forget_token().await;
        }
        Ok(response)
    }

    async fn json<T: DeserializeOwned>(&self, request: reqwest::RequestBuilder) -> CloudResult<T> {
        let response = self.send(request).await?;
        if !response.status().is_success() {
            return Err(error_from(response).await);
        }
        response
            .json()
            .await
            .map_err(|e| CloudError::Protocol(e.to_string()))
    }

    async fn no_content(&self, request: reqwest::RequestBuilder) -> CloudResult<()> {
        let response = self.send(request).await?;
        if !response.status().is_success() {
            return Err(error_from(response).await);
        }
        Ok(())
    }

    pub async fn config(&self) -> CloudResult<PlayerConfig> {
        self.json(self.http.get(format!("{}/config", self.base)))
            .await
    }

    pub async fn report_outputs(&self, outputs: &[OutputReport]) -> CloudResult<()> {
        self.no_content(
            self.http
                .post(format!("{}/outputs", self.base))
                .json(&json!({ "outputs": outputs })),
        )
        .await
    }

    pub async fn heartbeat(&self, heartbeat: &Heartbeat) -> CloudResult<HeartbeatAck> {
        self.json(
            self.http
                .post(format!("{}/heartbeat", self.base))
                .json(heartbeat),
        )
        .await
    }

    /// Dernier manifest désiré ; `known_hash` évite de retélécharger une version connue.
    pub async fn manifest(
        &self,
        display_id: &str,
        known_hash: Option<&str>,
    ) -> CloudResult<ManifestFetch> {
        let mut request = self
            .http
            .get(format!("{}/manifest", self.base))
            .query(&[("display_id", display_id)]);
        if let Some(hash) = known_hash {
            request = request.header("if-none-match", format!("\"{hash}\""));
        }
        let response = self.send(request).await?;
        match response.status() {
            StatusCode::NOT_MODIFIED => Ok(ManifestFetch::NotModified),
            StatusCode::NOT_FOUND => Ok(ManifestFetch::None),
            status if status.is_success() => {
                if response.content_length().is_some_and(|len| {
                    len > pixlova_contracts::signature::DEFAULT_MAX_ENVELOPE_BYTES as u64
                }) {
                    return Err(CloudError::Protocol("manifest trop volumineux".into()));
                }
                response
                    .text()
                    .await
                    .map(ManifestFetch::Envelope)
                    .map_err(network)
            }
            _ => Err(error_from(response).await),
        }
    }

    pub async fn asset_url(&self, asset_id: &str, manifest_id: &str) -> CloudResult<AssetUrl> {
        self.json(
            self.http
                .get(format!("{}/assets/{asset_id}/url", self.base))
                .query(&[("manifest_id", manifest_id)]),
        )
        .await
    }

    /// Lot d’événements ; seuls les identifiants accusés peuvent être retirés (PROTO-019).
    pub async fn events(&self, events: &[Value], dropped_count: u64) -> CloudResult<EventsAck> {
        self.json(
            self.http
                .post(format!("{}/events", self.base))
                .json(&json!({ "events": events, "dropped_count": dropped_count })),
        )
        .await
    }

    pub async fn status(&self, status: &Value) -> CloudResult<()> {
        self.no_content(self.http.post(format!("{}/status", self.base)).json(status))
            .await
    }

    /// Enveloppes de commandes, jamais interprétées avant vérification.
    pub async fn commands(&self) -> CloudResult<Vec<String>> {
        #[derive(Deserialize)]
        struct Commands {
            commands: Vec<String>,
        }
        let body: Commands = self
            .json(self.http.get(format!("{}/commands", self.base)))
            .await?;
        Ok(body.commands)
    }

    pub async fn command_ack(&self, command_id: &str, acknowledged_millis: i64) -> CloudResult<()> {
        self.json::<Value>(
            self.http
                .post(format!("{}/commands/{command_id}/ack", self.base))
                .json(&json!({ "acknowledged_at": format_instant(acknowledged_millis) })),
        )
        .await
        .map(|_| ())
    }

    pub async fn command_result(&self, command_id: &str, result: &Value) -> CloudResult<()> {
        self.json::<Value>(
            self.http
                .post(format!("{}/commands/{command_id}/result", self.base))
                .json(result),
        )
        .await
        .map(|_| ())
    }

    pub async fn screenshot_session(&self, request: &Value) -> CloudResult<ScreenshotSession> {
        self.json(
            self.http
                .post(format!("{}/screenshots/upload-session", self.base))
                .json(request),
        )
        .await
    }

    /// Envoi direct vers le stockage : URL signée, sans jeton Player.
    pub async fn upload(&self, target: &UploadTarget, bytes: Vec<u8>) -> CloudResult<()> {
        let url = self
            .absolute_url(&target.url)
            .ok_or_else(|| CloudError::Protocol("URL d’envoi refusée".into()))?;
        let mut request = self.http.put(url).body(bytes);
        for (name, value) in &target.headers {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(network)?;
        if !response.status().is_success() {
            return Err(CloudError::Api {
                status: response.status().as_u16(),
                code: "UPLOAD_FAILED".into(),
                message: String::new(),
                retryable: response.status().is_server_error(),
            });
        }
        Ok(())
    }

    pub async fn screenshot_complete(&self, screenshot_id: &str) -> CloudResult<()> {
        self.json::<Value>(self.http.post(format!(
            "{}/screenshots/{screenshot_id}/complete",
            self.base
        )))
        .await
        .map(|_| ())
    }

    pub async fn manifest_status(
        &self,
        manifest_id: &str,
        state: &str,
        observed_millis: i64,
        error_code: Option<&str>,
        detail: Option<&str>,
    ) -> CloudResult<()> {
        let detail = detail.map(|d| d.chars().take(500).collect::<String>());
        self.json::<Value>(
            self.http
                .post(format!("{}/manifests/{manifest_id}/status", self.base))
                .json(&json!({
                    "state": state,
                    "observed_at": format_instant(observed_millis),
                    "error_code": error_code,
                    "detail": detail,
                })),
        )
        .await
        .map(|_| ())
    }
}

fn is_local(url: &str) -> bool {
    url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resout_les_urls_de_stockage_relatives_sur_l_origine_de_l_api() {
        let cloud = Cloud::new("https://api.example.test/prefixe/").unwrap();
        assert_eq!(
            cloud.absolute_url("/storage/v1/objects/a?sig=x").as_deref(),
            Some("https://api.example.test/storage/v1/objects/a?sig=x")
        );
        assert_eq!(
            cloud.absolute_url("https://cdn.example.test/a").as_deref(),
            Some("https://cdn.example.test/a")
        );
        assert_eq!(cloud.absolute_url("//evil.test/a"), None);
        assert_eq!(cloud.absolute_url("file:///etc/passwd"), None);
    }
}
