/**
 * Mode `measure` du banc (ADR-010) : rend chaque composition de référence à l’échelle 1
 * et relève la géométrie de chaque élément, le chargement des polices, le nombre de
 * lignes des textes et le texte des horloges. Le même relevé est produit par Chromium
 * (preview, Player Web) et par le renderer natif ; `scripts/compare-render.mjs` compare.
 */
import { elementBounds } from '@pixlova/render-engine';
import { loadCompositionFonts, renderComposition } from '@pixlova/render-engine/dom';
import { FIXTURE_NOW, FIXTURE_TIMEZONE, FIXTURES, type Fixture } from './fixtures.js';

export interface ElementMeasure {
  id: string;
  type: string;
  expected: { x: number; y: number; width: number; height: number };
  measured: { x: number; y: number; width: number; height: number };
  /** Plus grand écart absolu entre attendu et mesuré, en pixels. */
  delta: number;
  /** Textes non tournés : nombre de lignes rendues. */
  lines?: number;
  /** Horloges : texte affiché à l’instant figé. */
  text?: string;
}

export interface FixtureMeasure {
  id: string;
  canvas: { width: number; height: number };
  fonts: { family: string; weight: number; loaded: boolean }[];
  images: { decoded: number; failed: number };
  elements: ElementMeasure[];
  errors: string[];
}

export interface MeasureReport {
  kind: 'pixlova-render-measure';
  version: 1;
  measured_at: string;
  user_agent: string;
  fixtures: FixtureMeasure[];
}

const round = (value: number) => Math.round(value * 100) / 100;

function lineCount(node: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(node);
  const tops = new Set<number>();
  for (const rect of range.getClientRects()) {
    if (rect.width > 0 && rect.height > 0) tops.add(Math.round(rect.top));
  }
  return tops.size;
}

async function measureFixture(
  fixture: Fixture,
  host: HTMLElement,
  assets: Map<string, string>,
): Promise<FixtureMeasure> {
  const { width, height } = fixture.document.canvas;
  const errors: string[] = [];
  const holder = document.createElement('div');
  Object.assign(holder.style, {
    position: 'absolute',
    left: '0',
    top: '0',
    width: `${width}px`,
    height: `${height}px`,
  });
  host.replaceChildren(holder);
  const fonts = await loadCompositionFonts(fixture.document);
  const rendered = renderComposition(fixture.document, width, height, {
    resolveAsset: (id) => assets.get(id) ?? '',
    contents: new Map(),
    timezone: FIXTURE_TIMEZONE,
    now: () => FIXTURE_NOW,
    onError: (error) => errors.push(`${error.reason} ${error.detail}`),
  });
  holder.append(rendered.element);
  const images = [...rendered.element.querySelectorAll('img')];
  const decoded = await Promise.all(
    images.map((img) =>
      img.decode().then(
        () => true,
        () => false,
      ),
    ),
  );
  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const origin = rendered.element.getBoundingClientRect();
  const elements: ElementMeasure[] = [];
  for (const element of fixture.document.elements) {
    const node = rendered.element.querySelector<HTMLElement>(`[data-element-id="${element.id}"]`);
    if (!node) {
      errors.push(`élément absent : ${element.id}`);
      continue;
    }
    const box = node.getBoundingClientRect();
    const expected = elementBounds(element);
    const measured = {
      x: box.left - origin.left,
      y: box.top - origin.top,
      width: box.width,
      height: box.height,
    };
    const delta = Math.max(
      Math.abs(measured.x - expected.x),
      Math.abs(measured.y - expected.y),
      Math.abs(measured.width - expected.width),
      Math.abs(measured.height - expected.height),
    );
    const entry: ElementMeasure = {
      id: element.id,
      type: element.type,
      expected: {
        x: round(expected.x),
        y: round(expected.y),
        width: round(expected.width),
        height: round(expected.height),
      },
      measured: {
        x: round(measured.x),
        y: round(measured.y),
        width: round(measured.width),
        height: round(measured.height),
      },
      delta: round(delta),
    };
    if (element.type === 'text' && element.rotation === 0) entry.lines = lineCount(node);
    if (element.type === 'clock') entry.text = node.textContent ?? '';
    elements.push(entry);
  }
  rendered.destroy();
  return {
    id: fixture.id,
    canvas: { width, height },
    fonts,
    images: { decoded: decoded.filter(Boolean).length, failed: decoded.filter((ok) => !ok).length },
    elements,
    errors,
  };
}

export async function measureAll(
  host: HTMLElement,
  assets: Map<string, string>,
  only: string | null,
): Promise<MeasureReport> {
  const fixtures: FixtureMeasure[] = [];
  for (const fixture of FIXTURES) {
    if (only && fixture.id !== only) continue;
    fixtures.push(await measureFixture(fixture, host, assets));
  }
  return {
    kind: 'pixlova-render-measure',
    version: 1,
    measured_at: new Date().toISOString(),
    user_agent: navigator.userAgent,
    fixtures,
  };
}
