//! Connexion du renderer à l’agent (NAT-006) : socket local, lignes JSON bornées. Le
//! renderer ne détient aucun secret ; il ne parle qu’à l’agent de la même machine.

use pixlova_contracts::ipc::{DecodeError, Envelope, IPC_MAX_MESSAGE_BYTES, MessageType};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Écriture partagée entre le fil d’IPC, la boucle d’événements et le minuteur.
#[derive(Clone)]
pub struct AgentWriter {
    stream: Arc<Mutex<UnixStream>>,
}

impl AgentWriter {
    pub fn send(&self, kind: MessageType, correlation_id: Option<String>, payload: Value) -> bool {
        let line = Envelope::new(kind, new_id(), correlation_id, payload).encode();
        let mut stream = self.stream.lock().unwrap_or_else(|p| p.into_inner());
        stream
            .write_all(line.as_bytes())
            .and_then(|()| stream.write_all(b"\n"))
            .is_ok()
    }

    pub fn reply(&self, to: &Envelope, kind: MessageType, payload: Value) -> bool {
        self.send(kind, Some(to.message_id.clone()), payload)
    }

    pub fn error(&self, to: &Envelope, code: &str, detail: &str) -> bool {
        self.reply(
            to,
            MessageType::Error,
            json!({ "code": code, "detail": detail }),
        )
    }
}

/// Identifiant de message unique pour ce processus (pas de secret, pas d’aléa requis).
pub fn new_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(1);
    format!(
        "r{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

pub struct AgentReader {
    reader: BufReader<UnixStream>,
}

impl AgentReader {
    /// Prochain message ; `None` en fin de connexion ou flux invalide (trop long).
    pub fn next(&mut self) -> Option<Result<Envelope, DecodeError>> {
        let mut buffer = Vec::new();
        let read = (&mut self.reader)
            .take(IPC_MAX_MESSAGE_BYTES as u64 + 1)
            .read_until(b'\n', &mut buffer)
            .ok()?;
        if read == 0 {
            return None;
        }
        if buffer.last() == Some(&b'\n') {
            buffer.pop();
        } else if buffer.len() > IPC_MAX_MESSAGE_BYTES {
            return None;
        }
        let line = String::from_utf8(buffer).ok()?;
        Some(Envelope::decode(&line))
    }
}

/// Se connecte (l’agent peut démarrer après le renderer) puis envoie `HELLO`.
pub fn connect(socket: &Path, engine: &str) -> (AgentReader, AgentWriter) {
    let stream = loop {
        match UnixStream::connect(socket) {
            Ok(stream) => break stream,
            Err(_) => std::thread::sleep(Duration::from_millis(500)),
        }
    };
    let writer = AgentWriter {
        stream: Arc::new(Mutex::new(stream.try_clone().expect("socket dupliqué"))),
    };
    writer.send(
        MessageType::Hello,
        None,
        json!({ "renderer_version": env!("CARGO_PKG_VERSION"), "engine": engine }),
    );
    (
        AgentReader {
            reader: BufReader::new(stream),
        },
        writer,
    )
}

pub fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
