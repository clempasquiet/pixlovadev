import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  evaluateCommand,
  evaluateManifestCandidate,
  parseInstantMicros,
  parseStrictJson,
  verifyCommand,
  verifyManifest,
  type PlayerCapabilities,
} from '../src/index.js';
import { readFixture, readJson, trustStore } from './support/fixtures.js';

interface Vector {
  name: string;
  file: string;
  now: string;
  local?: {
    organization_id: string;
    player_id: string;
    displays: Record<
      string,
      {
        assignment_generation: string;
        highest_version: string | null;
        highest_version_hash: string | null;
      }
    >;
  };
  context?: {
    organization_id: string;
    player_id: string;
    assignments: Record<string, string>;
    seen: Record<string, string>;
    capabilities: Pick<PlayerCapabilities, 'reboot_host' | 'screenshot'>;
  };
  expect: { verification: string; reason?: string; decision?: string; code?: string };
}

describe('vecteurs de manifests (PROTO-011/013/021)', () => {
  const trust = trustStore('manifest');
  for (const vector of readJson<Vector[]>('manifest-vectors.json')) {
    it(vector.name, () => {
      const result = verifyManifest(readFixture(vector.file), trust);
      if (!result.ok) {
        expect({ verification: result.code, reason: result.reason }).toEqual({
          verification: vector.expect.verification,
          reason: vector.expect.reason,
        });
        return;
      }
      expect(vector.expect.verification).toBe('ok');
      const local = vector.local!;
      const decision = evaluateManifestCandidate(
        result.manifest,
        result.manifestHash,
        { ...local, displays: new Map(Object.entries(local.displays)) },
        vector.now,
      );
      expect(decision.decision).toBe(vector.expect.decision);
      if (decision.decision === 'reject') expect(decision.code).toBe(vector.expect.code);
    });
  }
});

describe('vecteurs de commandes (PROTO-007/008, SEC-010)', () => {
  const trust = trustStore('command');
  for (const vector of readJson<Vector[]>('command-vectors.json')) {
    it(vector.name, () => {
      const result = verifyCommand(readFixture(vector.file), trust);
      if (!result.ok) {
        expect({ verification: result.code, reason: result.reason }).toEqual({
          verification: vector.expect.verification,
          reason: vector.expect.reason,
        });
        return;
      }
      expect(vector.expect.verification).toBe('ok');
      const context = vector.context!;
      const decision = evaluateCommand(
        result.command,
        result.commandHash,
        {
          ...context,
          assignments: new Map(Object.entries(context.assignments)),
          seen: new Map(Object.entries(context.seen)),
        },
        vector.now,
      );
      expect(decision.decision).toBe(vector.expect.decision);
      if (decision.decision === 'reject') expect(decision.code).toBe(vector.expect.code);
    });
  }
});

describe('JSON strict', () => {
  for (const vector of readJson<{ name: string; input: string; valid: boolean }[]>(
    'strict-json-vectors.json',
  )) {
    it(vector.name, () => {
      const parse = () => parseStrictJson(vector.input);
      if (vector.valid) expect(parse).not.toThrow();
      else expect(parse).toThrow();
    });
  }

  it('conserve « __proto__ » comme donnée sans modifier le prototype', () => {
    const value = parseStrictJson('{"__proto__":{"x":1}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(['__proto__']);
  });
});

describe('JCS (RFC 8785)', () => {
  for (const vector of readJson<{ name: string; input: string; canonical: string }[]>(
    'jcs-vectors.json',
  )) {
    it(vector.name, () => {
      expect(canonicalJson(parseStrictJson(vector.input) as object)).toBe(vector.canonical);
    });
  }

  it('produit les formes numériques attendues par la RFC', () => {
    const canonical = readJson<{ name: string; canonical: string }[]>('jcs-vectors.json').find(
      (v) => v.name === 'numbers',
    )!.canonical;
    expect(canonical).toBe('[0,0,1,100,0.1,1e-7,123456789.125,-0.0055,9007199254740991]');
  });
});

describe('instants UTC', () => {
  for (const vector of readJson<{ input: string; micros: number | null }[]>(
    'instant-vectors.json',
  )) {
    it(vector.input, () => {
      expect(parseInstantMicros(vector.input)).toBe(vector.micros);
    });
  }
});
