import { describe, expect, it } from 'vitest';
import {
  normalizePairingCode,
  validator,
  verifyPlayerChallenge,
  type PlayerAuthChallenge,
} from '../src/index.js';
import { readJson } from './support/fixtures.js';

interface Vectors {
  public_key_b64u: string;
  vectors: { name: string; challenge: PlayerAuthChallenge; signature: string; valid: boolean }[];
}

describe('preuve de possession de la clé Player (PROTO-002)', () => {
  const file = readJson<Vectors>('player-auth-vectors.json');
  for (const vector of file.vectors) {
    it(vector.name, () => {
      expect(validator('player-auth-challenge.json')(vector.challenge)).toBe(true);
      expect(verifyPlayerChallenge(vector.challenge, vector.signature, file.public_key_b64u)).toBe(
        vector.valid,
      );
    });
  }

  it('refuse un challenge d’un autre domaine (manifest, commande)', () => {
    const challenge = {
      ...file.vectors[0]!.challenge,
      type: 'SIGNAGE_MANIFEST_V1',
    } as unknown as PlayerAuthChallenge;
    expect(verifyPlayerChallenge(challenge, file.vectors[0]!.signature, file.public_key_b64u)).toBe(
      false,
    );
  });
});

describe('code d’appairage', () => {
  it.each([
    ['k7m4 q9xp', 'K7M4-Q9XP'],
    ['K7M4-Q9XP', 'K7M4-Q9XP'],
    ['k7m4q9xp', 'K7M4-Q9XP'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePairingCode(input)).toBe(expected);
  });

  it.each(['K7M4-Q9X', 'K7M4-Q9XO', 'I1L0-AAAA', ''])('refuse %j', (input) => {
    expect(normalizePairingCode(input)).toBeNull();
  });
});
