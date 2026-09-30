/**
 * Relevé des compositions de référence dans Chromium (preview et Player Web, ADR-010).
 * Le même relevé, produit par le renderer natif (WebKitGTK sous Xvfb en CI), est comparé
 * par `scripts/compare-render.mjs`. Prérequis : `pnpm --filter @pixlova/render-lab build`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { preview, type PreviewServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURES } from '../src/fixtures.js';
import type { MeasureReport } from '../src/measure.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(root, 'test-results');

let server: PreviewServer;
let browser: Browser;
let report: MeasureReport;

beforeAll(async () => {
  server = await preview({ root, logLevel: 'silent', preview: { port: 0, host: '127.0.0.1' } });
  browser = await chromium.launch();
  await mkdir(outputDir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.resolvedUrls!.local[0]!}?measure`);
  await page.waitForFunction(() => window.__PIXLOVA_LAB__?.status === 'done', undefined, {
    timeout: 60_000,
  });
  report = (await page.evaluate(() => window.__PIXLOVA_LAB__.measure)) as MeasureReport;
  if (errors.length) throw new Error(errors.join('\n'));
  await writeFile(resolve(outputDir, 'measure-chromium.json'), JSON.stringify(report, null, 2));
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('compositions de référence dans Chromium (preview, Player Web)', () => {
  it('toutes les compositions sont relevées', () => {
    expect(report.fixtures.map((f) => f.id)).toEqual(FIXTURES.map((f) => f.id));
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.id} : polices empaquetées, images décodées, géométrie à 1 px près`, () => {
      const measured = report.fixtures.find((f) => f.id === fixture.id)!;
      expect(measured.errors).toEqual([]);
      expect(measured.fonts.length).toBeGreaterThan(0);
      expect(measured.fonts.filter((f) => !f.loaded)).toEqual([]);
      expect(measured.images.failed).toBe(0);
      expect(measured.elements).toHaveLength(fixture.document.elements.length);
      for (const element of measured.elements) {
        expect(element.delta, `${element.id} ${JSON.stringify(element)}`).toBeLessThanOrEqual(1);
      }
    });
  }

  it('horloges figées : fuseau du Display appliqué', () => {
    const clocks = report.fixtures.flatMap((f) => f.elements.filter((e) => e.type === 'clock'));
    expect(clocks.find((c) => c.id === 'heure')?.text).toBe('11:30');
    expect(clocks.map((c) => c.text)).toContain('jeudi 15 janvier 2026');
  });
});
