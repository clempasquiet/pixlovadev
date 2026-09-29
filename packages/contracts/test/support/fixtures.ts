import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBase64url, type TrustStore } from '../../src/index.js';

export const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../fixtures');

export function readFixture(path: string): string {
  return readFileSync(resolve(fixturesDir, path), 'utf8');
}
export function readJson<T>(path: string): T {
  return JSON.parse(readFixture(path)) as T;
}

interface KeysFile {
  keys: { kid: string; public_key_b64u: string }[];
  trust: { manifest: string[]; command: string[] };
}

export function trustStore(purpose: 'manifest' | 'command'): TrustStore {
  const file = readJson<KeysFile>('keys.json');
  return new Map(
    file.trust[purpose].map((kid) => {
      const key = file.keys.find((k) => k.kid === kid)!;
      return [kid, decodeBase64url(key.public_key_b64u)!];
    }),
  );
}
