#!/usr/bin/env node
/**
 * Signe les métadonnées d’une release du Player natif (`SIGNAGE_RELEASE_V1`, NAT-013).
 * À exécuter uniquement dans l’environnement de release contrôlé (ARC-018) :
 *
 *   PIXLOVA_RELEASE_KEY_ID=release-2026-a PIXLOVA_RELEASE_SIGNING_KEY=<graine base64url> \
 *     node scripts/release/sign-release.mjs --package pixlova-0.2.0.tar --version 0.2.0 \
 *       [--os linux] [--arch x86_64] [--sqlite-schema 1] [--sqlite-reader-level 1] > release.json
 *
 * La graine n’est jamais écrite sur disque ni affichée. Les métadonnées produites sont
 * validées par le schéma publié avant signature.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
const contracts = new URL('../../packages/contracts/dist/index.js', import.meta.url);
const { RELEASE_ENVELOPE_TYPE, decodeBase64url, signEnvelope, validator } = await import(contracts.href);

const { values } = parseArgs({
  options: {
    package: { type: 'string' },
    version: { type: 'string' },
    os: { type: 'string', default: 'linux' },
    arch: { type: 'string', default: 'x86_64' },
    'sqlite-schema': { type: 'string', default: '1' },
    'sqlite-reader-level': { type: 'string', default: '1' },
    'renderer-build': { type: 'string' },
  },
});
const kid = process.env.PIXLOVA_RELEASE_KEY_ID;
const seed = process.env.PIXLOVA_RELEASE_SIGNING_KEY;
if (!values.package || !values.version || !kid || !seed) {
  console.error('--package, --version, PIXLOVA_RELEASE_KEY_ID et PIXLOVA_RELEASE_SIGNING_KEY sont requis');
  process.exit(2);
}
const bytes = readFileSync(values.package);
const payload = {
  schema_version: 1,
  release_id: randomUUID(),
  version: values.version,
  os: values.os,
  arch: values.arch,
  package: { sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length },
  protocol_min: 1,
  protocol_max: 1,
  sqlite_schema: Number(values['sqlite-schema']),
  sqlite_reader_level: Number(values['sqlite-reader-level']),
  renderer_build: values['renderer-build'] ?? values.version,
  published_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
};
const validate = validator('release-payload.json');
if (!validate(payload)) {
  console.error('métadonnées invalides', validate.errors);
  process.exit(1);
}
const secret = decodeBase64url(seed);
if (!secret || secret.length !== 32) {
  console.error('graine Ed25519 de 32 octets attendue');
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(signEnvelope(RELEASE_ENVELOPE_TYPE, kid, payload, secret))}\n`);
