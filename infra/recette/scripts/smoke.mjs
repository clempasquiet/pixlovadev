#!/usr/bin/env node
/**
 * Recette automatisée d’une instance (ADR-015), par son URL publique comme un utilisateur :
 * passerelle, inscription et email capturé par Mailpit, connexion, organisation, envoi
 * d’une image au stockage privé par URL présignée, traitement par le worker, relecture,
 * appairage d’un Player simulé et jeton Player ; puis contrôles d’exposition (routes
 * internes, listing du bucket). Sans dépendance : Node 24 suffit.
 *
 *   node infra/recette/scripts/smoke.mjs            # lit infra/recette/.env
 *   PIXLOVA_SMOKE_URL=https://recette.example.com node infra/recette/scripts/smoke.mjs
 *
 * Options d’exploitation (machine qui exécute Docker Compose) :
 *   --worker-restart     arrête le worker avant la finalisation de l’envoi, vérifie que la
 *                        tâche attend, puis le redémarre : la tâche est reprise ;
 *   --save-state FICHIER conserve compte et média créés (fichier de test, hors dépôt) ;
 *   --check-state FICHIER vérifie seulement qu’ils existent encore (après redémarrage,
 *                        restauration de sauvegarde ou mise à jour).
 *
 * Crée un compte `recette-<horodatage>@example.test` et son organisation (données de test).
 */
import { createPrivateKey, createPublicKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
try {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
} catch {
  // Variables d’environnement seulement.
}
const setting = (name, fallback) => process.env[name] ?? env[name] ?? fallback;
const base = setting('PIXLOVA_SMOKE_URL', setting('PIXLOVA_PUBLIC_URL')).replace(/\/$/, '');
const mailpit = setting(
  'PIXLOVA_SMOKE_MAILPIT_URL',
  `http://127.0.0.1:${setting('MAILPIT_PORT', '8025')}`,
).replace(/\/$/, '');
const mailAuth = `Basic ${Buffer.from(`${setting('MAILPIT_UI_USER')}:${setting('MAILPIT_UI_PASSWORD')}`).toString('base64')}`;
const bucket = setting('PIXLOVA_S3_BUCKET', 'pixlova-media');
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const compose = (...command) =>
  execFileSync('docker', ['compose', '-f', join(root, 'compose.yaml'), ...command], {
    stdio: 'pipe',
  });

let step = 0;
const ok = (message) => console.log(`  ✔ ${String(++step).padStart(2)} ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, check, seconds = 60) {
  for (let i = 0; i < seconds * 2; i++) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`délai dépassé : ${what}`);
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

let cookie = null;
let org = null;
async function call(prefix, method, path, body, headers = {}) {
  const response = await fetch(`${base}${prefix}${path}`, {
    method,
    headers: {
      origin: base,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie && prefix === '/api/v1' ? { cookie } : {}),
      ...(org && prefix === '/api/v1' ? { 'x-organization-id': org } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const set = response.headers.getSetCookie();
  if (set.length) cookie = set[0].split(';')[0];
  const json = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(`${method} ${prefix}${path} → ${response.status} ${JSON.stringify(json)}`);
  return json;
}
const api = (method, path, body, headers) => call('/api/v1', method, path, body, headers);
const player = (method, path, body, headers) => call('/player/v1', method, path, body, headers);
const idem = () => ({ 'idempotency-key': randomUUID() });

/** PNG RVB uni, sans dépendance. */
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from([r, g, b]))]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** JSON canonique (RFC 8785) des objets simples du challenge Player. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

/** Média relu : état prêt et miniature servie par URL présignée. */
async function checkMedia(id) {
  const media = await api('GET', `/media/${id}`);
  expect(media.status === 'ready', `média ${id} : ${media.status}`);
  if (media.thumbnail_url) {
    const thumbnail = await fetch(new URL(media.thumbnail_url, base));
    expect(thumbnail.ok, `miniature illisible : ${thumbnail.status}`);
  }
  return media;
}

console.log(`Recette de ${base}`);
try {
  const checkState = option('--check-state');
  if (checkState) {
    const state = JSON.parse(readFileSync(checkState, 'utf8'));
    await api('POST', '/auth/login', { email: state.email, password: state.password });
    org = state.organization_id;
    await checkMedia(state.media_id);
    ok(`compte ${state.email} et média ${state.media_id} présents et lisibles`);
    console.log(`Vérification réussie (${step} étape).`);
    process.exit(0);
  }

  // --- Passerelle et exposition ----------------------------------------------------------
  expect((await fetch(`${base}/gateway-health`)).ok, 'passerelle injoignable');
  const home = await fetch(`${base}/`);
  expect(home.ok && (await home.text()).includes('<div id="root"'), 'dashboard non servi');
  const trust = await fetch(`${base}/play/trust/manifest-keys.json`);
  expect(trust.ok && (await trust.json()).keys?.length === 1, 'clés publiques du Player Web absentes');
  ok('passerelle, dashboard et Player Web servis');
  for (const path of ['/internal/v1/health', '/internal/v1/metrics', '/internal/v1/ready']) {
    expect((await fetch(`${base}${path}`)).status === 404, `${path} exposé publiquement`);
  }
  const listing = await fetch(`${base}/${bucket}/?list-type=2`);
  expect(listing.status === 403, `listing du bucket non refusé (${listing.status})`);
  expect((await fetch(`${base}/${bucket}/x`, { method: 'DELETE' })).status === 405, 'DELETE non filtré');
  ok('routes internes absentes, bucket privé (listing 403, DELETE 405)');

  // --- Compte, email et organisation -----------------------------------------------------
  const email = `recette-${Date.now()}@example.test`;
  const password = `recette ${randomBytes(9).toString('base64url')}`;
  await api('POST', '/auth/register', { email, password, display_name: 'Recette' });
  const message = await until('email de vérification dans Mailpit', async () => {
    const search = await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`, {
      headers: { authorization: mailAuth },
    });
    const found = (await search.json()).messages?.[0];
    if (!found) return null;
    return (await fetch(`${mailpit}/api/v1/message/${found.ID}`, { headers: { authorization: mailAuth } })).json();
  });
  const link = message.Text.match(/https?:\/\/\S+verify-email\S*/)?.[0];
  expect(link?.startsWith(base), `lien de vérification inattendu : ${link}`);
  ok('inscription et email de vérification capturé par Mailpit');
  await api('POST', '/auth/verify-email', { token: new URL(link).searchParams.get('token') });
  await api('POST', '/auth/login', { email, password });
  org = (await api('POST', '/organizations', { name: 'Recette', country: 'FR', timezone: 'Europe/Paris' })).id;
  const site = (await api('GET', '/sites')).items[0].id;
  ok('email vérifié, connexion, organisation créée');

  // --- Média : envoi présigné, worker, relecture -----------------------------------------
  const image = png(640, 360, [34, 102, 170]);
  const session = await api(
    'POST',
    '/media/upload-session',
    { filename: 'recette.png', mime_type: 'image/png', size_bytes: image.length },
    idem(),
  );
  const uploadUrl = new URL(session.upload.url, base);
  expect(uploadUrl.origin === base, `URL d’envoi hors de l’origine publique : ${uploadUrl.origin}`);
  const put = await fetch(uploadUrl, { method: 'PUT', headers: session.upload.headers, body: image });
  expect(put.ok, `envoi au stockage : ${put.status} ${await put.text()}`);
  const workerRestart = args.includes('--worker-restart');
  if (workerRestart) compose('stop', 'worker');
  await api('POST', `/media/upload-session/${session.upload_id}/complete`);
  ok('image envoyée au stockage privé par URL présignée');
  if (workerRestart) {
    await sleep(5000);
    const waiting = await api('GET', `/media/${session.media.id}`);
    expect(waiting.status !== 'ready', 'média prêt alors que le worker est arrêté');
    compose('start', 'worker');
    ok(`worker arrêté : tâche en attente (${waiting.status}) ; worker relancé`);
  }
  const media = await until('image préparée par le worker', async () => {
    const found = await api('GET', `/media/${session.media.id}`);
    if (found.status === 'failed') throw new Error(`traitement en échec : ${JSON.stringify(found)}`);
    return found.status === 'ready' ? found : null;
  });
  ok('image préparée par le worker');
  if (media.thumbnail_url) {
    const thumbnail = await fetch(new URL(media.thumbnail_url, base));
    expect(thumbnail.ok, `miniature illisible : ${thumbnail.status}`);
    const tampered = new URL(media.thumbnail_url, base);
    tampered.searchParams.set('X-Amz-Signature', '0'.repeat(64));
    expect((await fetch(tampered)).status === 403, 'signature altérée acceptée');
    ok('miniature relue par URL présignée ; signature altérée refusée');
  }
  const tooLarge = Number(setting('PIXLOVA_MEDIA_VIDEO_MAX_BYTES', 2 * 1024 ** 3)) + 1;
  const refused = await fetch(`${base}/api/v1/media/upload-session`, {
    method: 'POST',
    headers: { origin: base, cookie, 'x-organization-id': org, 'content-type': 'application/json', ...idem() },
    body: JSON.stringify({ filename: 'trop.mp4', mime_type: 'video/mp4', size_bytes: tooLarge }),
  });
  expect(refused.status === 413, `envoi hors limite non refusé (${refused.status})`);
  ok(`envoi de ${tooLarge} octets refusé avant transfert (413)`);

  // --- Player simulé : enregistrement, appairage, jeton ----------------------------------
  const seed = randomBytes(32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey).export({ format: 'jwk' }).x;
  const registration = await player('POST', '/register', {
    installation_id: randomUUID(),
    public_key: publicKey,
    capabilities: {
      player_type: 'native',
      app_version: '0.0.0-recette',
      os: { family: 'other', version: null },
      architecture: 'unknown',
      protocol_versions: [1],
      manifest_schemas: [1],
      render_schemas: [1],
      renderer: { engine: 'recette', version: '0' },
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
      { output_key: 'RECETTE-1', connector_type: 'virtuel', width: 1920, height: 1080, refresh_hz: 60, connected: true },
    ],
    machine_fingerprint: null,
  });
  await api('POST', '/players/pair', { code: registration.pairing_code, name: 'Player de recette', site_id: site }, idem());
  const paired = await player('POST', '/pair', {
    registration_id: registration.registration_id,
    poll_secret: registration.poll_secret,
  });
  expect(paired.status === 'paired', `appairage : ${JSON.stringify(paired)}`);
  const { challenge } = await player('POST', '/token/challenge', { player_id: paired.player_id });
  const signature = sign(null, Buffer.from(canonical(challenge)), privateKey).toString('base64url');
  const token = await player('POST', '/token/refresh', { challenge_id: challenge.challenge_id, signature });
  expect(typeof token.access_token === 'string', 'jeton Player absent');
  ok('Player simulé appairé par code et authentifié (challenge Ed25519)');

  const saveState = option('--save-state');
  if (saveState) {
    writeFileSync(
      saveState,
      JSON.stringify({ email, password, organization_id: org, media_id: session.media.id }),
      { mode: 0o600 },
    );
  }
  console.log(`Recette réussie (${step} étapes). Compte de test : ${email}`);
} catch (error) {
  console.error(`  ✘ ${error.message}`);
  process.exit(1);
}
