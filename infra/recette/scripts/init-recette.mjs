#!/usr/bin/env node
/**
 * Initialise une instance de recette (ADR-015) : génère `infra/recette/.env` (secrets,
 * mode 600, jamais versionné) puis les clés PUBLIQUES de confiance dans `trust/`.
 *
 *   node infra/recette/scripts/init-recette.mjs --url https://recette.example.com
 *   node infra/recette/scripts/init-recette.mjs --trust-only   # régénère trust/ depuis .env
 *   … --url http://localhost:8080 --no-tunnel                   # essai local, sans Cloudflare
 *
 * Un `.env` existant n’est jamais écrasé : changer une clé de données ou un mot de passe
 * de base rendrait les données existantes illisibles ou inaccessibles.
 */
import { createPrivateKey, createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const trustDir = join(root, 'trust');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
/** Clé publique Ed25519 (base64url brute) d’une graine de 32 octets. */
function publicKey(seed) {
  const raw = Buffer.from(seed, 'base64url');
  if (raw.length !== 32) throw new Error('Graine Ed25519 invalide (32 octets attendus).');
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw]);
  const key = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }));
  return key.export({ format: 'jwk' }).x;
}

function parseEnv(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  return env;
}

if (!args.includes('--trust-only')) {
  if (existsSync(envPath)) {
    console.error(`${envPath} existe déjà : rien n’est écrasé (utiliser --trust-only).`);
    process.exit(1);
  }
  const url = option('--url');
  if (!url || !/^https?:\/\/[^/]+$/.test(url)) {
    console.error('Usage : init-recette.mjs --url https://recette.example.com (origine, sans chemin)');
    process.exit(2);
  }
  const suffix = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const lines = [
    '# Instance de RECETTE pixlova — généré par init-recette.mjs. SECRET : ne jamais versionner,',
    '# ne jamais partager. Sauvegarder ce fichier avec les données (sans lui, rien n’est lisible).',
    '',
    '# Origine publique (celle du tunnel Cloudflare), sans chemin.',
    `PIXLOVA_PUBLIC_URL=${url}`,
    `PIXLOVA_COOKIE_SECURE=${url.startsWith('https://') ? 'true' : 'false'}`,
    '# Tunnel Cloudflare : jeton du connecteur (Zero Trust > Networks > Tunnels).',
    `COMPOSE_PROFILES=${args.includes('--no-tunnel') ? '' : 'tunnel'}`,
    'CLOUDFLARE_TUNNEL_TOKEN=',
    '# Passerelle publiée sur la machine hôte (tests locaux ; 0.0.0.0 l’ouvre au réseau local).',
    'PIXLOVA_GATEWAY_BIND=127.0.0.1',
    'PIXLOVA_GATEWAY_PORT=8080',
    '',
    '# Base de données',
    `POSTGRES_PASSWORD=${secret()}`,
    `PIXLOVA_DB_OWNER_PASSWORD=${secret()}`,
    `PIXLOVA_DB_APP_PASSWORD=${secret()}`,
    `PIXLOVA_DB_SYSTEM_PASSWORD=${secret()}`,
    `REDIS_PASSWORD=${secret()}`,
    '',
    '# Chiffrement des données sensibles (kid:clé base64, 32 octets).',
    `PIXLOVA_DATA_KEYS=r${suffix}:${randomBytes(32).toString('base64')}`,
    '# Signature des manifests et des commandes (graines Ed25519, clés publiques dans trust/).',
    `PIXLOVA_MANIFEST_KEY_ID=manifest-r${suffix}`,
    `PIXLOVA_MANIFEST_SIGNING_KEY=${secret()}`,
    `PIXLOVA_COMMAND_KEY_ID=command-r${suffix}`,
    `PIXLOVA_COMMAND_SIGNING_KEY=${secret()}`,
    '',
    '# Stockage objet privé (passerelle S3 versitygw)',
    'PIXLOVA_S3_BUCKET=pixlova-media',
    `PIXLOVA_S3_ACCESS_KEY_ID=pixlova${randomBytes(6).toString('hex')}`,
    `PIXLOVA_S3_SECRET_ACCESS_KEY=${secret()}`,
    '',
    '# Boîte email de test (Mailpit) : interface protégée, publiée sur la machine hôte.',
    'MAILPIT_UI_USER=recette',
    `MAILPIT_UI_PASSWORD=${secret(18)}`,
    'MAILPIT_BIND=127.0.0.1',
    'MAILPIT_PORT=8025',
    '',
    '# Droits de recette avant la facturation (L08) [à valider] : quotas fixes.',
    'PIXLOVA_DEV_MAX_USERS=10',
    'PIXLOVA_DEV_DISPLAY_SLOTS=10',
    'PIXLOVA_DEV_STORAGE_BYTES=20000000000',
    'PIXLOVA_DEV_FEATURES=templates',
    '# Taille maximale d’un envoi : le plan gratuit Cloudflare refuse les corps > 100 Mo.',
    'PIXLOVA_MEDIA_VIDEO_MAX_BYTES=95000000',
    'PIXLOVA_MEDIA_IMAGE_MAX_BYTES=50000000',
    '',
  ];
  writeFileSync(envPath, lines.join('\n'), { mode: 0o600, flag: 'wx' });
  console.log(`Écrit : ${envPath} (mode 600)`);
}

const env = parseEnv(readFileSync(envPath, 'utf8'));
mkdirSync(trustDir, { recursive: true });
const keys = (kid, seed) =>
  `${JSON.stringify({ keys: [{ kid, public_key: publicKey(seed) }] }, null, 2)}\n`;
writeFileSync(
  join(trustDir, 'manifest-keys.json'),
  keys(env.PIXLOVA_MANIFEST_KEY_ID, env.PIXLOVA_MANIFEST_SIGNING_KEY),
);
writeFileSync(
  join(trustDir, 'command-keys.json'),
  keys(env.PIXLOVA_COMMAND_KEY_ID, env.PIXLOVA_COMMAND_SIGNING_KEY),
);
console.log(`Écrit : ${trustDir}/manifest-keys.json et command-keys.json (clés publiques)`);
