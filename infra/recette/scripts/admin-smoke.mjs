#!/usr/bin/env node
/**
 * Recette réseau et fonctionnelle de l’administration plateforme (ADM-006, ADR-016), sur
 * le serveur qui exécute Docker Compose :
 *   - l’administration n’est servie ni par l’URL publique ni depuis la passerelle ;
 *   - elle répond sur la boucle locale (port publié 127.0.0.1:8081) ;
 *   - un opérateur jetable est créé par l’outil serveur, activé (mot de passe + TOTP),
 *     puis désactivé : un compte sans rôle ne voit rien, un compte révoqué est refusé,
 *     et chaque étape figure au journal.
 *
 *   node infra/recette/scripts/admin-smoke.mjs
 */
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match) env[match[1]] = match[2];
}
const setting = (name, fallback) => process.env[name] ?? env[name] ?? fallback;
const publicUrl = setting('PIXLOVA_SMOKE_URL', setting('PIXLOVA_PUBLIC_URL')).replace(/\/$/, '');
const admin = `http://127.0.0.1:${setting('PIXLOVA_ADMIN_PORT', '8081')}`;
const compose = (...command) =>
  execFileSync('docker', ['compose', '-f', join(root, 'compose.yaml'), ...command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

let step = 0;
const ok = (message) => console.log(`  ✔ ${String(++step).padStart(2)} ${message}`);
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** TOTP RFC 6238 (SHA-1, 6 chiffres, 30 s), pour jouer le rôle de l’application de l’opérateur. */
function totp(secret, offset = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '')) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + offset));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const at = hmac[hmac.length - 1] & 0xf;
  return String((hmac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

let cookie = '';
async function call(method, path, body) {
  const response = await fetch(`${admin}/admin-api/v1${path}`, {
    method,
    headers: {
      origin: admin,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const set = response.headers.getSetCookie();
  if (set.length) cookie = set[0].split(';')[0];
  return { status: response.status, json: await response.json().catch(() => null) };
}

console.log(`Recette de l’administration (${admin})`);
try {
  // --- Réseau --------------------------------------------------------------------------
  for (const path of ['/admin-api/v1/auth/me', '/admin-ready']) {
    const response = await fetch(`${publicUrl}${path}`);
    const body = await response.text();
    expect(!body.includes('"permissions"') && !body.includes('"ready"'), `${path} servi par l’URL publique`);
  }
  ok('aucune route d’administration par l’URL publique');
  let reachable = true;
  try {
    compose('exec', '-T', 'gateway', 'wget', '-q', '-T', '3', '-O', '/dev/null', 'http://admin:8081/admin-ready');
  } catch {
    reachable = false;
  }
  expect(!reachable, 'administration joignable depuis la passerelle');
  ok('administration injoignable depuis la passerelle publique');
  const ready = await fetch(`${admin}/admin-ready`);
  expect(ready.ok, `admin-ready : ${ready.status}`);
  const page = await fetch(`${admin}/login`);
  expect((await page.text()).includes('<div id="root">'), 'console non servie');
  expect(page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), 'CSP absente');
  ok('console et API servies sur la boucle locale du serveur');

  // --- Opérateur jetable -----------------------------------------------------------------
  const email = `recette-admin-${Date.now()}@pixlova.invalid`;
  const password = `recette ${randomBytes(12).toString('base64url')}`;
  const output = compose(
    'exec', '-T', 'admin', 'node', 'apps/api/dist/admin-cli.js', 'create-operator',
    '--email', email, '--name', 'Recette automatisée', '--role', 'operations',
  );
  const code = output.trim().split('\n').at(-1).trim();
  expect(/^[A-Za-z0-9_-]{40,}$/.test(code), 'code d’activation non émis');
  ok('opérateur créé par l’outil serveur (code d’activation affiché une fois)');

  expect((await call('POST', '/auth/login', { email, password })).status === 401, 'connexion avant activation');
  const activated = await call('POST', '/auth/activate', { email, activation_code: code, password });
  expect(activated.status === 200, `activation : ${JSON.stringify(activated.json)}`);
  const me = await call('GET', '/auth/me');
  expect(me.json.permissions.length === 0, 'droits avant confirmation du TOTP');
  expect((await call('GET', '/health')).status === 401, 'santé lisible sans second facteur');
  expect((await call('POST', '/auth/activate/confirm', { code: totp(activated.json.secret) })).status === 200, 'confirmation TOTP');
  const health = await call('GET', '/health');
  expect(health.status === 200 && typeof health.json.organizations === 'number', 'santé illisible');
  expect((await call('GET', '/team')).status === 403, 'Operator gère l’équipe');
  ok('activation, TOTP obligatoire, droits limités au rôle (santé oui, équipe non)');

  cookie = '';
  expect((await call('POST', '/auth/login', { email, password })).status === 200, 'connexion');
  expect((await call('GET', '/organizations')).status === 401, 'accès sans second facteur');
  expect((await call('POST', '/auth/mfa/verify', { code: totp(activated.json.secret, 1) })).status === 200, 'second facteur');
  expect((await call('GET', '/organizations')).status === 200, 'organisations');
  ok('reconnexion : mot de passe puis TOTP exigés');

  // Révocation : l’opérateur jetable est remis à zéro puis ne peut plus rien.
  compose('exec', '-T', 'admin', 'node', 'apps/api/dist/admin-cli.js', 'reset-operator', '--email', email);
  expect((await call('GET', '/organizations')).status === 401, 'session conservée après révocation');
  expect((await call('POST', '/auth/login', { email, password })).status === 401, 'connexion après révocation');
  ok('après révocation : session fermée, connexion refusée');
  console.log(`Recette de l’administration réussie (${step} étapes). Opérateur jetable : ${email}`);
} catch (error) {
  console.error(`  ✘ ${error.message}`);
  process.exit(1);
}
