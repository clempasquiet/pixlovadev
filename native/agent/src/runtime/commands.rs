//! Commandes distantes (SUP-005, PROTO-007, PROTO-008, ADR-014).
//!
//! Ordre : vérification de la signature et du schéma, décision (tenant, Player, génération,
//! capacité, expiration), inscription durable, ACK, exécution, résultat enregistré puis
//! transmis. Un doublon n’est jamais ré-exécuté ; une commande lancée sans résultat
//! enregistré avant un redémarrage est déclarée `unknown`.

use super::Runtime;
use crate::cloud::CloudError;
use crate::store::CommandRow;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use pixlova_contracts::command::{
    CommandContext, CommandDecision, CommandPayload, Support, evaluate_command, verify_command,
};
use pixlova_contracts::ipc::{MessageType, ScreenshotReply};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;

const SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(20);
/// Taille maximale d’une capture acceptée par l’API (SUP-004).
const SCREENSHOT_MAX_BYTES: usize = 5 * 1024 * 1024;

/// Issue d’une commande, au format `CommandResult`.
pub(super) struct Outcome {
    status: &'static str,
    code: Option<String>,
    detail: Option<String>,
}

impl Outcome {
    fn success(detail: impl Into<Option<String>>) -> Self {
        Self {
            status: "success",
            code: None,
            detail: detail.into(),
        }
    }

    fn failed(code: &str, detail: impl Into<Option<String>>) -> Self {
        Self {
            status: "failed",
            code: Some(code.to_owned()),
            detail: detail.into(),
        }
    }

    fn rejected(code: &str) -> Self {
        Self {
            status: "rejected",
            code: Some(code.to_owned()),
            detail: None,
        }
    }

    fn unknown(code: &str) -> Self {
        Self {
            status: "unknown",
            code: Some(code.to_owned()),
            detail: None,
        }
    }
}

/// Code d’erreur conforme au contrat (`^[A-Z][A-Z0-9_]{1,63}$`), sinon générique.
fn contract_code(code: &str) -> String {
    let valid = code.len() >= 2
        && code.len() <= 64
        && code.starts_with(|c: char| c.is_ascii_uppercase())
        && code
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if valid {
        code.to_owned()
    } else {
        "COMMAND_FAILED".into()
    }
}

/// Identifiant annoncé par une enveloppe non vérifiée : seulement pour déclarer son refus,
/// jamais pour agir.
fn unverified_id(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    let id = value.get("payload")?.get("command_id")?.as_str()?;
    (id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'))
        .then(|| id.to_ascii_lowercase())
}

impl Runtime {
    fn result_json(&self, command_id: &str, outcome: &Outcome) -> Value {
        let (_, now) = self.now();
        json!({
            "command_id": command_id,
            "status": outcome.status,
            "finished_at": now,
            "code": outcome.code.as_deref().map(contract_code),
            "detail": outcome.detail.as_ref().map(|d| d.chars().take(500).collect::<String>()),
        })
    }

    /// Au démarrage : une commande lancée sans résultat a un effet inconnu ; une commande
    /// accusée mais jamais lancée ne sera plus redistribuée et n’a eu aucun effet.
    pub(super) fn recover_commands(&self) {
        let (_, now) = self.now();
        for (state, outcome) in [
            ("running", Outcome::unknown("INTERRUPTED")),
            (
                "received",
                Outcome::failed("INTERRUPTED_BEFORE_START", None),
            ),
        ] {
            for row in self.store.commands_in_state(state).unwrap_or_default() {
                if state == "received" && !row.ack_sent {
                    // Toujours `sent` côté cloud : redistribuée, puis exécutée comme doublon.
                    continue;
                }
                let result = self.result_json(&row.command_id, &outcome).to_string();
                let _ = self.store.finish_command(&row.command_id, &result, &now);
                tracing::warn!(command_id = %row.command_id, state, "commande interrompue par un redémarrage");
            }
        }
    }

    /// Récupère, vérifie et exécute les commandes en attente.
    pub(super) async fn process_commands(&self, org: &str, player: &str) -> Result<(), CloudError> {
        for raw in self.cloud.commands().await? {
            self.handle_command(org, player, &raw).await;
        }
        self.flush_commands().await;
        Ok(())
    }

    async fn handle_command(&self, org: &str, player: &str, raw: &str) {
        let (_, now) = self.now();
        let verified = match verify_command(raw, &self.command_trust) {
            Ok(verified) => verified,
            Err(error) => {
                tracing::warn!(code = error.code(), "commande refusée avant tout effet");
                // Refus déclaré pour que la commande cesse d’être redistribuée.
                if let Some(id) = unverified_id(raw)
                    && self.store.command(&id).ok().flatten().is_none()
                {
                    let result = self.result_json(&id, &Outcome::rejected(error.code()));
                    let _ = self.cloud.command_result(&id, &result).await;
                }
                return;
            }
        };
        let command = verified.command;
        let assignments = self
            .store
            .displays()
            .unwrap_or_default()
            .into_iter()
            .filter(|d| d.assigned)
            .map(|d| (d.display_id, d.assignment_generation))
            .collect();
        let context = CommandContext {
            organization_id: org.to_owned(),
            player_id: player.to_owned(),
            assignments,
            seen: self.store.command_hashes().unwrap_or_default(),
            reboot_host: Support::Unsupported,
            screenshot: if self.screenshot_supported {
                Support::Supported
            } else {
                Support::Unsupported
            },
        };
        let mut row = CommandRow {
            command_id: command.command_id.clone(),
            command_hash: verified.command_hash.clone(),
            kind: command.kind.clone(),
            state: "received".into(),
            ack_sent: false,
            result: None,
            result_sent: false,
            expires_at: command.expires_at.clone(),
        };
        match evaluate_command(&command, &verified.command_hash, &context, &now) {
            CommandDecision::Duplicate => {
                // Inscrite mais jamais lancée (arrêt avant l’ACK) : exécutée maintenant.
                let pending = self
                    .store
                    .command(&command.command_id)
                    .ok()
                    .flatten()
                    .is_some_and(|r| r.state == "received" && !r.ack_sent);
                if pending {
                    self.run_command(&command).await;
                }
            }
            CommandDecision::Reject(rejection) => {
                tracing::warn!(command_id = %command.command_id, code = rejection.as_str(), "commande refusée");
                if self
                    .store
                    .command(&command.command_id)
                    .ok()
                    .flatten()
                    .is_some()
                {
                    // Même identifiant, contenu différent : le premier reste seul valable.
                    return;
                }
                row.state = "done".into();
                row.result = Some(
                    self.result_json(&command.command_id, &Outcome::rejected(rejection.as_str()))
                        .to_string(),
                );
                if let Err(error) = self.store.record_command(&row, &now) {
                    tracing::error!(%error, "refus non enregistré");
                }
            }
            CommandDecision::Execute => {
                if let Err(error) = self.store.record_command(&row, &now) {
                    // Sans inscription durable, aucune exécution.
                    tracing::error!(%error, "commande non inscrite : non exécutée");
                    return;
                }
                self.run_command(&command).await;
            }
        }
    }

    async fn run_command(&self, command: &CommandPayload) {
        let id = &command.command_id;
        let (now_millis, now) = self.now();
        // L’ACK signifie « reçue et inscrite », jamais « réussie ».
        if self.cloud.command_ack(id, now_millis).await.is_ok() {
            let _ = self.store.mark_command_ack(id);
        }
        let _ = self.store.set_command_running(id, &now);
        tracing::info!(command_id = %id, kind = %command.kind, "commande lancée");
        let outcome = self.execute(command).await;
        let result = self.result_json(id, &outcome);
        let (_, finished) = self.now();
        if let Err(error) = self
            .store
            .finish_command(id, &result.to_string(), &finished)
        {
            tracing::error!(%error, "résultat non enregistré");
        }
        tracing::info!(command_id = %id, status = outcome.status, code = ?outcome.code, "commande terminée");
    }

    async fn execute(&self, command: &CommandPayload) -> Outcome {
        match command.kind.as_str() {
            "FORCE_SYNC" => {
                self.wake.notify_one();
                Outcome::success("synchronisation lancée".to_owned())
            }
            "RELOAD_CONTENT" => {
                self.configure_renderer().await;
                let _guard = self.activation.lock().await;
                match self.pipeline.restore_all().await {
                    Ok(()) => Outcome::success(None),
                    Err(error) => Outcome::failed("RELOAD_FAILED", error.to_string()),
                }
            }
            "GET_STATUS" => match self.send_status().await {
                Ok(()) => Outcome::success(None),
                Err(error) => Outcome::failed(error.code(), None),
            },
            "RESTART_RENDERER" => match self.link.peer_pid() {
                Some(pid) => {
                    crate::supervisor::kill_process(pid).await;
                    Outcome::success("renderer arrêté, relance par la supervision".to_owned())
                }
                None => Outcome::failed("RENDERER_UNAVAILABLE", None),
            },
            "CLEAR_UNUSED_CACHE" => match self.cache.collect_garbage() {
                Ok(freed) => Outcome::success(format!("{freed} octets libérés")),
                Err(error) => Outcome::failed("CACHE_ERROR", error.to_string()),
            },
            "TAKE_SCREENSHOT" => self.take_screenshot(command).await,
            // Distribution des releases et redémarrage de l’hôte absents de cette version.
            _ => Outcome::rejected("UNSUPPORTED_COMMAND"),
        }
    }

    /// Capture de la vue du Display par le renderer, envoyée au stockage privé (SUP-004).
    async fn take_screenshot(&self, command: &CommandPayload) -> Outcome {
        let (Some(display_id), Some(screenshot_id)) = (
            command.display_id.as_deref(),
            command.params.get("screenshot_id").and_then(Value::as_str),
        ) else {
            return Outcome::rejected("SCHEMA_INVALID");
        };
        let reply = match self
            .link
            .request(
                MessageType::Screenshot,
                json!({ "display_id": display_id }),
                SCREENSHOT_TIMEOUT,
            )
            .await
        {
            Ok(reply) => reply,
            Err(error) => return Outcome::failed(error.code(), None),
        };
        let (captured_millis, _) = self.now();
        let Ok(reply) = serde_json::from_value::<ScreenshotReply>(reply) else {
            return Outcome::failed("SCREENSHOT_INVALID", None);
        };
        if reply.mime_type != "image/png" || reply.display_id != display_id {
            return Outcome::failed("SCREENSHOT_INVALID", None);
        }
        let Ok(bytes) = STANDARD.decode(reply.data_base64.as_bytes()) else {
            return Outcome::failed("SCREENSHOT_INVALID", None);
        };
        if bytes.is_empty() || bytes.len() > SCREENSHOT_MAX_BYTES {
            return Outcome::failed("SCREENSHOT_TOO_LARGE", format!("{} octets", bytes.len()));
        }
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let request = json!({
            "command_id": command.command_id,
            "screenshot_id": screenshot_id,
            "mime_type": "image/png",
            "size_bytes": bytes.len(),
            "sha256": sha256,
            "captured_at": crate::clock::format_instant(captured_millis),
        });
        let uploaded = async {
            let session = self.cloud.screenshot_session(&request).await?;
            self.cloud.upload(&session.upload, bytes).await?;
            self.cloud.screenshot_complete(screenshot_id).await
        }
        .await;
        match uploaded {
            Ok(()) => Outcome::success(None),
            Err(error) => Outcome::failed(error.code(), None),
        }
    }

    /// ACK et résultats encore à transmettre (après une coupure).
    pub(super) async fn flush_commands(&self) {
        let (now_millis, _) = self.now();
        for row in self.store.command_outbox().unwrap_or_default() {
            if !row.ack_sent && row.state != "done" {
                match self.cloud.command_ack(&row.command_id, now_millis).await {
                    Ok(())
                    | Err(CloudError::Api {
                        status: 404 | 409, ..
                    }) => {
                        let _ = self.store.mark_command_ack(&row.command_id);
                    }
                    Err(_) => return,
                }
            }
            if let (Some(result), false) = (row.result.as_deref(), row.result_sent) {
                let body: Value = serde_json::from_str(result).unwrap_or(Value::Null);
                match self.cloud.command_result(&row.command_id, &body).await {
                    // 409 : un autre résultat fait foi côté cloud ; 404 : commande oubliée.
                    Ok(())
                    | Err(CloudError::Api {
                        status: 404 | 409, ..
                    }) => {
                        let _ = self.store.mark_result_sent(&row.command_id);
                    }
                    Err(error) => {
                        tracing::debug!(%error, "résultat de commande conservé pour plus tard");
                        return;
                    }
                }
            }
        }
        // Une heure après expiration, plus aucune redistribution possible.
        let expired_before = crate::clock::format_instant(now_millis - 3_600_000);
        let _ = self.store.prune_commands(&expired_before);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_et_identifiants_bornes() {
        assert_eq!(contract_code("RENDERER_TIMEOUT"), "RENDERER_TIMEOUT");
        assert_eq!(contract_code("HTTP_503"), "HTTP_503");
        assert_eq!(contract_code("réseau"), "COMMAND_FAILED");
        assert_eq!(
            unverified_id(r#"{"payload":{"command_id":"AAAAAAAA-0000-4000-8000-000000000001"}}"#)
                .as_deref(),
            Some("aaaaaaaa-0000-4000-8000-000000000001")
        );
        assert_eq!(unverified_id(r#"{"payload":{"command_id":"../x"}}"#), None);
        assert_eq!(unverified_id("pas du json"), None);
    }
}
