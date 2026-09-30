//! Renderer natif pixlova (NAT-002, NAT-006, ADR-005, ADR-012).
//!
//! Héberge le moteur de rendu partagé dans la WebView du système (WebKitGTK sous Linux,
//! WebView2 sous Windows). Aucun serveur réseau n’est ouvert et aucun credential cloud
//! n’est présent dans ce processus (SEC-012).
//!
//! Modes :
//! - Player (défaut) : `pixlova-renderer [--agent-socket <chemin>] [--blobs-dir <dossier>]
//!   [--shell-dir <dossier>] [--windowed]` ; valeurs par défaut lues dans
//!   `PIXLOVA_AGENT_SOCKET`, `PIXLOVA_BLOBS_DIR` et `PIXLOVA_SHELL_DIR` ;
//! - `--headless` : même protocole sans affichage (parcours de bout en bout en CI) ;
//! - `--lab-dir <dossier>` : banc de qualification `apps/render-lab`.

mod agent_link;
mod headless;
mod lab;
mod local_files;
mod player;
mod serve;

use std::path::PathBuf;

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn fail(message: &str) -> ! {
    eprintln!("pixlova-renderer : {message}");
    std::process::exit(2);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--lab-dir") {
        lab::run(args);
        return;
    }
    let mut socket = env_path("PIXLOVA_AGENT_SOCKET");
    let mut blobs = env_path("PIXLOVA_BLOBS_DIR");
    let mut shell = env_path("PIXLOVA_SHELL_DIR");
    let (mut headless, mut windowed) = (false, false);
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        let mut value = || {
            iter.next()
                .map(PathBuf::from)
                .unwrap_or_else(|| fail(&format!("valeur manquante pour {arg}")))
        };
        match arg.as_str() {
            "--agent-socket" => socket = Some(value()),
            "--blobs-dir" => blobs = Some(value()),
            "--shell-dir" => shell = Some(value()),
            "--headless" => headless = true,
            "--windowed" => windowed = true,
            "--version" => {
                println!("pixlova-renderer {}", env!("CARGO_PKG_VERSION"));
                return;
            }
            other => fail(&format!("option inconnue : {other}")),
        }
    }
    let socket = socket.unwrap_or_else(|| PathBuf::from("/var/lib/pixlova/run/agent.sock"));
    let blobs = blobs.unwrap_or_else(|| PathBuf::from("/var/lib/pixlova/cache/blobs"));
    if headless {
        headless::run(socket, blobs);
    }
    let shell = shell
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|exe| exe.parent().map(|dir| dir.join("player-shell")))
        })
        .unwrap_or_else(|| fail("dossier de la page de lecture introuvable (--shell-dir)"));
    player::run(player::Options {
        socket,
        blobs,
        shell,
        windowed,
    });
}
