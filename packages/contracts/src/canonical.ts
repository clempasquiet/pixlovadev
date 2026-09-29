import canonicalize from 'canonicalize';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { JsonValue } from './strict-json.js';

/** Sérialisation canonique JCS (RFC 8785). */
export function canonicalJson(value: JsonValue | object): string {
  const text = canonicalize(value);
  if (text === undefined) throw new Error('Valeur non sérialisable en JSON canonique.');
  return text;
}

export function canonicalBytes(value: JsonValue | object): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

/** Empreinte SHA-256 hexadécimale de la forme canonique (ex. `payload_hash` d’un manifest). */
export function canonicalSha256(value: JsonValue | object): string {
  return bytesToHex(sha256(canonicalBytes(value)));
}
