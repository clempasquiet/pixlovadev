#!/usr/bin/env node
/**
 * Parcours de bout en bout du Player natif (L06-N, TST-052) : API, worker et PostgreSQL
 * réels, agent `pixlova-agent` réel et renderer `pixlova-renderer` (sans affichage, ou
 * WebKitGTK avec `--webview` sous un serveur X).
 *
 *   PIXLOVA_TEST_DATABASE_URL=… node apps/api/scripts/e2e-native-player.mjs [--webview]
 *
 * Prérequis : `pnpm run build`, `cargo build -p pixlova-agent -p pixlova-renderer` et,
 * pour `--webview`, `pnpm --filter @pixlova/player-shell run build`.
 *
 * Étapes : appairage par le code affiché, sortie déclarée, Display affecté, image
 * envoyée et préparée par le worker, planning publié, manifest signé téléchargé,
 * vérifié, préparé, première image, état « appliqué » visible au dashboard, heartbeat
 * réel ; puis API arrêtée : la diffusion locale continue ; API relancée : reconnexion.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const webview = process.argv.includes('--webview');
const { buildPublicApp } = await import(`${root}/apps/api/dist/app.js`);
const { createTestServices } = await import(`${root}/apps/api/dist/testing.js`);
const { createTestDatabase } = await import(`${root}/packages/db/dist/testing.js`);
const { createWorker, DEFAULT_VIDEO_TOOLS, silentLogger } = await import(
  `${root}/apps/workers/dist/index.js`
);
const { manifestSignerFromSeed } = await import(
  `${root}/packages/scheduling/dist/compiler/index.js`
);
const { DEFAULT_MEDIA_LIMITS, encodeBase64url, publicKeyFromSecret } = await import(
  `${root}/packages/contracts/dist/index.js`
);

const agentBin = process.env.PIXLOVA_AGENT_BIN ?? `${root}/target/debug/pixlova-agent`;
const rendererBin = process.env.PIXLOVA_RENDERER_BIN ?? `${root}/target/debug/pixlova-renderer`;
const work = await mkdtemp(join(tmpdir(), 'pixlova-e2e-'));
const log = (message) => console.log(`[e2e] ${message}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, check, seconds = 90) {
  for (let i = 0; i < seconds * 5; i++) {
    const value = await check().catch(() => null);
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`délai dépassé : ${what}`);
}

// --- Cloud réel (API, worker, PostgreSQL) ----------------------------------------------
const database = await createTestDatabase();
const test = createTestServices(database, {
  cookieSecure: false,
  allowedOrigins: ['http://localhost:5173'],
});
test.setDisplaySlots(2);
let app = buildPublicApp({ services: test.services });
await app.listen({ host: '127.0.0.1', port: 0 });
const port = app.server.address().port;
const seed = randomBytes(32);
const kid = 'manifest-e2e';
const worker = createWorker(
  {
    appDb: database.app,
    systemDb: database.system,
    storage: test.storage,
    limits: DEFAULT_MEDIA_LIMITS,
    tools: DEFAULT_VIDEO_TOOLS,
    tmpRoot: await mkdtemp(join(tmpdir(), 'pixlova-e2e-worker-')),
    trashRetentionDays: 30,
    manifestSigner: manifestSignerFromSeed(kid, encodeBase64url(seed)),
    now: () => new Date(),
    logger: silentLogger,
  },
  { pollIntervalMs: 200, sweepIntervalMs: 3_600_000 },
);
worker.start();

// Clés de confiance « installées avec le paquet ».
const trustDir = join(work, 'trust');
await mkdir(trustDir, { recursive: true });
await writeFile(
  join(trustDir, 'manifest-keys.json'),
  JSON.stringify({ keys: [{ kid, public_key: encodeBase64url(publicKeyFromSecret(seed)) }] }),
);

// --- Agent et renderer réels ------------------------------------------------------------
const dataDir = join(work, 'data');
const rendererArgs = webview
  ? ['--renderer-arg', '--shell-dir', '--renderer-arg', `${root}/apps/player-shell/dist`, '--renderer-arg', '--windowed']
  : ['--renderer-arg', '--headless'];
const agent = spawn(
  agentBin,
  [
    'run',
    '--data-dir', dataDir,
    '--api-url', `http://127.0.0.1:${port}`,
    '--trust-dir', trustDir,
    '--renderer-program', rendererBin,
    ...rendererArgs,
    '--virtual-output', 'HDMI-1:1920x1080',
    '--sync-interval', '2',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PIXLOVA_LOG: 'info' } },
);
let agentLog = '';
agent.stderr.on('data', (chunk) => {
  agentLog += chunk;
  if (process.env.PIXLOVA_E2E_VERBOSE) process.stderr.write(chunk);
});
/** Capture de l’écran X (PIXLOVA_E2E_SCREENSHOTS=<dossier>, avec --webview). */
function screenshot(name) {
  const dir = process.env.PIXLOVA_E2E_SCREENSHOTS;
  if (!dir || !webview || !process.env.DISPLAY) return;
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', '1280x720', '-i', process.env.DISPLAY, '-frames:v', '1', join(dir, `${name}.png`)]);
    log(`capture ${name}.png`);
  } catch (error) {
    log(`capture impossible : ${error.message}`);
  }
}
const diagnose = () =>
  JSON.parse(
    execFileSync(agentBin, ['diagnose', '--data-dir', dataDir, '--api-url', `http://127.0.0.1:${port}`], {
      encoding: 'utf8',
    }),
  );

const API = () => `http://127.0.0.1:${port}/api/v1`;
let cookie = null;
let org = null;
async function call(method, path, body, headers = {}) {
  const response = await fetch(API() + path, {
    method,
    headers: {
      origin: 'http://localhost:5173',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(org ? { 'x-organization-id': org } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const set = response.headers.getSetCookie();
  if (set.length) cookie = set[0].split(';')[0];
  const json = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(json)}`);
  return json;
}
const key = () => ({ 'idempotency-key': randomUUID() });

let exitCode = 0;
try {
  const code = await until('code d’appairage affiché par l’agent', async () =>
    agentLog.match(/code=([2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4})/)?.[1],
  );
  log(`code d’appairage ${code}`);
  await sleep(1500);
  screenshot('1-appairage');

  const email = 'e2e-native@example.test';
  const password = 'correct horse battery staple';
  await call('POST', '/auth/register', { email, password, display_name: 'E2E' });
  await test.flushEmails();
  const token = new URL(test.mailer.linkFor(email, '/verify-email')).searchParams.get('token');
  await call('POST', '/auth/verify-email', { token });
  await call('POST', '/auth/login', { email, password });
  org = (await call('POST', '/organizations', { name: 'E2E natif', country: 'FR', timezone: 'Europe/Paris' })).id;
  const site = (await call('GET', '/sites')).items[0].id;
  await call('POST', '/players/pair', { code, name: 'Player natif', site_id: site }, key());
  const player = await until('sortie déclarée par l’agent', async () => {
    const found = (await call('GET', '/players')).items[0];
    return found?.outputs?.some((o) => o.output_key === 'HDMI-1') ? found : null;
  });
  log(`Player appairé, sortie ${player.outputs[0].output_key}`);

  const display = await call('POST', '/displays', { site_id: site, name: 'Vitrine', width: 1920, height: 1080 }, key());
  const output = player.outputs.find((o) => o.output_key === 'HDMI-1');
  await call('PUT', `/displays/${display.id}/assignment`, { player_output_id: output.id }, key());

  // Image réelle : envoi signé, finalisation, préparation par le worker.
  const png = await sharp({ create: { width: 800, height: 450, channels: 3, background: '#2266aa' } }).png().toBuffer();
  const session = await call('POST', '/media/upload-session', { filename: 'vitrine.png', mime_type: 'image/png', size_bytes: png.length }, key());
  const put = await fetch(`http://127.0.0.1:${port}${session.upload.url}`, { method: 'PUT', headers: session.upload.headers, body: png });
  if (!put.ok) throw new Error(`envoi du fichier : ${put.status}`);
  await call('POST', `/media/upload-session/${session.upload_id}/complete`);
  await until('image préparée par le worker', async () => (await call('GET', `/media/${session.media.id}`)).status === 'ready');

  const schedule = await call('POST', '/schedules', { name: 'Toute la semaine' }, key());
  await call('PUT', `/schedules/${schedule.id}/draft`, {
    revision: 1,
    document: {
      schema_version: 1,
      kind: 'schedule',
      timezone: null,
      targets: { include: [{ type: 'organization' }], exclude: [] },
      rules: [{ id: randomUUID(), content: { type: 'media', id: session.media.id }, priority: 10, weekdays: [1, 2, 3, 4, 5, 6, 7], start_time: '00:00', end_time: '24:00', start_date: null, end_date: null }],
      exceptions: [],
    },
  });
  await call('POST', `/schedules/${schedule.id}/publish`, { revision: 2 });
  log('planning publié');

  const delivery = await until('manifest appliqué et déclaré par le Player', async () => {
    const d = await call('GET', `/displays/${display.id}/delivery`);
    return d.applied?.version ? d : null;
  });
  log(`manifest v${delivery.applied.version} appliqué (désiré v${delivery.desired?.version})`);
  await sleep(1000);
  screenshot('2-diffusion');
  const report = diagnose();
  const local = report.database.displays[0];
  if (local.current.version !== delivery.applied.version) throw new Error('état local incohérent');
  if (report.database.blobs.count < 1) throw new Error('aucun blob vérifié dans le cache');
  const seen = await until('Player en ligne par son heartbeat', async () => {
    const found = (await call('GET', '/players')).items.find((p) => p.id === player.id);
    return found?.presence === 'online' && found.last_seen_at ? found : null;
  });
  log(`Player en ligne (${seen.app_version}, ${seen.os?.family ?? seen.os ?? 'os ?'})`);
  if (!report.health_marker?.version) throw new Error('marqueur de santé absent');
  log(`état local : ${JSON.stringify({ current: local.current, renderer: report.runtime.renderer.state })}`);

  // Cloud coupé : la diffusion continue sur l’état local.
  await app.close();
  log('API arrêtée');
  await until('agent hors ligne', async () => diagnose().runtime.online === false, 60);
  const offline = diagnose();
  if (offline.database.displays[0].current.version !== delivery.applied.version) {
    throw new Error('le manifest courant a changé hors ligne');
  }
  if (offline.runtime.renderer.connected !== true) throw new Error('renderer déconnecté hors ligne');
  log('hors ligne : manifest courant conservé, renderer toujours connecté');

  // Retour du cloud sur le même port.
  app = buildPublicApp({ services: test.services });
  await app.listen({ host: '127.0.0.1', port });
  await until('reconnexion au cloud', async () => diagnose().runtime.online === true, 60);
  log('reconnecté');
  log('PARCOURS RÉUSSI');
} catch (error) {
  exitCode = 1;
  console.error(`[e2e] ÉCHEC : ${error.message}`);
  console.error(agentLog.split('\n').slice(-40).join('\n'));
} finally {
  agent.kill('SIGTERM');
  await new Promise((r) => agent.once('exit', r));
  await worker.stop();
  await app.close().catch(() => undefined);
  await database.close();
  await rm(work, { recursive: true, force: true });
}
process.exit(exitCode);
