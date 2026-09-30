//! Réception et activation atomique des manifests, Display par Display (NAT-008,
//! PROTO-013). La diffusion courante n’est jamais interrompue par une préparation :
//! `current` ne change qu’à la première image confirmée du nouveau manifest.

use crate::cache::{Cache, CacheError};
use crate::clock::{Clock, clock_is_plausible, format_instant, parse_instant_millis};
use crate::cloud::{Cloud, CloudError, ManifestFetch};
use crate::ipc::{IpcError, RendererEvent, RendererLink};
use crate::store::{AssetRow, DisplayRow, Store, StoreError, StoredManifest};
use pixlova_contracts::ipc::{ActivatePayload, MessageType, PreparePayload};
use pixlova_contracts::manifest::VerifiedManifest;
use pixlova_contracts::{
    LocalAssociation, LocalDisplayState, ManifestDecision, ManifestRejection, TrustStore,
    evaluate_manifest_candidate, verify_manifest,
};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Délai accordé au renderer pour préparer un manifest (décodage, polices).
const PREPARE_TIMEOUT: Duration = Duration::from_secs(120);
const RETRY_BASE_MILLIS: i64 = 10_000;
const RETRY_MAX_MILLIS: i64 = 10 * 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Rien à faire.
    Idle,
    /// Nouveau manifest courant, première image confirmée.
    Applied(String),
    /// Préparation en attente (renderer absent, `valid_from` futur, nouvel essai planifié).
    Waiting(&'static str),
    /// Échec transitoire, nouvel essai planifié.
    Retrying(String),
    /// Échec définitif du candidat ; l’ancien contenu continue.
    Failed(String),
}

#[derive(Debug, thiserror::Error)]
pub enum PipelineError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Cloud(#[from] CloudError),
}

struct Retry {
    manifest_id: String,
    attempts: u32,
    next_at: i64,
    reported: Option<String>,
}

#[derive(Clone)]
pub struct Pipeline {
    store: Store,
    cache: Cache,
    cloud: Cloud,
    trust: Arc<TrustStore>,
    renderer: RendererLink,
    clock: Arc<dyn Clock>,
    activation_timeout: Duration,
    retries: Arc<Mutex<HashMap<String, Retry>>>,
}

enum Failure {
    Transient(String, String),
    Permanent(String, String),
}

impl From<CacheError> for Failure {
    fn from(error: CacheError) -> Self {
        let (code, detail) = (error.code().to_owned(), error.to_string());
        if error.is_transient() {
            Failure::Transient(code, detail)
        } else {
            Failure::Permanent(code, detail)
        }
    }
}

impl From<StoreError> for Failure {
    fn from(error: StoreError) -> Self {
        Failure::Transient("LOCAL_STORAGE_ERROR".into(), error.to_string())
    }
}

fn asset_rows(verified: &VerifiedManifest) -> Vec<AssetRow> {
    verified
        .manifest
        .assets
        .iter()
        .map(|a| AssetRow {
            asset_id: a.id.clone(),
            sha256: a.sha256.clone(),
            size_bytes: a.size_bytes,
            mime_type: a.mime_type.clone(),
        })
        .collect()
}

impl Pipeline {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: Store,
        cache: Cache,
        cloud: Cloud,
        trust: TrustStore,
        renderer: RendererLink,
        clock: Arc<dyn Clock>,
        activation_timeout: Duration,
    ) -> Self {
        Self {
            store,
            cache,
            cloud,
            trust: Arc::new(trust),
            renderer,
            clock,
            activation_timeout,
            retries: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn now(&self) -> (i64, String) {
        let now = self.clock.now_millis();
        (now, format_instant(now))
    }

    fn retries(&self) -> std::sync::MutexGuard<'_, HashMap<String, Retry>> {
        self.retries.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Relit et revérifie un manifest stocké : une base altérée ne fait rien jouer.
    fn load_verified(
        &self,
        manifest_id: &str,
    ) -> Result<Option<(StoredManifest, VerifiedManifest)>, StoreError> {
        let Some(stored) = self.store.manifest(manifest_id)? else {
            return Ok(None);
        };
        match verify_manifest(&stored.envelope, &self.trust) {
            Ok(verified) if verified.manifest.manifest_id == manifest_id => {
                Ok(Some((stored, verified)))
            }
            _ => {
                tracing::error!(manifest_id, "manifest local invalide : ignoré");
                Ok(None)
            }
        }
    }

    // --- Étapes 1 et 2 : réception, vérification, acceptation ---------------------------

    /// Interroge le cloud pour un Display et place un candidat accepté en `staging`.
    pub async fn fetch_candidate(
        &self,
        organization_id: &str,
        player_id: &str,
        row: &DisplayRow,
    ) -> Result<Option<String>, PipelineError> {
        let raw = match self
            .cloud
            .manifest(&row.display_id, row.highest_hash.as_deref())
            .await?
        {
            ManifestFetch::Envelope(raw) => raw,
            ManifestFetch::NotModified | ManifestFetch::None => return Ok(None),
        };
        let (now_millis, now) = self.now();
        let verified = match verify_manifest(&raw, &self.trust) {
            Ok(verified) => verified,
            Err(error) => {
                // Non authentique ou invalide : rien n’est appliqué ni déclaré au nom du manifest.
                tracing::warn!(
                    display_id = row.display_id.as_str(),
                    code = error.code(),
                    "manifest refusé"
                );
                self.store
                    .set_display_error(&row.display_id, Some(error.code()))?;
                return Ok(None);
            }
        };
        if !clock_is_plausible(now_millis) {
            tracing::warn!("horloge invalide : aucune nouvelle activation");
            self.store
                .set_display_error(&row.display_id, Some("CLOCK_INVALID"))?;
            return Ok(None);
        }
        let local = LocalAssociation {
            organization_id: organization_id.to_owned(),
            player_id: player_id.to_owned(),
            displays: HashMap::from([(
                row.display_id.clone(),
                LocalDisplayState {
                    assignment_generation: row.assignment_generation.clone(),
                    highest_version: row.highest_version.clone(),
                    highest_version_hash: row.highest_hash.clone(),
                },
            )]),
        };
        let manifest = &verified.manifest;
        match evaluate_manifest_candidate(manifest, &verified.manifest_hash, &local, &now) {
            ManifestDecision::Duplicate => Ok(None),
            ManifestDecision::Reject(ManifestRejection::VersionReplayed) => Ok(None),
            ManifestDecision::Reject(rejection) => {
                tracing::warn!(manifest = %manifest.manifest_id, reason = rejection.as_str(), "manifest rejeté");
                self.store
                    .set_display_error(&row.display_id, Some(rejection.as_str()))?;
                self.store.push_delivery(
                    &manifest.manifest_id,
                    "failed",
                    Some(rejection.as_str()),
                    None,
                    &now,
                )?;
                Ok(None)
            }
            ManifestDecision::Accept { .. } => {
                self.store.insert_manifest(
                    &StoredManifest {
                        manifest_id: manifest.manifest_id.clone(),
                        display_id: manifest.display_id.clone(),
                        version: manifest.version.clone(),
                        assignment_generation: manifest.assignment_generation.clone(),
                        manifest_hash: verified.manifest_hash.clone(),
                        envelope: raw,
                    },
                    &asset_rows(&verified),
                    &now,
                )?;
                self.store.set_staging(
                    &row.display_id,
                    &manifest.manifest_id,
                    &manifest.version,
                    &verified.manifest_hash,
                )?;
                self.store
                    .push_delivery(&manifest.manifest_id, "downloading", None, None, &now)?;
                self.retries().remove(&row.display_id);
                tracing::info!(display_id = row.display_id.as_str(), manifest = %manifest.manifest_id, version = %manifest.version, "nouveau manifest en préparation");
                Ok(Some(manifest.manifest_id.clone()))
            }
        }
    }

    // --- Étapes 3 à 9 : téléchargement, préparation, activation -------------------------

    /// Fait progresser le candidat d’un Display. Sans effet sur la diffusion courante tant
    /// que la première image du candidat n’est pas confirmée.
    pub async fn advance(&self, display_id: &str) -> Result<Outcome, StoreError> {
        let Some(display) = self.store.display(display_id)? else {
            return Ok(Outcome::Idle);
        };
        let Some(manifest_id) = display
            .staging_manifest
            .clone()
            .filter(|_| display.assigned)
        else {
            return Ok(Outcome::Idle);
        };
        let (now_millis, _) = self.now();
        if let Some(retry) = self.retries().get(display_id)
            && retry.manifest_id == manifest_id
            && retry.next_at > now_millis
        {
            return Ok(Outcome::Waiting("retry"));
        }
        let Some((_, verified)) = self.load_verified(&manifest_id)? else {
            self.store
                .clear_staging(display_id, Some("MANIFEST_INVALID"))?;
            return Ok(Outcome::Failed("MANIFEST_INVALID".into()));
        };
        match self.prepare_and_activate(&display, &verified).await {
            Ok(outcome) => {
                if matches!(outcome, Outcome::Applied(_)) {
                    self.retries().remove(display_id);
                }
                Ok(outcome)
            }
            Err(Failure::Permanent(code, detail)) => {
                tracing::warn!(display_id, manifest = %manifest_id, %code, %detail, "préparation abandonnée");
                let (_, now) = self.now();
                self.store.abort_activation(
                    display_id,
                    &manifest_id,
                    &code,
                    &detail,
                    &now,
                    false,
                )?;
                self.retries().remove(display_id);
                Ok(Outcome::Failed(code))
            }
            Err(Failure::Transient(code, detail)) => {
                tracing::info!(display_id, manifest = %manifest_id, %code, %detail, "préparation reportée");
                let (now_millis, now) = self.now();
                let report = {
                    let mut retries = self.retries();
                    let retry = retries.entry(display_id.to_owned()).or_insert(Retry {
                        manifest_id: manifest_id.clone(),
                        attempts: 0,
                        next_at: 0,
                        reported: None,
                    });
                    if retry.manifest_id != manifest_id {
                        *retry = Retry {
                            manifest_id: manifest_id.clone(),
                            attempts: 0,
                            next_at: 0,
                            reported: None,
                        };
                    }
                    retry.attempts += 1;
                    let delay = RETRY_BASE_MILLIS
                        .saturating_mul(1 << retry.attempts.min(10))
                        .min(RETRY_MAX_MILLIS);
                    retry.next_at = now_millis + delay;
                    let report = retry.reported.as_deref() != Some(code.as_str());
                    retry.reported = Some(code.clone());
                    report
                };
                // Un même échec n’est déclaré qu’une fois par candidat.
                if report {
                    self.store.push_delivery(
                        &manifest_id,
                        "failed",
                        Some(&code),
                        Some(&detail),
                        &now,
                    )?;
                }
                self.store.set_display_error(display_id, Some(&code))?;
                Ok(Outcome::Retrying(code))
            }
        }
    }

    async fn prepare_and_activate(
        &self,
        row: &DisplayRow,
        verified: &VerifiedManifest,
    ) -> Result<Outcome, Failure> {
        let manifest = &verified.manifest;
        let (now_millis, _) = self.now();
        if !clock_is_plausible(now_millis) {
            return Ok(Outcome::Waiting("clock"));
        }
        let activate_before = parse_instant_millis(&manifest.activate_before).unwrap_or(i64::MIN);
        if now_millis >= activate_before {
            return Err(Failure::Permanent(
                ManifestRejection::ActivationWindowExpired.as_str().into(),
                "fenêtre d’activation dépassée".into(),
            ));
        }
        let assets = asset_rows(verified);
        self.cache.ensure_space(self.cache.missing_bytes(&assets))?;
        for asset in &assets {
            self.cache
                .fetch(&self.cloud, &manifest.manifest_id, asset)
                .await?;
        }
        for asset in &assets {
            if !self.cache.verify_blob(asset)? {
                return Err(Failure::Transient(
                    "CHECKSUM_MISMATCH".into(),
                    format!("blob {} altéré", asset.asset_id),
                ));
            }
        }
        let valid_from = parse_instant_millis(&manifest.valid_from).unwrap_or(0);
        if now_millis < valid_from {
            return Ok(Outcome::Waiting("valid_from"));
        }
        if !self.renderer.is_connected() {
            return Ok(Outcome::Waiting("renderer"));
        }
        self.prepare(&row.display_id, verified, &assets)
            .await
            .map_err(|error| match error {
                IpcError::Remote { code, detail } => Failure::Permanent(code, detail),
                other => Failure::Transient(other.code().into(), other.to_string()),
            })?;
        let (_, now) = self.now();
        self.store
            .push_delivery(&manifest.manifest_id, "ready", None, None, &now)?;
        self.store
            .begin_intent(&row.display_id, &manifest.manifest_id, &now)?;
        match self
            .activate_and_confirm(&row.display_id, &manifest.manifest_id)
            .await
        {
            Ok(()) => {
                let (_, now) = self.now();
                self.store
                    .commit_activation(&row.display_id, &manifest.manifest_id, &now)?;
                self.cache.touch(&assets)?;
                tracing::info!(display_id = row.display_id.as_str(), manifest = %manifest.manifest_id, "manifest appliqué");
                Ok(Outcome::Applied(manifest.manifest_id.clone()))
            }
            Err(error) => {
                // Retour immédiat à l’ancien contenu ; l’intention est close par l’appelant.
                self.restore_display(&row.display_id).await;
                Err(match error {
                    IpcError::Timeout => Failure::Permanent(
                        "ACTIVATION_TIMEOUT".into(),
                        "première image non confirmée".into(),
                    ),
                    IpcError::Remote { code, detail } => Failure::Permanent(code, detail),
                    IpcError::NotConnected => Failure::Transient(
                        "ACTIVATION_INTERRUPTED".into(),
                        "renderer déconnecté pendant l’activation".into(),
                    ),
                })
            }
        }
    }

    async fn prepare(
        &self,
        display_id: &str,
        verified: &VerifiedManifest,
        assets: &[AssetRow],
    ) -> Result<(), IpcError> {
        let payload = PreparePayload {
            display_id: display_id.to_owned(),
            manifest_id: verified.manifest.manifest_id.clone(),
            manifest: verified.document.clone(),
            assets: assets
                .iter()
                .map(|a| (a.asset_id.clone(), a.sha256.clone()))
                .collect::<BTreeMap<_, _>>(),
        };
        self.renderer
            .request(
                MessageType::Prepare,
                serde_json::to_value(payload).expect("payload sérialisable"),
                PREPARE_TIMEOUT,
            )
            .await
            .map(|_| ())
    }

    async fn activate_and_confirm(
        &self,
        display_id: &str,
        manifest_id: &str,
    ) -> Result<(), IpcError> {
        let mut events = self.renderer.subscribe();
        let payload = ActivatePayload {
            display_id: display_id.to_owned(),
            manifest_id: manifest_id.to_owned(),
        };
        self.renderer
            .request(
                MessageType::Activate,
                serde_json::to_value(payload).expect("payload sérialisable"),
                self.activation_timeout,
            )
            .await?;
        let wait = async {
            loop {
                match events.recv().await {
                    Ok(RendererEvent::FramePresented {
                        display_id: Some(d),
                        manifest_id: Some(m),
                    }) if d == display_id && m == manifest_id => return Ok(()),
                    Ok(RendererEvent::Disconnected { .. }) => return Err(IpcError::NotConnected),
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        return Err(IpcError::NotConnected);
                    }
                }
            }
        };
        tokio::time::timeout(self.activation_timeout, wait)
            .await
            .unwrap_or(Err(IpcError::Timeout))
    }

    // --- Reprise ------------------------------------------------------------------------

    /// Au démarrage : toute intention ouverte correspond à une activation interrompue
    /// (coupure, crash). L’ancien manifest reste courant ; le candidat sera repris.
    pub fn recover_intents(&self) -> Result<usize, StoreError> {
        let intents = self.store.intents()?;
        let (_, now) = self.now();
        for intent in &intents {
            tracing::warn!(display_id = %intent.display_id, manifest = %intent.new_manifest, "activation interrompue : retour à l’état confirmé");
            self.store.abort_activation(
                &intent.display_id,
                &intent.new_manifest,
                "ACTIVATION_INTERRUPTED",
                "activation interrompue avant confirmation",
                &now,
                true,
            )?;
        }
        Ok(intents.len())
    }

    /// Remet le manifest courant d’un Display dans le renderer (reconnexion, retour
    /// arrière), sans le cloud. Retourne vrai si un manifest a été activé.
    pub async fn restore_display(&self, display_id: &str) -> bool {
        let Ok(Some(display)) = self.store.display(display_id) else {
            return false;
        };
        for manifest_id in [&display.current_manifest, &display.previous_manifest]
            .into_iter()
            .flatten()
        {
            let Ok(Some((_, verified))) = self.load_verified(manifest_id) else {
                continue;
            };
            let assets = asset_rows(&verified);
            let complete = assets
                .iter()
                .all(|a| self.cache.verify_blob(a).unwrap_or(false));
            if !complete {
                tracing::error!(display_id, manifest = %manifest_id, "assets manquants : manifest non restauré");
                continue;
            }
            if self.prepare(display_id, &verified, &assets).await.is_ok()
                && self
                    .renderer
                    .request(
                        MessageType::Activate,
                        serde_json::json!({ "display_id": display_id, "manifest_id": manifest_id }),
                        self.activation_timeout,
                    )
                    .await
                    .is_ok()
            {
                return true;
            }
        }
        false
    }

    /// Reconnexion du renderer : manifests courants de tous les Displays affectés.
    pub async fn restore_all(&self) -> Result<(), StoreError> {
        for display in self.store.displays()? {
            if display.assigned && display.current_manifest.is_some() {
                self.restore_display(&display.display_id).await;
            }
        }
        Ok(())
    }
}
