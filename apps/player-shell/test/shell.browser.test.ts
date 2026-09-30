/**
 * Page de lecture dans Chromium headless, avec un pont IPC simulé : préparation sans
 * affichage, bascule confirmée par la première image, changement de créneau hors ligne,
 * échec de décodage sans effet sur l’écran, écran d’appairage. Ne qualifie pas WebKitGTK
 * (voir le parcours Xvfb du renderer natif).
 *
 * Prérequis : `pnpm --filter @pixlova/player-shell build` et un Chromium Playwright installé.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { preview, type PreviewServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// PNG 1×1 valide ; le contenu importe peu, seul le décodage est vérifié.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_BAD = 'c'.repeat(64);

let server: PreviewServer;
let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  server = await preview({ root, logLevel: 'silent', preview: { port: 0, host: '127.0.0.1' } });
  baseUrl = server.resolvedUrls!.local[0]!;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function manifest(id: string, switchAt: number, assets: { a: string; b: string }) {
  const from = iso(Date.now() - 3_600_000);
  const until = iso(Date.now() + 86_400_000);
  const asset = (n: string) => ({
    id: `77777777-7777-4777-8777-00000000000${n}`,
    variant: 'display-image',
    mime_type: 'image/png',
    size_bytes: PNG.length,
    sha256: n === '1' ? assets.a : assets.b,
  });
  const content = (n: string) => ({
    id: `image-${n}`,
    type: 'media',
    media_kind: 'image',
    asset_id: `77777777-7777-4777-8777-00000000000${n}`,
    duration_ms: 10000,
    fit: 'contain',
    muted: true,
  });
  const source = {
    type: 'schedule',
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
    priority: 10,
    revision: '1',
  };
  return {
    manifest_id: id,
    display: { width: 1280, height: 720, orientation: 0, fit: 'contain', timezone: 'Europe/Paris' },
    assets: [asset('1'), asset('2')],
    contents: [content('1'), content('2')],
    timeline: [
      { starts_at: from, ends_at: iso(switchAt), content_ref: 'image-1', source },
      { starts_at: iso(switchAt), ends_at: until, content_ref: 'image-2', source },
    ],
    fallback: { content_ref: 'image-1', after_schedule: 'play_fallback' },
    valid_from: from,
    schedule_until: until,
  };
}

async function open(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => {
    const w = window as unknown as { __messages: unknown[]; ipc: { postMessage(m: string): void } };
    w.__messages = [];
    w.ipc = { postMessage: (m: string) => w.__messages.push(JSON.parse(m)) };
  });
  await page.route('http://pixlova.asset/**', (route) => {
    const sha = new URL(route.request().url()).pathname.slice(1);
    if (sha === SHA_BAD) return route.fulfill({ contentType: 'image/png', body: 'pas une image' });
    return route.fulfill({ contentType: 'image/png', body: PNG });
  });
  await page.goto(baseUrl);
  await waitFor(page, (m) => m.type === 'loaded');
  return page;
}

type Message = { type: string; [key: string]: unknown };

async function messages(page: Page): Promise<Message[]> {
  return page.evaluate(() => (window as unknown as { __messages: Message[] }).__messages);
}

async function waitFor(page: Page, predicate: (m: Message) => boolean): Promise<Message> {
  for (let i = 0; i < 100; i++) {
    const found = (await messages(page)).find(predicate);
    if (found) return found;
    await page.waitForTimeout(50);
  }
  throw new Error(`message attendu absent : ${JSON.stringify(await messages(page))}`);
}

async function send(page: Page, message: unknown): Promise<void> {
  await page.evaluate((m) => window.pixlova!.receive(m as never), message);
}

const display = {
  display_id: '33333333-3333-4333-8333-333333333333',
  name: 'Vitrine',
  width: 1280,
  height: 720,
  orientation: 0,
  timezone: 'Europe/Paris',
};

describe('page de lecture (Chromium)', () => {
  it('prépare, bascule à la première image et suit la timeline hors ligne', async () => {
    const page = await open();
    await send(page, {
      type: 'configure',
      display,
      notice: null,
      asset_base: 'http://pixlova.asset/',
    });
    await send(page, {
      type: 'prepare',
      manifest_id: 'm1',
      manifest: manifest('m1', Date.now() + 1500, { a: SHA_A, b: SHA_B }),
      assets: {
        '77777777-7777-4777-8777-000000000001': SHA_A,
        '77777777-7777-4777-8777-000000000002': SHA_B,
      },
    });
    expect(await waitFor(page, (m) => m.type === 'prepared')).toMatchObject({
      manifest_id: 'm1',
      error: null,
    });
    // Préparé ne veut pas dire affiché.
    expect(await page.locator('img').count()).toBe(0);
    await send(page, { type: 'activate', manifest_id: 'm1' });
    await waitFor(page, (m) => m.type === 'frame' && m.manifest_id === 'm1');
    await expect
      .poll(() => page.locator('img').getAttribute('src'))
      .toBe(`http://pixlova.asset/${SHA_A}`);
    // Changement de créneau sans aucun message de l’hôte.
    await waitFor(
      page,
      (m) => m.type === 'status' && m.content_ref === 'image-2' && m.playback === 'playing',
    );
    await expect
      .poll(() => page.locator('img').getAttribute('src'))
      .toBe(`http://pixlova.asset/${SHA_B}`);
    await expect.poll(() => page.locator('img').count()).toBe(1);

    // Un candidat illisible échoue à la préparation ; l’écran reste inchangé.
    await send(page, {
      type: 'prepare',
      manifest_id: 'm2',
      manifest: manifest('m2', Date.now() + 60_000, { a: SHA_BAD, b: SHA_B }),
      assets: {
        '77777777-7777-4777-8777-000000000001': SHA_BAD,
        '77777777-7777-4777-8777-000000000002': SHA_B,
      },
    });
    expect(
      await waitFor(page, (m) => m.type === 'prepared' && m.manifest_id === 'm2'),
    ).toMatchObject({
      error: { code: 'DECODE_FAILED' },
    });
    expect(await page.locator('img').getAttribute('src')).toBe(`http://pixlova.asset/${SHA_B}`);
    // Activer un manifest non préparé est refusé.
    await send(page, { type: 'activate', manifest_id: 'm2' });
    await waitFor(
      page,
      (m) =>
        m.type === 'prepared' && (m.error as { code?: string } | null)?.code === 'NOT_PREPARED',
    );
    await page.close();
  });

  it('affiche le code d’appairage sans Display', async () => {
    const page = await open();
    await send(page, {
      type: 'configure',
      display: null,
      notice: { kind: 'pairing', pairing_code: 'ABCD-EFGH', expires_at: '2099-01-01T00:00:00Z' },
      asset_base: 'http://pixlova.asset/',
    });
    await waitFor(page, (m) => m.type === 'frame' && m.manifest_id === null);
    expect(await page.locator('#notice .code').textContent()).toBe('ABCD-EFGH');
    await page.close();
  });
});
