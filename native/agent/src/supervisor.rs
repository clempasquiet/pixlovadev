//! Supervision du renderer (PLY-004) : watchdog sur le silence IPC, relance en mode
//! `spawn`, détection des boucles de crash et état remonté dans le heartbeat.

use crate::config::RendererMode;
use crate::ipc::{RendererEvent, RendererLink};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

/// Au-delà de ce nombre de redémarrages dans la fenêtre, le renderer est `degraded`.
pub const CRASH_LOOP_RESTARTS: usize = 5;
pub const CRASH_LOOP_WINDOW: Duration = Duration::from_secs(5 * 60);
pub const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// Délai de grâce au démarrage avant de juger un renderer absent.
pub const STARTUP_GRACE: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RendererState {
    Starting,
    Ok,
    Degraded,
    Error,
    Stopped,
}

impl RendererState {
    /// Valeur du contrat heartbeat.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ok => "ok",
            Self::Degraded => "degraded",
            Self::Error => "error",
            Self::Stopped => "stopped",
        }
    }
}

struct HealthInner {
    started: Instant,
    restarts: VecDeque<Instant>,
    spawn_failed: bool,
    stopped: bool,
}

/// État partagé du renderer, lu par le heartbeat et le diagnostic.
#[derive(Clone)]
pub struct RendererHealth {
    inner: Arc<Mutex<HealthInner>>,
    link: RendererLink,
    watchdog: Duration,
}

impl RendererHealth {
    pub fn new(link: RendererLink, watchdog: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(HealthInner {
                started: Instant::now(),
                restarts: VecDeque::new(),
                spawn_failed: false,
                stopped: false,
            })),
            link,
            watchdog,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HealthInner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Enregistre un redémarrage (crash, arrêt forcé) et retourne le délai avant relance.
    pub fn record_restart(&self) -> Duration {
        let mut inner = self.lock();
        let now = Instant::now();
        inner.restarts.push_back(now);
        while inner
            .restarts
            .front()
            .is_some_and(|t| now.duration_since(*t) > CRASH_LOOP_WINDOW)
        {
            inner.restarts.pop_front();
        }
        backoff(inner.restarts.len())
    }

    pub fn restarts_in_window(&self) -> usize {
        let inner = self.lock();
        inner
            .restarts
            .iter()
            .filter(|t| t.elapsed() <= CRASH_LOOP_WINDOW)
            .count()
    }

    pub fn state(&self) -> RendererState {
        let (started, spawn_failed, stopped) = {
            let inner = self.lock();
            (inner.started, inner.spawn_failed, inner.stopped)
        };
        if stopped {
            return RendererState::Stopped;
        }
        let crash_loop = self.restarts_in_window() > CRASH_LOOP_RESTARTS;
        if self.link.is_connected() && self.link.silence().is_some_and(|s| s < self.watchdog) {
            return if crash_loop {
                RendererState::Degraded
            } else {
                RendererState::Ok
            };
        }
        if spawn_failed {
            RendererState::Error
        } else if crash_loop {
            RendererState::Degraded
        } else if started.elapsed() < STARTUP_GRACE && self.restarts_in_window() == 0 {
            RendererState::Starting
        } else {
            RendererState::Error
        }
    }
}

/// Délai de relance : immédiat, puis croissant au-delà du seuil de boucle de crash.
pub fn backoff(restarts_in_window: usize) -> Duration {
    if restarts_in_window <= CRASH_LOOP_RESTARTS {
        return Duration::from_secs(1);
    }
    let excess = (restarts_in_window - CRASH_LOOP_RESTARTS).min(6) as u32;
    (Duration::from_secs(5) * 2u32.pow(excess - 1)).min(MAX_BACKOFF)
}

pub struct Supervisor {
    pub link: RendererLink,
    pub health: RendererHealth,
    pub mode: RendererMode,
    pub socket: PathBuf,
    /// Cache vérifié servi par le renderer (`pixlova://asset/<sha256>`).
    pub blobs: PathBuf,
    pub watchdog: Duration,
}

impl Supervisor {
    /// Tâches de supervision ; ne se termine qu’à l’arrêt de l’agent.
    pub async fn run(self, shutdown: Arc<Notify>) {
        let kill = Arc::new(Notify::new());
        let watchdog = tokio::spawn(watchdog_loop(
            self.link.clone(),
            self.health.clone(),
            self.watchdog,
            matches!(self.mode, RendererMode::External),
            kill.clone(),
        ));
        match self.mode {
            RendererMode::Spawn { program, args } => {
                tokio::select! {
                    _ = spawn_loop(program, args, (self.socket, self.blobs), self.link, self.health.clone(), kill) => {}
                    _ = shutdown.notified() => {}
                }
                self.health.lock().stopped = true;
            }
            RendererMode::External => shutdown.notified().await,
        }
        watchdog.abort();
    }
}

async fn watchdog_loop(
    link: RendererLink,
    health: RendererHealth,
    limit: Duration,
    external: bool,
    kill: Arc<Notify>,
) {
    let mut events = link.subscribe();
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            _ = ticker.tick() => {}
            event = events.recv() => {
                // Renderer externe : chaque perte de connexion compte comme un redémarrage.
                if external && matches!(event, Ok(RendererEvent::Disconnected { .. })) {
                    health.record_restart();
                }
                continue;
            }
        }
        let Some(silence) = link.silence() else {
            continue;
        };
        if silence <= limit {
            continue;
        }
        tracing::error!(silence_s = silence.as_secs(), "renderer figé : arrêt forcé");
        if external {
            if let Some(pid) = link.peer_pid() {
                kill_process(pid).await;
            }
        } else {
            kill.notify_one();
        }
        link.disconnect();
    }
}

/// Arrêt forcé d’un renderer du même compte (NAT-003) ; le processus est identifié par le
/// noyau via `SO_PEERCRED`, jamais par ses propres déclarations.
pub async fn kill_process(pid: i32) {
    // Jamais init ni l’agent lui-même (renderer factice dans le même processus en test).
    if pid <= 1 || pid as u32 == std::process::id() {
        return;
    }
    let status = tokio::process::Command::new("kill")
        .arg("-KILL")
        .arg(pid.to_string())
        .status()
        .await;
    if !status.is_ok_and(|s| s.success()) {
        tracing::warn!(pid, "arrêt forcé du renderer impossible");
    }
}

async fn spawn_loop(
    program: PathBuf,
    args: Vec<String>,
    (socket, blobs): (PathBuf, PathBuf),
    link: RendererLink,
    health: RendererHealth,
    kill: Arc<Notify>,
) {
    loop {
        let child = tokio::process::Command::new(&program)
            .args(&args)
            .env("PIXLOVA_AGENT_SOCKET", &socket)
            .env("PIXLOVA_BLOBS_DIR", &blobs)
            .kill_on_drop(true)
            .spawn();
        let delay = match child {
            Ok(mut child) => {
                health.lock().spawn_failed = false;
                tracing::info!(pid = child.id(), "renderer lancé");
                let status = tokio::select! {
                    status = child.wait() => status.ok(),
                    _ = kill.notified() => {
                        let _ = child.kill().await;
                        None
                    }
                };
                link.disconnect();
                let delay = health.record_restart();
                tracing::warn!(
                    ?status,
                    restarts = health.restarts_in_window(),
                    "renderer arrêté, relance dans {delay:?}"
                );
                delay
            }
            Err(error) => {
                health.lock().spawn_failed = true;
                tracing::error!(%error, program = %program.display(), "lancement du renderer impossible");
                MAX_BACKOFF
            }
        };
        tokio::time::sleep(delay).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attente_croissante_en_boucle_de_crash() {
        assert_eq!(backoff(1), Duration::from_secs(1));
        assert_eq!(backoff(5), Duration::from_secs(1));
        assert_eq!(backoff(6), Duration::from_secs(5));
        assert_eq!(backoff(7), Duration::from_secs(10));
        assert_eq!(backoff(9), Duration::from_secs(40));
        assert_eq!(backoff(50), MAX_BACKOFF);
    }

    #[test]
    fn etat_degrade_apres_trop_de_redemarrages() {
        let health = RendererHealth::new(RendererLink::new(), Duration::from_secs(30));
        assert_eq!(health.state(), RendererState::Starting);
        for _ in 0..6 {
            health.record_restart();
        }
        assert_eq!(health.state(), RendererState::Degraded);
    }

    #[tokio::test]
    async fn relance_un_renderer_qui_s_arrete() {
        let link = RendererLink::new();
        let health = RendererHealth::new(link.clone(), Duration::from_secs(30));
        let shutdown = Arc::new(Notify::new());
        let supervisor = Supervisor {
            link,
            health: health.clone(),
            mode: RendererMode::Spawn {
                program: "true".into(),
                args: vec![],
            },
            socket: "/nonexistent".into(),
            blobs: "/nonexistent".into(),
            watchdog: Duration::from_secs(30),
        };
        let task = tokio::spawn(supervisor.run(shutdown.clone()));
        tokio::time::sleep(Duration::from_millis(2500)).await;
        assert!(health.restarts_in_window() >= 2, "le renderer est relancé");
        shutdown.notify_one();
        task.await.unwrap();
        assert_eq!(health.state(), RendererState::Stopped);
    }
}
