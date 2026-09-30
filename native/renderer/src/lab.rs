//! Mode laboratoire (L00, NAT-002) : héberge le banc `apps/render-lab` pour les mesures
//! de qualification et la comparaison géométrique avec Chromium.
//!
//! Usage : `pixlova-renderer --lab-dir apps/render-lab/dist [--video fichier.mp4]
//!          [--query "auto&duration=20"] [--out resultats.json] [--windowed]`

use crate::local_files::{ResolveError, resolve_within};
use crate::serve::{respond, serve_file};
use std::path::PathBuf;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::{Fullscreen, WindowBuilder};
use wry::WebViewBuilder;
use wry::http::{Request, StatusCode, header};

const VIDEO_PATH: &str = "/__video";

struct Options {
    lab_dir: PathBuf,
    video: Option<PathBuf>,
    query: String,
    out: Option<PathBuf>,
    windowed: bool,
}

fn parse_args(args: Vec<String>) -> Result<Options, String> {
    let mut options = Options {
        lab_dir: PathBuf::from("apps/render-lab/dist"),
        video: None,
        query: "auto".to_owned(),
        out: None,
        windowed: false,
    };
    let mut args = args.into_iter();
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

/// Banc de rendu (`apps/render-lab`) : mesures REN-004 et comparaison avec Chromium.
pub fn run(args: Vec<String>) {
    let options = match parse_args(args) {
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
