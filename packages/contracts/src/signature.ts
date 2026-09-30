import { ed25519 } from '@noble/curves/ed25519.js';
import { decodeBase64url, encodeBase64url } from './base64url.js';
import { canonicalBytes, canonicalSha256 } from './canonical.js';
import { parseStrictJson, StrictJsonError, type JsonValue } from './strict-json.js';

/** Clés publiques de confiance, par identifiant de clé (`kid`). */
export type TrustStore = ReadonlyMap<string, Uint8Array>;

export const DEFAULT_MAX_ENVELOPE_BYTES = 8 * 1024 * 1024;

export type EnvelopeErrorCode =
  'MALFORMED_JSON' | 'ENVELOPE_INVALID' | 'UNKNOWN_KEY' | 'SIGNATURE_INVALID';

export interface VerifiedEnvelope {
  protected: { type: string; alg: 'Ed25519'; kid: string };
  payload: { [key: string]: JsonValue };
  /** SHA-256 de la forme canonique du payload seul. */
  payloadHash: string;
}

export type EnvelopeResult =
  { ok: true; envelope: VerifiedEnvelope } | { ok: false; code: EnvelopeErrorCode; detail: string };

const KID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const ENVELOPE_KEYS = ['payload', 'protected', 'signature'];
const HEADER_KEYS = ['alg', 'kid', 'type'];

function isObject(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sameKeys(object: { [key: string]: JsonValue }, expected: string[]): boolean {
  const keys = Object.keys(object).sort();
  return keys.length === expected.length && keys.every((key, i) => key === expected[i]);
}

/** Octets signés : JCS de `{protected, payload}`, signature exclue (PROTO-011). */
export function signingInput(protectedHeader: object, payload: object): Uint8Array {
  return canonicalBytes({ protected: protectedHeader, payload });
}

export function signEnvelope<P extends object>(
  type: string,
  kid: string,
  payload: P,
  secretKey: Uint8Array,
): { protected: { type: string; alg: 'Ed25519'; kid: string }; payload: P; signature: string } {
  const header = { type, alg: 'Ed25519' as const, kid };
  const signature = ed25519.sign(signingInput(header, payload), secretKey);
  return { protected: header, payload, signature: encodeBase64url(signature) };
}

/**
 * Vérifie une enveloppe signée reçue sous forme textuelle, dans cet ordre :
 * taille → JSON strict → forme de l’enveloppe et type attendu → clé connue → signature.
 * Le schéma du payload est contrôlé ensuite par l’appelant (manifest, commande).
 */
export function verifyEnvelope(
  raw: string,
  expectedType: string,
  trust: TrustStore,
  maxBytes = DEFAULT_MAX_ENVELOPE_BYTES,
): EnvelopeResult {
  if (new TextEncoder().encode(raw).length > maxBytes) {
    return { ok: false, code: 'MALFORMED_JSON', detail: 'taille maximale dépassée' };
  }
  let document: JsonValue;
  try {
    document = parseStrictJson(raw);
  } catch (error) {
    const detail = error instanceof StrictJsonError ? error.message : 'JSON invalide';
    return { ok: false, code: 'MALFORMED_JSON', detail };
  }
  if (!isObject(document) || !sameKeys(document, ENVELOPE_KEYS)) {
    return { ok: false, code: 'ENVELOPE_INVALID', detail: 'membres de l’enveloppe invalides' };
  }
  const header = document.protected;
  const payload = document.payload;
  const signature = document.signature;
  if (!isObject(header) || !sameKeys(header, HEADER_KEYS) || !isObject(payload)) {
    return { ok: false, code: 'ENVELOPE_INVALID', detail: 'en-tête ou payload invalide' };
  }
  if (header.type !== expectedType) {
    return { ok: false, code: 'ENVELOPE_INVALID', detail: 'type d’enveloppe inattendu' };
  }
  if (header.alg !== 'Ed25519') {
    return { ok: false, code: 'ENVELOPE_INVALID', detail: 'algorithme non accepté' };
  }
  if (typeof header.kid !== 'string' || !KID.test(header.kid)) {
    return { ok: false, code: 'ENVELOPE_INVALID', detail: 'kid invalide' };
  }
  const signatureBytes = typeof signature === 'string' ? decodeBase64url(signature) : null;
  if (!signatureBytes || signatureBytes.length !== 64) {
    return { ok: false, code: 'ENVELOPE_INVALID', detail: 'signature mal encodée' };
  }
  const publicKey = trust.get(header.kid);
  if (!publicKey) return { ok: false, code: 'UNKNOWN_KEY', detail: `clé inconnue ${header.kid}` };

  let valid: boolean;
  try {
    // zip215: false → vérification stricte RFC 8032, alignée sur `verify_strict` d’ed25519-dalek.
    valid = ed25519.verify(signatureBytes, signingInput(header, payload), publicKey, {
      zip215: false,
    });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, code: 'SIGNATURE_INVALID', detail: 'signature invalide' };
  return {
    ok: true,
    envelope: {
      protected: { type: header.type, alg: 'Ed25519', kid: header.kid },
      payload,
      payloadHash: canonicalSha256(payload),
    },
  };
}

export function publicKeyFromSecret(secretKey: Uint8Array): Uint8Array {
  return ed25519.getPublicKey(secretKey);
}
