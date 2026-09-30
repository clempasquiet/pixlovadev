//! Point d’entrée de l’agent natif pixlova (ADR-012).

use pixlova_agent::AGENT_VERSION;
use pixlova_agent::config::{AgentConfig, CliOverrides};
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage : pixlova-agent <commande> [options]

Commandes :
  run        démarre l’agent (appairage, synchronisation, diffusion, supervision)
  diagnose   affiche un rapport JSON local, sans secret
  init       crée l’identité de l’appareil et la base locale
  update apply --release <release.json> --package <paquet.tar>
             vérifie et installe une release signée ; active au prochain démarrage
  version    affiche la version

Options communes :
  --data-dir <dossier>          racine des données (défaut /var/lib/pixlova, ou PIXLOVA_DATA_DIR)
  --api-url <url>               API Player (HTTPS ; HTTP admis seulement en local)
  --trust-dir <dossier>         clés de confiance installées avec le paquet

Options de run :
  --renderer-program <chemin>   l’agent lance et relance lui-même le renderer
  --renderer-arg <argument>     argument du renderer (répétable)
  --renderer-external           renderer lancé par la session graphique (défaut)
  --virtual-output <CLE:LxH>    sortie déclarée à la place de la détection (répétable)
  --sync-interval <secondes>    intervalle maximal entre deux synchronisations
  --reserve-bytes <octets>      espace disque toujours laissé libre";

struct Cli {
    command: String,
    positional: Vec<String>,
    release: Option<PathBuf>,
    package: Option<PathBuf>,
    data_dir: Option<PathBuf>,
    overrides: CliOverrides,
}

fn parse(args: Vec<String>) -> Result<Cli, String> {
    let mut args = args.into_iter();
    let command = args.next().ok_or_else(|| USAGE.to_owned())?;
    let mut cli = Cli {
        command,
        positional: Vec::new(),
        release: None,
        package: None,
        data_dir: None,
        overrides: CliOverrides::default(),
    };
    while let Some(flag) = args.next() {
        let mut value = || {
            args.next()
                .ok_or_else(|| format!("valeur manquante pour {flag}"))
        };
        let number = |text: String| {
            text.parse::<u64>()
                .map_err(|_| format!("nombre attendu : {text}"))
        };
        match flag.as_str() {
            "--data-dir" => cli.data_dir = Some(PathBuf::from(value()?)),
            "--api-url" => cli.overrides.api_url = Some(value()?),
            "--trust-dir" => cli.overrides.trust_dir = Some(PathBuf::from(value()?)),
            "--renderer-program" => cli.overrides.renderer_program = Some(PathBuf::from(value()?)),
            "--renderer-arg" => cli
                .overrides
                .renderer_args
                .get_or_insert_with(Vec::new)
                .push(value()?),
            "--renderer-external" => cli.overrides.renderer_external = true,
            "--virtual-output" => cli.overrides.virtual_outputs.push(value()?),
            "--sync-interval" => cli.overrides.sync_interval_seconds = Some(number(value()?)?),
            "--reserve-bytes" => cli.overrides.reserve_bytes = Some(number(value()?)?),
            "--release" => cli.release = Some(PathBuf::from(value()?)),
            "--package" => cli.package = Some(PathBuf::from(value()?)),
            other if !other.starts_with('-') => cli.positional.push(other.to_owned()),
            other => return Err(format!("option inconnue {other}\n\n{USAGE}")),
        }
    }
    Ok(cli)
}

fn version_line() -> String {
    format!("pixlova-agent {AGENT_VERSION}")
}

fn main() -> ExitCode {
    let cli = match parse(std::env::args().skip(1).collect()) {
        Ok(cli) => cli,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::from(2);
        }
    };
    let result = match cli.command.as_str() {
        "version" | "--version" => {
            println!("{}", version_line());
            Ok(())
        }
        "help" | "--help" | "-h" => {
            println!("{USAGE}");
            Ok(())
        }
        "init" => init(&cli),
        "diagnose" => config(&cli).map(|config| {
            let report = pixlova_agent::diagnostics::report(&config);
            println!(
                "{}",
                serde_json::to_string_pretty(&report).expect("rapport sérialisable")
            );
        }),
        "run" => run(&cli),
        "update" if cli.positional.first().map(String::as_str) == Some("apply") => {
            update_apply(&cli)
        }
        other => Err(format!("commande inconnue {other}\n\n{USAGE}")),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("pixlova-agent : {message}");
            ExitCode::FAILURE
        }
    }
}

fn config(cli: &Cli) -> Result<AgentConfig, String> {
    AgentConfig::load(cli.data_dir.clone(), &cli.overrides).map_err(|e| e.to_string())
}

fn init(cli: &Cli) -> Result<(), String> {
    let config = config(cli)?;
    let identity = pixlova_agent::identity::DeviceIdentity::load_or_create(&config.identity_dir())
        .map_err(|e| e.to_string())?;
    let store = pixlova_agent::store::Store::open(&config.db_path()).map_err(|e| e.to_string())?;
    let now = pixlova_agent::clock::format_instant(pixlova_agent::clock::Clock::now_millis(
        &pixlova_agent::clock::SystemClock,
    ));
    let installation = store.installation_id(&now).map_err(|e| e.to_string())?;
    println!("installation {installation}");
    println!("clé publique {}", identity.public_key_b64u());
    Ok(())
}

fn update_apply(cli: &Cli) -> Result<(), String> {
    let config = config(cli)?;
    let (Some(release), Some(package)) = (&cli.release, &cli.package) else {
        return Err("--release et --package sont requis".into());
    };
    let raw = std::fs::read_to_string(release).map_err(|e| e.to_string())?;
    let trust =
        pixlova_agent::trust::TrustAnchors::load(&config.trust_dir).map_err(|e| e.to_string())?;
    let now = pixlova_agent::clock::format_instant(pixlova_agent::clock::Clock::now_millis(
        &pixlova_agent::clock::SystemClock,
    ));
    let store = pixlova_agent::store::Store::open(&config.db_path()).map_err(|e| e.to_string())?;
    match pixlova_agent::updater::apply(
        &config.data_dir,
        &trust.releases,
        &raw,
        package,
        AGENT_VERSION,
        &now,
    ) {
        Ok(installed) => {
            let _ = store.record_update(
                &installed.release.release_id,
                &installed.release.version,
                "pending",
                None,
                &now,
            );
            println!(
                "version {} installée dans {} ; elle sera essayée au prochain démarrage du service",
                installed.release.version,
                installed.directory.display()
            );
            Ok(())
        }
        Err(error) => Err(format!("{} ({})", error, error.code())),
    }
}

/// Journaux : sortie d’erreur (journald) et fichiers quotidiens, 7 au plus.
fn init_logging(config: &AgentConfig) -> Option<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::{EnvFilter, fmt};
    let filter = EnvFilter::try_from_env("PIXLOVA_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let file = std::fs::create_dir_all(config.logs_dir())
        .ok()
        .and_then(|()| {
            tracing_appender::rolling::RollingFileAppender::builder()
                .rotation(tracing_appender::rolling::Rotation::DAILY)
                .filename_prefix("agent")
                .filename_suffix("log")
                .max_log_files(7)
                .build(config.logs_dir())
                .ok()
        });
    let (file_layer, guard) = match file {
        Some(appender) => {
            let (writer, guard) = tracing_appender::non_blocking(appender);
            (
                Some(fmt::layer().with_ansi(false).with_writer(writer)),
                Some(guard),
            )
        }
        None => (None, None),
    };
    tracing_subscriber::registry()
        .with(filter)
        .with(
            fmt::layer()
                .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
                .with_writer(std::io::stderr),
        )
        .with(file_layer)
        .init();
    guard
}

fn run(cli: &Cli) -> Result<(), String> {
    let config = config(cli)?;
    let _guard = init_logging(&config);
    tracing::info!(version = AGENT_VERSION, data_dir = %config.data_dir.display(), api = %config.api_url, "démarrage de l’agent");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(async {
        let (agent, server) =
            pixlova_agent::runtime::Runtime::new(config).map_err(|e| e.to_string())?;
        let shutdown = agent.shutdown_handle();
        tokio::spawn(async move {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("signal SIGTERM");
            tokio::select! {
                _ = term.recv() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
            tracing::info!("arrêt demandé");
            shutdown.notify_waiters();
        });
        agent.run(server).await.map_err(|e| e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn affiche_la_version_du_paquet() {
        assert!(version_line().starts_with("pixlova-agent "));
    }

    #[test]
    fn analyse_les_options() {
        let cli = parse(
            [
                "run",
                "--data-dir",
                "/tmp/x",
                "--api-url",
                "http://127.0.0.1:3000",
                "--renderer-program",
                "/usr/bin/pixlova-renderer",
                "--renderer-arg",
                "--windowed",
                "--virtual-output",
                "SIM-1:1920x1080",
            ]
            .map(String::from)
            .to_vec(),
        )
        .unwrap();
        assert_eq!(cli.command, "run");
        assert_eq!(cli.data_dir, Some(PathBuf::from("/tmp/x")));
        assert_eq!(cli.overrides.renderer_args, Some(vec!["--windowed".into()]));
        assert_eq!(cli.overrides.virtual_outputs, ["SIM-1:1920x1080"]);
        assert!(parse(vec!["init".into(), "--inconnue".into()]).is_err());
    }
}
