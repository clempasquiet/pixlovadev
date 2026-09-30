//! Informations de la plateforme : sorties vidéo (DSP-005), capacités déclarées
//! (PROTO-017), espace disque (NAT-010).

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;

/// Sortie vidéo telle que déclarée au cloud (`OutputReport`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputReport {
    pub output_key: String,
    pub connector_type: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub refresh_hz: Option<f64>,
    /// `None` : la plateforme ne permet pas de le savoir.
    pub connected: Option<bool>,
}

/// Sorties détectées ; `virtual_outputs` (configuration) les remplace entièrement, pour le
/// développement et les machines sans DRM. Au moins une sortie est toujours déclarée.
pub fn detect_outputs(virtual_outputs: Option<&[OutputReport]>) -> Vec<OutputReport> {
    if let Some(outputs) = virtual_outputs.filter(|o| !o.is_empty()) {
        return outputs.iter().take(16).cloned().collect();
    }
    let mut outputs = read_drm_connectors(Path::new("/sys/class/drm"));
    if outputs.is_empty() {
        outputs.push(OutputReport {
            output_key: "default".into(),
            connector_type: None,
            width: None,
            height: None,
            refresh_hz: None,
            connected: None,
        });
    }
    outputs.truncate(16);
    outputs
}

/// Connecteurs DRM Linux (`card0-HDMI-A-1`) : état et mode préféré. Le nom du connecteur
/// sert de clé de sortie : stable tant que le câblage et le pilote ne changent pas.
pub fn read_drm_connectors(root: &Path) -> Vec<OutputReport> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut outputs: Vec<OutputReport> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let rest = name.strip_prefix("card")?;
            let (card, connector) = rest.split_once('-')?;
            if card.is_empty() || !card.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            if connector.starts_with("Writeback") {
                return None;
            }
            let path = entry.path();
            let status = std::fs::read_to_string(path.join("status")).ok()?;
            let connected = match status.trim() {
                "connected" => Some(true),
                "disconnected" => Some(false),
                _ => None,
            };
            let mode = std::fs::read_to_string(path.join("modes"))
                .ok()
                .and_then(|modes| modes.lines().next().map(str::to_owned));
            let (width, height) = mode
                .as_deref()
                .and_then(parse_mode)
                .map_or((None, None), |(w, h)| (Some(w), Some(h)));
            let connector_type = connector
                .rsplit_once('-')
                .map_or(connector, |(kind, _)| kind)
                .to_owned();
            Some(OutputReport {
                output_key: connector.chars().take(128).collect(),
                connector_type: Some(connector_type.chars().take(64).collect()),
                width,
                height,
                refresh_hz: None,
                connected,
            })
        })
        .collect();
    outputs.sort_by(|a, b| a.output_key.cmp(&b.output_key));
    outputs.dedup_by(|a, b| a.output_key == b.output_key);
    outputs
}

fn parse_mode(mode: &str) -> Option<(u32, u32)> {
    let (w, h) = mode.split_once('x')?;
    let h: String = h.chars().take_while(char::is_ascii_digit).collect();
    let (w, h) = (w.parse().ok()?, h.parse().ok()?);
    (1..=16_384).contains(&w).then_some(())?;
    (1..=16_384).contains(&h).then_some((w, h))
}

pub fn os_family() -> &'static str {
    match std::env::consts::OS {
        "linux" => "linux",
        "windows" => "windows",
        "macos" => "macos",
        "android" => "android",
        _ => "other",
    }
}

pub fn architecture() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        _ => "other",
    }
}

fn os_version() -> Option<String> {
    let text = std::fs::read_to_string("/etc/os-release").ok()?;
    text.lines()
        .find_map(|line| line.strip_prefix("PRETTY_NAME="))
        .map(|value| value.trim_matches('"').chars().take(64).collect())
}

/// Capacités déclarées (PROTO-017) : elles guident le choix des variantes, ce ne sont ni
/// des droits ni des preuves matérielles.
///
/// `screenshot` : la capture dépend du renderer réel (WebKitGTK) ; un renderer headless ou
/// un autre moteur ne la déclare pas.
pub fn capabilities(
    app_version: &str,
    storage_quota_bytes: Option<u64>,
    screenshot: bool,
) -> Value {
    json!({
        "player_type": "native",
        "app_version": app_version,
        "os": { "family": os_family(), "version": os_version() },
        "architecture": architecture(),
        "protocol_versions": [1],
        "manifest_schemas": [1],
        "render_schemas": [1],
        "renderer": {
            "engine": if cfg!(windows) { "webview2" } else { "webkitgtk" },
            "version": app_version,
        },
        "image_types": ["image/jpeg", "image/png", "image/webp"],
        "video_profiles": ["mp4-h264-aac"],
        "max_canvas": { "width": 3840, "height": 2160 },
        "max_concurrent_videos": 1,
        "multi_output": "supported",
        "screenshot": if screenshot { "supported" } else { "unsupported" },
        "volume_control": "unsupported",
        "reboot_host": "unsupported",
        "persistent_storage": "granted",
        "storage_quota_bytes": storage_quota_bytes,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DiskSpace {
    pub available_bytes: u64,
    pub total_bytes: u64,
}

pub fn disk_space(path: &Path) -> Option<DiskSpace> {
    Some(DiskSpace {
        available_bytes: fs4::available_space(path).ok()?,
        total_bytes: fs4::total_space(path).ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lit_les_connecteurs_drm() {
        let dir = tempfile::tempdir().unwrap();
        let add = |name: &str, status: &str, modes: &str| {
            let path = dir.path().join(name);
            std::fs::create_dir(&path).unwrap();
            std::fs::write(path.join("status"), status).unwrap();
            std::fs::write(path.join("modes"), modes).unwrap();
        };
        add("card0-HDMI-A-1", "connected\n", "1920x1080\n1280x720\n");
        add("card0-DP-2", "disconnected\n", "");
        add("card0-Writeback-1", "unknown\n", "");
        add("renderD128", "", "");
        let outputs = read_drm_connectors(dir.path());
        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs[0].output_key, "DP-2");
        assert_eq!(outputs[0].connected, Some(false));
        assert_eq!(outputs[1].output_key, "HDMI-A-1");
        assert_eq!(outputs[1].connector_type.as_deref(), Some("HDMI-A"));
        assert_eq!(
            (outputs[1].width, outputs[1].height),
            (Some(1920), Some(1080))
        );
    }

    #[test]
    fn declare_toujours_au_moins_une_sortie() {
        let virtual_outputs = [OutputReport {
            output_key: "SIM-1".into(),
            connector_type: None,
            width: Some(1920),
            height: Some(1080),
            refresh_hz: Some(60.0),
            connected: Some(true),
        }];
        assert_eq!(
            detect_outputs(Some(&virtual_outputs))[0].output_key,
            "SIM-1"
        );
        assert!(!detect_outputs(None).is_empty());
        assert_eq!(parse_mode("3840x2160i"), Some((3840, 2160)));
        assert_eq!(parse_mode("0x0"), None);
    }
}
