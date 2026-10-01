/**
 * Site public dans Chromium (L09-M) : pages générées par `pnpm run build`, servies en
 * statique. Clavier (lien d’évitement, menu mobile, calculateur), absence de défilement
 * horizontal, mur LED dessiné et absence d’erreur dans la console.
 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PAGES } from '../../src/pages.js';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
  '.txt': 'text/plain',
};

describe('site public dans un vrai navigateur', () => {
  let server: Server;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    if (!existsSync(join(dist, 'index.html'))) {
      throw new Error(
        'dist/ absent : lancer `pnpm --filter @pixlova/site run build` avant ce test',
      );
    }
    server = createServer(async (req, res) => {
      const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
      let file = join(dist, path);
      try {
        if (!file.startsWith(dist)) throw new Error('hors racine');
        if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': TYPES['.html']! });
        res.end(await readFile(join(dist, '404.html')));
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((done) => server?.close(done));
  });

  async function open(path: string, width: number): Promise<{ page: Page; errors: string[] }> {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto(`${base}${path}`);
    return { page, errors };
  }

  it('affiche chaque page sans erreur ni défilement horizontal, sur mobile et ordinateur', async () => {
    for (const width of [390, 1440]) {
      for (const { path } of PAGES) {
        const { page, errors } = await open(path, width);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${path} à ${width}px`).toBeLessThanOrEqual(0);
        expect(errors, path).toEqual([]);
        await page.close();
      }
    }
  });

  it('dessine le mur LED et garde son équivalent textuel', async () => {
    const { page } = await open('/', 1440);
    const led = page.locator('canvas.led');
    await expect.poll(() => led.getAttribute('data-drawn')).toBe('true');
    expect(await led.getAttribute('aria-label')).toContain('Plat du jour');
    await page.close();
  });

  it('propose un lien d’évitement vers le contenu au premier Tab', async () => {
    const { page } = await open('/tarifs/', 1440);
    await page.keyboard.press('Tab');
    const skip = page.locator('a.skip');
    expect(await skip.evaluate((el) => el === document.activeElement)).toBe(true);
    expect((await skip.boundingBox())!.y).toBeGreaterThanOrEqual(0);
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('contenu');
    await page.close();
  });

  it('ouvre et ferme le menu mobile au clavier', async () => {
    const { page } = await open('/', 390);
    const toggle = page.locator('.menu-toggle');
    const link = page.locator('#navigation a[href="/tarifs/"]');
    expect(await link.isVisible()).toBe(false);
    await toggle.focus();
    await page.keyboard.press('Enter');
    expect(await toggle.getAttribute('aria-expanded')).toBe('true');
    expect(await link.isVisible()).toBe(true);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    expect(await toggle.getAttribute('aria-expanded')).toBe('false');
    expect(await toggle.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await link.isVisible()).toBe(false);
    await page.close();
  });

  it('met à jour le calculateur au clavier', async () => {
    const { page } = await open('/tarifs/', 1440);
    const range = page.locator('#ecrans');
    const result = page.locator('#devis');
    expect(await result.textContent()).toBe('Pro · 39 € + (14 − 10) × 4 € = 55 € HT / mois');
    await range.focus();
    for (let i = 0; i < 12; i++) await page.keyboard.press('ArrowRight');
    expect(await page.locator('.calc .count').textContent()).toBe('26 écrans');
    expect(await result.textContent()).toBe('Business · 99 € HT / mois');
    await page.keyboard.press('Home');
    expect(await result.textContent()).toBe('Free · Gratuit, sans carte bancaire');
    await page.close();
  });

  it('renvoie vers l’inscription et la connexion du dashboard', async () => {
    const { page } = await open('/', 1440);
    const register = await page.locator('header .account .btn').getAttribute('href');
    const login = await page.locator('header .account a').first().getAttribute('href');
    expect(register).toMatch(/\/register$/);
    expect(login).toMatch(/\/login$/);
    await page.close();
  });
});
