/**
 * Exécute le banc dans Chromium headless (Playwright) et vérifie le rendu au pixel près
 * par rapport aux calculs du moteur. Ce test prouve la cohérence géométrique du moteur
 * DOM ; il ne qualifie ni un GPU, ni un décodeur, ni une sortie physique (REN-004).
 *
 * Prérequis : `pnpm --filter @pixlova/render-lab build` et un Chromium Playwright installé.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageTransform, type Orientation } from '@pixlova/render-engine';
import { chromium, type Browser, type Page } from 'playwright-core';
import { preview, type PreviewServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scenarios } from '../src/scenarios.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(root, 'test-results');
const VIEWPORT = { width: 1920, height: 1080 };

let server: PreviewServer;
let browser: Browser;
let baseUrl: string;

beforeAll(async () => {
  server = await preview({ root, logLevel: 'silent', preview: { port: 0, host: '127.0.0.1' } });
  baseUrl = server.resolvedUrls!.local[0]!;
  browser = await chromium.launch();
  await mkdir(outputDir, { recursive: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

interface LabResult {
  environment: Record<string, unknown>;
  codecs: unknown[];
  scenarios: {
    id: string;
    status: string;
    first_frame_ms: number | null;
    errors: string[];
    frames: { frames: number } | null;
  }[];
}

async function runScenario(page: Page, id: string): Promise<LabResult> {
  await page.goto(`${baseUrl}?auto&keep&duration=2&scenario=${id}`);
  await page.waitForFunction(() => window.__PIXLOVA_LAB__?.status === 'done', undefined, {
    timeout: 30_000,
  });
  await page.screenshot({ path: resolve(outputDir, `${id}.png`) });
  return (await page.evaluate(() => window.__PIXLOVA_LAB__.results)) as unknown as LabResult;
}

async function rect(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`Élément absent : ${selector}`);
  return box;
}

describe('banc de rendu dans Chromium headless', () => {
  const expected = scenarios(false).filter((s) => !s.needsVideo);

  for (const scenario of expected) {
    it(`${scenario.id} : rendu sans erreur et scène placée selon stageTransform`, async () => {
      const page = await browser.newPage({ viewport: VIEWPORT });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const result = await runScenario(page, scenario.id);
      const measured = result.scenarios[0]!;
      expect(errors).toEqual([]);
      expect(measured).toMatchObject({ id: scenario.id, status: 'ok', errors: [] });
      expect(measured.first_frame_ms).not.toBeNull();
      expect(measured.frames!.frames).toBeGreaterThan(0);

      const { width, height, orientation } = scenario.display;
      const t = stageTransform(
        width,
        height,
        VIEWPORT.width,
        VIEWPORT.height,
        orientation as Orientation,
        'contain',
      );
      const stage = await rect(page, '[data-pixlova-stage]');
      expect(stage.x).toBeCloseTo(t.box.x, 0);
      expect(stage.y).toBeCloseTo(t.box.y, 0);
      expect(stage.width).toBeCloseTo(t.box.width, 0);
      expect(stage.height).toBeCloseTo(t.box.height, 0);
      await page.close();
    }, 60_000);
  }

  it('place les éléments d’une composition LED 2688×672 au pixel près', async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await runScenario(page, 'led-2688x672');
    const t = stageTransform(2688, 672, VIEWPORT.width, VIEWPORT.height, 0, 'contain');
    const title = await rect(page, '[data-element-id="titre"]');
    expect(title.x).toBeCloseTo(t.box.x + 1660 * t.scale, 0);
    expect(title.y).toBeCloseTo(t.box.y + 40 * t.scale, 0);
    expect(title.width).toBeCloseTo(980 * t.scale, 0);
    const clock = await page.locator('[data-element-id="horloge"]').textContent();
    expect(clock).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    await page.close();
  }, 60_000);

  it('rend un QR code, un texte Unicode sans interprétation HTML et l’ordre de profondeur', async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await runScenario(page, 'text-qr-clock');
    expect(await page.locator('[data-element-id="titre"]').textContent()).toBe(
      'Bienvenue — Crêperie « Chez Zoé » 🥞',
    );
    const path = await page.locator('[data-element-id="qr"] path').getAttribute('d');
    expect(path?.length).toBeGreaterThan(100);
    const order = await page
      .locator('[data-element-id]')
      .evaluateAll((nodes) =>
        nodes.map((n) => [
          (n as HTMLElement).dataset.elementId,
          Number((n as HTMLElement).style.zIndex),
        ]),
      );
    const z = Object.fromEntries(order);
    expect(z.fond).toBeLessThan(z.pastille);
    expect(z.pastille).toBeLessThan(z.qr);
    await page.close();
  }, 60_000);

  it('enregistre l’environnement et le support des codecs de ce runtime', async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    const result = await runScenario(page, 'led-768x2304');
    await writeFile(
      resolve(outputDir, 'headless-chromium.json'),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    expect(result.codecs.length).toBeGreaterThan(0);
    expect(result.environment).toHaveProperty('user_agent');
    await page.close();
  }, 60_000);
});
