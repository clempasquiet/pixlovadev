import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  encodeBase64url,
  signPlayerChallenge,
  type OutputReport,
  type PlayerCapabilities,
  type PlayerConfig,
} from '@pixlova/contracts';
import type { Harness } from './harness.js';

export function capabilities(overrides: Partial<PlayerCapabilities> = {}): PlayerCapabilities {
  return {
    player_type: 'native',
    app_version: '0.1.0',
    os: { family: 'linux', version: '24.04' },
    architecture: 'x86_64',
    protocol_versions: [1],
    manifest_schemas: [1],
    render_schemas: [1],
    renderer: { engine: 'webkitgtk', version: '2.52' },
    image_types: ['image/png', 'image/jpeg'],
    video_profiles: ['mp4-h264-aac'],
    max_canvas: { width: 3840, height: 2160 },
    max_concurrent_videos: 2,
    multi_output: 'supported',
    screenshot: 'supported',
    volume_control: 'supported',
    reboot_host: 'unsupported',
    persistent_storage: 'granted',
    storage_quota_bytes: null,
    ...overrides,
  };
}

const OUTPUTS: OutputReport[] = [
  {
    output_key: 'HDMI-A-1',
    connector_type: 'HDMI',
    width: 1920,
    height: 1080,
    refresh_hz: 60,
    connected: true,
  },
  {
    output_key: 'HDMI-A-2',
    connector_type: 'HDMI',
    width: 1920,
    height: 1080,
    refresh_hz: 60,
    connected: true,
  },
];

/** Player simulé : clé Ed25519 locale, enregistrement, appairage, jeton, heartbeat. */
export class SimulatedPlayer {
  readonly secretKey = ed25519.utils.randomSecretKey();
  readonly installationId = randomUUID();
  registration: { registration_id: string; pairing_code: string; poll_secret: string } | null =
    null;
  playerId: string | null = null;
  organizationId: string | null = null;
  token: string | null = null;

  constructor(
    private readonly harness: Harness,
    readonly outputs: OutputReport[] = OUTPUTS,
    readonly caps: PlayerCapabilities = capabilities(),
  ) {}

  async call(method: 'GET' | 'POST', url: string, payload?: unknown) {
    return this.harness.app.inject({
      method,
      url: `/player/v1${url}`,
      ...(payload === undefined ? {} : { payload: payload as object }),
      headers: this.token ? { authorization: `Bearer ${this.token}` } : {},
    });
  }

  async register(): Promise<string> {
    const response = await this.call('POST', '/register', {
      installation_id: this.installationId,
      public_key: encodeBase64url(ed25519.getPublicKey(this.secretKey)),
      capabilities: this.caps,
      outputs: this.outputs,
      machine_fingerprint: null,
    });
    if (response.statusCode !== 201) throw new Error(`register: ${response.body}`);
    this.registration = response.json();
    return this.registration!.pairing_code;
  }

  async poll() {
    const response = await this.call('POST', '/pair', {
      registration_id: this.registration!.registration_id,
      poll_secret: this.registration!.poll_secret,
    });
    if (response.statusCode === 200 && response.json().status === 'paired') {
      this.playerId = response.json().player_id;
      this.organizationId = response.json().organization_id;
    }
    return response;
  }

  async challenge() {
    const response = await this.call('POST', '/token/challenge', { player_id: this.playerId });
    return response;
  }

  async authenticate(): Promise<void> {
    const challenge = await this.challenge();
    if (challenge.statusCode !== 200) throw new Error(`challenge: ${challenge.body}`);
    const doc = challenge.json().challenge;
    const response = await this.call('POST', '/token/refresh', {
      challenge_id: doc.challenge_id,
      signature: signPlayerChallenge(doc, this.secretKey),
    });
    if (response.statusCode !== 200) throw new Error(`token: ${response.body}`);
    this.token = response.json().access_token;
  }

  async config(): Promise<PlayerConfig> {
    const response = await this.call('GET', '/config');
    if (response.statusCode !== 200)
      throw new Error(`config ${response.statusCode}: ${response.body}`);
    return response.json();
  }

  async heartbeat(displays: { display_id: string; assignment_generation: string }[] = []) {
    return this.call('POST', '/heartbeat', {
      uptime_seconds: 42,
      renderer: 'ok',
      displays: displays.map((d) => ({
        ...d,
        manifest_applied_version: null,
        playback: 'standby',
      })),
    });
  }
}
