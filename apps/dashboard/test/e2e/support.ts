import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { chromium, type Browser, type Page } from 'playwright-core';
import { preview, type PreviewServer } from 'vite';
import { buildPublicApp } from '@pixlova/api';
import { createTestServices, type TestServices } from '@pixlova/api/testing';
import { encodeBase64url, signPlayerChallenge } from '@pixlova/contracts';
import { DEFAULT_MEDIA_LIMITS } from '@pixlova/contracts';
import { createTestDatabase, type TestDatabase } from '@pixlova/db/testing';
import { manifestSignerFromSeed, type ManifestSigner } from '@pixlova/scheduling/compiler';
import {
  createMediaWorker,
  DEFAULT_VIDEO_TOOLS,
  silentLogger,
  type Worker,
} from '@pixlova/workers';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const output = resolve(root, 'test-results');
export const PASSWORD = 'une phrase de passe assez longue';

export interface Stack {
  database: TestDatabase;
  test: TestServices;
  api: ReturnType<typeof buildPublicApp>;
  apiUrl: string;
  server: PreviewServer;
  browser: Browser;
  base: string;
  /** Worker réel (ADR-009, ADR-011) : médias et compilation des manifests. */
  worker: Worker;
  /** Clé de signature des manifests du worker, pour vérifier comme un Player. */
  signer: ManifestSigner;
  close(): Promise<void>;
}

/** API réelle + PostgreSQL + dashboard construit, servi par Vite preview, et Chromium. */
export async function startStack(options: { billing?: boolean } = {}): Promise<Stack> {
  const database = await createTestDatabase();
  const test = createTestServices(database, { cookieSecure: false }, options);
  test.setMaxUsers(5);
  test.setDisplaySlots(5);
  const api = buildPublicApp({ services: test.services });
  await api.listen({ host: '127.0.0.1', port: 0 });
  const apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  process.env.PIXLOVA_API_URL = apiUrl;
  const server = await preview({
    root,
    logLevel: 'silent',
    preview: { port: 0, strictPort: false, host: '127.0.0.1' },
  });
  const base = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
  test.services.security.allowedOrigins = [base];
  test.services.security.appBaseUrl = base;
  const browser = await chromium.launch();
  await mkdir(output, { recursive: true });
  const workerTmp = await mkdtemp(join(tmpdir(), 'pixlova-e2e-worker-'));
  const signer = manifestSignerFromSeed(
    'manifest-key-e2e',
    encodeBase64url(ed25519.utils.randomSecretKey()),
  );
  const worker = createMediaWorker(
    {
      appDb: database.app,
      systemDb: database.system,
      storage: test.storage,
      limits: DEFAULT_MEDIA_LIMITS,
      tools: DEFAULT_VIDEO_TOOLS,
      tmpRoot: workerTmp,
      trashRetentionDays: 30,
      manifestSigner: signer,
      now: () => new Date(),
      logger: silentLogger,
    },
    { pollIntervalMs: 200, concurrency: 1, sweepIntervalMs: 3_600_000 },
  );
  worker.start();
  return {
    database,
    test,
    api,
    apiUrl,
    server,
    browser,
    base,
    worker,
    signer,
    async close() {
      await worker.stop();
      await rm(workerTmp, { recursive: true, force: true });
      await browser.close();
      await server.close();
      await api.close();
      await database.close();
    },
  };
}

export async function emailLink(stack: Stack, to: string, path: string): Promise<string> {
  await stack.test.flushEmails();
  const link = stack.test.mailer.linkFor(to, path);
  if (!link) throw new Error(`Aucun lien ${path} pour ${to}`);
  return link;
}

export async function register(
  stack: Stack,
  page: Page,
  email: string,
  name: string,
): Promise<void> {
  await page.goto(`${stack.base}/register`);
  await page.getByLabel('Nom affiché').fill(name);
  await page.getByLabel('Adresse email').fill(email);
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await page.getByRole('heading', { name: 'Vérifiez votre boîte mail' }).waitFor();
  await page.goto(await emailLink(stack, email, '/verify-email'));
  await page.getByText('Adresse confirmée').waitFor();
}

export async function login(page: Page, email: string): Promise<void> {
  await page.getByLabel('Adresse email').fill(email);
  await page.getByLabel('Mot de passe').fill(PASSWORD);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

/** Player simulé côté réseau : clé Ed25519 locale, protocole `/player/v1` réel. */
export class NetworkPlayer {
  readonly secretKey = ed25519.utils.randomSecretKey();
  private registration: {
    registration_id: string;
    pairing_code: string;
    poll_secret: string;
  } | null = null;
  playerId: string | null = null;
  private token: string | null = null;

  constructor(private readonly apiUrl: string) {}

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.apiUrl}/player/v1${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = response.status === 204 ? {} : await response.json();
    if (!response.ok) throw new Error(`${path} ${response.status} ${JSON.stringify(json)}`);
    return json as T;
  }

  async register(): Promise<string> {
    this.registration = await this.call('POST', '/register', {
      installation_id: randomUUID(),
      public_key: encodeBase64url(ed25519.getPublicKey(this.secretKey)),
      capabilities: {
        player_type: 'native',
        app_version: '0.1.0',
        os: { family: 'linux', version: '24.04' },
        architecture: 'x86_64',
        protocol_versions: [1],
        manifest_schemas: [1],
        render_schemas: [1],
        renderer: { engine: 'webkitgtk', version: '2.52' },
        image_types: ['image/png'],
        video_profiles: ['mp4-h264-aac'],
        max_canvas: { width: 3840, height: 2160 },
        max_concurrent_videos: 2,
        multi_output: 'supported',
        screenshot: 'supported',
        volume_control: 'supported',
        reboot_host: 'unsupported',
        persistent_storage: 'granted',
        storage_quota_bytes: null,
      },
      outputs: [
        {
          output_key: 'HDMI-A-1',
          connector_type: 'HDMI',
          width: 1920,
          height: 1080,
          refresh_hz: 60,
          connected: true,
        },
      ],
      machine_fingerprint: null,
    });
    return this.registration!.pairing_code;
  }

  async connect(): Promise<void> {
    const paired = await this.call<{ status: string; player_id?: string }>('POST', '/pair', {
      registration_id: this.registration!.registration_id,
      poll_secret: this.registration!.poll_secret,
    });
    if (paired.status !== 'paired') throw new Error('Player non appairé');
    this.playerId = paired.player_id!;
    const { challenge } = await this.call<{ challenge: Parameters<typeof signPlayerChallenge>[0] }>(
      'POST',
      '/token/challenge',
      { player_id: this.playerId },
    );
    const token = await this.call<{ access_token: string }>('POST', '/token/refresh', {
      challenge_id: challenge.challenge_id,
      signature: signPlayerChallenge(challenge, this.secretKey),
    });
    this.token = token.access_token;
  }

  async heartbeat(
    displays: { display_id: string; assignment_generation: string }[] = [],
  ): Promise<{ pending_commands: number }> {
    return this.call('POST', '/heartbeat', {
      uptime_seconds: 10,
      renderer: 'ok',
      displays: displays.map((d) => ({
        ...d,
        manifest_applied_version: null,
        playback: 'playing',
      })),
    });
  }

  config() {
    return this.call<{
      assignments: {
        display_id: string;
        assignment_generation: string;
        manifest_version: string | null;
      }[];
    }>('GET', '/config');
  }

  /** Octets signés du dernier manifest désiré, tels que distribués. */
  async manifest(displayId: string): Promise<string | null> {
    const response = await fetch(`${this.apiUrl}/player/v1/manifest?display_id=${displayId}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    return response.status === 200 ? response.text() : null;
  }

  async report(manifestId: string, state: 'downloading' | 'ready' | 'applied'): Promise<void> {
    await this.call('POST', `/manifests/${manifestId}/status`, {
      state,
      observed_at: new Date().toISOString().replace(/\.[0-9]{3}Z$/, 'Z'),
      error_code: null,
      detail: null,
    });
  }
}
