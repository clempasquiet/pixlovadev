//! Boucle principale de l’agent : appairage, synchronisation, activation, heartbeat et
//! supervision. Le cloud n’est jamais requis pour continuer à diffuser (NAT-011) :
//! chaque étape réseau peut échouer sans toucher à l’état local validé.

use crate::cache::Cache;
use crate::clock::{Clock, SystemClock, format_instant, parse_instant_millis};
use crate::cloud::{Cloud, CloudError, Heartbeat, HeartbeatDisplay, PairStatus, PlayerConfig};
use crate::config::AgentConfig;
use crate::identity::DeviceIdentity;
use crate::ipc::{IpcServer, RendererEvent, RendererLink};
use crate::pipeline::Pipeline;
use crate::platform::{OutputReport, capabilities, detect_outputs};
use crate::store::Store;
use crate::supervisor::{RendererHealth, Supervisor};
use crate::trust::TrustAnchors;
use pixlova_contracts::ipc::{ConfigurePayload, DisplaySurface, MessageType, Notice, Playback};
use serde_json::json;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// Dérive d’horloge signalée au-delà de ce seuil [à valider] (NAT-012).
pub const CLOCK_DRIFT_WARNING_MILLIS: i64 = 5 * 60_000;
/// Nouvelle déclaration des sorties, même sans changement.
const OUTPUTS_REFRESH: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("{0}")]
    Init(String),
}

/// État observable écrit dans `state/status.json` pour `pixlova-agent diagnose`.
#[derive(Default, Clone)]
struct Observed {
    online: bool,
    last_cloud_error: Option<String>,
    last_sync_at: Option<String>,
    clock_offset_ms: Option<i64>,
    notice: Option<Notice>,
}

pub struct Runtime {
    config: AgentConfig,
    store: Store,
    identity: DeviceIdentity,
    cloud: Cloud,
    link: RendererLink,
    health: RendererHealth,
    pipeline: Pipeline,
    cache: Cache,
    clock: Arc<dyn Clock>,
    /// Sérialise les activations entre la boucle et la restauration après reconnexion.
    activation: Arc<tokio::sync::Mutex<()>>,
    observed: Arc<Mutex<Observed>>,
    started: Instant,
    shutdown: Arc<Notify>,
}

fn init<E: std::fmt::Display>(context: &str) -> impl FnOnce(E) -> RuntimeError + '_ {
    move |error| RuntimeError::Init(format!("{context} : {error}"))
}

impl Runtime {
    pub fn new(config: AgentConfig) -> Result<(Self, IpcServer), RuntimeError> {
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let store = Store::open(&config.db_path()).map_err(init("base locale"))?;
        let identity =
            DeviceIdentity::load_or_create(&config.identity_dir()).map_err(init("identité"))?;
        let trust = TrustAnchors::load(&config.trust_dir).map_err(init("clés de confiance"))?;
        if trust.manifests.is_empty() {
            tracing::warn!(dir = %config.trust_dir.display(), "aucune clé de manifest installée : aucun contenu ne sera accepté");
        }
        let cache = Cache::open(
            &config.cache_dir(),
            store.clone(),
            config.cache_budget_bytes,
            config.reserve_bytes,
        )
        .map_err(init("cache"))?;
        let cloud = Cloud::new(&config.api_url).map_err(init("client HTTP"))?;
        let server = IpcServer::bind(&config.socket_path()).map_err(init("socket IPC"))?;
        let link = RendererLink::new();
        let health = RendererHealth::new(link.clone(), config.renderer_watchdog);
        let pipeline = Pipeline::new(
            store.clone(),
            cache.clone(),
            cloud.clone(),
            trust.manifests,
            link.clone(),
            clock.clone(),
            config.activation_timeout,
        );
        Ok((
            Self {
                config,
                store,
                identity,
                cloud,
                link,
                health,
                pipeline,
                cache,
                clock,
                activation: Arc::default(),
                observed: Arc::default(),
                started: Instant::now(),
                shutdown: Arc::new(Notify::new()),
            },
            server,
        ))
    }

    pub fn shutdown_handle(&self) -> Arc<Notify> {
        self.shutdown.clone()
    }

    fn now(&self) -> (i64, String) {
        let now = self.clock.now_millis();
        (now, format_instant(now))
    }

    /// Exécute l’agent jusqu’à l’arrêt demandé.
    pub async fn run(self, server: IpcServer) -> Result<(), RuntimeError> {
        let (_, now) = self.now();
        self.store
            .installation_id(&now)
            .map_err(init("installation"))?;
        let recovered = self.pipeline.recover_intents().map_err(init("reprise"))?;
        if recovered > 0 {
            tracing::warn!(recovered, "activations interrompues reprises");
        }
        if let Err(error) = self.cache.collect_garbage() {
            tracing::warn!(%error, "nettoyage du cache impossible");
        }
        let _ = std::fs::remove_file(self.config.health_marker());
        let this = Arc::new(self);
        tokio::spawn(server.serve(this.link.clone()));
        let supervisor = tokio::spawn(
            Supervisor {
                link: this.link.clone(),
                health: this.health.clone(),
                mode: this.config.renderer.clone(),
                socket: this.config.socket_path(),
                blobs: this.config.cache_dir().join("blobs"),
                watchdog: this.config.renderer_watchdog,
            }
            .run(this.shutdown.clone()),
        );
        let events = tokio::spawn(this.clone().renderer_events());
        tokio::select! {
            _ = this.clone().main_loop() => {}
            _ = this.shutdown.notified() => {}
        }
        this.shutdown.notify_waiters();
        events.abort();
        let _ = supervisor.await;
        let _ = std::fs::remove_file(this.config.socket_path());
        tracing::info!("agent arrêté");
        Ok(())
    }

    // --- Renderer -------------------------------------------------------------------------

    async fn renderer_events(self: Arc<Self>) {
        let mut events = self.link.subscribe();
        let mut healthy = false;
        loop {
            match events.recv().await {
                Ok(RendererEvent::Connected { pid, .. }) => {
                    tracing::info!(?pid, "renderer connecté");
                    self.configure_renderer().await;
                    let _guard = self.activation.lock().await;
                    if let Err(error) = self.pipeline.restore_all().await {
                        tracing::error!(%error, "restauration des manifests impossible");
                    }
                }
                Ok(RendererEvent::FramePresented { .. }) if !healthy => {
                    // Base ouverte, IPC prêt, renderer connecté, première image affichée :
                    // version saine pour le lanceur, même hors ligne (NAT-014).
                    healthy = self.write_health_marker();
                }
                Ok(RendererEvent::Disconnected { .. }) => tracing::warn!("renderer déconnecté"),
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            }
        }
    }

    fn write_health_marker(&self) -> bool {
        let path = self.config.health_marker();
        let (_, now) = self.now();
        let body = json!({ "version": crate::AGENT_VERSION, "at": now }).to_string();
        let result = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(&path, body));
        match result {
            Ok(()) => {
                tracing::info!("marqueur de santé écrit");
                true
            }
            Err(error) => {
                tracing::error!(%error, "marqueur de santé impossible");
                false
            }
        }
    }

    fn surfaces(&self) -> Vec<DisplaySurface> {
        self.store
            .displays()
            .unwrap_or_default()
            .into_iter()
            .filter(|d| d.assigned)
            .map(|d| DisplaySurface {
                display_id: d.display_id,
                output_key: d.output_key.unwrap_or_default(),
                name: d.name.unwrap_or_default(),
                width: d.width.unwrap_or(1920).clamp(1, 16_384) as u32,
                height: d.height.unwrap_or(1080).clamp(1, 16_384) as u32,
                orientation: d.orientation.unwrap_or(0).clamp(0, 270) as u32,
                timezone: d.timezone.unwrap_or_else(|| "UTC".into()),
            })
            .collect()
    }

    async fn configure_renderer(&self) {
        let notice = self.observed().notice;
        let displays = self.surfaces();
        let notice = if displays.is_empty() {
            notice.or(Some(Notice::Waiting))
        } else {
            None
        };
        let payload = ConfigurePayload { displays, notice };
        if self.link.is_connected()
            && let Err(error) = self
                .link
                .notify(
                    MessageType::Configure,
                    serde_json::to_value(payload).expect("payload sérialisable"),
                )
                .await
        {
            tracing::warn!(%error, "configuration du renderer impossible");
        }
    }

    fn observed(&self) -> Observed {
        self.observed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn observe(&self, update: impl FnOnce(&mut Observed)) {
        update(&mut self.observed.lock().unwrap_or_else(|p| p.into_inner()));
    }

    async fn set_notice(&self, notice: Option<Notice>) {
        if self.observed().notice != notice {
            self.observe(|o| o.notice = notice);
            self.configure_renderer().await;
        }
    }

    // --- Boucle principale ------------------------------------------------------------------

    async fn main_loop(self: Arc<Self>) {
        let mut outputs_reported: Option<(Vec<OutputReport>, Instant)> = None;
        loop {
            let pause = match self.store.association() {
                Ok(association) => match association.paired() {
                    Some((org, player)) => {
                        let (org, player) = (org.to_owned(), player.to_owned());
                        self.set_notice(None).await;
                        self.sync_once(&org, &player, &mut outputs_reported).await
                    }
                    None => self.pairing_step(&association).await,
                },
                Err(error) => {
                    tracing::error!(%error, "base locale illisible");
                    Duration::from_secs(10)
                }
            };
            self.write_status();
            tokio::time::sleep(pause).await;
        }
    }

    /// Enregistrement puis attente de l’appairage (PROTO-001). Le code est affiché par le
    /// renderer ; il n’est jamais journalisé en clair au-delà du niveau info.
    async fn pairing_step(&self, association: &crate::store::Association) -> Duration {
        let (now_millis, now) = self.now();
        let expired = association
            .pairing_expires_at
            .as_deref()
            .and_then(parse_instant_millis)
            .is_none_or(|expires| expires <= now_millis);
        let (Some(registration_id), Some(poll_secret), false) = (
            association.registration_id.as_deref(),
            association.poll_secret.as_deref(),
            expired,
        ) else {
            let installation = match self.store.installation_id(&now) {
                Ok(id) => id,
                Err(error) => {
                    tracing::error!(%error, "installation illisible");
                    return Duration::from_secs(10);
                }
            };
            let outputs = detect_outputs(self.config.virtual_outputs.as_deref());
            return match self
                .cloud
                .register(
                    &installation,
                    &self.identity,
                    capabilities(crate::AGENT_VERSION, None),
                    &outputs,
                )
                .await
            {
                Ok(registration) => {
                    let _ = self.store.save_registration(
                        &registration.registration_id,
                        &registration.poll_secret,
                        &registration.pairing_code,
                        &registration.expires_at,
                    );
                    tracing::info!(code = %registration.pairing_code, "code d’appairage affiché");
                    self.set_notice(Some(Notice::Pairing {
                        pairing_code: registration.pairing_code,
                        expires_at: registration.expires_at,
                    }))
                    .await;
                    self.cloud_ok();
                    Duration::from_secs(registration.poll_interval_s.clamp(1, 60))
                }
                Err(error) => self.cloud_failed(&error),
            };
        };
        if let (Some(code), Some(expires)) = (
            association.pairing_code.clone(),
            association.pairing_expires_at.clone(),
        ) {
            self.set_notice(Some(Notice::Pairing {
                pairing_code: code,
                expires_at: expires,
            }))
            .await;
        }
        match self.cloud.pair(registration_id, poll_secret).await {
            Ok(PairStatus::Paired {
                player_id,
                organization_id,
            }) => {
                tracing::info!(%player_id, "Player appairé");
                let _ = self.store.save_pairing(&organization_id, &player_id, &now);
                self.cloud_ok();
                Duration::ZERO
            }
            Ok(PairStatus::Pending { .. }) => {
                self.cloud_ok();
                Duration::from_secs(5).min(self.config.sync_interval)
            }
            Err(CloudError::Api { code, .. })
                if code == "PAIRING_EXPIRED" || code == "RESOURCE_NOT_FOUND" =>
            {
                // Nouvel enregistrement au prochain tour.
                let _ =
                    self.store
                        .save_registration(registration_id, "", "", "1970-01-01T00:00:00Z");
                Duration::ZERO
            }
            Err(error) => self.cloud_failed(&error),
        }
    }

    fn cloud_ok(&self) {
        let (_, now) = self.now();
        self.observe(|o| {
            o.online = true;
            o.last_cloud_error = None;
            o.last_sync_at = Some(now);
        });
    }

    fn cloud_failed(&self, error: &CloudError) -> Duration {
        let was_online = self.observed().online;
        if was_online {
            tracing::warn!(%error, "cloud injoignable : diffusion locale maintenue");
        } else {
            tracing::debug!(%error, "cloud toujours injoignable");
        }
        let code = error.code().to_owned();
        self.observe(|o| {
            o.online = false;
            o.last_cloud_error = Some(code);
        });
        Duration::from_secs(if error.is_transient() { 15 } else { 60 })
    }

    async fn revoke(&self) {
        let (_, now) = self.now();
        tracing::error!(
            "Player révoqué : synchronisation arrêtée, contenus du compte retirés de l’écran"
        );
        let _ = self.store.mark_revoked(&now);
        let _ = self.store.unassign_missing(&[], &now);
        self.cloud.forget_token().await;
        self.set_notice(Some(Notice::Revoked)).await;
        self.configure_renderer().await;
    }

    /// Un tour de synchronisation ; retourne la pause avant le suivant.
    async fn sync_once(
        &self,
        org: &str,
        player: &str,
        outputs_reported: &mut Option<(Vec<OutputReport>, Instant)>,
    ) -> Duration {
        let online = self.sync_cloud(org, player, outputs_reported).await;
        // Étapes locales, même hors ligne : activation différée, renderer revenu, reprise.
        self.advance_all().await;
        let pause = match online {
            Ok(interval) => {
                self.flush_outbox().await;
                interval
            }
            Err(error) => {
                if matches!(error, CloudError::Revoked) {
                    self.revoke().await;
                    return Duration::ZERO;
                }
                self.cloud_failed(&error)
            }
        };
        pause.min(self.config.sync_interval)
    }

    async fn sync_cloud(
        &self,
        org: &str,
        player: &str,
        outputs_reported: &mut Option<(Vec<OutputReport>, Instant)>,
    ) -> Result<Duration, CloudError> {
        let (now_millis, _) = self.now();
        if !self.cloud.has_token(now_millis).await {
            self.cloud.authenticate(player, &self.identity).await?;
        }
        let outputs = detect_outputs(self.config.virtual_outputs.as_deref());
        let stale = outputs_reported
            .as_ref()
            .is_none_or(|(previous, at)| *previous != outputs || at.elapsed() > OUTPUTS_REFRESH);
        if stale {
            self.cloud.report_outputs(&outputs).await?;
            *outputs_reported = Some((outputs, Instant::now()));
        }
        let config = self.cloud.config().await?;
        if config.organization_id != org || config.player_id != player {
            return Err(CloudError::Protocol(
                "configuration d’un autre Player".into(),
            ));
        }
        self.apply_config(&config).await;
        for display in self.store.displays().unwrap_or_default() {
            if display.assigned {
                let candidate = self.pipeline.fetch_candidate(org, player, &display).await;
                match candidate {
                    Ok(_) => {}
                    Err(crate::pipeline::PipelineError::Cloud(error)) => return Err(error),
                    Err(error) => tracing::error!(%error, "réception du manifest impossible"),
                }
            }
        }
        self.heartbeat().await?;
        self.cloud_ok();
        Ok(Duration::from_secs(
            config.heartbeat_interval_s.clamp(5, 600),
        ))
    }

    async fn apply_config(&self, config: &PlayerConfig) {
        let (_, now) = self.now();
        let before = self.surfaces();
        for assignment in &config.assignments {
            let display = &assignment.display;
            match self.store.upsert_display(
                &assignment.display_id,
                &assignment.assignment_generation,
                &assignment.output_key,
                &display.name,
                display.width,
                display.height,
                display.orientation,
                &display.timezone,
                &now,
            ) {
                Ok(true) => {
                    tracing::info!(display_id = %assignment.display_id, "nouvelle affectation : anciens manifests invalidés")
                }
                Ok(false) => {}
                Err(error) => tracing::error!(%error, "affectation non enregistrée"),
            }
        }
        let keep: Vec<String> = config
            .assignments
            .iter()
            .map(|a| a.display_id.clone())
            .collect();
        if let Ok(removed) = self.store.unassign_missing(&keep, &now)
            && !removed.is_empty()
        {
            tracing::info!(?removed, "Displays retirés de ce Player");
        }
        if self.surfaces() != before {
            self.configure_renderer().await;
        }
    }

    async fn advance_all(&self) {
        let _guard = self.activation.lock().await;
        for display in self.store.displays().unwrap_or_default() {
            if display.assigned
                && display.staging_manifest.is_some()
                && let Err(error) = self.pipeline.advance(&display.display_id).await
            {
                tracing::error!(%error, "activation impossible");
            }
        }
    }

    async fn flush_outbox(&self) {
        let Ok(entries) = self.store.outbox(100) else {
            return;
        };
        for entry in entries {
            let observed =
                parse_instant_millis(&entry.observed_at).unwrap_or_else(|| self.clock.now_millis());
            match self
                .cloud
                .manifest_status(
                    &entry.manifest_id,
                    &entry.state,
                    observed,
                    entry.error_code.as_deref(),
                    entry.detail.as_deref(),
                )
                .await
            {
                Ok(()) => {
                    let _ = self.store.ack_outbox(entry.id);
                }
                // Manifest devenu étranger à ce Player (réaffectation) : rien à déclarer.
                Err(CloudError::Api { status: 404, .. }) => {
                    let _ = self.store.ack_outbox(entry.id);
                }
                Err(error) => {
                    tracing::debug!(%error, "états de livraison conservés pour plus tard");
                    return;
                }
            }
        }
    }

    async fn heartbeat(&self) -> Result<(), CloudError> {
        let status = self.link.last_status();
        let displays = self
            .store
            .displays()
            .unwrap_or_default()
            .into_iter()
            .filter(|d| d.assigned)
            .map(|d| {
                let applied = d
                    .current_manifest
                    .as_deref()
                    .and_then(|id| self.store.manifest(id).ok().flatten())
                    .map(|m| m.version);
                let playback = status
                    .as_ref()
                    .and_then(|s| s.displays.iter().find(|x| x.display_id == d.display_id))
                    .map(|x| x.playback)
                    .unwrap_or(if self.link.is_connected() {
                        Playback::Unknown
                    } else {
                        Playback::Error
                    });
                HeartbeatDisplay {
                    display_id: d.display_id,
                    assignment_generation: d.assignment_generation,
                    manifest_applied_version: applied,
                    playback: playback.as_str(),
                }
            })
            .collect();
        let sent = self.clock.now_millis();
        let ack = self
            .cloud
            .heartbeat(&Heartbeat {
                uptime_seconds: self.started.elapsed().as_secs(),
                renderer: self.health.state().as_str(),
                displays,
            })
            .await?;
        let received = self.clock.now_millis();
        if let Some(server) = parse_instant_millis(&ack.server_time) {
            // Heure serveur rapportée au milieu de l’aller-retour (précision de la seconde).
            let offset = server - (sent + received) / 2;
            let (_, now) = self.now();
            let _ = self.store.save_clock_offset(offset, &now);
            if offset.abs() > CLOCK_DRIFT_WARNING_MILLIS {
                tracing::warn!(offset_ms = offset, "dérive d’horloge importante");
            }
            self.observe(|o| o.clock_offset_ms = Some(offset));
        }
        Ok(())
    }

    fn write_status(&self) {
        let observed = self.observed();
        let (_, now) = self.now();
        let status = json!({
            "updated_at": now,
            "agent_version": crate::AGENT_VERSION,
            "pid": std::process::id(),
            "uptime_seconds": self.started.elapsed().as_secs(),
            "online": observed.online,
            "last_sync_at": observed.last_sync_at,
            "last_cloud_error": observed.last_cloud_error,
            "clock_offset_ms": observed.clock_offset_ms,
            "renderer": {
                "state": self.health.state().as_str(),
                "connected": self.link.is_connected(),
                "pid": self.link.peer_pid(),
                "restarts_5min": self.health.restarts_in_window(),
                "status": self.link.last_status(),
            },
            "notice": observed.notice.as_ref().map(|n| match n {
                Notice::Pairing { .. } => "pairing",
                Notice::Revoked => "revoked",
                Notice::Waiting => "waiting",
            }),
        });
        let path: PathBuf = self.config.data_dir.join("state").join("status.json");
        let tmp = path.with_extension("json.tmp");
        let written = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|()| std::fs::write(&tmp, status.to_string()))
            .and_then(|()| std::fs::rename(&tmp, &path));
        if let Err(error) = written {
            tracing::debug!(%error, "état local non écrit");
        }
    }
}
