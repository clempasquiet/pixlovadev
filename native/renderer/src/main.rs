//! Prototype du renderer natif pixlova (L00, NAT-002).
//!
//! Héberge le moteur de rendu partagé (banc `apps/render-lab`) dans la WebView du
//! système : WebKitGTK sous Linux, WebView2 sous Windows. Les fichiers sont servis par
//! un protocole local `pixlova` limité à une racine ; aucun serveur réseau n’est ouvert
//! et aucun credential cloud n’est présent dans ce processus (SEC-012).
//!
//! Usage : `pixlova-renderer --lab-dir apps/render-lab/dist [--video fichier.mp4]
//!          [--query "auto&duration=20"] [--out resultats.json] [--windowed]`

mod local_files;

use local_files::{ResolveError, content_type, parse_range, resolve_within};
use std::borrow::Cow;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::{Fullscreen, WindowBuilder};
use wry::WebViewBuilder;
use wry::http::{Request, Response, StatusCode, header};

const VIDEO_PATH: &str = "/__video";
/// Taille maximale d’une réponse partielle : la WebView redemande la suite.
const MAX_CHUNK: u64 = 8 * 1024 * 1024;

struct Options {
    lab_dir: PathBuf,
    video: Option<PathBuf>,
    query: String,
    out: Option<PathBuf>,
    windowed: bool,
}

fn parse_args() -> Result<Options, String> {
    let mut options = Options {
        lab_dir: PathBuf::from("apps/render-lab/dist"),
        video: None,
        query: "auto".to_owned(),
        out: None,
        windowed: false,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or(format!("valeur manquante pour {arg}"));
        match arg.as_str() {
            "--lab-dir" => options.lab_dir = PathBuf::from(value()?),
            "--video" => options.video = Some(PathBuf::from(value()?)),
            "--query" => options.query = value()?,
            "--out" => options.out = Some(PathBuf::from(value()?)),
            "--windowed" => options.windowed = true,
            other => return Err(format!("option inconnue : {other}")),
        }
    }
    if !options
        .query
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "&=_-.".contains(c))
    {
        return Err("--query ne peut contenir que [A-Za-z0-9&=_-.]".to_owned());
    }
    Ok(options)
}

fn respond(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Cow::Owned(body))
        .expect("réponse HTTP valide")
}

fn serve_file(path: &Path, range: Option<&str>) -> Response<Cow<'static, [u8]>> {
    let Ok(mut file) = File::open(path) else {
        return respond(StatusCode::NOT_FOUND, "text/plain", Vec::new());
    };
    let size = file.metadata().map(|m| m.len()).unwrap_or(0);
    let kind = content_type(path);
    let Some(range) = range else {
        let mut body = Vec::new();
        return match file.read_to_end(&mut body) {
            Ok(_) => respond(StatusCode::OK, kind, body),
            Err(_) => respond(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", Vec::new()),
        };
    };
    let Some((start, end)) = parse_range(range, size) else {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::CONTENT_RANGE, format!("bytes */{size}"))
            .body(Cow::Owned(Vec::new()))
            .expect("réponse HTTP valide");
    };
    let end = end.min(start + MAX_CHUNK - 1);
    let mut body = vec![0; (end - start + 1) as usize];
    if file.seek(SeekFrom::Start(start)).is_err() || file.read_exact(&mut body).is_err() {
        return respond(StatusCode::INTERNAL_SERVER_ERROR, "text/plain", Vec::new());
    }
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, kind)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{size}"))
        .body(Cow::Owned(body))
        .expect("réponse HTTP valide")
}

fn main() {
    let options = match parse_args() {
        Ok(options) => options,
        Err(message) => {
            eprintln!("pixlova-renderer : {message}");
            std::process::exit(2);
        }
    };
    let lab_dir = options.lab_dir.clone();
    let video = options.video.clone();
    let out = options.out.clone();

    let event_loop = EventLoopBuilder::<()>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let mut builder = WindowBuilder::new().with_title("pixlova renderer (prototype)");
    if !options.windowed {
        builder = builder.with_fullscreen(Some(Fullscreen::Borderless(None)));
    }
    let window = builder.build(&event_loop).expect("création de la fenêtre");

    // Windows (WebView2) expose les protocoles personnalisés sous http://<schéma>.<hôte>/.
    let base = if cfg!(windows) {
        "http://pixlova.lab"
    } else {
        "pixlova://lab"
    };
    let video_param = if video.is_some() {
        format!("&video={base}{VIDEO_PATH}")
    } else {
        String::new()
    };
    let url = format!("{base}/index.html?{}{video_param}", options.query);

    let webview_builder = WebViewBuilder::new()
        .with_custom_protocol("pixlova".into(), move |_id, request: Request<Vec<u8>>| {
            let path = request.uri().path();
            let range = request
                .headers()
                .get(header::RANGE)
                .and_then(|value| value.to_str().ok());
            if path == VIDEO_PATH {
                return match &video {
                    Some(file) => serve_file(file, range),
                    None => respond(StatusCode::NOT_FOUND, "text/plain", Vec::new()),
                };
            }
            match resolve_within(&lab_dir, path) {
                Ok(file) => serve_file(&file, range),
                Err(ResolveError::Forbidden) => {
                    respond(StatusCode::FORBIDDEN, "text/plain", Vec::new())
                }
                Err(ResolveError::NotFound) => {
                    respond(StatusCode::NOT_FOUND, "text/plain", Vec::new())
                }
            }
        })
        .with_ipc_handler(move |request: Request<String>| {
            // Seul message accepté : résultats JSON du banc, bornés en taille.
            let body = request.body();
            if body.len() > 1024 * 1024 {
                return;
            }
            match &out {
                Some(path) => {
                    if let Err(error) = std::fs::write(path, body) {
                        eprintln!("écriture des résultats impossible : {error}");
                    }
                    let _ = proxy.send_event(());
                }
                None => println!("{body}"),
            }
        })
        .with_url(url);

    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let _webview = webview_builder
        .build(&window)
        .expect("création de la WebView");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let _webview = {
        use tao::platform::unix::WindowExtUnix;
        use wry::WebViewBuilderExtUnix;
        let vbox = window.default_vbox().expect("conteneur GTK de la fenêtre");
        webview_builder
            .build_gtk(vbox)
            .expect("création de la WebView")
    };

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            }
            | Event::UserEvent(()) => *control_flow = ControlFlow::Exit,
            _ => {}
        }
    });
}
