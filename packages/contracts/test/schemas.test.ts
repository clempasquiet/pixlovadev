import { describe, expect, it } from 'vitest';
import {
  ROOT_SCHEMAS,
  decodeBase64url,
  encodeBase64url,
  validator,
  type HeartbeatPayload,
  type PlayerCapabilities,
  type RootSchemaName,
  type WsMessage,
} from '../src/index.js';

const webCapabilities: PlayerCapabilities = {
  player_type: 'web',
  app_version: '0.1.0',
  os: { family: 'unknown', version: null },
  architecture: 'unknown',
  protocol_versions: [1],
  manifest_schemas: [1],
  render_schemas: [1],
  renderer: { engine: 'chromium', version: '140' },
  image_types: ['image/png', 'image/jpeg', 'image/webp'],
  video_profiles: ['mp4-h264-aac'],
  max_canvas: null,
  max_concurrent_videos: null,
  multi_output: 'unsupported',
  screenshot: 'unknown',
  volume_control: 'supported',
  reboot_host: 'unsupported',
  persistent_storage: 'denied',
  storage_quota_bytes: null,
};

describe('schémas racines', () => {
  it.each(Object.keys(ROOT_SCHEMAS) as RootSchemaName[])('%s compile en mode strict', (name) => {
    expect(() => validator(name)).not.toThrow();
  });
});

describe('WebSocket (PROTO-005)', () => {
  const validate = validator('ws-message.json');
  const heartbeat: HeartbeatPayload = {
    uptime_seconds: 123456,
    renderer: 'ok',
    displays: [
      {
        display_id: '33333333-3333-4333-8333-333333333333',
        assignment_generation: '2',
        manifest_applied_version: '182',
        playback: 'playing',
      },
    ],
  };
  const message: WsMessage = {
    type: 'HEARTBEAT',
    version: 1,
    id: '22222222-2222-4222-8222-222222222222',
    timestamp: '2026-09-29T18:00:00Z',
    payload: heartbeat,
  };

  it('accepte le heartbeat de référence', () => {
    expect(validate(message)).toBe(true);
  });

  it('refuse un payload qui ne correspond pas au type annoncé', () => {
    expect(validate({ ...message, type: 'HELLO' })).toBe(false);
  });

  it('refuse un type inconnu et une version de protocole non supportée', () => {
    expect(validate({ ...message, type: 'SHELL' })).toBe(false);
    expect(validate({ ...message, version: 2 })).toBe(false);
  });

  it('accepte un HELLO de Player Web aux capacités inconnues ou absentes', () => {
    const hello: WsMessage = {
      type: 'HELLO',
      version: 1,
      id: '22222222-2222-4222-8222-000000000001',
      timestamp: '2026-09-29T18:00:00Z',
      payload: {
        protocol_version: 1,
        installation_id: '12121212-1212-4212-8212-121212121212',
        boot_id: '13131313-1313-4313-8313-131313131313',
        capabilities: webCapabilities,
        displays: [],
        pending_events: 0,
        local_time: '2026-09-29T17:59:58.250Z',
      },
    };
    expect(validate(hello)).toBe(true);
  });

  it('refuse un instant qui n’est pas en UTC', () => {
    expect(validate({ ...message, timestamp: '2026-09-29T20:00:00+02:00' })).toBe(false);
  });

  it('représente une mesure indisponible par null, jamais par zéro implicite', () => {
    const status: WsMessage = {
      type: 'STATUS',
      version: 1,
      id: '22222222-2222-4222-8222-000000000002',
      timestamp: '2026-09-29T18:00:00Z',
      payload: {
        metrics: {
          cpu_percent: null,
          memory_used_bytes: null,
          memory_total_bytes: null,
          disk_free_bytes: null,
          disk_total_bytes: null,
          temperature_c: null,
        },
        cache: null,
        outputs: [
          { output_key: 'virtual-0', connected: null, width: 1920, height: 1080, refresh_hz: null },
        ],
      },
    };
    expect(validate(status)).toBe(true);
    const missing = structuredClone(status) as { payload: { metrics: Record<string, unknown> } };
    delete missing.payload.metrics.cpu_percent;
    expect(validate(missing)).toBe(false);
  });
});

describe('Display et affectation', () => {
  const validate = validator('display.json');
  const display = {
    id: '33333333-3333-4333-8333-333333333333',
    organization_id: '55555555-5555-4555-8555-555555555555',
    site_id: '10101010-1010-4010-8010-101010101010',
    name: 'Bandeau vitrine',
    width: 3840,
    height: 480,
    orientation: 0,
    timezone: null,
    lifecycle_status: 'active',
    assignment_generation: '0',
    active_assignment: null,
  };

  it('accepte une résolution LED atypique sans affectation (PROD-002)', () => {
    expect(validate(display)).toBe(true);
    expect(validate({ ...display, width: 768, height: 2304, orientation: 90 })).toBe(true);
  });

  it('refuse une dimension nulle ou une orientation arbitraire', () => {
    expect(validate({ ...display, width: 0 })).toBe(false);
    expect(validate({ ...display, orientation: 45 })).toBe(false);
  });

  it('refuse une génération non décimale ou un UUID en majuscules', () => {
    expect(validate({ ...display, assignment_generation: 2 })).toBe(false);
    expect(validate({ ...display, assignment_generation: '02' })).toBe(false);
    expect(validate({ ...display, id: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF' })).toBe(false);
  });
});

describe('enveloppe d’erreur (API-006)', () => {
  it('accepte l’exemple du cahier des charges', () => {
    expect(
      validator('error.json')({
        error: {
          code: 'DISPLAY_LIMIT_REACHED',
          message: 'Aucune licence de Display disponible.',
          request_id: '11111111-1111-4111-8111-111111111111',
          retryable: false,
          details: { allowed: 1, assigned: 1 },
        },
      }),
    ).toBe(true);
  });
});

describe('base64url', () => {
  it('fait l’aller-retour pour toutes les longueurs de reste', () => {
    for (let length = 0; length < 70; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + length) & 0xff);
      expect(decodeBase64url(encodeBase64url(bytes))).toEqual(bytes);
    }
  });

  it('refuse les formes non canoniques', () => {
    expect(decodeBase64url('AB==')).toBeNull();
    expect(decodeBase64url('AB+/')).toBeNull();
    expect(decodeBase64url('AR')).toBeNull(); // bits de bourrage non nuls
    expect(decodeBase64url('A')).toBeNull();
  });
});
