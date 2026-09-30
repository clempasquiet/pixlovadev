//! Configuration de l’agent : fichier `config.json` de la racine de données, surchargé par
//! l’environnement puis la ligne de commande. Aucune clé de confiance n’est configurable
//! depuis le réseau (PROTO-012).

use crate::platform::OutputReport;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Réserve d’espace disque toujours laissée libre [à valider] (NAT-010).
pub const DEFAULT_RESERVE_BYTES: u64 = 512 * 1024 * 1024;
/// Budget du cache avant éviction des blobs non épinglés.
pub const DEFAULT_CACHE_BUDGET_BYTES: u64 = 20 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RendererMode {
    /// Le renderer est lancé par la session graphique (production Linux, NAT-003).
    External,
    /// L’agent lance lui-même le renderer (développement, tests).
    Spawn { program: PathBuf, args: Vec<String> },
}

#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub data_dir: PathBuf,
    pub api_url: String,
    /// Dossier des clés de confiance installées avec le paquet signé.
    pub trust_dir: PathBuf,
    pub renderer: RendererMode,
    pub cache_budget_bytes: u64,
    pub reserve_bytes: u64,
    /// Nom affiché proposé lors de l’appairage.
    pub device_name: String,
    /// Délai de confirmation de la première image après `ACTIVATE` [à valider].
    pub activation_timeout: Duration,
    /// Silence du renderer avant arrêt forcé [à valider].
    pub renderer_watchdog: Duration,
    /// Intervalle de contrôle du manifest désiré.
    pub sync_interval: Duration,
    /// Sorties déclarées à la place de la détection (développement, machines sans DRM).
    pub virtual_outputs: Option<Vec<OutputReport>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileConfig {
    api_url: Option<String>,
    trust_dir: Option<PathBuf>,
    renderer_program: Option<PathBuf>,
    renderer_args: Option<Vec<String>>,
    cache_budget_bytes: Option<u64>,
    reserve_bytes: Option<u64>,
    device_name: Option<String>,
    activation_timeout_seconds: Option<u64>,
    renderer_watchdog_seconds: Option<u64>,
    sync_interval_seconds: Option<u64>,
    virtual_outputs: Option<Vec<OutputReport>>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("config.json illisible : {0}")]
    File(String),
    #[error("{0}")]
    Invalid(String),
}

pub fn default_data_dir() -> PathBuf {
    if cfg!(windows) {
        let base = std::env::var_os("ProgramData").unwrap_or_else(|| "C:\\ProgramData".into());
        PathBuf::from(base).join("pixlova")
    } else {
        PathBuf::from("/var/lib/pixlova")
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

impl AgentConfig {
    /// `overrides` : options de la ligne de commande (`--data-dir`, `--api-url`, …).
    pub fn load(data_dir: Option<PathBuf>, overrides: &CliOverrides) -> Result<Self, ConfigError> {
        let data_dir = data_dir
            .or_else(|| env("PIXLOVA_DATA_DIR").map(PathBuf::from))
            .unwrap_or_else(default_data_dir);
        let file = read_file_config(&data_dir.join("config.json"))?;
        let api_url = overrides
            .api_url
            .clone()
            .or_else(|| env("PIXLOVA_API_URL"))
            .or(file.api_url)
            .unwrap_or_else(|| "https://api.pixlova.com".to_owned());
        if !(api_url.starts_with("https://")
            || api_url.starts_with("http://127.0.0.1")
            || api_url.starts_with("http://localhost"))
        {
            return Err(ConfigError::Invalid(
                "l’API doit être en HTTPS (HTTP admis seulement en local)".to_owned(),
            ));
        }
        let renderer = match overrides.renderer_program.clone().or(file.renderer_program) {
            Some(program) if !overrides.renderer_external => RendererMode::Spawn {
                program,
                args: overrides
                    .renderer_args
                    .clone()
                    .or(file.renderer_args)
                    .unwrap_or_default(),
            },
            _ => RendererMode::External,
        };
        let seconds =
            |value: Option<u64>, default: u64| Duration::from_secs(value.unwrap_or(default));
        Ok(Self {
            trust_dir: overrides
                .trust_dir
                .clone()
                .or_else(|| env("PIXLOVA_TRUST_DIR").map(PathBuf::from))
                .or(file.trust_dir)
                .unwrap_or_else(|| data_dir.join("trust")),
            api_url: api_url.trim_end_matches('/').to_owned(),
            renderer,
            cache_budget_bytes: file
                .cache_budget_bytes
                .unwrap_or(DEFAULT_CACHE_BUDGET_BYTES),
            reserve_bytes: overrides
                .reserve_bytes
                .or(file.reserve_bytes)
                .unwrap_or(DEFAULT_RESERVE_BYTES),
            device_name: file
                .device_name
                .unwrap_or_else(|| "Player pixlova".to_owned()),
            activation_timeout: seconds(file.activation_timeout_seconds, 30),
            renderer_watchdog: seconds(file.renderer_watchdog_seconds, 30),
            sync_interval: seconds(
                overrides
                    .sync_interval_seconds
                    .or(file.sync_interval_seconds),
                60,
            ),
            virtual_outputs: if overrides.virtual_outputs.is_empty() {
                file.virtual_outputs
            } else {
                Some(
                    overrides
                        .virtual_outputs
                        .iter()
                        .map(|spec| parse_virtual_output(spec))
                        .collect::<Result<_, _>>()?,
                )
            },
            data_dir,
        })
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("pixlova.db")
    }
    pub fn cache_dir(&self) -> PathBuf {
        self.data_dir.join("cache")
    }
    pub fn identity_dir(&self) -> PathBuf {
        self.data_dir.join("identity")
    }
    pub fn socket_path(&self) -> PathBuf {
        self.data_dir.join("run").join("agent.sock")
    }
    pub fn logs_dir(&self) -> PathBuf {
        self.data_dir.join("logs")
    }
    /// Marqueur de santé lu par le lanceur (NAT-014).
    pub fn health_marker(&self) -> PathBuf {
        self.data_dir.join("state").join("healthy")
    }
}

/// Options de la ligne de commande, prioritaires sur l’environnement et le fichier.
#[derive(Debug, Default, Clone)]
pub struct CliOverrides {
    pub api_url: Option<String>,
    pub trust_dir: Option<PathBuf>,
    pub renderer_program: Option<PathBuf>,
    pub renderer_args: Option<Vec<String>>,
    pub renderer_external: bool,
    pub reserve_bytes: Option<u64>,
    pub sync_interval_seconds: Option<u64>,
    /// `CLE:LARGEURxHAUTEUR`, répétable.
    pub virtual_outputs: Vec<String>,
}

fn parse_virtual_output(spec: &str) -> Result<OutputReport, ConfigError> {
    let invalid =
        || ConfigError::Invalid(format!("sortie virtuelle invalide {spec} (CLE:1920x1080)"));
    let (key, size) = spec.rsplit_once(':').ok_or_else(invalid)?;
    let (width, height) = size.split_once('x').ok_or_else(invalid)?;
    let (width, height): (u32, u32) = (
        width.parse().map_err(|_| invalid())?,
        height.parse().map_err(|_| invalid())?,
    );
    if key.is_empty() || key.len() > 128 || width == 0 || height == 0 {
        return Err(invalid());
    }
    Ok(OutputReport {
        output_key: key.to_owned(),
        connector_type: Some("virtual".to_owned()),
        width: Some(width),
        height: Some(height),
        refresh_hz: Some(60.0),
        connected: Some(true),
    })
}

fn read_file_config(path: &Path) -> Result<FileConfig, ConfigError> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| ConfigError::File(e.to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(FileConfig::default()),
        Err(error) => Err(ConfigError::File(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuse_une_api_non_chiffree_hors_local() {
        let dir = tempfile::tempdir().unwrap();
        let overrides = CliOverrides {
            api_url: Some("http://api.example.com".into()),
            ..Default::default()
        };
        assert!(AgentConfig::load(Some(dir.path().into()), &overrides).is_err());
        let local = CliOverrides {
            api_url: Some("http://127.0.0.1:3000/".into()),
            ..Default::default()
        };
        let config = AgentConfig::load(Some(dir.path().into()), &local).unwrap();
        assert_eq!(config.api_url, "http://127.0.0.1:3000");
        assert_eq!(config.renderer, RendererMode::External);
    }

    #[test]
    fn refuse_une_cle_inconnue_du_fichier() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), r#"{"trusted_keys": []}"#).unwrap();
        assert!(matches!(
            AgentConfig::load(Some(dir.path().into()), &CliOverrides::default()),
            Err(ConfigError::File(_))
        ));
    }
}
