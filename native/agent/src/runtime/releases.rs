//! Mises à jour distribuées par le cloud (PLY-005, NAT-013, SEC-011, ADR-019).
//!
//! Le cloud indique la release souhaitée ; rien n’est cru avant vérification : signature
//! avec les seules clés de release, plateforme, protocole, version postérieure, taille et
//! empreinte du paquet. L’installation passe par `updater::apply` (version `pending` du
//! lanceur A/B), puis l’agent s’arrête pour que le lanceur l’essaie. Un retour arrière
//! demandé (release bloquée, commande `ROLLBACK_PLAYER`) est exécuté par le lanceur, base
//! fermée. Sans lanceur (développement), aucune mise à jour n’est tentée.

use super::Runtime;
use crate::cloud::{CloudError, DesiredRelease};
use crate::supervision::Severity;
use crate::updater::{self, LauncherState, UpdateError};
use futures_util::StreamExt;
use pixlova_contracts::release::{parse_version, verify_release};
use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::time::Instant;

/// Issue d’un contrôle de release.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ReleaseAction {
    /// Aucune release souhaitée, ou version en service déjà à jour.
    UpToDate,
    /// Version installée en attente, ou retour arrière inscrit : redémarrage demandé.
    Restart(String),
}

/// Échec d’un contrôle : code de contrat et détail borné.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ReleaseFailure {
    pub code: String,
    pub detail: Option<String>,
}

impl ReleaseFailure {
    fn new(code: &str, detail: impl Into<Option<String>>) -> Self {
        Self {
            code: code.to_owned(),
            detail: detail.into(),
        }
    }
}

impl From<CloudError> for ReleaseFailure {
    fn from(error: CloudError) -> Self {
        Self::new(error.code(), None)
    }
}

impl From<UpdateError> for ReleaseFailure {
    fn from(error: UpdateError) -> Self {
        Self::new(error.code(), error.to_string())
    }
}

/// Version annoncée au cloud seulement si elle a la forme d’une release (`a.b.c`).
fn release_version() -> Option<&'static str> {
    parse_version(crate::AGENT_VERSION).map(|_| crate::AGENT_VERSION)
}

/// État local → état déclaré (`pending` est l’ancien nom de `installed`).
fn reported_state(state: &str) -> Option<&'static str> {
    match state {
        "installed" | "pending" => Some("installed"),
        "promoted" => Some("promoted"),
        "rolled_back" => Some("rolled_back"),
        "failed" => Some("failed"),
        _ => None,
    }
}

impl Runtime {
    /// Mises à jour possibles : lancé par le lanceur A/B et clés de release installées.
    fn updates_supported(&self) -> Result<(), ReleaseFailure> {
        if !self.config.under_launcher {
            return Err(ReleaseFailure::new(
                "LAUNCHER_ABSENT",
                "agent lancé hors du lanceur A/B : mise à jour impossible".to_owned(),
            ));
        }
        if self.release_trust.is_empty() {
            return Err(ReleaseFailure::new("NO_RELEASE_KEYS", None));
        }
        Ok(())
    }

    /// Contrôle périodique (au plus une fois par intervalle) ; échecs journalisés.
    pub(super) async fn periodic_release_check(&self) {
        if self.updates_supported().is_err() {
            return;
        }
        let due = self
            .release_checked
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_none_or(|at| at.elapsed() >= self.config.release_check_interval);
        if !due {
            return;
        }
        *self
            .release_checked
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
        match self.check_release(None, false).await {
            Ok(ReleaseAction::UpToDate) => {}
            Ok(ReleaseAction::Restart(reason)) => self.request_restart(&reason),
            Err(failure) => {
                tracing::warn!(code = %failure.code, detail = ?failure.detail, "mise à jour non appliquée")
            }
        }
    }

    /// Contrôle de la release souhaitée. `expected` : release visée par `UPDATE_PLAYER`.
    /// `forced` : retour arrière explicite (`ROLLBACK_PLAYER`), sans consulter le cloud.
    pub(super) async fn check_release(
        &self,
        expected: Option<&str>,
        forced: bool,
    ) -> Result<ReleaseAction, ReleaseFailure> {
        self.updates_supported()?;
        let data_dir = self.config.data_dir.clone();
        if forced {
            let target = updater::request_rollback(&data_dir, "retour arrière demandé à distance")?;
            return Ok(ReleaseAction::Restart(format!(
                "retour arrière vers {target}"
            )));
        }
        let state = LauncherState::load(&data_dir).map_err(UpdateError::from)?;
        if state.pending.is_some() {
            return Err(UpdateError::TrialInProgress.into());
        }
        let desired: DesiredRelease = self.cloud.desired_release(release_version()).await?;
        if desired.rollback && expected.is_none() {
            let target = updater::request_rollback(&data_dir, "release bloquée par la plateforme")?;
            return Ok(ReleaseAction::Restart(format!(
                "retour arrière vers {target}"
            )));
        }
        let (Some(raw), Some(package)) = (desired.release, desired.package) else {
            return match expected {
                Some(_) => Err(ReleaseFailure::new("RELEASE_UNAVAILABLE", None)),
                None => Ok(ReleaseAction::UpToDate),
            };
        };
        let verified = verify_release(&raw, &self.release_trust)
            .map_err(|e| ReleaseFailure::new(e.code(), e.to_string()))?;
        let release = verified.release;
        if let Some(id) = expected
            && id != release.release_id
        {
            return Err(ReleaseFailure::new("RELEASE_CHANGED", None));
        }
        let current = state
            .current
            .clone()
            .unwrap_or_else(|| crate::AGENT_VERSION.to_owned());
        if parse_version(&release.version) <= parse_version(&current) {
            return Ok(ReleaseAction::UpToDate);
        }
        if state.blocked.contains(&release.version) {
            // Revenue en arrière ici : jamais réinstallée automatiquement (NAT-014).
            return match expected {
                Some(_) => Err(UpdateError::Blocked(release.version).into()),
                None => Ok(ReleaseAction::UpToDate),
            };
        }
        if package.size_bytes != release.package.size_bytes
            || package.sha256 != release.package.sha256
        {
            return Err(ReleaseFailure::new(
                "PACKAGE_MISMATCH",
                "paquet annoncé différent des métadonnées signées".to_owned(),
            ));
        }
        let (_, now) = self.now();
        let result = async {
            let path = self
                .download_package(
                    &release.release_id,
                    &package.url,
                    release.package.size_bytes,
                )
                .await?;
            let running = crate::AGENT_VERSION.to_owned();
            let applied = tokio::task::spawn_blocking({
                let (data_dir, trust, raw, path, now) = (
                    data_dir.clone(),
                    self.release_trust.clone(),
                    raw.clone(),
                    path.clone(),
                    now.clone(),
                );
                move || updater::apply(&data_dir, &trust, &raw, &path, &running, &now)
            })
            .await
            .map_err(|e| ReleaseFailure::new("UPDATE_FAILED", e.to_string()))?;
            let _ = std::fs::remove_file(&path);
            applied.map_err(ReleaseFailure::from)
        }
        .await;
        match result {
            Ok(installed) => {
                let _ = self.store.record_update(
                    &installed.release.release_id,
                    &installed.release.version,
                    "installed",
                    None,
                    &now,
                );
                self.events.record(
                    "UPDATE_INSTALLED",
                    Severity::Info,
                    None,
                    json!({ "release_id": installed.release.release_id, "version": installed.release.version }),
                );
                Ok(ReleaseAction::Restart(format!(
                    "version {} installée",
                    installed.release.version
                )))
            }
            Err(failure) => {
                let detail = failure
                    .detail
                    .clone()
                    .unwrap_or_else(|| failure.code.clone());
                let _ = self.store.record_update(
                    &release.release_id,
                    &release.version,
                    "failed",
                    Some(&format!("{}: {detail}", failure.code)),
                    &now,
                );
                self.events.record(
                    "UPDATE_FAILED",
                    Severity::Error,
                    None,
                    json!({ "release_id": release.release_id, "version": release.version, "code": failure.code }),
                );
                Err(failure)
            }
        }
    }

    /// Paquet téléchargé dans `downloads/`, taille bornée par les métadonnées signées ;
    /// l’empreinte est revérifiée par `updater::apply` avant toute extraction.
    async fn download_package(
        &self,
        release_id: &str,
        url: &str,
        size: u64,
    ) -> Result<PathBuf, ReleaseFailure> {
        let address = self
            .cloud
            .absolute_url(url)
            .ok_or_else(|| ReleaseFailure::new("DOWNLOAD_FAILED", "URL refusée".to_owned()))?;
        let dir = self.config.downloads_dir();
        std::fs::create_dir_all(&dir).map_err(UpdateError::from)?;
        self.cache
            .ensure_space(size.saturating_mul(2))
            .map_err(|e| ReleaseFailure::new(e.code(), e.to_string()))?;
        let path = dir.join(format!("{release_id}.tar"));
        let failed = |detail: String| ReleaseFailure::new("DOWNLOAD_FAILED", detail);
        let response = self
            .cloud
            .package_downloader()
            .get(address)
            .send()
            .await
            .map_err(|e| failed(e.without_url().to_string()))?;
        if !response.status().is_success() {
            return Err(failed(format!("HTTP {}", response.status().as_u16())));
        }
        let mut file = std::fs::File::create(&path).map_err(UpdateError::from)?;
        let mut written = 0u64;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| failed(e.without_url().to_string()))?;
            written += chunk.len() as u64;
            if written > size {
                drop(file);
                let _ = std::fs::remove_file(&path);
                return Err(ReleaseFailure::new(
                    "PACKAGE_MISMATCH",
                    "paquet plus grand que prévu".to_owned(),
                ));
            }
            file.write_all(&chunk).map_err(UpdateError::from)?;
        }
        file.sync_all().map_err(UpdateError::from)?;
        if written != size {
            let _ = std::fs::remove_file(&path);
            return Err(failed(format!("{written} octets reçus sur {size}")));
        }
        Ok(path)
    }

    /// Arrêt propre demandé : le lanceur (systemd) relance et essaie la nouvelle version.
    pub(super) fn request_restart(&self, reason: &str) {
        tracing::warn!(reason, "redémarrage de l’agent pour mise à jour");
        self.restart.store(true, Ordering::SeqCst);
    }

    /// Redémarrage effectif, après l’envoi des résultats encore en attente.
    pub(super) async fn restart_if_requested(&self) -> bool {
        if !self.restart.load(Ordering::SeqCst) {
            return false;
        }
        self.flush_commands().await;
        self.report_updates().await;
        self.flush_events().await;
        self.shutdown.notify_waiters();
        true
    }

    /// États de mise à jour non encore déclarés (installée, promue, revenue, échec).
    pub(super) async fn report_updates(&self) {
        // La promotion est écrite par le lanceur pendant que l’agent tourne.
        self.import_update_history();
        for row in self.store.unreported_updates().unwrap_or_default() {
            let Some(state) = reported_state(&row.state) else {
                let _ = self.store.mark_update_reported(&row.release_id, &row.state);
                continue;
            };
            let code = (state == "failed").then(|| {
                row.detail
                    .as_deref()
                    .and_then(|d| d.split(':').next())
                    .filter(|c| {
                        c.len() >= 2
                            && c.len() <= 64
                            && c.starts_with(|ch: char| ch.is_ascii_uppercase())
                            && c.chars().all(|ch| {
                                ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_'
                            })
                    })
                    .unwrap_or("UPDATE_FAILED")
                    .to_owned()
            });
            let body: Value = json!({
                "version": row.version,
                "state": state,
                "code": code,
                "detail": row.detail.as_ref().map(|d| d.chars().take(500).collect::<String>()),
                "observed_at": row.updated_at,
            });
            match self.cloud.update_status(&row.release_id, &body).await {
                Ok(()) => {
                    let _ = self.store.mark_update_reported(&row.release_id, &row.state);
                }
                // Déclaration refusée définitivement : inutile de la rejouer.
                Err(CloudError::Api { status, .. })
                    if (400..500).contains(&status) && status != 401 && status != 429 =>
                {
                    let _ = self.store.mark_update_reported(&row.release_id, &row.state);
                }
                Err(error) => {
                    tracing::debug!(%error, "état de mise à jour conservé pour plus tard");
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn etats_declares() {
        assert_eq!(reported_state("pending"), Some("installed"));
        assert_eq!(reported_state("rolled_back"), Some("rolled_back"));
        assert_eq!(reported_state("autre"), None);
    }
}
