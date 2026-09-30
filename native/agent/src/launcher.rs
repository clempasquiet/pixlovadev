//! Lanceur A/B (NAT-014, NAT-015) : démarre la version en service ou essaie la version
//! `pending`. L’essai est promu dès que l’agent de cette version écrit son marqueur de
//! santé (base ouverte, IPC prêt, renderer connecté, première image, sans cloud requis).
//! Trois démarrages sans santé ou deux minutes sans marqueur [à valider] ramènent à la
//! version précédente et bloquent la release fautive.
//!
//! Le lanceur est lancé par systemd (`Restart=always`) : un agent qui s’arrête fait
//! redémarrer le lanceur, qui compte alors un essai de plus.

use crate::clock::{Clock, SystemClock, format_instant};
use crate::identity::sync_dir;
use crate::store::{READER_LEVEL, snapshot_path};
use crate::updater::{LauncherState, installed_release, versions_dir};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::{Duration, Instant};

pub const MAX_TRIAL_BOOTS: u32 = 3;
pub const HEALTH_TIMEOUT: Duration = Duration::from_secs(120);
/// Lien vers la version en cours d’exécution, suivi par l’unité du renderer.
pub const ACTIVE_LINK: &str = "active";

pub struct LauncherOptions {
    pub data_dir: PathBuf,
    /// Arguments transmis à `pixlova-agent` (commande `run` et options).
    pub agent_args: Vec<String>,
    pub health_timeout: Duration,
    /// Clés de release pour relire les métadonnées des versions installées.
    pub release_trust: pixlova_contracts::TrustStore,
}

fn now() -> String {
    format_instant(SystemClock.now_millis())
}

fn log(message: &str) {
    eprintln!("pixlova-launcher : {message}");
}

/// Version à démarrer quand l’état est vide : la plus récente installée.
fn discover(data_dir: &Path) -> Option<String> {
    let mut versions: Vec<(u32, u32, u32, String)> = std::fs::read_dir(versions_dir(data_dir))
        .ok()?
        .flatten()
        .filter(|e| e.path().join("pixlova-agent").is_file())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let (a, b, c) = pixlova_contracts::release::parse_version(&name)?;
            Some((a, b, c, name))
        })
        .collect();
    versions.sort();
    versions.pop().map(|v| v.3)
}

fn health_version(marker: &Path) -> Option<String> {
    let text = std::fs::read_to_string(marker).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value["version"].as_str().map(str::to_owned)
}

/// Remplace atomiquement `versions/active` → `<version>`.
fn point_active(data_dir: &Path, version: &str) -> std::io::Result<()> {
    let versions = versions_dir(data_dir);
    let tmp = versions.join(".active.tmp");
    let _ = std::fs::remove_file(&tmp);
    #[cfg(unix)]
    std::os::unix::fs::symlink(version, &tmp)?;
    #[cfg(not(unix))]
    std::fs::write(&tmp, version)?;
    std::fs::rename(&tmp, versions.join(ACTIVE_LINK))?;
    sync_dir(&versions);
    Ok(())
}

fn spawn(options: &LauncherOptions, version: &str) -> std::io::Result<Child> {
    let dir = versions_dir(&options.data_dir).join(version);
    let mut args = options.agent_args.clone();
    if !args.iter().any(|a| a == "--data-dir") {
        args.push("--data-dir".into());
        args.push(options.data_dir.display().to_string());
    }
    // Les clés de confiance voyagent avec le paquet signé de chaque version.
    if !args.iter().any(|a| a == "--trust-dir") && dir.join("trust").is_dir() {
        args.push("--trust-dir".into());
        args.push(dir.join("trust").display().to_string());
    }
    Command::new(dir.join("pixlova-agent"))
        .args(&args)
        .env("PIXLOVA_VERSION_DIR", &dir)
        .spawn()
}

fn reader_level(options: &LauncherOptions, version: &str) -> i64 {
    installed_release(&options.data_dir, version, &options.release_trust)
        .map(|r| r.sqlite_reader_level)
        .unwrap_or(READER_LEVEL.min(1))
}

/// Association (organisation, Player) d’une base, lue sans migration.
fn association(path: &Path) -> Option<(Option<String>, Option<String>)> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    conn.query_row(
        "SELECT organization_id, player_id FROM association WHERE id = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
    .ok()
    .map(|row| row.unwrap_or((None, None)))
}

fn min_reader_level(path: &Path) -> Option<i64> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    conn.query_row(
        "SELECT value FROM schema_meta WHERE key = 'min_reader_level'",
        [],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// Après retour arrière : si la base n’est plus lisible par la version restaurée, la
/// copie d’avant migration est restaurée **seulement** si elle porte la même association
/// (jamais une identité révoquée ou remplacée, NAT-015). Retourne vrai si restaurée.
pub fn restore_database_if_needed(data_dir: &Path, target_reader_level: i64) -> bool {
    let db = data_dir.join("pixlova.db");
    let Some(level) = min_reader_level(&db) else {
        return false;
    };
    if level <= target_reader_level {
        return false;
    }
    let current = association(&db);
    let mut snapshots: Vec<PathBuf> = (1..=1000)
        .map(|v| snapshot_path(&db, v))
        .filter(|p| p.is_file())
        .collect();
    snapshots.reverse();
    for snapshot in snapshots {
        let readable = min_reader_level(&snapshot).is_some_and(|l| l <= target_reader_level);
        if readable && association(&snapshot) == current {
            let tmp = db.with_extension("db.restore");
            if std::fs::copy(&snapshot, &tmp).is_ok() {
                for suffix in ["-wal", "-shm"] {
                    let mut name = db.as_os_str().to_owned();
                    name.push(suffix);
                    let _ = std::fs::remove_file(PathBuf::from(name));
                }
                if std::fs::rename(&tmp, &db).is_ok() {
                    log(&format!("base restaurée depuis {}", snapshot.display()));
                    return true;
                }
            }
        }
    }
    log("base conservée : aucune copie compatible avec la même association");
    false
}

fn rollback(options: &LauncherOptions, state: &mut LauncherState, version: &str, reason: &str) {
    log(&format!("retour arrière depuis {version} : {reason}"));
    if !state.blocked.iter().any(|b| b == version) {
        state.blocked.push(version.to_owned());
    }
    state.pending = None;
    state.pending_attempts = 0;
    let release_id =
        installed_release(&options.data_dir, version, &options.release_trust).map(|r| r.release_id);
    state.record(
        version,
        release_id,
        "rolled_back",
        Some(reason.to_owned()),
        &now(),
    );
    if let Some(current) = state.current.clone() {
        restore_database_if_needed(&options.data_dir, reader_level(options, &current));
    }
}

/// Boucle du lanceur ; retourne le code de sortie à transmettre à systemd.
pub fn run(options: &LauncherOptions) -> i32 {
    loop {
        let mut state = match LauncherState::load(&options.data_dir) {
            Ok(state) => state,
            Err(error) => {
                log(&format!(
                    "état illisible ({error}) : version installée la plus récente"
                ));
                LauncherState::default()
            }
        };
        if state.current.is_none() {
            state.current = discover(&options.data_dir);
        }
        if let Some(pending) = state.pending.clone() {
            let installed = versions_dir(&options.data_dir)
                .join(&pending)
                .join("pixlova-agent")
                .is_file();
            if !installed {
                rollback(options, &mut state, &pending, "version absente");
            } else if state.pending_attempts >= MAX_TRIAL_BOOTS {
                rollback(
                    options,
                    &mut state,
                    &pending,
                    "trois démarrages sans marqueur de santé",
                );
            }
        }
        let (version, trial) = match (&state.pending, &state.current) {
            (Some(pending), _) => {
                state.pending_attempts += 1;
                (pending.clone(), true)
            }
            (None, Some(current)) => (current.clone(), false),
            (None, None) => {
                log("aucune version installée");
                return 1;
            }
        };
        if let Err(error) = state.save(&options.data_dir) {
            log(&format!("état non enregistré : {error}"));
            return 1;
        }
        let marker = options.data_dir.join("state").join("healthy");
        if trial {
            let _ = std::fs::remove_file(&marker);
            log(&format!(
                "essai de la version {version} ({}/{MAX_TRIAL_BOOTS})",
                state.pending_attempts
            ));
        }
        if let Err(error) = point_active(&options.data_dir, &version) {
            log(&format!("lien de version impossible : {error}"));
        }
        let mut child = match spawn(options, &version) {
            Ok(child) => child,
            Err(error) => {
                log(&format!("lancement de {version} impossible : {error}"));
                if trial {
                    rollback(options, &mut state, &version, "binaire non exécutable");
                    let _ = state.save(&options.data_dir);
                    continue;
                }
                return 1;
            }
        };
        if trial {
            let started = Instant::now();
            let promoted = loop {
                if health_version(&marker).as_deref() == Some(version.as_str()) {
                    let mut state = LauncherState::load(&options.data_dir).unwrap_or(state.clone());
                    state.previous = state.current.replace(version.clone());
                    state.pending = None;
                    state.pending_attempts = 0;
                    let release_id =
                        installed_release(&options.data_dir, &version, &options.release_trust)
                            .map(|r| r.release_id);
                    state.record(&version, release_id, "promoted", None, &now());
                    let _ = state.save(&options.data_dir);
                    log(&format!("version {version} promue"));
                    break true;
                }
                if let Ok(Some(status)) = child.try_wait() {
                    log(&format!("{version} arrêtée avant d’être saine ({status})"));
                    // systemd relance le lanceur : essai suivant ou retour arrière.
                    return status.code().unwrap_or(1).max(1);
                }
                if started.elapsed() > options.health_timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    rollback(
                        options,
                        &mut state,
                        &version,
                        "aucun marqueur de santé dans le délai",
                    );
                    let _ = state.save(&options.data_dir);
                    break false;
                }
                std::thread::sleep(Duration::from_millis(200));
            };
            if !promoted {
                // Retour à la version précédente dans le même processus.
                continue;
            }
        }
        return match child.wait() {
            Ok(status) => status.code().unwrap_or(1),
            Err(_) => 1,
        };
    }
}
