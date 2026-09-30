//! Mode Player : une fenêtre plein écran par Display affecté, chacune hébergeant la page
//! de lecture `apps/player-shell`. Le renderer relaie l’IPC de l’agent vers les pages et
//! sert les fichiers par le protocole `pixlova` :
//!
//! - `pixlova://app/…` : la page de lecture, depuis son dossier d’installation ;
//! - `pixlova://asset/<sha256>` : un blob du cache, seulement si son empreinte figure
//!   dans un manifest préparé (NAT-006, SEC-012). Aucune URL ni aucun jeton cloud.
//!
//! Les `STATUS` vers l’agent partent de la boucle d’événements et seulement si chaque
//! page a donné signe de vie : une interface figée cesse de répondre et le watchdog de
//! l’agent arrête le processus.

use crate::agent_link::{AgentWriter, connect, is_sha256};
use crate::local_files::{ResolveError, resolve_within};
use crate::serve::{respond, serve_file};
use pixlova_contracts::ipc::{
    ConfigurePayload, DisplayStatus, DisplaySurface, Envelope, MessageType, Playback,
    PreparePayload,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoop, EventLoopBuilder, EventLoopProxy};
use tao::monitor::MonitorHandle;
use tao::window::{Fullscreen, Window, WindowBuilder};
use wry::http::{Request, StatusCode, header};
use wry::{WebView, WebViewBuilder};

const NOTICE_KEY: &str = "__notice";
/// Délai au-delà duquel une page silencieuse bloque les `STATUS` (watchdog de l’agent).
const PAGE_SILENCE_LIMIT: Duration = Duration::from_secs(20);
const PAGE_LOAD_GRACE: Duration = Duration::from_secs(30);
const MAX_PAGE_MESSAGE: usize = 1024 * 1024;
/// Manifests préparés conservés par Display (actif, précédent, candidat).
const PREPARED_PER_DISPLAY: usize = 3;

pub struct Options {
    pub socket: PathBuf,
    pub blobs: PathBuf,
    pub shell: PathBuf,
    pub windowed: bool,
}

enum UserEvent {
    Agent(Envelope),
    Page { key: String, body: String },
    Tick,
    AgentLost,
}

struct Surface {
    /// Maintient la fenêtre ouverte tant que le Display est affecté.
    _window: Window,
    webview: WebView,
    created: Instant,
    loaded: bool,
    last_seen: Option<Instant>,
    queue: Vec<String>,
    status: Option<(Option<String>, Playback, Option<String>)>,
}

impl Surface {
    fn send(&mut self, message: &Value) {
        let script = format!("window.pixlova && window.pixlova.receive({message})");
        if self.loaded {
            let _ = self.webview.evaluate_script(&script);
        } else {
            self.queue.push(script);
        }
    }
}

fn base(host: &str) -> String {
    // WebView2 expose les protocoles personnalisés sous http://<schéma>.<hôte>/.
    if cfg!(windows) {
        format!("http://pixlova.{host}/")
    } else {
        format!("pixlova://{host}/")
    }
}

struct State {
    agent: AgentWriter,
    proxy: EventLoopProxy<UserEvent>,
    options: Arc<Options>,
    allowed: Arc<RwLock<HashSet<String>>>,
    surfaces: BTreeMap<String, Surface>,
    /// display_id → manifests préparés (identifiant, empreintes).
    prepared: HashMap<String, Vec<(String, HashSet<String>)>>,
    /// (display_id, manifest_id) → message `PREPARE` en attente de réponse.
    pending: HashMap<(String, String), Envelope>,
}

pub fn run(options: Options) -> ! {
    let options = Arc::new(options);
    let event_loop: EventLoop<UserEvent> = EventLoopBuilder::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let (mut reader, agent) = connect(&options.socket, "webkitgtk");
    {
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            while let Some(message) = reader.next() {
                match message {
                    Ok(envelope) => {
                        if proxy.send_event(UserEvent::Agent(envelope)).is_err() {
                            return;
                        }
                    }
                    Err(error) => eprintln!("message IPC refusé : {}", error.code()),
                }
            }
            let _ = proxy.send_event(UserEvent::AgentLost);
        });
    }
    {
        let proxy = proxy.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(
                    pixlova_contracts::ipc::IPC_STATUS_INTERVAL_SECONDS,
                ));
                if proxy.send_event(UserEvent::Tick).is_err() {
                    return;
                }
            }
        });
    }
    let mut state = State {
        agent,
        proxy,
        options,
        allowed: Arc::default(),
        surfaces: BTreeMap::new(),
        prepared: HashMap::new(),
        pending: HashMap::new(),
    };
    event_loop.run(move |event, target, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Agent(envelope)) => state.on_agent(envelope, target),
            Event::UserEvent(UserEvent::Page { key, body }) => state.on_page(&key, &body),
            Event::UserEvent(UserEvent::Tick) => state.on_tick(),
            Event::UserEvent(UserEvent::AgentLost) => {
                eprintln!("pixlova-renderer : connexion à l’agent perdue");
                std::process::exit(1);
            }
            // Une fenêtre de diffusion ne se ferme pas à la demande de l’utilisateur.
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {}
            _ => {}
        }
    })
}

impl State {
    fn on_agent(
        &mut self,
        envelope: Envelope,
        target: &tao::event_loop::EventLoopWindowTarget<UserEvent>,
    ) {
        match envelope.kind {
            MessageType::Configure => {
                match serde_json::from_value::<ConfigurePayload>(envelope.payload.clone()) {
                    Ok(configure) => self.apply_configure(configure, target),
                    Err(error) => {
                        self.agent
                            .error(&envelope, "MALFORMED_MESSAGE", &error.to_string());
                    }
                }
            }
            MessageType::Prepare => {
                match serde_json::from_value::<PreparePayload>(envelope.payload.clone()) {
                    Ok(prepare) => self.prepare(prepare, envelope),
                    Err(error) => {
                        self.agent
                            .error(&envelope, "MALFORMED_MESSAGE", &error.to_string());
                    }
                }
            }
            MessageType::Activate => {
                let display = envelope.payload["display_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                let manifest = envelope.payload["manifest_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                let known = self
                    .prepared
                    .get(&display)
                    .is_some_and(|list| list.iter().any(|(id, _)| *id == manifest));
                match self.surfaces.get_mut(&display) {
                    Some(surface) if known => {
                        self.agent.reply(&envelope, MessageType::Ready, json!({}));
                        surface.send(&json!({ "type": "activate", "manifest_id": manifest }));
                    }
                    _ => {
                        self.agent.error(&envelope, "NOT_PREPARED", &manifest);
                    }
                }
            }
            MessageType::GetStatus => {
                self.agent
                    .reply(&envelope, MessageType::Status, self.status());
            }
            MessageType::Reload => {
                for surface in self.surfaces.values_mut() {
                    surface.loaded = false;
                    let _ = surface.webview.reload();
                }
            }
            _ => {
                self.agent
                    .error(&envelope, "UNEXPECTED_TYPE", "type réservé au renderer");
            }
        }
    }

    fn apply_configure(
        &mut self,
        configure: ConfigurePayload,
        target: &tao::event_loop::EventLoopWindowTarget<UserEvent>,
    ) {
        let wanted: Vec<(String, Option<DisplaySurface>)> = if configure.displays.is_empty() {
            vec![(NOTICE_KEY.to_owned(), None)]
        } else {
            configure
                .displays
                .iter()
                .map(|d| (d.display_id.clone(), Some(d.clone())))
                .collect()
        };
        let keys: HashSet<&String> = wanted.iter().map(|(k, _)| k).collect();
        self.surfaces.retain(|key, _| keys.contains(key));
        self.prepared.retain(|key, _| keys.contains(key));
        self.pending
            .retain(|(display, _), _| keys.contains(display));
        self.refresh_allowed();
        let monitors: Vec<MonitorHandle> = target.available_monitors().collect();
        for (index, (key, display)) in wanted.iter().enumerate() {
            if !self.surfaces.contains_key(key) {
                let monitor = pick_monitor(
                    &monitors,
                    display.as_ref().map(|d| d.output_key.as_str()),
                    index,
                );
                match self.open_surface(key, monitor, target) {
                    Ok(surface) => {
                        self.surfaces.insert(key.clone(), surface);
                    }
                    Err(error) => eprintln!("fenêtre {key} impossible : {error}"),
                }
            }
            let notice = if display.is_none() {
                configure.notice.clone()
            } else {
                None
            };
            if let Some(surface) = self.surfaces.get_mut(key) {
                surface.send(&json!({
                    "type": "configure",
                    "display": display,
                    "notice": notice,
                    "asset_base": base("asset"),
                }));
            }
        }
    }

    fn open_surface(
        &self,
        key: &str,
        monitor: Option<MonitorHandle>,
        target: &tao::event_loop::EventLoopWindowTarget<UserEvent>,
    ) -> Result<Surface, String> {
        let mut builder = WindowBuilder::new().with_title(format!("pixlova {key}"));
        if self.options.windowed {
            builder = builder.with_inner_size(tao::dpi::LogicalSize::new(960.0, 540.0));
        } else {
            builder = builder
                .with_decorations(false)
                .with_fullscreen(Some(Fullscreen::Borderless(monitor)));
        }
        let window = builder.build(target).map_err(|e| e.to_string())?;
        let options = self.options.clone();
        let allowed = self.allowed.clone();
        let proxy = self.proxy.clone();
        let page_key = key.to_owned();
        let builder = WebViewBuilder::new()
            .with_custom_protocol("pixlova".into(), move |_id, request: Request<Vec<u8>>| {
                let uri = request.uri();
                let host = uri.host().unwrap_or_default();
                let path = uri.path();
                let range = request
                    .headers()
                    .get(header::RANGE)
                    .and_then(|value| value.to_str().ok());
                let host = host.strip_prefix("pixlova.").unwrap_or(host);
                match host {
                    "app" => match resolve_within(&options.shell, path) {
                        Ok(file) => serve_file(&file, range),
                        Err(ResolveError::Forbidden) => {
                            respond(StatusCode::FORBIDDEN, "text/plain", Vec::new())
                        }
                        Err(ResolveError::NotFound) => {
                            respond(StatusCode::NOT_FOUND, "text/plain", Vec::new())
                        }
                    },
                    "asset" => serve_asset(&allowed, &options.blobs, path, range),
                    _ => respond(StatusCode::FORBIDDEN, "text/plain", Vec::new()),
                }
            })
            .with_ipc_handler(move |request: Request<String>| {
                let body = request.body();
                if body.len() <= MAX_PAGE_MESSAGE {
                    let _ = proxy.send_event(UserEvent::Page {
                        key: page_key.clone(),
                        body: body.clone(),
                    });
                }
            })
            .with_url(format!("{}index.html", base("app")));
        #[cfg(any(target_os = "windows", target_os = "macos"))]
        let webview = builder.build(&window).map_err(|e| e.to_string())?;
        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        let webview = {
            use tao::platform::unix::WindowExtUnix;
            use wry::WebViewBuilderExtUnix;
            let vbox = window.default_vbox().ok_or("conteneur GTK absent")?;
            builder.build_gtk(vbox).map_err(|e| e.to_string())?
        };
        Ok(Surface {
            _window: window,
            webview,
            created: Instant::now(),
            loaded: false,
            last_seen: None,
            queue: Vec::new(),
            status: None,
        })
    }

    fn refresh_allowed(&self) {
        let set: HashSet<String> = self
            .prepared
            .values()
            .flatten()
            .flat_map(|(_, shas)| shas.iter().cloned())
            .collect();
        if let Ok(mut allowed) = self.allowed.write() {
            *allowed = set;
        }
    }

    fn prepare(&mut self, prepare: PreparePayload, envelope: Envelope) {
        if !prepare.assets.values().all(|sha| is_sha256(sha)) {
            self.agent
                .error(&envelope, "MALFORMED_MESSAGE", "empreinte invalide");
            return;
        }
        let Some(surface) = self.surfaces.get_mut(&prepare.display_id) else {
            self.agent
                .error(&envelope, "UNKNOWN_DISPLAY", &prepare.display_id);
            return;
        };
        let list = self.prepared.entry(prepare.display_id.clone()).or_default();
        list.retain(|(id, _)| *id != prepare.manifest_id);
        list.push((
            prepare.manifest_id.clone(),
            prepare.assets.values().cloned().collect(),
        ));
        // Le plus ancien est oublié ; l’actif fait partie des trois plus récents.
        while list.len() > PREPARED_PER_DISPLAY {
            list.remove(0);
        }
        surface.send(&json!({
            "type": "prepare",
            "manifest_id": prepare.manifest_id,
            "manifest": prepare.manifest,
            "assets": prepare.assets,
        }));
        self.pending
            .insert((prepare.display_id, prepare.manifest_id), envelope);
        self.refresh_allowed();
    }

    fn on_page(&mut self, key: &str, body: &str) {
        let Ok(message) = serde_json::from_str::<Value>(body) else {
            return;
        };
        let Some(surface) = self.surfaces.get_mut(key) else {
            return;
        };
        surface.last_seen = Some(Instant::now());
        let display_id = (key != NOTICE_KEY).then(|| key.to_owned());
        match message["type"].as_str() {
            Some("loaded") => {
                surface.loaded = true;
                for script in std::mem::take(&mut surface.queue) {
                    let _ = surface.webview.evaluate_script(&script);
                }
            }
            Some("prepared") => {
                let manifest = message["manifest_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                if let Some(envelope) = self.pending.remove(&(key.to_owned(), manifest.clone())) {
                    if message["error"].is_null() {
                        self.agent.reply(&envelope, MessageType::Ready, json!({}));
                    } else {
                        let code = message["error"]["code"]
                            .as_str()
                            .unwrap_or("PREPARATION_FAILED");
                        let detail = message["error"]["detail"].as_str().unwrap_or_default();
                        self.agent.error(&envelope, code, detail);
                    }
                }
            }
            Some("frame") => {
                self.agent.send(
                    MessageType::FramePresented,
                    None,
                    json!({ "display_id": display_id, "manifest_id": message["manifest_id"] }),
                );
            }
            Some("status") => {
                let playback = serde_json::from_value(message["playback"].clone())
                    .unwrap_or(Playback::Unknown);
                surface.status = Some((
                    message["manifest_id"].as_str().map(str::to_owned),
                    playback,
                    message["content_ref"].as_str().map(str::to_owned),
                ));
            }
            _ => {}
        }
    }

    fn status(&self) -> Value {
        let displays: Vec<DisplayStatus> = self
            .surfaces
            .iter()
            .filter(|(key, _)| key.as_str() != NOTICE_KEY)
            .map(|(key, surface)| {
                let (manifest_id, playback, content_ref) =
                    surface
                        .status
                        .clone()
                        .unwrap_or((None, Playback::Unknown, None));
                DisplayStatus {
                    display_id: key.clone(),
                    manifest_id,
                    playback,
                    content_ref,
                }
            })
            .collect();
        json!({ "displays": displays })
    }

    fn on_tick(&mut self) {
        let responsive = self
            .surfaces
            .values()
            .all(|surface| match surface.last_seen {
                Some(seen) => seen.elapsed() < PAGE_SILENCE_LIMIT,
                None => surface.created.elapsed() < PAGE_LOAD_GRACE,
            });
        if responsive {
            self.agent.send(MessageType::Status, None, self.status());
        } else {
            eprintln!("page de lecture sans réponse : STATUS suspendu");
        }
    }
}

/// Blob du cache, seulement pour une empreinte d’un manifest préparé (NAT-006).
pub fn serve_asset(
    allowed: &RwLock<HashSet<String>>,
    blobs: &std::path::Path,
    path: &str,
    range: Option<&str>,
) -> wry::http::Response<std::borrow::Cow<'static, [u8]>> {
    let sha = path.strip_prefix('/').unwrap_or(path);
    let permitted = is_sha256(sha) && allowed.read().map(|set| set.contains(sha)).unwrap_or(false);
    if !permitted {
        return respond(StatusCode::FORBIDDEN, "text/plain", Vec::new());
    }
    match resolve_within(blobs, sha) {
        Ok(file) => serve_file(&file, range),
        Err(_) => respond(StatusCode::NOT_FOUND, "text/plain", Vec::new()),
    }
}

/// Sortie demandée par son nom de connecteur, sinon dans l’ordre des moniteurs.
fn pick_monitor(
    monitors: &[MonitorHandle],
    output_key: Option<&str>,
    index: usize,
) -> Option<MonitorHandle> {
    if let Some(key) = output_key
        && let Some(found) = monitors.iter().find(|m| {
            m.name()
                .is_some_and(|name| name == key || name.contains(key) || key.contains(&name))
        })
    {
        return Some(found.clone());
    }
    monitors.get(index).or_else(|| monitors.first()).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ne_sert_que_les_blobs_des_manifests_prepares() {
        let dir = std::env::temp_dir().join(format!("pixlova-assets-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("blobs")).unwrap();
        let (allowed_sha, other_sha) = ("a".repeat(64), "b".repeat(64));
        std::fs::write(dir.join("blobs").join(&allowed_sha), b"image").unwrap();
        std::fs::write(dir.join("blobs").join(&other_sha), b"autre").unwrap();
        std::fs::write(dir.join("device.key"), b"secret").unwrap();
        let allowed = RwLock::new(HashSet::from([allowed_sha.clone()]));
        let blobs = dir.join("blobs");
        let status = |path: &str| serve_asset(&allowed, &blobs, path, None).status();
        assert_eq!(status(&format!("/{allowed_sha}")), StatusCode::OK);
        assert_eq!(
            serve_asset(&allowed, &blobs, &format!("/{allowed_sha}"), None)
                .body()
                .as_ref(),
            b"image"
        );
        // Présent dans le cache mais absent des manifests préparés.
        assert_eq!(status(&format!("/{other_sha}")), StatusCode::FORBIDDEN);
        for path in [
            "/../device.key",
            "/device.key",
            "/%2e%2e/device.key",
            "/",
            &format!("/{}", "A".repeat(64)),
        ] {
            assert_eq!(status(path), StatusCode::FORBIDDEN, "{path}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
