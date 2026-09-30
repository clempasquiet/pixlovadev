//! Serveur IPC côté agent (NAT-006, SEC-012) : socket Unix `0600`, pair authentifié par
//! `SO_PEERCRED` (même compte), une seule connexion renderer à la fois (la plus récente).

use pixlova_contracts::ipc::{
    DecodeError, Envelope, ErrorPayload, IPC_MAX_MESSAGE_BYTES, MessageType, StatusPayload,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{broadcast, mpsc, oneshot};

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum IpcError {
    #[error("renderer non connecté")]
    NotConnected,
    #[error("renderer sans réponse")]
    Timeout,
    #[error("renderer : {code} ({detail})")]
    Remote { code: String, detail: String },
}

impl IpcError {
    pub fn code(&self) -> &str {
        match self {
            Self::NotConnected => "RENDERER_UNAVAILABLE",
            Self::Timeout => "RENDERER_TIMEOUT",
            Self::Remote { code, .. } => code,
        }
    }
}

/// Événements spontanés du renderer.
#[derive(Debug, Clone, PartialEq)]
pub enum RendererEvent {
    /// Nouvelle connexion authentifiée (`HELLO` reçu) ; `connection` l’identifie.
    Connected {
        connection: u64,
        pid: Option<i32>,
        /// Version déclarée par le renderer dans `HELLO`.
        version: Option<String>,
    },
    Disconnected {
        connection: u64,
    },
    FramePresented {
        display_id: Option<String>,
        manifest_id: Option<String>,
    },
    Status(StatusPayload),
}

struct Connection {
    id: u64,
    pid: Option<i32>,
    outbox: mpsc::Sender<String>,
    hello: bool,
    /// Abandonné quand la connexion est remplacée ou fermée par l’agent.
    _cancel: oneshot::Sender<()>,
}

struct Inner {
    connection: Option<Connection>,
    pending: HashMap<String, oneshot::Sender<Result<Value, IpcError>>>,
    last_seen: Option<Instant>,
    last_status: Option<StatusPayload>,
    next_id: u64,
}

/// Poignée partagée vers le renderer connecté.
#[derive(Clone)]
pub struct RendererLink {
    inner: Arc<Mutex<Inner>>,
    events: broadcast::Sender<RendererEvent>,
}

impl Default for RendererLink {
    fn default() -> Self {
        Self::new()
    }
}

impl RendererLink {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                connection: None,
                pending: HashMap::new(),
                last_seen: None,
                last_status: None,
                next_id: 0,
            })),
            events: broadcast::channel(256).0,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RendererEvent> {
        self.events.subscribe()
    }

    pub fn is_connected(&self) -> bool {
        self.lock().connection.as_ref().is_some_and(|c| c.hello)
    }

    /// Processus du renderer connecté, d’après le noyau (pas d’après ses déclarations).
    pub fn peer_pid(&self) -> Option<i32> {
        self.lock().connection.as_ref().and_then(|c| c.pid)
    }

    /// Temps écoulé depuis le dernier message du renderer connecté.
    pub fn silence(&self) -> Option<Duration> {
        let inner = self.lock();
        inner.connection.as_ref()?;
        inner.last_seen.map(|t| t.elapsed())
    }

    pub fn last_status(&self) -> Option<StatusPayload> {
        self.lock().last_status.clone()
    }

    /// Ferme la connexion courante (renderer figé, remplacé).
    pub fn disconnect(&self) {
        let mut inner = self.lock();
        if let Some(connection) = inner.connection.take() {
            let _ = self.events.send(RendererEvent::Disconnected {
                connection: connection.id,
            });
        }
        for (_, waiter) in inner.pending.drain() {
            let _ = waiter.send(Err(IpcError::NotConnected));
        }
    }

    /// Envoie une commande et attend sa réponse (`READY`, `STATUS`) ou son `ERROR`.
    pub async fn request(
        &self,
        kind: MessageType,
        payload: Value,
        timeout: Duration,
    ) -> Result<Value, IpcError> {
        let message_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        let outbox = {
            let mut inner = self.lock();
            let connection = inner
                .connection
                .as_ref()
                .filter(|c| c.hello)
                .ok_or(IpcError::NotConnected)?;
            let outbox = connection.outbox.clone();
            inner.pending.insert(message_id.clone(), tx);
            outbox
        };
        let line = Envelope::new(kind, message_id.clone(), None, payload).encode();
        if outbox.send(line).await.is_err() {
            self.lock().pending.remove(&message_id);
            return Err(IpcError::NotConnected);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(IpcError::NotConnected),
            Err(_) => {
                self.lock().pending.remove(&message_id);
                Err(IpcError::Timeout)
            }
        }
    }

    /// Envoi sans réponse attendue (`CONFIGURE`, `RELOAD`).
    pub async fn notify(&self, kind: MessageType, payload: Value) -> Result<(), IpcError> {
        let outbox = self
            .lock()
            .connection
            .as_ref()
            .filter(|c| c.hello)
            .map(|c| c.outbox.clone())
            .ok_or(IpcError::NotConnected)?;
        let line = Envelope::new(kind, uuid::Uuid::new_v4().to_string(), None, payload).encode();
        outbox.send(line).await.map_err(|_| IpcError::NotConnected)
    }

    fn handle(&self, connection: u64, envelope: Envelope) -> Option<String> {
        let mut inner = self.lock();
        if inner.connection.as_ref().map(|c| c.id) != Some(connection) {
            return None;
        }
        inner.last_seen = Some(Instant::now());
        let hello = inner.connection.as_ref().is_some_and(|c| c.hello);
        if !hello && envelope.kind != MessageType::Hello {
            return Some(error_line(&envelope, "HELLO_REQUIRED", "HELLO attendu"));
        }
        if envelope.kind.from_agent() {
            return Some(error_line(
                &envelope,
                "UNEXPECTED_TYPE",
                "type réservé à l’agent",
            ));
        }
        match envelope.kind {
            MessageType::Hello => {
                let pid = inner.connection.as_mut().map(|c| {
                    c.hello = true;
                    c.pid
                });
                drop(inner);
                let _ = self.events.send(RendererEvent::Connected {
                    connection,
                    pid: pid.flatten(),
                    version: envelope
                        .payload
                        .get("renderer_version")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                });
            }
            MessageType::Ready | MessageType::Status | MessageType::Error
                if envelope.correlation_id.is_some() =>
            {
                let waiter = envelope
                    .correlation_id
                    .as_ref()
                    .and_then(|id| inner.pending.remove(id));
                if envelope.kind == MessageType::Status
                    && let Ok(status) = serde_json::from_value(envelope.payload.clone())
                {
                    inner.last_status = Some(status);
                }
                if let Some(waiter) = waiter {
                    let result = if envelope.kind == MessageType::Error {
                        let error: ErrorPayload = serde_json::from_value(envelope.payload)
                            .unwrap_or(ErrorPayload {
                                code: "RENDERER_ERROR".into(),
                                detail: String::new(),
                            });
                        Err(IpcError::Remote {
                            code: error.code,
                            detail: error.detail,
                        })
                    } else {
                        Ok(envelope.payload)
                    };
                    let _ = waiter.send(result);
                }
            }
            MessageType::Status => {
                match serde_json::from_value::<StatusPayload>(envelope.payload.clone()) {
                    Ok(status) => {
                        inner.last_status = Some(status.clone());
                        drop(inner);
                        let _ = self.events.send(RendererEvent::Status(status));
                    }
                    Err(error) => {
                        return Some(error_line(
                            &envelope,
                            "MALFORMED_MESSAGE",
                            &error.to_string(),
                        ));
                    }
                }
            }
            MessageType::FramePresented => {
                drop(inner);
                let _ = self.events.send(RendererEvent::FramePresented {
                    display_id: envelope
                        .payload
                        .get("display_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    manifest_id: envelope
                        .payload
                        .get("manifest_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                });
            }
            _ => {}
        }
        None
    }
}

fn error_line(envelope: &Envelope, code: &str, detail: &str) -> String {
    Envelope::new(
        MessageType::Error,
        uuid::Uuid::new_v4().to_string(),
        Some(envelope.message_id.clone()),
        json!({ "code": code, "detail": detail }),
    )
    .encode()
}

fn decode_error_line(error: &DecodeError) -> String {
    Envelope::new(
        MessageType::Error,
        uuid::Uuid::new_v4().to_string(),
        None,
        json!({ "code": error.code(), "detail": "" }),
    )
    .encode()
}

/// Lit une ligne d’au plus `IPC_MAX_MESSAGE_BYTES` ; `Ok(None)` en fin de flux.
pub async fn read_line<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
) -> std::io::Result<Option<Result<String, DecodeError>>> {
    let mut buffer = Vec::new();
    let read = (&mut *reader)
        .take(IPC_MAX_MESSAGE_BYTES as u64 + 1)
        .read_until(b'\n', &mut buffer)
        .await?;
    if read == 0 {
        return Ok(None);
    }
    if buffer.last() == Some(&b'\n') {
        buffer.pop();
    } else if buffer.len() > IPC_MAX_MESSAGE_BYTES {
        return Ok(Some(Err(DecodeError::TooLarge)));
    }
    Ok(Some(String::from_utf8(buffer).map_err(|_| {
        DecodeError::Malformed("UTF-8 invalide".into())
    })))
}

pub struct IpcServer {
    listener: UnixListener,
    path: PathBuf,
    uid: u32,
}

impl IpcServer {
    /// Crée le socket `0600` dans un dossier `0700`, en remplaçant un socket orphelin.
    pub fn bind(path: &Path) -> std::io::Result<Self> {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let listener = UnixListener::bind(path)?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        // Propriétaire du socket = compte effectif de l’agent.
        let uid = std::fs::metadata(path)?.uid();
        Ok(Self {
            listener,
            path: path.to_path_buf(),
            uid,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Accepte les renderers ; chaque nouvelle connexion authentifiée remplace la précédente.
    pub async fn serve(self, link: RendererLink) {
        loop {
            let Ok((stream, _)) = self.listener.accept().await else {
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            };
            let credentials = stream.peer_cred();
            let Ok(credentials) = credentials else {
                continue;
            };
            if credentials.uid() != self.uid {
                tracing::warn!(
                    uid = credentials.uid(),
                    "connexion IPC d’un autre compte refusée"
                );
                continue;
            }
            let link = link.clone();
            tokio::spawn(handle_connection(stream, credentials.pid(), link));
        }
    }
}

async fn handle_connection(stream: UnixStream, pid: Option<i32>, link: RendererLink) {
    let (read, mut write) = stream.into_split();
    let (tx, mut rx) = mpsc::channel::<String>(64);
    let (cancel, mut cancelled) = oneshot::channel::<()>();
    let id = {
        let mut inner = link.lock();
        inner.next_id += 1;
        let id = inner.next_id;
        if let Some(previous) = inner.connection.take() {
            let _ = link.events.send(RendererEvent::Disconnected {
                connection: previous.id,
            });
        }
        for (_, waiter) in inner.pending.drain() {
            let _ = waiter.send(Err(IpcError::NotConnected));
        }
        inner.connection = Some(Connection {
            id,
            pid,
            outbox: tx.clone(),
            hello: false,
            _cancel: cancel,
        });
        inner.last_seen = Some(Instant::now());
        id
    };
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write.write_all(line.as_bytes()).await.is_err()
                || write.write_all(b"\n").await.is_err()
            {
                break;
            }
        }
    });
    let mut reader = BufReader::new(read);
    loop {
        let line = tokio::select! {
            line = read_line(&mut reader) => match line {
                Ok(Some(line)) => line,
                _ => break,
            },
            _ = &mut cancelled => break,
        };
        let reply = match line.and_then(|line| Envelope::decode(&line)) {
            Ok(envelope) => link.handle(id, envelope),
            Err(error @ DecodeError::TooLarge) => {
                // Flux désynchronisé : la connexion est fermée.
                let _ = tx.send(decode_error_line(&error)).await;
                break;
            }
            Err(error) => Some(decode_error_line(&error)),
        };
        if let Some(reply) = reply
            && tx.send(reply).await.is_err()
        {
            break;
        }
        if link.lock().connection.as_ref().map(|c| c.id) != Some(id) {
            break;
        }
    }
    {
        let mut inner = link.lock();
        if inner.connection.as_ref().map(|c| c.id) == Some(id) {
            inner.connection = None;
            for (_, waiter) in inner.pending.drain() {
                let _ = waiter.send(Err(IpcError::NotConnected));
            }
            drop(inner);
            let _ = link
                .events
                .send(RendererEvent::Disconnected { connection: id });
        }
    }
    // Laisse partir un dernier message d’erreur avant de fermer.
    drop(tx);
    if tokio::time::timeout(Duration::from_secs(1), writer)
        .await
        .is_err()
    {
        tracing::debug!("écriture IPC interrompue à la fermeture");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    async fn setup() -> (
        tempfile::TempDir,
        RendererLink,
        BufReader<tokio::net::unix::OwnedReadHalf>,
        tokio::net::unix::OwnedWriteHalf,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("run").join("agent.sock");
        let server = IpcServer::bind(&path).unwrap();
        let link = RendererLink::new();
        tokio::spawn(server.serve(link.clone()));
        let stream = UnixStream::connect(&path).await.unwrap();
        let (read, write) = stream.into_split();
        (dir, link, BufReader::new(read), write)
    }

    async fn send(
        write: &mut tokio::net::unix::OwnedWriteHalf,
        kind: MessageType,
        correlation: Option<String>,
        payload: Value,
    ) {
        let line =
            Envelope::new(kind, uuid::Uuid::new_v4().to_string(), correlation, payload).encode();
        write
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
    }

    async fn next(reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>) -> Envelope {
        let line = read_line(reader).await.unwrap().unwrap().unwrap();
        Envelope::decode(&line).unwrap()
    }

    #[tokio::test]
    async fn requete_reponse_et_refus() {
        let (dir, link, mut reader, mut write) = setup().await;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join("run/agent.sock"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let mut events = link.subscribe();
        // Avant HELLO, rien n’est accepté.
        send(
            &mut write,
            MessageType::Status,
            None,
            json!({ "displays": [] }),
        )
        .await;
        assert_eq!(next(&mut reader).await.payload["code"], "HELLO_REQUIRED");
        send(
            &mut write,
            MessageType::Hello,
            None,
            json!({ "renderer_version": "0.1.0", "engine": "test" }),
        )
        .await;
        assert!(matches!(
            events.recv().await.unwrap(),
            RendererEvent::Connected { pid: Some(_), .. }
        ));
        assert!(link.is_connected());
        assert_eq!(link.peer_pid(), Some(std::process::id() as i32));

        let requester = link.clone();
        let pending = tokio::spawn(async move {
            requester
                .request(
                    MessageType::Prepare,
                    json!({ "display_id": "d" }),
                    Duration::from_secs(5),
                )
                .await
        });
        let prepare = next(&mut reader).await;
        assert_eq!(prepare.kind, MessageType::Prepare);
        send(
            &mut write,
            MessageType::Error,
            Some(prepare.message_id),
            json!({ "code": "DECODE_FAILED", "detail": "image" }),
        )
        .await;
        assert_eq!(pending.await.unwrap().unwrap_err().code(), "DECODE_FAILED");

        // Type inconnu ou réservé à l’agent : refusé, la connexion reste ouverte.
        write.write_all(b"{\"protocol_version\":1,\"message_id\":\"x\",\"type\":\"EXEC\",\"correlation_id\":null,\"payload\":{}}\n").await.unwrap();
        assert_eq!(next(&mut reader).await.payload["code"], "UNKNOWN_TYPE");
        send(&mut write, MessageType::Activate, None, json!({})).await;
        assert_eq!(next(&mut reader).await.payload["code"], "UNEXPECTED_TYPE");

        send(
            &mut write,
            MessageType::FramePresented,
            None,
            json!({ "display_id": "d", "manifest_id": "m" }),
        )
        .await;
        assert_eq!(
            events.recv().await.unwrap(),
            RendererEvent::FramePresented {
                display_id: Some("d".into()),
                manifest_id: Some("m".into())
            }
        );
    }

    #[tokio::test]
    async fn message_trop_long_ferme_la_connexion() {
        let (_dir, link, mut reader, mut write) = setup().await;
        send(
            &mut write,
            MessageType::Hello,
            None,
            json!({ "renderer_version": "0.1.0", "engine": "test" }),
        )
        .await;
        let big = vec![b'a'; IPC_MAX_MESSAGE_BYTES + 10];
        let _ = write.write_all(&big).await;
        assert_eq!(next(&mut reader).await.payload["code"], "MESSAGE_TOO_LARGE");
        assert!(read_line(&mut reader).await.unwrap().is_none());
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!link.is_connected());
    }

    #[tokio::test]
    async fn une_nouvelle_connexion_remplace_l_ancienne() {
        let (dir, link, mut old_reader, mut old_write) = setup().await;
        send(
            &mut old_write,
            MessageType::Hello,
            None,
            json!({ "renderer_version": "0.1.0", "engine": "test" }),
        )
        .await;
        let stream = UnixStream::connect(dir.path().join("run/agent.sock"))
            .await
            .unwrap();
        let (_read, mut write) = stream.into_split();
        send(
            &mut write,
            MessageType::Hello,
            None,
            json!({ "renderer_version": "0.1.0", "engine": "test" }),
        )
        .await;
        // Fin de flux ou réinitialisation : l’ancienne connexion est fermée.
        assert!(!matches!(read_line(&mut old_reader).await, Ok(Some(_))));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(link.is_connected());
        assert_eq!(
            link.request(
                MessageType::GetStatus,
                json!({}),
                Duration::from_millis(100)
            )
            .await,
            Err(IpcError::Timeout)
        );
    }
}
