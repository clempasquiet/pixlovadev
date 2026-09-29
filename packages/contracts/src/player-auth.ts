import { ed25519 } from '@noble/curves/ed25519.js';
import { decodeBase64url, encodeBase64url } from './base64url.js';
import { canonicalBytes } from './canonical.js';
import {
  PLAYER_AUTH_AUDIENCE,
  PLAYER_AUTH_TYPE,
  type PlayerAuthChallenge,
} from './schemas/index.js';

/**
 * Preuve de possession de la clé Player (PROTO-002) : signature Ed25519 du JCS du
 * challenge. `type` et `audience` séparent ce domaine des manifests et commandes.
 */
export function playerChallengeSigningInput(challenge: PlayerAuthChallenge): Uint8Array {
  if (challenge.type !== PLAYER_AUTH_TYPE || challenge.audience !== PLAYER_AUTH_AUDIENCE) {
    throw new Error('Challenge Player de type ou d’audience inattendus.');
  }
  return canonicalBytes(challenge);
}

export function signPlayerChallenge(challenge: PlayerAuthChallenge, secretKey: Uint8Array): string {
  return encodeBase64url(ed25519.sign(playerChallengeSigningInput(challenge), secretKey));
}

/** Vérification stricte (RFC 8032, sans ZIP-215), alignée sur la crate Rust. */
export function verifyPlayerChallenge(
  challenge: PlayerAuthChallenge,
  signature: string,
  publicKey: string,
): boolean {
  const signatureBytes = decodeBase64url(signature);
  const keyBytes = decodeBase64url(publicKey);
  if (!signatureBytes || signatureBytes.length !== 64 || !keyBytes || keyBytes.length !== 32)
    return false;
  try {
    return ed25519.verify(signatureBytes, playerChallengeSigningInput(challenge), keyBytes, {
      zip215: false,
    });
  } catch {
    return false;
  }
}

/** Normalise une saisie de code (`k7m4 q9xp` → `K7M4-Q9XP`) ; `null` si invalide. */
export function normalizePairingCode(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[2-9A-HJKMNP-Z]{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}
