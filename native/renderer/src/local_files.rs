//! Résolution sûre des fichiers servis au moteur de rendu par le protocole local.
//!
//! Le renderer ne lit que des fichiers situés sous une racine autorisée : les
//! traversées (`..`), chemins absolus, séparateurs Windows, encodages et liens
//! symboliques sortant de la racine sont refusés (SEC-012, NAT-006).

use std::fmt;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveError {
    /// Chemin syntaxiquement refusé (traversée, encodage, séparateur inattendu).
    Forbidden,
    /// Fichier absent ou sortant de la racine après résolution des liens.
    NotFound,
}

impl fmt::Display for ResolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ResolveError::Forbidden => f.write_str("chemin refusé"),
            ResolveError::NotFound => f.write_str("fichier introuvable"),
        }
    }
}

/// `request_path` est le chemin de l’URL (`/assets/index.js`), sans requête ni fragment.
pub fn resolve_within(root: &Path, request_path: &str) -> Result<PathBuf, ResolveError> {
    let relative = request_path.strip_prefix('/').unwrap_or(request_path);
    let relative = if relative.is_empty() {
        "index.html"
    } else {
        relative
    };
    let allowed = |c: char| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '-' | '_');
    if !relative.chars().all(allowed) || relative.contains("//") {
        return Err(ResolveError::Forbidden);
    }
    let candidate = Path::new(relative);
    if !candidate
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(ResolveError::Forbidden);
    }
    let root = root.canonicalize().map_err(|_| ResolveError::NotFound)?;
    let resolved = root
        .join(candidate)
        .canonicalize()
        .map_err(|_| ResolveError::NotFound)?;
    if !resolved.starts_with(&root) || !resolved.is_file() {
        return Err(ResolveError::NotFound);
    }
    Ok(resolved)
}

pub fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
    {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// Plage d’octets demandée (`Range: bytes=a-b`), bornée à la taille du fichier.
pub fn parse_range(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?;
    if size == 0 || spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = match (start.trim(), end.trim()) {
        ("", suffix) => {
            let length: u64 = suffix.parse().ok()?;
            (size.saturating_sub(length), size - 1)
        }
        (start, "") => (start.parse().ok()?, size - 1),
        (start, end) => (start.parse().ok()?, end.parse::<u64>().ok()?.min(size - 1)),
    };
    (start <= end && start < size).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn sandbox(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("pixlova-renderer-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("root/assets")).unwrap();
        fs::write(dir.join("root/index.html"), "<!doctype html>").unwrap();
        fs::write(dir.join("root/assets/app.js"), "void 0").unwrap();
        fs::write(dir.join("secret.txt"), "secret").unwrap();
        dir
    }

    #[test]
    fn sert_les_fichiers_de_la_racine() {
        let dir = sandbox("ok");
        let root = dir.join("root");
        assert!(resolve_within(&root, "/").unwrap().ends_with("index.html"));
        assert!(
            resolve_within(&root, "/assets/app.js")
                .unwrap()
                .ends_with("app.js")
        );
    }

    #[test]
    fn refuse_les_traversees_et_encodages() {
        let dir = sandbox("traversal");
        let root = dir.join("root");
        for path in [
            "/../secret.txt",
            "/assets/../../secret.txt",
            "/./index.html",
            "/%2e%2e/secret.txt",
            "/assets\\..\\..\\secret.txt",
            "/C:/Windows/win.ini",
            "//etc/passwd",
        ] {
            assert_eq!(
                resolve_within(&root, path),
                Err(ResolveError::Forbidden),
                "{path}"
            );
        }
        assert_eq!(
            resolve_within(&root, "/absent.js"),
            Err(ResolveError::NotFound)
        );
        assert_eq!(
            resolve_within(&root, "/assets"),
            Err(ResolveError::NotFound)
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuse_un_lien_symbolique_sortant_de_la_racine() {
        let dir = sandbox("symlink");
        let root = dir.join("root");
        std::os::unix::fs::symlink(dir.join("secret.txt"), root.join("assets/leak.txt")).unwrap();
        assert_eq!(
            resolve_within(&root, "/assets/leak.txt"),
            Err(ResolveError::NotFound)
        );
    }

    #[test]
    fn interprete_les_plages_video() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-500", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=5-1", 100), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 100), None);
    }
}
