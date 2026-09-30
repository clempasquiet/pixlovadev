//! Réponses du protocole local `pixlova` : fichiers entiers ou plages (vidéo).

use crate::local_files::{content_type, parse_range};
use std::borrow::Cow;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use wry::http::{Response, StatusCode, header};

/// Taille maximale d’une réponse partielle : la WebView redemande la suite.
const MAX_CHUNK: u64 = 8 * 1024 * 1024;

pub fn respond(
    status: StatusCode,
    content_type: &str,
    body: Vec<u8>,
) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Cow::Owned(body))
        .expect("réponse HTTP valide")
}

pub fn serve_file(path: &Path, range: Option<&str>) -> Response<Cow<'static, [u8]>> {
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
