/**
 * Player Web dans Chromium contre l’API, le worker et PostgreSQL réels (L06-W, TST-043) :
 * appairage, activation complète, ressources invalides refusées, quota plein, fermeture et
 * reprise, rechargement hors ligne après amorçage, effacement du profil.
 *
 * Prérequis : `pnpm run build`, Chromium Playwright et `PIXLOVA_TEST_DATABASE_URL`.
 * Ne qualifie ni un navigateur de production, ni un OS, ni une durée hors ligne : voir
 * docs/quality/PLAYER-WEB.md.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPublicApp } from '@pixlova/api';
import { createTestServices, type TestServices } from '@pixlova/api/testing';
import { DEFAULT_MEDIA_LIMITS, encodeBase64url } from '@pixlova/contracts';
import { createTestDatabase, type TestDatabase } from '@pixlova/db/testing';
import { manifestSignerFromSeed } from '@pixlova/scheduling/compiler';
import {
  createMediaWorker,
  DEFAULT_VIDEO_TOOLS,
  silentLogger,
  type Worker,
} from '@pixlova/workers';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import sharp from 'sharp';
import { preview, type PreviewServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'http://localhost:5173';
const KID = 'manifest-web-e2e';
let nextPriority = 10;

let database: TestDatabase;
let test: TestServices;
let api: ReturnType<typeof buildPublicApp>;
let apiUrl: string;
let worker: Worker;
let server: PreviewServer;
let browser: Browser;
let base: string;

beforeAll(async () => {
  database = await createTestDatabase();
  test = createTestServices(database, { cookieSecure: false, allowedOrigins: [ORIGIN] });
  test.setDisplaySlots(5);
  api = buildPublicApp({ services: test.services });
  await api.listen({ host: '127.0.0.1', port: 0 });
  apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
  const seed = randomBytes(32);
  const signer = manifestSignerFromSeed(KID, encodeBase64url(seed));
  worker = createMediaWorker(
    {
      appDb: database.app,
      systemDb: database.system,
      storage: test.storage,
      limits: DEFAULT_MEDIA_LIMITS,
      tools: DEFAULT_VIDEO_TOOLS,
      tmpRoot: await mkdtemp(join(tmpdir(), 'pixlova-web-e2e-')),
      trashRetentionDays: 30,
      manifestSigner: signer,
      now: () => new Date(),
      logger: silentLogger,
    },
    { pollIntervalMs: 200, concurrency: 1, sweepIntervalMs: 3_600_000 },
  );
  worker.start();
  // Clé publique « livrée avec l’application » (ADR-013).
  await mkdir(join(root, 'dist/trust'), { recursive: true });
  await writeFile(
    join(root, 'dist/trust/manifest-keys.json'),
    JSON.stringify({ keys: [{ kid: KID, public_key: encodeBase64url(signer.publicKey) }] }),
  );
  process.env.PIXLOVA_API_URL = apiUrl;
  server = await preview({
    root,
    logLevel: 'silent',
    preview: { port: 0, strictPort: false, host: '127.0.0.1' },
  });
  base = server.resolvedUrls!.local[0]!;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  await worker?.stop();
  await api?.close();
  await database?.close();
  await rm(join(root, 'dist/trust/manifest-keys.json'), { force: true });
});

// --- Dashboard simulé par l’API --------------------------------------------------------

class Account {
  cookie: string | null = null;
  org: string | null = null;

  async call<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${apiUrl}/api/v1${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.org ? { 'x-organization-id': this.org } : {}),
        ...(method === 'POST' || method === 'PUT' ? { 'idempotency-key': randomUUID() } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const set = response.headers.getSetCookie();
    if (set.length) this.cookie = set[0]!.split(';')[0]!;
    const json = response.status === 204 ? {} : await response.json();
    if (!response.ok)
      throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(json)}`);
    return json as T;
  }

  static async create(email: string): Promise<Account> {
    const account = new Account();
    const password = 'correct horse battery staple';
    await account.call('POST', '/auth/register', { email, password, display_name: 'Web' });
    await test.flushEmails();
    const token = new URL(test.mailer.linkFor(email, '/verify-email')!).searchParams.get('token');
    await account.call('POST', '/auth/verify-email', { token });
    await account.call('POST', '/auth/login', { email, password });
    account.org = (
      await account.call<{ id: string }>('POST', '/organizations', {
        name: `Org ${email}`,
        country: 'FR',
        timezone: 'Europe/Paris',
      })
    ).id;
    return account;
  }

  async site(): Promise<string> {
    return (await this.call<{ items: { id: string }[] }>('GET', '/sites')).items[0]!.id;
  }

  async image(width: number, height: number, noise = false): Promise<string> {
    const raw = noise
      ? await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
          .png()
          .toBuffer()
      : await sharp({ create: { width, height, channels: 3, background: '#2266aa' } })
          .png()
          .toBuffer();
    const session = await this.call<{
      upload_id: string;
      media: { id: string };
      upload: { url: string; headers: Record<string, string> };
    }>('POST', '/media/upload-session', {
      filename: 'image.png',
      mime_type: 'image/png',
      size_bytes: raw.length,
    });
    const put = await fetch(`${apiUrl}${session.upload.url}`, {
      method: 'PUT',
      headers: session.upload.headers,
      body: raw,
    });
    expect(put.ok).toBe(true);
    await this.call('POST', `/media/upload-session/${session.upload_id}/complete`);
    await until(
      async () =>
        (await this.call<{ status: string }>('GET', `/media/${session.media.id}`)).status ===
        'ready',
    );
    return session.media.id;
  }

  async publish(mediaId: string): Promise<void> {
    const schedule = await this.call<{ id: string }>('POST', '/schedules', {
      name: `Planning ${randomUUID().slice(0, 4)}`,
    });
    await this.call('PUT', `/schedules/${schedule.id}/draft`, {
      revision: 1,
      document: {
        schema_version: 1,
        kind: 'schedule',
        timezone: null,
        targets: { include: [{ type: 'organization' }], exclude: [] },
        rules: [
          {
            id: randomUUID(),
            content: { type: 'media', id: mediaId },
            // Chaque publication l’emporte sur la précédente (bande planning ≤ 19).
            priority: nextPriority++,
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            start_time: '00:00',
            end_time: '24:00',
            start_date: null,
            end_date: null,
          },
        ],
        exceptions: [],
      },
    });
    await this.call('POST', `/schedules/${schedule.id}/publish`, { revision: 2 });
  }
}

async function until<T>(check: () => Promise<T | null | false>, seconds = 60): Promise<T> {
  for (let i = 0; i < seconds * 5; i++) {
    const value = await check().catch(() => null);
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('délai dépassé');
}

async function openPlayer(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${base}?status`);
  return page;
}

async function pairingCode(page: Page): Promise<string> {
  const code = page.locator('#notice .code');
  await code.waitFor({ timeout: 30_000 });
  return (await code.textContent())!;
}

const panelData = (page: Page, key: string) => page.locator('#panel').getAttribute(`data-${key}`);

/** Appaire le Player, crée un écran et l’affecte à la sortie `browser`. */
async function pairAndAssign(
  account: Account,
  page: Page,
): Promise<{ playerId: string; displayId: string }> {
  const code = await pairingCode(page);
  const site = await account.site();
  await account.call('POST', '/players/pair', { code, name: 'Player Web', site_id: site });
  const player = await until(async () => {
    const found = (
      await account.call<{
        items: { id: string; outputs: { id: string; output_key: string }[] }[];
      }>('GET', '/players')
    ).items[0];
    return found?.outputs.some((o) => o.output_key === 'browser') ? found : null;
  });
  const display = await account.call<{ id: string }>('POST', '/displays', {
    site_id: site,
    name: 'Vitrine Web',
    width: 1280,
    height: 720,
  });
  const output = player.outputs.find((o) => o.output_key === 'browser')!;
  await account.call('PUT', `/displays/${display.id}/assignment`, { player_output_id: output.id });
  return { playerId: player.id, displayId: display.id };
}

describe('Player Web (Chromium, API et worker réels)', () => {
  it('appaire, active, refuse les ressources invalides, reprend hors ligne', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const account = await Account.create('web-a@example.test');
    let page = await openPlayer(context);
    const { displayId } = await pairAndAssign(account, page);

    // Activation complète : manifest vérifié, image vérifiée en cache, première image.
    const first = await account.image(640, 360);
    await account.publish(first);
    await expect.poll(() => panelData(page, 'applied'), { timeout: 60_000 }).not.toBe('');
    const appliedVersion = await panelData(page, 'applied');
    await expect.poll(() => page.locator('#surface img').getAttribute('src')).toMatch(/^blob:/);
    await until(async () => {
      const delivery = await account.call<{ applied: { version: string } | null }>(
        'GET',
        `/displays/${displayId}/delivery`,
      );
      return delivery.applied?.version === appliedVersion;
    });

    // Asset corrompu en transit : refusé, le contenu courant reste affiché.
    await page.route('**/storage/**', async (route) => {
      const response = await route.fetch();
      const body = Buffer.from(await response.body());
      body[body.length - 20] = body[body.length - 20]! ^ 0xff;
      await route.fulfill({ response, body });
    });
    await account.publish(await account.image(320, 180));
    await expect
      .poll(() => panelData(page, 'error'), { timeout: 60_000 })
      .toBe('CHECKSUM_MISMATCH');
    expect(await panelData(page, 'applied')).toBe(appliedVersion);
    await page.unroute('**/storage/**');
    // Réseau rétabli : le candidat est repris (nouvel essai différé) et appliqué.
    await page.reload();
    const recovered = await until(async () => {
      const value = await panelData(page, 'applied');
      return value && value !== appliedVersion ? value : null;
    }, 90);
    await expect.poll(() => panelData(page, 'error')).toBe('');

    // Nouveau manifest altéré en transit : signature refusée, rien n’est appliqué.
    await page.route('**/player/v1/manifest?*', async (route) => {
      const response = await route.fetch();
      if (response.status() !== 200) return route.fulfill({ response });
      const envelope = JSON.parse(await response.text());
      envelope.payload.version = String(Number(envelope.payload.version) + 1000);
      await route.fulfill({ response, body: JSON.stringify(envelope) });
    });
    await account.publish(await account.image(200, 100));
    await expect
      .poll(() => panelData(page, 'error'), { timeout: 60_000 })
      .toBe('SIGNATURE_INVALID');
    expect(await panelData(page, 'applied')).toBe(recovered);
    await page.unroute('**/player/v1/manifest?*');

    // Fermeture puis réouverture : pas de nouvel appairage, contenu restauré localement.
    await page.close();
    page = await openPlayer(context);
    await expect
      .poll(() => page.locator('#surface img').getAttribute('src'), { timeout: 30_000 })
      .toMatch(/^blob:/);
    expect(await page.locator('#notice .code').count()).toBe(0);

    // Hors ligne après amorçage : application servie par le service worker, contenu repris.
    await until(async () =>
      page.evaluate(async () => (await navigator.serviceWorker.ready).active !== null),
    );
    await context.setOffline(true);
    await page.reload();
    await expect
      .poll(() => page.locator('#surface img').getAttribute('src'), { timeout: 30_000 })
      .toMatch(/^blob:/);
    await expect.poll(() => panelData(page, 'online'), { timeout: 30_000 }).toBe('false');
    expect(await panelData(page, 'applied')).not.toBe('');
    await context.setOffline(false);
    await context.close();
  }, 240_000);

  it('quota plein : erreur remontée, contenu courant conservé', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const account = await Account.create('web-quota@example.test');
    const page = await openPlayer(context);
    await pairAndAssign(account, page);
    await account.publish(await account.image(320, 180));
    await expect.poll(() => panelData(page, 'applied'), { timeout: 60_000 }).not.toBe('');
    const applied = await panelData(page, 'applied');
    // Quota réduit à l’usage courant (outil de test de Chromium).
    const cdp = await context.newCDPSession(page);
    const usage = await page.evaluate(async () => (await navigator.storage.estimate()).usage ?? 0);
    await cdp.send('Storage.overrideQuotaForOrigin', {
      origin: new URL(base).origin,
      quotaSize: Math.ceil(usage / 0.9) + 50_000,
    });
    await account.publish(await account.image(1200, 800, true));
    await expect
      .poll(() => panelData(page, 'error'), { timeout: 60_000 })
      .toBe('STORAGE_QUOTA_EXCEEDED');
    expect(await panelData(page, 'applied')).toBe(applied);
    await expect.poll(() => page.locator('#surface img').getAttribute('src')).toMatch(/^blob:/);
    await context.close();
  }, 180_000);

  it('un profil effacé est une nouvelle installation, isolée de l’ancienne', async () => {
    const context = await browser.newContext();
    const page = await openPlayer(context);
    const first = await pairingCode(page);
    const firstInstallation = await page.evaluate(
      () => document.querySelector('#panel [data-field="Installation"]')?.textContent,
    );
    // Effacement des données du site (équivalent d’un changement de profil).
    const cdp = await context.newCDPSession(page);
    await cdp.send('Storage.clearDataForOrigin', {
      origin: new URL(base).origin,
      storageTypes: 'all',
    });
    await page.reload();
    const second = await pairingCode(page);
    const secondInstallation = await page.evaluate(
      () => document.querySelector('#panel [data-field="Installation"]')?.textContent,
    );
    expect(second).not.toBe(first);
    expect(secondInstallation).not.toBe(firstInstallation);
    // La clé de l’appareil n’est pas extractible (WebCrypto Ed25519).
    expect(
      await page.evaluate(
        () => document.querySelector('#panel [data-field="Clé de l’appareil"]')?.textContent,
      ),
    ).toBe('webcrypto-non-extractible');
    await context.close();
  }, 120_000);
});
