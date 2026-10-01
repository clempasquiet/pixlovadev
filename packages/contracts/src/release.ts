import {
  MAX_RELEASE_ENVELOPE_BYTES,
  RELEASE_ENVELOPE_TYPE,
  type ReleasePayload,
} from './schemas/index.js';
import { verifyEnvelope, type EnvelopeErrorCode, type TrustStore } from './signature.js';
import { describeErrors, validator } from './validate.js';

export type ReleaseVerification =
  | { ok: true; release: ReleasePayload; kid: string; payloadHash: string }
  | { ok: false; code: EnvelopeErrorCode | 'SCHEMA_INVALID'; detail: string };

/**
 * Vérifie des métadonnées de release (`SIGNAGE_RELEASE_V1`, NAT-013) avec les seules clés
 * de release, comme le fait l’agent natif (`pixlova_contracts::release`).
 */
export function verifyRelease(raw: string, trust: TrustStore): ReleaseVerification {
  const envelope = verifyEnvelope(raw, RELEASE_ENVELOPE_TYPE, trust, MAX_RELEASE_ENVELOPE_BYTES);
  if (!envelope.ok) return envelope;
  const validate = validator('release-payload.json');
  if (!validate(envelope.envelope.payload)) {
    return { ok: false, code: 'SCHEMA_INVALID', detail: describeErrors(validate.errors) };
  }
  const release = envelope.envelope.payload as unknown as ReleasePayload;
  if (release.protocol_min > release.protocol_max) {
    return { ok: false, code: 'SCHEMA_INVALID', detail: 'plage de protocole vide' };
  }
  return {
    ok: true,
    release,
    kid: envelope.envelope.protected.kid,
    payloadHash: envelope.envelope.payloadHash,
  };
}

/** Version SemVer `a.b.c` → triplet comparable ; `null` si la forme est autre. */
export function parseReleaseVersion(version: string): [number, number, number] | null {
  const match = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Comparaison de deux versions SemVer `a.b.c` valides (négatif si `a < b`). */
export function compareReleaseVersions(a: string, b: string): number {
  const left = parseReleaseVersion(a);
  const right = parseReleaseVersion(b);
  if (!left || !right) throw new Error('Version de release invalide.');
  for (let i = 0; i < 3; i += 1) {
    const diff = left[i]! - right[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}
