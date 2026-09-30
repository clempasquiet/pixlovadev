#!/usr/bin/env node
/**
 * Player simulé pour le développement local (en attendant les Players réels, L06) :
 * enregistrement, affichage du code, attente de l’appairage, jeton signé par une clé
 * Ed25519 locale, puis heartbeat toutes les 30 s et affichage des affectations. Chaque
 * nouveau manifest désiré est téléchargé, contrôlé (schéma et cohérence), puis déclaré
 * préparé et appliqué : ces états sont simulés, aucun rendu ni téléchargement d’asset.
 *
 *   node scripts/simulate-player.mjs [URL_API]    (défaut http://127.0.0.1:3000)
 *
 * Outil de développement uniquement : la clé est gardée en mémoire et perdue à l’arrêt.
 */
import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  checkManifestSemantics,
  encodeBase64url,
  signPlayerChallenge,
  validator,
} from '@pixlova/contracts';

const api = (process.argv[2] ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const secretKey = ed25519.utils.randomSecretKey();
let token = null;

async function call(method, path, body) {
  const response = await fetch(`${api}/player/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(`${path} → ${response.status} ${json.error?.code ?? ''} ${json.error?.message ?? ''}`);
  return json;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const registration = await call('POST', '/register', {
  installation_id: randomUUID(),
  public_key: encodeBase64url(ed25519.getPublicKey(secretKey)),
  capabilities: {
    player_type: 'native',
    app_version: '0.0.0-sim',
    os: { family: 'other', version: null },
    architecture: 'unknown',
    protocol_versions: [1],
    manifest_schemas: [1],
    render_schemas: [1],
    renderer: { engine: 'simulateur', version: '0' },
    image_types: ['image/png', 'image/jpeg'],
    video_profiles: ['mp4-h264-aac'],
    max_canvas: { width: 3840, height: 2160 },
    max_concurrent_videos: 1,
    multi_output: 'supported',
    screenshot: 'unsupported',
    volume_control: 'unsupported',
    reboot_host: 'unsupported',
    persistent_storage: 'unknown',
    storage_quota_bytes: null,
  },
  outputs: [
    { output_key: 'SIM-1', connector_type: 'virtuel', width: 1920, height: 1080, refresh_hz: 60, connected: true },
    { output_key: 'SIM-2', connector_type: 'virtuel', width: 1080, height: 1920, refresh_hz: 60, connected: true },
  ],
  machine_fingerprint: null,
});
console.log(`\n  Code d’appairage : ${registration.pairing_code}   (valable jusqu’à ${new Date(registration.expires_at).toLocaleTimeString('fr-FR')})\n`);
console.log('  Saisissez-le dans le dashboard : Players → Appairer un Player.\n');

let paired;
for (;;) {
  paired = await call('POST', '/pair', { registration_id: registration.registration_id, poll_secret: registration.poll_secret });
  if (paired.status === 'paired') break;
  await sleep(registration.poll_interval_s * 1000);
}
console.log(`Appairé : Player ${paired.player_id}`);

async function authenticate() {
  const { challenge } = await call('POST', '/token/challenge', { player_id: paired.player_id });
  const result = await call('POST', '/token/refresh', { challenge_id: challenge.challenge_id, signature: signPlayerChallenge(challenge, secretKey) });
  token = result.access_token;
  return new Date(result.expires_at).getTime();
}

const validatePayload = validator('manifest-payload.json');
/** Dernière version appliquée (simulée) par Display. */
const applied = new Map();

async function syncManifest(assignment) {
  if (!assignment.manifest_version || applied.get(assignment.display_id) === assignment.manifest_version) return;
  const response = await fetch(`${api}/player/v1/manifest?display_id=${assignment.display_id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status !== 200) return;
  const envelope = JSON.parse(await response.text());
  const payload = envelope.payload;
  if (!validatePayload(payload)) throw new Error('manifest hors schéma');
  checkManifestSemantics(payload);
  const report = (state) =>
    call('POST', `/manifests/${payload.manifest_id}/status`, {
      state,
      observed_at: new Date().toISOString().replace(/\.[0-9]{3}Z$/, 'Z'),
      error_code: null,
      detail: null,
    });
  await report('ready');
  await report('applied');
  applied.set(assignment.display_id, payload.version);
  console.log(
    `[${new Date().toLocaleTimeString('fr-FR')}] manifest v${payload.version} pour ${assignment.display.name} : ${payload.timeline.length} intervalle(s), ${payload.assets.length} asset(s), jusqu’au ${new Date(payload.schedule_until).toLocaleString('fr-FR')} — appliqué (simulé, sans rendu)`,
  );
}

let tokenExpiry = await authenticate();
for (;;) {
  try {
    if (Date.now() > tokenExpiry - 60_000) tokenExpiry = await authenticate();
    const config = await call('GET', '/config');
    const known = config.assignments;
    for (const assignment of known) await syncManifest(assignment);
    const heartbeat = await call('POST', '/heartbeat', {
      uptime_seconds: Math.round(process.uptime()),
      renderer: 'ok',
      displays: known.map((a) => ({ display_id: a.display_id, assignment_generation: a.assignment_generation, manifest_applied_version: applied.get(a.display_id) ?? null, playback: 'standby' })),
    });
    const summary = known.map((a) => `${a.display.name} (${a.display.width}×${a.display.height}) sur ${a.output_key}, génération ${a.assignment_generation}`);
    console.log(`[${new Date().toLocaleTimeString('fr-FR')}] heartbeat · ${summary.length ? summary.join(' ; ') : 'aucun Display affecté'}${heartbeat.stale_displays.length ? ' · affectation périmée signalée' : ''}`);
    await sleep(config.heartbeat_interval_s * 1000);
  } catch (error) {
    console.error(`Erreur : ${error.message}`);
    if (String(error.message).includes('PLAYER_REVOKED')) process.exit(1);
    await sleep(10_000);
  }
}
