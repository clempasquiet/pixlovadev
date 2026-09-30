/**
 * Construction déterministe des artefacts publiés par le package :
 * - `schemas/*.json` : schémas JSON (draft 2020-12) consommés par Rust et les outils ;
 * - `fixtures/**` : vecteurs de test communs TypeScript/Rust (PROTO-021).
 *
 * Les clés de `fixtures/keys.json` sont dérivées d’une graine publique : elles ne
 * servent qu’aux tests et ne doivent jamais figurer dans un trust store réel.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  COMMAND_ENVELOPE_TYPE,
  MANIFEST_ENVELOPE_TYPE,
  ROOT_SCHEMAS,
  canonicalSha256,
  decodeBase64url,
  encodeBase64url,
  publicKeyFromSecret,
  signEnvelope,
  type CommandPayload,
  type ManifestPayload,
} from '../../src/index.js';

const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

function seed(label: string): Uint8Array {
  return sha256(new TextEncoder().encode(`pixlova-contracts-test-only:${label}`));
}
export const TEST_KEYS = {
  'test-manifest-a': seed('manifest-a'),
  'test-manifest-b': seed('manifest-b'),
  'test-untrusted-c': seed('untrusted-c'),
  'test-command-a': seed('command-a'),
} as const;
type Kid = keyof typeof TEST_KEYS;
const TRUSTED_MANIFEST: Kid[] = ['test-manifest-a', 'test-manifest-b'];
const TRUSTED_COMMAND: Kid[] = ['test-command-a'];

const ORG = '55555555-5555-4555-8555-555555555555';
const OTHER_ORG = '55555555-5555-4555-8555-000000000002';
const PLAYER = '66666666-6666-4666-8666-666666666666';
const DISPLAY = '33333333-3333-4333-8333-333333333333';
const IMAGE_ASSET = '77777777-7777-4777-8777-777777777777';
const VIDEO_ASSET = '77777777-7777-4777-8777-000000000002';

export function baseManifest(): ManifestPayload {
  return {
    schema_version: 1,
    manifest_id: '44444444-4444-4444-8444-444444444444',
    organization_id: ORG,
    display_id: DISPLAY,
    player_id: PLAYER,
    version: '182',
    assignment_generation: '2',
    config_revision: '57',
    generated_at: '2026-09-29T18:00:00Z',
    valid_from: '2026-09-29T18:00:00Z',
    activate_before: '2026-10-06T18:00:00Z',
    schedule_until: '2026-10-06T18:00:00Z',
    display: { width: 2688, height: 672, orientation: 0, fit: 'contain', timezone: 'Europe/Paris' },
    required_capabilities: {
      render_schema: 1,
      image_types: ['image/png'],
      video_profiles: ['mp4-h264-aac'],
    },
    assets: [
      {
        id: IMAGE_ASSET,
        variant: 'display-image',
        mime_type: 'image/png',
        size_bytes: 125000,
        sha256: bytesToHex(sha256(new TextEncoder().encode('image-accueil'))),
      },
      {
        id: VIDEO_ASSET,
        variant: 'mp4-h264-aac-1080p',
        mime_type: 'video/mp4',
        size_bytes: 48_000_000,
        sha256: bytesToHex(sha256(new TextEncoder().encode('video-promo'))),
      },
    ],
    contents: [
      {
        id: 'image-accueil',
        type: 'media',
        media_kind: 'image',
        asset_id: IMAGE_ASSET,
        duration_ms: 15000,
        fit: 'contain',
        muted: true,
      },
      {
        id: 'video-promo',
        type: 'media',
        media_kind: 'video',
        asset_id: VIDEO_ASSET,
        duration_ms: 30000,
        fit: 'cover',
        muted: true,
      },
      {
        id: 'boucle-promo',
        type: 'playlist',
        playlist_version_id: '88888888-8888-4888-8888-000000000001',
        transition: 'fade',
        items: [
          { content_ref: 'video-promo', duration_ms: 30000 },
          { content_ref: 'image-accueil', duration_ms: 10000 },
        ],
      },
      {
        id: 'bandeau-led',
        type: 'composition',
        composition_version_id: '99999999-9999-4999-8999-000000000001',
        duration_ms: 20000,
        document: {
          schema_version: 1,
          canvas: { width: 2688, height: 672, background: '#101820' },
          elements: [
            {
              id: 'titre',
              type: 'text',
              x: 48,
              y: 40,
              width: 1600,
              height: 180,
              rotation: 0,
              z_index: 2,
              opacity: 1,
              visible: true,
              locked: false,
              props: {
                text: 'Bienvenue — Crêperie « Chez Zoé » 🥞 Ouvert 7j/7',
                font_family: 'Inter',
                font_size_px: 96,
                font_weight: 600,
                color: '#FFFFFF',
                alignment: 'left',
                line_height: 1.2,
                letter_spacing_px: -0.5,
              },
            },
            {
              id: 'horloge',
              type: 'clock',
              x: 2200,
              y: 40,
              width: 440,
              height: 120,
              rotation: 0,
              z_index: 2,
              opacity: 0.85,
              visible: true,
              locked: true,
              props: {
                format: 'time_24h',
                timezone: null,
                locale: 'fr-FR',
                font_family: 'Inter',
                font_size_px: 88,
                color: '#FFFFFFCC',
                alignment: 'right',
              },
            },
            {
              id: 'qr-menu',
              type: 'qr',
              x: 2400,
              y: 380,
              width: 240,
              height: 240,
              rotation: 0,
              z_index: 3,
              opacity: 1,
              visible: true,
              locked: false,
              props: {
                data: 'https://pixlova.com/exemple',
                foreground: '#000000',
                background: '#FFFFFF',
                error_correction: 'M',
              },
            },
            {
              id: 'zone-promo',
              type: 'playlist_zone',
              x: 48,
              y: 260,
              width: 1200,
              height: 380,
              rotation: 12.5,
              z_index: 1,
              opacity: 1,
              visible: true,
              locked: false,
              props: { content_ref: 'boucle-promo' },
            },
          ],
          settings: { duration_ms: 20000, audio_policy: 'muted' },
        },
      },
    ],
    timeline: [
      {
        starts_at: '2026-09-29T18:00:00Z',
        ends_at: '2026-09-30T06:00:00Z',
        content_ref: 'image-accueil',
        source: {
          type: 'schedule',
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
          priority: 10,
          revision: '57',
        },
      },
      {
        starts_at: '2026-09-30T06:00:00Z',
        ends_at: '2026-09-30T08:00:00Z',
        content_ref: 'bandeau-led',
        source: {
          type: 'campaign',
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
          priority: 50,
          revision: '12',
        },
      },
      {
        starts_at: '2026-09-30T08:00:00Z',
        ends_at: '2026-10-06T18:00:00Z',
        content_ref: 'boucle-promo',
        source: {
          type: 'schedule',
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
          priority: 10,
          revision: '57',
        },
      },
    ],
    fallback: { content_ref: 'image-accueil', after_schedule: 'play_fallback' },
  };
}

function baseCommand(): CommandPayload {
  return {
    command_id: 'cccccccc-cccc-4ccc-8ccc-000000000001',
    organization_id: ORG,
    player_id: PLAYER,
    display_id: DISPLAY,
    assignment_generation: '2',
    type: 'TAKE_SCREENSHOT',
    issued_at: '2026-09-29T18:00:00Z',
    expires_at: '2026-09-29T18:05:00Z',
    params: { screenshot_id: 'dddddddd-dddd-4ddd-8ddd-000000000001' },
  };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const clone = <T>(value: T): T => structuredClone(value);

function signed(type: string, kid: Kid, payload: object): string {
  return json(signEnvelope(type, kid, payload, TEST_KEYS[kid]));
}

/** Ajoute L (ordre du groupe) à S : signature malléable que la vérification stricte refuse. */
function malleate(signature: string): string {
  const bytes = decodeBase64url(signature)!;
  const L = (1n << 252n) + 27742317777372353535851937790883648493n;
  let s = 0n;
  for (let i = 63; i >= 32; i--) s = (s << 8n) | BigInt(bytes[i]!);
  s += L;
  for (let i = 32; i < 64; i++) {
    bytes[i] = Number(s & 0xffn);
    s >>= 8n;
  }
  return encodeBase64url(bytes);
}

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
    capabilities: { reboot_host: string; screenshot: string };
  };
  expect: {
    verification: string;
    reason?: string;
    decision?: string;
    code?: string;
  };
}

export function buildArtifacts(): Map<string, string> {
  const files = new Map<string, string>();

  for (const [name, schema] of Object.entries(ROOT_SCHEMAS)) {
    const { $id, ...rest } = schema as unknown as Record<string, unknown>;
    files.set(`schemas/${name}`, json({ $schema: SCHEMA_DIALECT, $id, ...rest }));
  }

  files.set(
    'fixtures/keys.json',
    json({
      warning: 'CLÉS DE TEST UNIQUEMENT — graines publiques, jamais dans un trust store réel.',
      keys: Object.entries(TEST_KEYS).map(([kid, secret]) => ({
        kid,
        seed_hex: bytesToHex(secret),
        public_key_b64u: encodeBase64url(publicKeyFromSecret(secret)),
      })),
      trust: { manifest: TRUSTED_MANIFEST, command: TRUSTED_COMMAND },
    }),
  );

  // --- Manifests -----------------------------------------------------------
  const manifestVectors: Vector[] = [];
  const base = baseManifest();
  const baseHash = canonicalSha256(base);
  const now = '2026-09-29T18:01:00Z';
  const local = (
    overrides: Partial<{ generation: string; highest: string | null; hash: string | null }> = {},
  ) => ({
    organization_id: ORG,
    player_id: PLAYER,
    displays: {
      [DISPLAY]: {
        assignment_generation: overrides.generation ?? '2',
        highest_version: overrides.highest === undefined ? '181' : overrides.highest,
        highest_version_hash: overrides.hash === undefined ? null : overrides.hash,
      },
    },
  });
  const addManifest = (
    name: string,
    raw: string,
    expect: Vector['expect'],
    extra: Partial<Vector> = {},
  ) => {
    const file = `fixtures/manifests/${name}.json`;
    files.set(file, raw);
    manifestVectors.push({
      name,
      file: file.replace('fixtures/', ''),
      now,
      local: local(),
      expect,
      ...extra,
    });
  };
  const validRaw = signed(MANIFEST_ENVELOPE_TYPE, 'test-manifest-a', base);
  const accept = { verification: 'ok', decision: 'accept' };

  addManifest('valid-led-2688x672', validRaw, accept);
  addManifest('valid-rotated-key', signed(MANIFEST_ENVELOPE_TYPE, 'test-manifest-b', base), accept);
  {
    // Même document, membres dans un autre ordre et espaces différents : même signature valide.
    const envelope = JSON.parse(validRaw) as {
      protected: object;
      payload: Record<string, unknown>;
      signature: string;
    };
    const reordered = Object.fromEntries(Object.entries(envelope.payload).reverse());
    addManifest(
      'valid-key-order',
      JSON.stringify({
        signature: envelope.signature,
        payload: reordered,
        protected: envelope.protected,
      }),
      accept,
    );
  }
  {
    const big = clone(base);
    big.version = '9223372036854775807';
    addManifest(
      'valid-max-version',
      signed(MANIFEST_ENVELOPE_TYPE, 'test-manifest-a', big),
      accept,
    );
  }
  addManifest(
    'duplicate-identical',
    validRaw,
    { verification: 'ok', decision: 'duplicate' },
    {
      local: local({ highest: '182', hash: baseHash }),
    },
  );
  addManifest(
    'same-version-other-hash',
    validRaw,
    { verification: 'ok', decision: 'reject', code: 'VERSION_CONFLICT' },
    {
      local: local({ highest: '182', hash: '0'.repeat(64) }),
    },
  );
  addManifest(
    'replayed-older-version',
    validRaw,
    { verification: 'ok', decision: 'reject', code: 'VERSION_REPLAYED' },
    {
      local: local({ highest: '183', hash: '0'.repeat(64) }),
    },
  );
  addManifest(
    'stale-assignment',
    validRaw,
    { verification: 'ok', decision: 'reject', code: 'STALE_ASSIGNMENT' },
    {
      local: local({ generation: '3' }),
    },
  );
  addManifest(
    'assignment-ahead',
    validRaw,
    { verification: 'ok', decision: 'reject', code: 'ASSIGNMENT_AHEAD' },
    {
      local: local({ generation: '1' }),
    },
  );
  addManifest(
    'activation-window-expired',
    validRaw,
    { verification: 'ok', decision: 'reject', code: 'ACTIVATION_WINDOW_EXPIRED' },
    {
      now: '2026-10-06T18:00:00Z',
    },
  );
  {
    const other = clone(base);
    other.organization_id = OTHER_ORG;
    addManifest('wrong-organization', signed(MANIFEST_ENVELOPE_TYPE, 'test-manifest-a', other), {
      verification: 'ok',
      decision: 'reject',
      code: 'WRONG_ORGANIZATION',
    });
  }
  {
    const other = clone(base);
    other.display_id = '33333333-3333-4333-8333-000000000009';
    addManifest('wrong-display', signed(MANIFEST_ENVELOPE_TYPE, 'test-manifest-a', other), {
      verification: 'ok',
      decision: 'reject',
      code: 'WRONG_DISPLAY',
    });
  }
  addManifest(
    'tampered-payload',
    validRaw.replace('"duration_ms": 15000', '"duration_ms": 15001'),
    {
      verification: 'SIGNATURE_INVALID',
    },
  );
  addManifest(
    'duplicate-key',
    validRaw.replace('"version": "182",', '"version": "182",\n    "version": "999",'),
    {
      verification: 'MALFORMED_JSON',
    },
  );
  addManifest('truncated', validRaw.slice(0, Math.floor(validRaw.length / 2)), {
    verification: 'MALFORMED_JSON',
  });
  addManifest(
    'number-out-of-range',
    validRaw.replace('"size_bytes": 125000', '"size_bytes": 9007199254740993'),
    {
      verification: 'MALFORMED_JSON',
    },
  );
  addManifest(
    'lone-surrogate',
    validRaw.replace('"text": "Bienvenue', '"text": "\\ud800Bienvenue'),
    {
      verification: 'MALFORMED_JSON',
    },
  );
  addManifest('untrusted-key', signed(MANIFEST_ENVELOPE_TYPE, 'test-untrusted-c', base), {
    verification: 'UNKNOWN_KEY',
  });
  {
    const envelope = JSON.parse(validRaw) as { signature: string };
    addManifest(
      'malleable-signature',
      validRaw.replace(envelope.signature, malleate(envelope.signature)),
      {
        verification: 'SIGNATURE_INVALID',
      },
    );
  }
  addManifest('command-envelope-type', signed(COMMAND_ENVELOPE_TYPE, 'test-manifest-a', base), {
    verification: 'ENVELOPE_INVALID',
  });
  addManifest(
    'non-canonical-signature',
    validRaw.replace(/"signature": "([^"]+)"/, (_m, s: string) => `"signature": "${s}="`),
    {
      verification: 'ENVELOPE_INVALID',
    },
  );
  {
    const future = clone(base) as unknown as Record<string, unknown>;
    future.schema_version = 2;
    addManifest('unsupported-schema', signed(MANIFEST_ENVELOPE_TYPE, 'test-manifest-a', future), {
      verification: 'UNSUPPORTED_SCHEMA',
    });
  }
  {
    const extra = clone(base) as unknown as Record<string, unknown>;
    extra.remote_url = 'https://example.invalid/asset.png';
    addManifest('unknown-property', signed(MANIFEST_ENVELOPE_TYPE, 'test-manifest-a', extra), {
      verification: 'SCHEMA_INVALID',
    });
  }
  const semantic = (name: string, reason: string, mutate: (m: ManifestPayload) => void) => {
    const m = clone(base);
    mutate(m);
    addManifest(name, signed(MANIFEST_ENVELOPE_TYPE, 'test-manifest-a', m), {
      verification: 'SEMANTIC_INVALID',
      reason,
    });
  };
  semantic('window-invalid', 'WINDOW_INVALID', (m) => {
    m.activate_before = '2026-10-07T18:00:00Z';
  });
  semantic('invalid-calendar-date', 'WINDOW_INVALID', (m) => {
    m.generated_at = '2026-02-30T00:00:00Z';
  });
  semantic('duplicate-asset', 'DUPLICATE_ASSET_ID', (m) => {
    m.assets.push(clone(m.assets[0]!));
  });
  semantic('unknown-asset', 'UNKNOWN_ASSET', (m) => {
    m.assets.shift();
  });
  semantic('asset-kind-mismatch', 'ASSET_KIND_MISMATCH', (m) => {
    const media = m.contents[0]!;
    if (media.type === 'media') media.media_kind = 'video';
  });
  semantic('unknown-content-in-timeline', 'UNKNOWN_CONTENT', (m) => {
    m.timeline[0]!.content_ref = 'absent';
  });
  semantic('playlist-references-playlist', 'INVALID_REFERENCE', (m) => {
    const playlist = m.contents[2]!;
    if (playlist.type === 'playlist')
      playlist.items.push({ content_ref: 'boucle-promo', duration_ms: 1000 });
  });
  semantic('composition-cycle', 'CONTENT_CYCLE', (m) => {
    const playlist = m.contents[2]!;
    if (playlist.type === 'playlist')
      playlist.items.push({ content_ref: 'bandeau-led', duration_ms: 1000 });
  });
  semantic('timeline-overlap', 'TIMELINE_OVERLAP', (m) => {
    m.timeline[1]!.starts_at = '2026-09-30T05:00:00Z';
  });
  semantic('timeline-outside-window', 'TIMELINE_INTERVAL_INVALID', (m) => {
    m.timeline[2]!.ends_at = '2026-10-07T18:00:00Z';
  });
  semantic('priority-out-of-band', 'PRIORITY_OUT_OF_BAND', (m) => {
    m.timeline[1]!.source.priority = 90;
  });
  semantic('fallback-unknown', 'UNKNOWN_CONTENT', (m) => {
    m.fallback.content_ref = 'absent';
  });
  files.set('fixtures/manifest-vectors.json', json(manifestVectors));

  // --- Commandes -----------------------------------------------------------
  const commandVectors: Vector[] = [];
  const command = baseCommand();
  const commandHash = canonicalSha256(command);
  const context = (overrides: Partial<Vector['context']> = {}) => ({
    organization_id: ORG,
    player_id: PLAYER,
    assignments: { [DISPLAY]: '2' },
    seen: {},
    capabilities: { reboot_host: 'unsupported', screenshot: 'supported' },
    ...overrides,
  });
  const addCommand = (
    name: string,
    raw: string,
    expect: Vector['expect'],
    extra: Partial<Vector> = {},
  ) => {
    const file = `fixtures/commands/${name}.json`;
    files.set(file, raw);
    commandVectors.push({
      name,
      file: file.replace('fixtures/', ''),
      now: '2026-09-29T18:01:00Z',
      context: context(),
      expect,
      ...extra,
    });
  };
  const commandRaw = signed(COMMAND_ENVELOPE_TYPE, 'test-command-a', command);
  addCommand('screenshot-valid', commandRaw, { verification: 'ok', decision: 'execute' });
  addCommand(
    'duplicate-after-ack',
    commandRaw,
    { verification: 'ok', decision: 'duplicate' },
    {
      context: context({ seen: { [command.command_id]: commandHash } }),
      now: '2026-09-29T19:00:00Z',
    },
  );
  addCommand(
    'same-id-other-content',
    commandRaw,
    { verification: 'ok', decision: 'reject', code: 'COMMAND_CONFLICT' },
    {
      context: context({ seen: { [command.command_id]: '1'.repeat(64) } }),
    },
  );
  addCommand(
    'expired',
    commandRaw,
    { verification: 'ok', decision: 'reject', code: 'COMMAND_EXPIRED' },
    {
      now: '2026-09-29T18:05:00Z',
    },
  );
  addCommand(
    'old-assignment',
    commandRaw,
    { verification: 'ok', decision: 'reject', code: 'STALE_ASSIGNMENT' },
    {
      context: context({ assignments: { [DISPLAY]: '3' } }),
    },
  );
  addCommand(
    'screenshot-unsupported',
    commandRaw,
    { verification: 'ok', decision: 'reject', code: 'CAPABILITY_UNSUPPORTED' },
    {
      context: context({ capabilities: { reboot_host: 'unsupported', screenshot: 'unsupported' } }),
    },
  );
  {
    const reboot: CommandPayload = {
      ...command,
      command_id: 'cccccccc-cccc-4ccc-8ccc-000000000002',
      type: 'REBOOT_HOST',
      display_id: null,
      assignment_generation: null,
      params: {},
    };
    addCommand(
      'reboot-unqualified-platform',
      signed(COMMAND_ENVELOPE_TYPE, 'test-command-a', reboot),
      {
        verification: 'ok',
        decision: 'reject',
        code: 'CAPABILITY_UNSUPPORTED',
      },
    );
  }
  addCommand(
    'signed-with-manifest-key',
    signed(COMMAND_ENVELOPE_TYPE, 'test-manifest-a', command),
    { verification: 'UNKNOWN_KEY' },
  );
  addCommand('manifest-envelope-type', signed(MANIFEST_ENVELOPE_TYPE, 'test-command-a', command), {
    verification: 'ENVELOPE_INVALID',
  });
  {
    const shell = { ...command, type: 'RUN_SHELL', params: { cmd: 'rm -rf /' } };
    addCommand('unknown-command-type', signed(COMMAND_ENVELOPE_TYPE, 'test-command-a', shell), {
      verification: 'SCHEMA_INVALID',
    });
  }
  {
    const long = { ...command, expires_at: '2026-10-01T18:00:00Z' };
    addCommand('lifetime-too-long', signed(COMMAND_ENVELOPE_TYPE, 'test-command-a', long), {
      verification: 'SEMANTIC_INVALID',
      reason: 'COMMAND_WINDOW_INVALID',
    });
  }
  files.set('fixtures/command-vectors.json', json(commandVectors));

  // --- JSON canonique et analyse stricte -----------------------------------
  files.set(
    'fixtures/jcs-vectors.json',
    json(
      [
        { name: 'key-order-utf16', input: '{"b":1,"a":2,"é":3,"€":4,"😀":5,"\\ufb33":6}' },
        {
          name: 'numbers',
          input: '[0,-0,1.0,1e2,0.1,1e-7,123456789.125,-5.5e-3,9007199254740991]',
        },
        { name: 'escapes', input: '"\\u0001\\u001f\\"\\\\/\\b\\f\\n\\r\\t\\u2028\\u00e9"' },
        { name: 'nested', input: '{"z":[{"b":null,"a":true}],"a":{"d":false,"c":"x"}}' },
      ].map((vector) => ({ ...vector, canonical: canonicalJsonOf(vector.input) })),
    ),
  );
  files.set(
    'fixtures/strict-json-vectors.json',
    json([
      { name: 'valid-object', input: '{"a":[1,2,{"b":null}]}', valid: true },
      { name: 'duplicate-key', input: '{"a":1,"a":1}', valid: false },
      { name: 'duplicate-nested-key', input: '{"a":{"b":1,"b":2}}', valid: false },
      { name: 'duplicate-after-escape', input: '{"a":1,"\\u0061":2}', valid: false },
      { name: 'proto-key-is-data', input: '{"__proto__":{"x":1}}', valid: true },
      { name: 'max-safe-integer', input: '9007199254740991', valid: true },
      { name: 'beyond-safe-integer', input: '9007199254740992', valid: false },
      { name: 'large-float', input: '1e300', valid: false },
      { name: 'lone-surrogate', input: '"\\udc00"', valid: false },
      { name: 'surrogate-pair', input: '"\\ud83d\\ude00"', valid: true },
      { name: 'leading-zero', input: '01', valid: false },
      { name: 'trailing-comma', input: '[1,]', valid: false },
      { name: 'nan', input: 'NaN', valid: false },
      { name: 'trailing-content', input: '{} {}', valid: false },
      { name: 'raw-control-char', input: '"a\u0001"', valid: false },
      { name: 'depth-64', input: `${'['.repeat(64)}${']'.repeat(64)}`, valid: true },
      { name: 'depth-65', input: `${'['.repeat(65)}${']'.repeat(65)}`, valid: false },
    ]),
  );
  files.set(
    'fixtures/instant-vectors.json',
    json([
      { input: '1970-01-01T00:00:00Z', micros: 0 },
      { input: '2026-09-29T18:00:00Z', micros: 1790704800000000 },
      { input: '2026-09-29T18:00:00.5Z', micros: 1790704800500000 },
      { input: '2024-02-29T23:59:59.999999Z', micros: 1709251199999999 },
      { input: '2026-03-29T01:00:00Z', micros: 1774746000000000 },
      { input: '2025-02-29T00:00:00Z', micros: null },
      { input: '2026-13-01T00:00:00Z', micros: null },
      { input: '2026-09-29T24:00:00Z', micros: null },
      { input: '2026-12-31T23:59:60Z', micros: null },
      { input: '2026-09-29T18:00:00+02:00', micros: null },
      { input: '2026-09-29 18:00:00Z', micros: null },
    ]),
  );
  return files;
}

import { canonicalJson, parseStrictJson } from '../../src/index.js';
function canonicalJsonOf(input: string): string {
  return canonicalJson(parseStrictJson(input) as object);
}
