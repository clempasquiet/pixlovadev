//! Mises à jour signées et lanceur A/B (PLY-005, NAT-013 à NAT-015, SEC-011).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signer, SigningKey};
use pixlova_agent::launcher::restore_database_if_needed;
use pixlova_agent::store::{Store, snapshot_path};
use pixlova_agent::updater::{LauncherState, apply, versions_dir};
use pixlova_contracts::TrustStore;
use pixlova_contracts::canonical::canonical_bytes;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;

const NOW: &str = "2026-10-01T10:00:00Z";

fn release_key() -> SigningKey {
    SigningKey::from_bytes(&[42; 32])
}

fn trust() -> TrustStore {
    TrustStore::from([("release-test".to_owned(), release_key().verifying_key())])
}

fn sign(payload: &Value, key: &SigningKey, kind: &str) -> String {
    let protected = json!({ "type": kind, "alg": "Ed25519", "kid": "release-test" });
    let input = canonical_bytes(&json!({ "protected": protected, "payload": payload }));
    let signature = URL_SAFE_NO_PAD.encode(key.sign(&input).to_bytes());
    json!({ "protected": protected, "payload": payload, "signature": signature }).to_string()
}

fn sha256(path: &Path) -> (String, u64) {
    let bytes = std::fs::read(path).unwrap();
    (pixlova_agent::cache::sha256_hex(&bytes), bytes.len() as u64)
}

/// Script d’agent factice : écrit (ou non) le marqueur de santé de sa version.
fn agent_script(version: &str, healthy: bool, exit_code: i32, stay_ms: u32) -> String {
    let marker = if healthy {
        format!(
            "mkdir -p \"$3/state\" && printf '{{\"version\":\"{version}\"}}' > \"$3/state/healthy\"\n"
        )
    } else {
        String::new()
    };
    format!(
        "#!/bin/sh\n# $1=run $2=--data-dir $3=<dossier>\n{marker}sleep {}\nexit {exit_code}\n",
        f64::from(stay_ms) / 1000.0
    )
}

struct PackageEntry<'a> {
    path: &'a str,
    body: Vec<u8>,
    mode: u32,
    kind: tar::EntryType,
    link: Option<&'a str>,
}

fn file<'a>(path: &'a str, body: &[u8], mode: u32) -> PackageEntry<'a> {
    PackageEntry {
        path,
        body: body.to_vec(),
        mode,
        kind: tar::EntryType::Regular,
        link: None,
    }
}

fn build_package(dir: &Path, name: &str, entries: &[PackageEntry<'_>]) -> PathBuf {
    let path = dir.join(name);
    let mut builder = tar::Builder::new(std::fs::File::create(&path).unwrap());
    for entry in entries {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(entry.kind);
        header.set_mode(entry.mode);
        header.set_size(entry.body.len() as u64);
        if let Some(link) = entry.link {
            header.set_link_name(link).unwrap();
        }
        // Écriture brute du nom : les chemins dangereux doivent pouvoir être construits.
        let bytes = entry.path.as_bytes();
        header.as_gnu_mut().unwrap().name[..bytes.len()].copy_from_slice(bytes);
        header.set_cksum();
        builder.append(&header, entry.body.as_slice()).unwrap();
    }
    builder.finish().unwrap();
    path
}

fn good_entries(version: &str) -> Vec<PackageEntry<'static>> {
    vec![
        file(
            "pixlova-agent",
            agent_script(version, true, 0, 300).as_bytes(),
            0o755,
        ),
        file("pixlova-renderer", b"#!/bin/sh\n", 0o755),
        file("player-shell/index.html", b"<!doctype html>", 0o644),
    ]
}

fn release(version: &str, package: &Path) -> Value {
    let (sha, size) = sha256(package);
    json!({
        "schema_version": 1, "release_id": format!("12345678-1234-4234-8234-{:0>12}", version.replace('.', "")),
        "version": version, "os": pixlova_agent::platform::os_family(), "arch": pixlova_agent::platform::architecture(),
        "package": { "sha256": sha, "size_bytes": size },
        "protocol_min": 1, "protocol_max": 1, "sqlite_schema": 1, "sqlite_reader_level": 1,
        "renderer_build": version, "published_at": NOW,
    })
}

#[test]
fn installe_une_release_signee_comme_version_en_attente() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let package = build_package(dir.path(), "p.tar", &good_entries("0.2.0"));
    let raw = sign(
        &release("0.2.0", &package),
        &release_key(),
        "SIGNAGE_RELEASE_V1",
    );
    let installed = apply(&data, &trust(), &raw, &package, "0.1.0", NOW).unwrap();
    assert_eq!(installed.directory, versions_dir(&data).join("0.2.0"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(installed.directory.join("pixlova-agent"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
    }
    let state = LauncherState::load(&data).unwrap();
    assert_eq!(
        (state.current.as_deref(), state.pending.as_deref()),
        (Some("0.1.0"), Some("0.2.0"))
    );
    // Réinstaller la même version ou une plus ancienne est refusé.
    assert_eq!(
        apply(&data, &trust(), &raw, &package, "0.1.0", NOW)
            .unwrap_err()
            .code(),
        "ALREADY_INSTALLED"
    );
    let old = build_package(dir.path(), "old.tar", &good_entries("0.0.9"));
    let old_raw = sign(
        &release("0.0.9", &old),
        &release_key(),
        "SIGNAGE_RELEASE_V1",
    );
    assert_eq!(
        apply(&data, &trust(), &old_raw, &old, "0.1.0", NOW)
            .unwrap_err()
            .code(),
        "RELEASE_NOT_NEWER"
    );
}

#[test]
fn refuse_les_paquets_non_signes_alteres_ou_dangereux() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let package = build_package(dir.path(), "p.tar", &good_entries("0.2.0"));
    let payload = release("0.2.0", &package);
    let code = |raw: &str, package: &Path| {
        apply(&data, &trust(), raw, package, "0.1.0", NOW)
            .unwrap_err()
            .code()
    };
    // Signé par une clé inconnue, ou métadonnées d’un autre type.
    assert_eq!(
        code(
            &sign(
                &payload,
                &SigningKey::from_bytes(&[1; 32]),
                "SIGNAGE_RELEASE_V1"
            ),
            &package
        ),
        "RELEASE_INVALID"
    );
    assert_eq!(
        code(
            &sign(&payload, &release_key(), "SIGNAGE_MANIFEST_V1"),
            &package
        ),
        "RELEASE_INVALID"
    );
    // Autre architecture.
    let mut other = payload.clone();
    other["arch"] = json!(if pixlova_agent::platform::architecture() == "x86_64" {
        "aarch64"
    } else {
        "x86_64"
    });
    assert_eq!(
        code(
            &sign(&other, &release_key(), "SIGNAGE_RELEASE_V1"),
            &package
        ),
        "WRONG_PLATFORM"
    );
    // Paquet modifié après signature : refusé avant toute extraction.
    let raw = sign(&payload, &release_key(), "SIGNAGE_RELEASE_V1");
    let mut bytes = std::fs::read(&package).unwrap();
    bytes[600] ^= 1;
    let tampered = dir.path().join("tampered.tar");
    std::fs::write(&tampered, &bytes).unwrap();
    assert_eq!(code(&raw, &tampered), "PACKAGE_MISMATCH");
    assert!(!versions_dir(&data).join("0.2.0").exists());
    // Traversée, chemin absolu, lien symbolique, fichier requis absent.
    let unsafe_cases: Vec<(&str, Vec<PackageEntry<'_>>, &str)> = vec![
        (
            "traversee.tar",
            vec![file("../evil", b"x", 0o755)],
            "PACKAGE_UNSAFE",
        ),
        (
            "absolu.tar",
            vec![file("/etc/evil", b"x", 0o644)],
            "PACKAGE_UNSAFE",
        ),
        (
            "lien.tar",
            vec![PackageEntry {
                path: "pixlova-agent",
                body: vec![],
                mode: 0o777,
                kind: tar::EntryType::Symlink,
                link: Some("/bin/sh"),
            }],
            "PACKAGE_UNSAFE",
        ),
        (
            "incomplet.tar",
            vec![file("pixlova-agent", b"#!/bin/sh\n", 0o755)],
            "PACKAGE_INCOMPLETE",
        ),
    ];
    for (name, entries, expected) in unsafe_cases {
        let package = build_package(dir.path(), name, &entries);
        let raw = sign(
            &release("0.2.0", &package),
            &release_key(),
            "SIGNAGE_RELEASE_V1",
        );
        assert_eq!(code(&raw, &package), expected, "{name}");
        assert!(!versions_dir(&data).join("0.2.0").exists(), "{name}");
        assert!(!dir.path().join("evil").exists());
    }
    // Une release bloquée n’est jamais réinstallée.
    let mut state = LauncherState::load(&data).unwrap();
    state.blocked.push("0.2.0".into());
    state.save(&data).unwrap();
    assert_eq!(code(&raw, &package), "RELEASE_BLOCKED");
}

fn install_version(data: &Path, version: &str, script: &str) {
    let dir = versions_dir(data).join(version);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("pixlova-agent"), script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            dir.join("pixlova-agent"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
}

fn launch(data: &Path, timeout_seconds: u32) -> i32 {
    Command::new(env!("CARGO_BIN_EXE_pixlova-launcher"))
        .args([
            "--data-dir",
            data.to_str().unwrap(),
            "--health-timeout",
            &timeout_seconds.to_string(),
        ])
        .status()
        .unwrap()
        .code()
        .unwrap_or(-1)
}

fn set_state(data: &Path, current: &str, pending: &str) {
    LauncherState {
        current: Some(current.into()),
        pending: Some(pending.into()),
        ..Default::default()
    }
    .save(data)
    .unwrap();
}

#[test]
fn trois_demarrages_sans_sante_ramenent_a_la_version_precedente() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    install_version(&data, "0.1.0", &agent_script("0.1.0", true, 0, 100));
    install_version(&data, "0.2.0", &agent_script("0.2.0", false, 3, 0));
    set_state(&data, "0.1.0", "0.2.0");
    // systemd relance le lanceur après chaque arrêt de l’agent en essai.
    for attempt in 1..=3 {
        assert_ne!(launch(&data, 30), 0, "essai {attempt}");
        assert_eq!(
            LauncherState::load(&data).unwrap().pending_attempts,
            attempt
        );
    }
    assert_eq!(launch(&data, 30), 0);
    let state = LauncherState::load(&data).unwrap();
    assert_eq!(
        (state.current.as_deref(), state.pending.as_deref()),
        (Some("0.1.0"), None)
    );
    assert_eq!(state.blocked, ["0.2.0"]);
    assert_eq!(state.history.last().unwrap().result, "rolled_back");
    #[cfg(unix)]
    assert_eq!(
        std::fs::read_link(versions_dir(&data).join("active")).unwrap(),
        Path::new("0.1.0")
    );
}

#[test]
fn sans_marqueur_de_sante_dans_le_delai_retour_immediat() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    install_version(&data, "0.1.0", &agent_script("0.1.0", true, 0, 100));
    // Démarre mais n’affiche jamais d’image : aucun marqueur.
    install_version(&data, "0.3.0", &agent_script("0.3.0", false, 0, 30_000));
    set_state(&data, "0.1.0", "0.3.0");
    let started = std::time::Instant::now();
    assert_eq!(launch(&data, 1), 0);
    assert!(started.elapsed() < std::time::Duration::from_secs(20));
    let state = LauncherState::load(&data).unwrap();
    assert_eq!(state.blocked, ["0.3.0"]);
    assert_eq!(state.current.as_deref(), Some("0.1.0"));
}

#[test]
fn retour_arriere_demande_par_l_agent_execute_par_le_lanceur() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    install_version(&data, "0.1.0", &agent_script("0.1.0", true, 0, 100));
    install_version(&data, "0.4.0", &agent_script("0.4.0", true, 0, 100));
    // Sans version précédente, rien n’est demandé.
    LauncherState {
        current: Some("0.4.0".into()),
        ..Default::default()
    }
    .save(&data)
    .unwrap();
    assert_eq!(
        pixlova_agent::updater::request_rollback(&data, "plateforme")
            .unwrap_err()
            .code(),
        "ROLLBACK_UNAVAILABLE"
    );
    // Pendant un essai non plus.
    set_state(&data, "0.1.0", "0.4.0");
    assert_eq!(
        pixlova_agent::updater::request_rollback(&data, "plateforme")
            .unwrap_err()
            .code(),
        "UPDATE_IN_PROGRESS"
    );
    LauncherState {
        current: Some("0.4.0".into()),
        previous: Some("0.1.0".into()),
        ..Default::default()
    }
    .save(&data)
    .unwrap();
    assert_eq!(
        pixlova_agent::updater::request_rollback(&data, "release bloquée par la plateforme")
            .unwrap(),
        "0.1.0"
    );
    assert_eq!(launch(&data, 30), 0);
    let state = LauncherState::load(&data).unwrap();
    assert_eq!(
        (state.current.as_deref(), state.previous.as_deref()),
        (Some("0.1.0"), None)
    );
    assert_eq!(state.blocked, ["0.4.0"]);
    assert_eq!(state.rollback_requested, None);
    let last = state.history.last().unwrap();
    assert_eq!(
        (last.version.as_str(), last.result.as_str()),
        ("0.4.0", "rolled_back")
    );
    #[cfg(unix)]
    assert_eq!(
        std::fs::read_link(versions_dir(&data).join("active")).unwrap(),
        Path::new("0.1.0")
    );
}

#[test]
fn une_version_saine_est_promue() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().to_path_buf();
    install_version(&data, "0.1.0", &agent_script("0.1.0", true, 0, 100));
    install_version(&data, "0.4.0", &agent_script("0.4.0", true, 0, 500));
    set_state(&data, "0.1.0", "0.4.0");
    assert_eq!(launch(&data, 30), 0);
    let state = LauncherState::load(&data).unwrap();
    assert_eq!(
        (
            state.current.as_deref(),
            state.previous.as_deref(),
            state.pending.as_deref()
        ),
        (Some("0.4.0"), Some("0.1.0"), None)
    );
    assert_eq!(state.history.last().unwrap().result, "promoted");
}

#[test]
fn restaure_la_base_seulement_pour_la_meme_association() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("pixlova.db");
    let store = Store::open(&db).unwrap();
    store.save_registration("r", "s", "ABCD-EFGH", NOW).unwrap();
    store.save_pairing("org-1", "player-1", NOW).unwrap();
    drop(store);
    // Copie d’avant migration, puis migration hypothétique illisible par la version 1.
    std::fs::copy(&db, snapshot_path(&db, 1)).unwrap();
    let bump = |path: &Path, level: i64| {
        rusqlite::Connection::open(path)
            .unwrap()
            .execute(
                "UPDATE schema_meta SET value = ?1 WHERE key = 'min_reader_level'",
                [level],
            )
            .unwrap();
    };
    bump(&db, 2);
    assert!(restore_database_if_needed(dir.path(), 1));
    assert!(Store::open(&db).is_ok());
    // Association différente dans la copie (appareil réappairé entre-temps) : pas de restauration.
    bump(&db, 2);
    let conn = rusqlite::Connection::open(snapshot_path(&db, 1)).unwrap();
    conn.execute("UPDATE association SET player_id = 'player-2'", [])
        .unwrap();
    drop(conn);
    assert!(!restore_database_if_needed(dir.path(), 1));
    assert!(Store::open(&db).is_err());
}
