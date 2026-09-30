//! Lanceur A/B du Player natif (ADR-012, NAT-014). Lancé par systemd, il démarre
//! `versions/<version>/pixlova-agent` et gère l’essai, la promotion et le retour arrière.
//!
//! Usage : `pixlova-launcher [--data-dir <dossier>] [--release-trust <dossier>]
//!          [--health-timeout <secondes>] [-- <arguments de l’agent>]`

use pixlova_agent::launcher::{HEALTH_TIMEOUT, LauncherOptions, run};
use pixlova_agent::trust::TrustAnchors;
use std::path::PathBuf;
use std::time::Duration;

fn main() {
    let mut data_dir = std::env::var_os("PIXLOVA_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(pixlova_agent::config::default_data_dir);
    let mut release_trust: Option<PathBuf> = None;
    let mut health_timeout = HEALTH_TIMEOUT;
    let mut agent_args = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || {
            args.next().unwrap_or_else(|| {
                eprintln!("pixlova-launcher : valeur manquante pour {arg}");
                std::process::exit(2);
            })
        };
        match arg.as_str() {
            "--data-dir" => data_dir = PathBuf::from(value()),
            "--release-trust" => release_trust = Some(PathBuf::from(value())),
            "--health-timeout" => {
                health_timeout = Duration::from_secs(value().parse().unwrap_or_else(|_| {
                    eprintln!("pixlova-launcher : durée invalide");
                    std::process::exit(2);
                }))
            }
            "--" => {
                agent_args.extend(args.by_ref());
            }
            other => {
                eprintln!("pixlova-launcher : option inconnue {other}");
                std::process::exit(2);
            }
        }
    }
    if agent_args.is_empty() {
        agent_args.push("run".into());
    }
    let trust_dir = release_trust.unwrap_or_else(|| data_dir.join("trust"));
    let releases = match TrustAnchors::load(&trust_dir) {
        Ok(anchors) => anchors.releases,
        Err(error) => {
            eprintln!("pixlova-launcher : clés de release illisibles ({error})");
            Default::default()
        }
    };
    std::process::exit(run(&LauncherOptions {
        data_dir,
        agent_args,
        health_timeout,
        release_trust: releases,
    }));
}
