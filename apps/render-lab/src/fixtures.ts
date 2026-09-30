/**
 * Compositions de référence (ADR-010, critère de recette L04) : mêmes documents rendus
 * par la preview et le Player Web (Chromium) et par le prototype natif (WebKitGTK sous
 * Linux, WebView2 sous Windows). Formats paysage, portrait et LED atypiques ; toutes les
 * familles de polices qualifiées ; texte, formes, QR Code, horloge figée, images, rotations.
 */
import type { Composition, CompositionElement } from '@pixlova/contracts';
import { ASSETS } from './scenarios.js';

export interface Fixture {
  id: string;
  title: string;
  document: Composition;
}

/** Instant figé des horloges : 15 janvier 2026, 10:30:00 UTC (11:30 à Paris). */
export const FIXTURE_NOW = Date.UTC(2026, 0, 15, 10, 30, 0);
export const FIXTURE_TIMEZONE = 'Europe/Paris';

const base = { rotation: 0, z_index: 0, opacity: 1, visible: true, locked: false } as const;
type Box = [number, number, number, number];

function at(id: string, [x, y, width, height]: Box, extra: Partial<CompositionElement> = {}) {
  return { ...base, id, x, y, width, height, ...extra };
}

function text(
  id: string,
  box: Box,
  value: string,
  font: string,
  size: number,
  weight: number,
  extra: Partial<CompositionElement> = {},
  style: {
    align?: 'left' | 'center' | 'right';
    lineHeight?: number;
    valign?: 'top' | 'middle' | 'bottom';
  } = {},
): CompositionElement {
  return {
    ...at(id, box, { z_index: 10, ...extra }),
    type: 'text',
    props: {
      text: value,
      font_family: font,
      font_size_px: size,
      font_weight: weight,
      color: '#FFFFFF',
      alignment: style.align ?? 'left',
      vertical_alignment: style.valign ?? 'top',
      ...(style.lineHeight ? { line_height: style.lineHeight } : {}),
    },
  } as CompositionElement;
}

function shape(
  id: string,
  box: Box,
  fill: string,
  extra: Partial<CompositionElement> = {},
  props: { ellipse?: boolean; stroke?: string; strokeWidth?: number; radius?: number } = {},
): CompositionElement {
  return {
    ...at(id, box, extra),
    type: 'shape',
    props: {
      shape: props.ellipse ? 'ellipse' : 'rectangle',
      fill,
      stroke: props.stroke ?? null,
      stroke_width_px: props.strokeWidth ?? 0,
      ...(props.radius ? { corner_radius_px: props.radius } : {}),
    },
  } as CompositionElement;
}

const image = (
  id: string,
  box: Box,
  asset: string,
  fit: 'contain' | 'cover' | 'stretch',
  extra: Partial<CompositionElement> = {},
) =>
  ({
    ...at(id, box, { z_index: 2, ...extra }),
    type: 'image',
    props: { asset_id: asset, fit },
  }) as CompositionElement;

const qr = (id: string, box: Box, data: string) =>
  ({
    ...at(id, box, { z_index: 10 }),
    type: 'qr',
    props: { data, foreground: '#101820', background: '#FFFFFF', error_correction: 'M' },
  }) as CompositionElement;

const clock = (
  id: string,
  box: Box,
  format: 'time_24h' | 'date_long',
  font: string,
  size: number,
) =>
  ({
    ...at(id, box, { z_index: 10 }),
    type: 'clock',
    props: {
      format,
      timezone: null,
      locale: 'fr-FR',
      font_family: font,
      font_size_px: size,
      color: '#FFD166',
      alignment: 'right',
    },
  }) as CompositionElement;

function composition(
  width: number,
  height: number,
  background: string,
  elements: CompositionElement[],
): Composition {
  return {
    schema_version: 1,
    canvas: { width, height, background },
    elements,
    settings: { duration_ms: 15_000, audio_policy: 'muted' },
  };
}

export const FIXTURES: Fixture[] = [
  {
    id: 'paysage-1920x1080',
    title: 'Paysage 1920×1080 : texte multiligne, formes, images, QR, horloge, rotation',
    document: composition(1920, 1080, '#101820', [
      image('photo-cover', [1100, 0, 820, 1080], ASSETS.portrait, 'cover'),
      image('photo-contain', [60, 620, 640, 400], ASSETS.landscape, 'contain'),
      shape('bandeau', [0, 0, 1100, 160], '#1B7F79'),
      text(
        'titre',
        [60, 20, 1000, 120],
        'Menu du jour',
        'Montserrat',
        88,
        800,
        {},
        { valign: 'middle' },
      ),
      text(
        'corps',
        [60, 200, 980, 380],
        'Entrée · Velouté de saison\nPlat · Filet de cabillaud, légumes rôtis et beurre blanc\nDessert · Tarte fine aux pommes',
        'Inter',
        40,
        400,
        {},
        { lineHeight: 1.5 },
      ),
      shape(
        'pastille',
        [860, 640, 200, 200],
        '#E63946',
        { opacity: 0.9, z_index: 8 },
        { ellipse: true, stroke: '#FFFFFF', strokeWidth: 6 },
      ),
      text(
        'remise',
        [860, 640, 200, 200],
        '-30 %',
        'Montserrat',
        56,
        900,
        { rotation: -8, z_index: 9 },
        { align: 'center', valign: 'middle' },
      ),
      qr('qr', [1520, 780, 280, 280], 'https://pixlova.com/menu'),
      clock('heure', [700, 20, 380, 120], 'time_24h', 'Roboto Mono', 72),
      shape(
        'cadre',
        [720, 860, 320, 180],
        '#00000000',
        { z_index: 3 },
        { stroke: '#FFD166', strokeWidth: 8, radius: 24 },
      ),
    ]),
  },
  {
    id: 'portrait-1080x1920',
    title: 'Portrait 1080×1920 : Playfair, Roboto Mono, image cover, QR',
    document: composition(1080, 1920, '#FFFFFF', [
      image('visuel', [0, 0, 1080, 1180], ASSETS.landscape, 'cover'),
      text(
        'titre',
        [80, 1240, 920, 240],
        'Collection d’automne',
        'Playfair Display',
        96,
        700,
        {},
        { lineHeight: 1.05 },
      ),
      text(
        'detail',
        [80, 1500, 620, 240],
        'En magasin et en ligne jusqu’au 31 octobre.',
        'Open Sans',
        44,
        400,
        {},
        { lineHeight: 1.4 },
      ),
      qr('qr', [760, 1480, 240, 240], 'https://example.com'),
      shape('pied', [0, 1800, 1080, 120], '#E63946'),
      text(
        'code',
        [80, 1810, 920, 100],
        'CODE AUTOMNE26',
        'Roboto Mono',
        56,
        600,
        {},
        { valign: 'middle' },
      ),
    ]),
  },
  {
    id: 'led-2688x672',
    title: 'Bandeau LED 2688×672 : très grand texte, formes arrondies',
    document: composition(2688, 672, '#000000', [
      image('logo', [48, 96, 480, 480], ASSETS.banner, 'contain'),
      text(
        'message',
        [600, 60, 1300, 552],
        'Soldes d’hiver',
        'Montserrat',
        200,
        900,
        {},
        { valign: 'middle', lineHeight: 1 },
      ),
      shape('prix-fond', [1940, 96, 700, 480], '#FFD166', {}, { radius: 40 }),
      text(
        'prix',
        [1940, 96, 700, 480],
        'jusqu’à -50 %',
        'Montserrat',
        120,
        900,
        { z_index: 11 },
        { align: 'center', valign: 'middle', lineHeight: 1 },
      ),
    ]),
  },
  {
    id: 'led-3840x480',
    title: 'Bandeau très large 3840×480 : ligne unique, horloge, date longue',
    document: composition(3840, 480, '#0B1B2B', [
      text(
        'defilant',
        [60, 40, 2600, 400],
        'Arrivées · Vol AF 1234 · Porte B12 · Embarquement 11 h 45',
        'Roboto',
        96,
        500,
        {},
        { valign: 'middle' },
      ),
      clock('heure', [2760, 40, 1020, 200], 'time_24h', 'Inter', 150),
      clock('date', [2760, 260, 1020, 180], 'date_long', 'Inter', 56),
    ]),
  },
  {
    id: 'totem-768x2304',
    title: 'Totem LED 768×2304 : textes empilés, image contain, rotation à 90°',
    document: composition(768, 2304, '#14111F', [
      image('affiche', [0, 0, 768, 1024], ASSETS.portrait, 'contain'),
      text(
        'titre',
        [48, 1080, 672, 300],
        'Forum Innovation',
        'Open Sans',
        88,
        800,
        {},
        { lineHeight: 1.1 },
      ),
      text(
        'programme',
        [48, 1400, 672, 560],
        '09:00 Accueil\n10:15 Table ronde\n14:00 Ateliers\n17:30 Clôture',
        'Roboto',
        52,
        400,
        {},
        { lineHeight: 1.6 },
      ),
      text(
        'vertical',
        [-284, 2040, 700, 120],
        'pixlova · 2026',
        'Inter',
        64,
        700,
        { rotation: 90 },
        { align: 'center', valign: 'middle' },
      ),
      shape('barre', [640, 2000, 128, 304], '#6C4AB6'),
    ]),
  },
];
