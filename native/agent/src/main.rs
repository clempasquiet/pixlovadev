//! Point d’entrée de l’agent natif pixlova (ADR-012).

use pixlova_agent::AGENT_VERSION;
use pixlova_agent::config::{AgentConfig, CliOverrides};
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage : pixlova-agent <commande> [options]

Commandes :
  init       crée l’identité de l’appareil et la base locale
  version    affiche la version

Options communes :
  --data-dir <dossier>   racine des données (défaut /var/lib/pixlova, ou PIXLOVA_DATA_DIR)
  --api-url <url>        API Player (HTTPS ; HTTP admis seulement en local)
  --trust-dir <dossier>  clés de confiance installées avec le paquet";

struct Cli {
    command: String,
    data_dir: Option<PathBuf>,
    overrides: CliOverrides,
}

fn parse(args: Vec<String>) -> Result<Cli, String> {
    let mut args = args.into_iter();
    let command = args.next().ok_or_else(|| USAGE.to_owned())?;
    let mut cli = Cli {
        command,
        data_dir: None,
        overrides: CliOverrides::default(),
    };
    while let Some(flag) = args.next() {
        let mut value = || {
            args.next()
                .ok_or_else(|| format!("valeur manquante pour {flag}"))
        };
        match flag.as_str() {
            "--data-dir" => cli.data_dir = Some(PathBuf::from(value()?)),
            "--api-url" => cli.overrides.api_url = Some(value()?),
            "--trust-dir" => cli.overrides.trust_dir = Some(PathBuf::from(value()?)),
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
        "init" => init(&cli),
        "help" | "--help" | "-h" => {
            println!("{USAGE}");
            Ok(())
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

fn init(cli: &Cli) -> Result<(), String> {
    let config =
        AgentConfig::load(cli.data_dir.clone(), &cli.overrides).map_err(|e| e.to_string())?;
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
                "init",
                "--data-dir",
                "/tmp/x",
                "--api-url",
                "http://127.0.0.1:3000",
            ]
            .map(String::from)
            .to_vec(),
        )
        .unwrap();
        assert_eq!(cli.command, "init");
        assert_eq!(cli.data_dir, Some(PathBuf::from("/tmp/x")));
        assert!(parse(vec!["init".into(), "--inconnue".into()]).is_err());
    }
}
