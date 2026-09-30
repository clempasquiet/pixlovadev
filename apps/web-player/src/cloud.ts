/**
 * Client de l’API Player `/player/v1` (PROTO-001 à PROTO-004), même protocole que le
 * Player natif. Le jeton reste en mémoire : après un rechargement, la page se
 * réauthentifie par challenge signé. Aucune URL d’asset n’est journalisée.
 */
import {
  playerChallengeSigningInput,
  type PlayerAuthChallenge,
  type PlayerConfig,
} from '@pixlova/contracts';
import type { Identity } from './identity.js';

export class CloudError extends Error {
  constructor(
    readonly kind: 'network' | 'api' | 'revoked' | 'protocol',
    readonly code: string,
    readonly status: number | null,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }

  get transient(): boolean {
    return (
      this.kind === 'network' ||
      (this.kind === 'api' && (this.retryable || this.status === 429 || (this.status ?? 0) >= 500))
    );
  }
}

export interface Registration {
  registration_id: string;
  pairing_code: string;
  expires_at: string;
  poll_secret: string;
  poll_interval_s: number;
}

export type PairStatus =
  | { status: 'pending'; expires_at: string }
  | { status: 'paired'; player_id: string; organization_id: string };

export interface AssetUrl {
  asset_id: string;
  url: string;
  expires_at: string;
  size_bytes: number;
  sha256: string;
  range_supported: boolean;
}

export type ManifestFetch =
  { kind: 'envelope'; raw: string } | { kind: 'not-modified' } | { kind: 'none' };

export class Cloud {
  private token: { value: string; expiresAt: number } | null = null;
  readonly base: string;

  /** `apiUrl` vide : même origine que l’application (déploiement recommandé). */
  constructor(apiUrl: string) {
    this.base = new URL(apiUrl || '/', location.href).toString().replace(/\/$/, '');
  }

  /** URL absolue d’un téléchargement ; une URL relative désigne l’origine de l’API. */
  absoluteUrl(url: string): string | null {
    if (/^https?:\/\//.test(url)) return url;
    if (url.startsWith('/') && !url.startsWith('//')) return new URL(url, this.base).toString();
    return null;
  }

  private async send(path: string, init: RequestInit = {}, auth = true): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    if (auth) {
      if (!this.token) throw new CloudError('api', 'UNAUTHORIZED', 401, 'aucun jeton');
      headers.set('authorization', `Bearer ${this.token.value}`);
    }
    let response: Response;
    try {
      response = await fetch(`${this.base}/player/v1${path}`, {
        ...init,
        headers,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (error) {
      throw new CloudError('network', 'NETWORK_UNAVAILABLE', null, String(error));
    }
    if (response.status === 401) this.token = null;
    return response;
  }

  private async fail(response: Response): Promise<never> {
    let body: { error?: { code?: string; message?: string; retryable?: boolean } } = {};
    try {
      body = await response.json();
    } catch {
      // corps absent
    }
    const code = body.error?.code ?? `HTTP_${response.status}`;
    if (code === 'PLAYER_REVOKED') {
      throw new CloudError('revoked', code, response.status, 'Player révoqué');
    }
    throw new CloudError(
      'api',
      code,
      response.status,
      body.error?.message ?? code,
      body.error?.retryable ?? false,
    );
  }

  private async json<T>(path: string, init: RequestInit = {}, auth = true): Promise<T> {
    const response = await this.send(path, init, auth);
    if (!response.ok) return this.fail(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  register(body: unknown): Promise<Registration> {
    return this.json('/register', { method: 'POST', body: JSON.stringify(body) }, false);
  }

  pair(registrationId: string, pollSecret: string): Promise<PairStatus> {
    return this.json(
      '/pair',
      {
        method: 'POST',
        body: JSON.stringify({ registration_id: registrationId, poll_secret: pollSecret }),
      },
      false,
    );
  }

  hasToken(now = Date.now()): boolean {
    return this.token !== null && this.token.expiresAt - 60_000 > now;
  }

  forgetToken(): void {
    this.token = null;
  }

  async authenticate(playerId: string, identity: Identity): Promise<void> {
    const { challenge } = await this.json<{ challenge: PlayerAuthChallenge }>(
      '/token/challenge',
      { method: 'POST', body: JSON.stringify({ player_id: playerId }) },
      false,
    );
    if (challenge.player_id !== playerId) {
      throw new CloudError('protocol', 'PROTOCOL_ERROR', null, 'challenge d’un autre Player');
    }
    const signature = await identity.sign(playerChallengeSigningInput(challenge));
    const token = await this.json<{ access_token: string; expires_at: string }>(
      '/token/refresh',
      { method: 'POST', body: JSON.stringify({ challenge_id: challenge.challenge_id, signature }) },
      false,
    );
    this.token = { value: token.access_token, expiresAt: Date.parse(token.expires_at) };
  }

  config(): Promise<PlayerConfig> {
    return this.json('/config');
  }

  reportOutputs(outputs: unknown[]): Promise<void> {
    return this.json('/outputs', { method: 'POST', body: JSON.stringify({ outputs }) });
  }

  heartbeat(body: unknown): Promise<{ server_time: string; stale_displays: string[] }> {
    return this.json('/heartbeat', { method: 'POST', body: JSON.stringify(body) });
  }

  async manifest(displayId: string, knownHash: string | null): Promise<ManifestFetch> {
    const headers: Record<string, string> = {};
    if (knownHash) headers['if-none-match'] = `"${knownHash}"`;
    const response = await this.send(`/manifest?display_id=${encodeURIComponent(displayId)}`, {
      headers,
    });
    if (response.status === 304) return { kind: 'not-modified' };
    if (response.status === 404) return { kind: 'none' };
    if (!response.ok) return this.fail(response);
    return { kind: 'envelope', raw: await response.text() };
  }

  assetUrl(assetId: string, manifestId: string): Promise<AssetUrl> {
    return this.json(`/assets/${assetId}/url?manifest_id=${encodeURIComponent(manifestId)}`);
  }

  async manifestStatus(
    manifestId: string,
    state: string,
    observedAt: string,
    errorCode: string | null,
    detail: string | null,
  ): Promise<void> {
    await this.json(`/manifests/${manifestId}/status`, {
      method: 'POST',
      body: JSON.stringify({
        state,
        observed_at: observedAt,
        error_code: errorCode,
        detail: detail?.slice(0, 500) ?? null,
      }),
    });
  }
}
