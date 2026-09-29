//! Rejoue les vecteurs communs de `packages/contracts/fixtures` (PROTO-021) :
//! chaque décision doit être identique à celle de l’implémentation TypeScript.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::VerifyingKey;
use pixlova_contracts::canonical::canonical_string;
use pixlova_contracts::command::{CommandContext, Support};
use pixlova_contracts::instant::parse_instant_micros;
use pixlova_contracts::strict_json::parse_strict_json;
use pixlova_contracts::{
    CommandDecision, LocalAssociation, LocalDisplayState, ManifestDecision, TrustStore,
    evaluate_command, evaluate_manifest_candidate, verify_command, verify_manifest,
};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::PathBuf;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/contracts/fixtures")
}

fn read(path: &str) -> String {
    std::fs::read_to_string(fixtures().join(path)).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &str) -> T {
    serde_json::from_str(&read(path)).unwrap_or_else(|e| panic!("{path}: {e}"))
}

#[derive(Deserialize)]
struct KeysFile {
    keys: Vec<Key>,
    trust: HashMap<String, Vec<String>>,
}

#[derive(Deserialize)]
struct Key {
    kid: String,
    public_key_b64u: String,
}

fn trust_store(purpose: &str) -> TrustStore {
    let file: KeysFile = read_json("keys.json");
    file.trust[purpose]
        .iter()
        .map(|kid| {
            let key = file.keys.iter().find(|k| &k.kid == kid).unwrap();
            let bytes: [u8; 32] = URL_SAFE_NO_PAD
                .decode(&key.public_key_b64u)
                .unwrap()
                .try_into()
                .unwrap();
            (kid.clone(), VerifyingKey::from_bytes(&bytes).unwrap())
        })
        .collect()
}

#[derive(Deserialize)]
struct Expect {
    verification: String,
    reason: Option<String>,
    decision: Option<String>,
    code: Option<String>,
}

#[derive(Deserialize)]
struct DisplayState {
    assignment_generation: String,
    highest_version: Option<String>,
    highest_version_hash: Option<String>,
}

#[derive(Deserialize)]
struct Local {
    organization_id: String,
    player_id: String,
    displays: HashMap<String, DisplayState>,
}

#[derive(Deserialize)]
struct Capabilities {
    reboot_host: String,
    screenshot: String,
}

#[derive(Deserialize)]
struct Context {
    organization_id: String,
    player_id: String,
    assignments: HashMap<String, String>,
    seen: HashMap<String, String>,
    capabilities: Capabilities,
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    file: String,
    now: String,
    local: Option<Local>,
    context: Option<Context>,
    expect: Expect,
}

fn support(value: &str) -> Support {
    match value {
        "supported" => Support::Supported,
        "unsupported" => Support::Unsupported,
        _ => Support::Unknown,
    }
}

#[test]
fn vecteurs_de_manifests() {
    let trust = trust_store("manifest");
    let vectors: Vec<Vector> = read_json("manifest-vectors.json");
    assert!(vectors.len() >= 30);
    for vector in vectors {
        let name = &vector.name;
        match verify_manifest(&read(&vector.file), &trust) {
            Err(error) => {
                assert_eq!(
                    error.code(),
                    vector.expect.verification,
                    "{name}: {error:?}"
                );
                assert_eq!(error.reason(), vector.expect.reason.as_deref(), "{name}");
            }
            Ok(verified) => {
                assert_eq!(vector.expect.verification, "ok", "{name}");
                let local = vector.local.unwrap();
                let association = LocalAssociation {
                    organization_id: local.organization_id,
                    player_id: local.player_id,
                    displays: local
                        .displays
                        .into_iter()
                        .map(|(id, d)| {
                            let state = LocalDisplayState {
                                assignment_generation: d.assignment_generation,
                                highest_version: d.highest_version,
                                highest_version_hash: d.highest_version_hash,
                            };
                            (id, state)
                        })
                        .collect(),
                };
                let decision = evaluate_manifest_candidate(
                    &verified.manifest,
                    &verified.manifest_hash,
                    &association,
                    &vector.now,
                );
                let (kind, code) = match decision {
                    ManifestDecision::Accept { .. } => ("accept", None),
                    ManifestDecision::Duplicate => ("duplicate", None),
                    ManifestDecision::Reject(code) => ("reject", Some(code.as_str())),
                };
                assert_eq!(Some(kind), vector.expect.decision.as_deref(), "{name}");
                assert_eq!(code, vector.expect.code.as_deref(), "{name}");
            }
        }
    }
}

#[test]
fn vecteurs_de_commandes() {
    let trust = trust_store("command");
    let vectors: Vec<Vector> = read_json("command-vectors.json");
    assert!(vectors.len() >= 10);
    for vector in vectors {
        let name = &vector.name;
        match verify_command(&read(&vector.file), &trust) {
            Err(error) => {
                assert_eq!(
                    error.code(),
                    vector.expect.verification,
                    "{name}: {error:?}"
                );
                assert_eq!(error.reason(), vector.expect.reason.as_deref(), "{name}");
            }
            Ok(verified) => {
                assert_eq!(vector.expect.verification, "ok", "{name}");
                let context = vector.context.unwrap();
                let context = CommandContext {
                    organization_id: context.organization_id,
                    player_id: context.player_id,
                    assignments: context.assignments,
                    seen: context.seen,
                    reboot_host: support(&context.capabilities.reboot_host),
                    screenshot: support(&context.capabilities.screenshot),
                };
                let decision = evaluate_command(
                    &verified.command,
                    &verified.command_hash,
                    &context,
                    &vector.now,
                );
                let (kind, code) = match decision {
                    CommandDecision::Execute => ("execute", None),
                    CommandDecision::Duplicate => ("duplicate", None),
                    CommandDecision::Reject(code) => ("reject", Some(code.as_str())),
                };
                assert_eq!(Some(kind), vector.expect.decision.as_deref(), "{name}");
                assert_eq!(code, vector.expect.code.as_deref(), "{name}");
            }
        }
    }
}

#[derive(Deserialize)]
struct StrictVector {
    name: String,
    input: String,
    valid: bool,
}

#[test]
fn json_strict() {
    for vector in read_json::<Vec<StrictVector>>("strict-json-vectors.json") {
        let result = parse_strict_json(&vector.input);
        assert_eq!(result.is_ok(), vector.valid, "{}: {result:?}", vector.name);
    }
}

#[derive(Deserialize)]
struct JcsVector {
    name: String,
    input: String,
    canonical: String,
}

#[test]
fn jcs_identique_a_typescript() {
    for vector in read_json::<Vec<JcsVector>>("jcs-vectors.json") {
        let value = parse_strict_json(&vector.input).unwrap();
        assert_eq!(
            canonical_string(&value),
            vector.canonical,
            "{}",
            vector.name
        );
    }
}

#[derive(Deserialize)]
struct InstantVector {
    input: String,
    micros: Option<i64>,
}

#[test]
fn instants_utc() {
    for vector in read_json::<Vec<InstantVector>>("instant-vectors.json") {
        assert_eq!(
            parse_instant_micros(&vector.input),
            vector.micros,
            "{}",
            vector.input
        );
    }
}
