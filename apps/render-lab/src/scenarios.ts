/**
 * Scénarios de qualification REN-004 : boucle vidéo, composition texte/QR/horloge,
 * deux zones média, portrait tourné et formats LED larges. Sans dépendance au DOM.
 */
import type { Composition, CompositionElement, ManifestContent } from '@pixlova/contracts';
import type { Orientation } from '@pixlova/render-engine';

export const ASSETS = {
  landscape: '00000000-0000-4000-8000-00000000a001',
  portrait: '00000000-0000-4000-8000-00000000a002',
  banner: '00000000-0000-4000-8000-00000000a003',
  video: '00000000-0000-4000-8000-00000000b001',
} as const;

export interface Scenario {
  id: string;
  title: string;
  display: { width: number; height: number; orientation: Orientation };
  contents: ManifestContent[];
  root: string;
  needsVideo: boolean;
}

const base = {
  rotation: 0,
  opacity: 1,
  visible: true,
  locked: false,
} as const;

function text(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  value: string,
  size: number,
): CompositionElement {
  return {
    ...base,
    id,
    type: 'text',
    x,
    y,
    width,
    height,
    z_index: 5,
    props: {
      text: value,
      font_family: 'Inter',
      font_size_px: size,
      font_weight: 600,
      color: '#FFFFFF',
      alignment: 'left',
      vertical_alignment: 'middle',
    },
  };
}

function clock(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  size: number,
): CompositionElement {
  return {
    ...base,
    id,
    type: 'clock',
    x,
    y,
    width,
    height,
    z_index: 5,
    props: {
      format: 'time_24h_seconds',
      timezone: null,
      locale: 'fr-FR',
      font_family: 'Inter',
      font_size_px: size,
      color: '#FFD166',
      alignment: 'right',
    },
  };
}

function composition(
  id: string,
  width: number,
  height: number,
  elements: CompositionElement[],
): ManifestContent {
  const document: Composition = {
    schema_version: 1,
    canvas: { width, height, background: '#101820' },
    elements,
    settings: { duration_ms: 20000, audio_policy: 'muted' },
  };
  return {
    id,
    type: 'composition',
    composition_version_id: '00000000-0000-4000-8000-00000000c001',
    duration_ms: 20000,
    document,
  };
}

const image = (
  id: string,
  asset: string,
  fit: 'contain' | 'cover' | 'stretch' = 'contain',
): ManifestContent => ({
  id,
  type: 'media',
  media_kind: 'image',
  asset_id: asset,
  duration_ms: 8000,
  fit,
  muted: true,
});
const video: ManifestContent = {
  id: 'video',
  type: 'media',
  media_kind: 'video',
  asset_id: ASSETS.video,
  duration_ms: 30000,
  fit: 'contain',
  muted: true,
};

export function scenarios(hasVideo: boolean): Scenario[] {
  const zoneMedia = hasVideo ? video : image('zone-b-image', ASSETS.portrait, 'cover');
  return [
    {
      id: 'video-loop',
      title: 'Boucle vidéo plein écran 1920×1080',
      display: { width: 1920, height: 1080, orientation: 0 },
      contents: [video],
      root: 'video',
      needsVideo: true,
    },
    {
      id: 'text-qr-clock',
      title: 'Composition texte, QR code, horloge et formes 1920×1080',
      display: { width: 1920, height: 1080, orientation: 0 },
      contents: [
        composition('main', 1920, 1080, [
          {
            ...base,
            id: 'fond',
            type: 'shape',
            x: 0,
            y: 0,
            width: 1920,
            height: 200,
            z_index: 1,
            props: { shape: 'rectangle', fill: '#1B998B', stroke: null, stroke_width_px: 0 },
          },
          {
            ...base,
            id: 'pastille',
            type: 'shape',
            x: 1500,
            y: 500,
            width: 300,
            height: 300,
            z_index: 2,
            opacity: 0.8,
            props: { shape: 'ellipse', fill: '#E84855', stroke: '#FFFFFF', stroke_width_px: 8 },
          },
          text('titre', 64, 20, 1300, 160, 'Bienvenue — Crêperie « Chez Zoé » 🥞', 96),
          text(
            'corps',
            64,
            300,
            1300,
            500,
            'Menu du jour\nGalette complète 9,50 €\nCrêpe caramel beurre salé 5 €',
            72,
          ),
          clock('horloge', 1400, 20, 460, 160, 96),
          {
            ...base,
            id: 'qr',
            type: 'qr',
            x: 1560,
            y: 820,
            width: 240,
            height: 240,
            z_index: 3,
            props: {
              data: 'https://pixlova.com/exemple',
              foreground: '#000000',
              background: '#FFFFFF',
              error_correction: 'M',
            },
          },
        ]),
      ],
      root: 'main',
      needsVideo: false,
    },
    {
      id: 'two-media-zones',
      title: 'Deux zones média 1920×1080',
      display: { width: 1920, height: 1080, orientation: 0 },
      contents: [
        image('zone-a-image', ASSETS.landscape, 'cover'),
        zoneMedia,
        composition('main', 1920, 1080, [
          {
            ...base,
            id: 'zone-a',
            type: 'media_zone',
            x: 0,
            y: 0,
            width: 1152,
            height: 1080,
            z_index: 1,
            props: { content_ref: 'zone-a-image', fit: 'cover' },
          },
          {
            ...base,
            id: 'zone-b',
            type: 'media_zone',
            x: 1152,
            y: 0,
            width: 768,
            height: 1080,
            z_index: 1,
            props: { content_ref: zoneMedia.id, fit: 'cover' },
          },
        ]),
      ],
      root: 'main',
      needsVideo: false,
    },
    {
      id: 'portrait-rotated',
      title: 'Display portrait 1080×1920 sur sortie paysage (rotation 90°)',
      display: { width: 1080, height: 1920, orientation: 90 },
      contents: [
        image('portrait-image', ASSETS.portrait, 'cover'),
        composition('main', 1080, 1920, [
          {
            ...base,
            id: 'visuel',
            type: 'media_zone',
            x: 0,
            y: 0,
            width: 1080,
            height: 1400,
            z_index: 1,
            props: { content_ref: 'portrait-image', fit: 'cover' },
          },
          text('titre', 60, 1450, 960, 240, 'Nouvelle collection\nautomne', 88),
          clock('horloge', 560, 1740, 460, 140, 72),
        ]),
      ],
      root: 'main',
      needsVideo: false,
    },
    {
      id: 'led-2688x672',
      title: 'Bandeau LED 2688×672 avec playlist en fondu',
      display: { width: 2688, height: 672, orientation: 0 },
      contents: [
        image('slide-1', ASSETS.banner, 'cover'),
        image('slide-2', ASSETS.landscape, 'cover'),
        {
          id: 'boucle',
          type: 'playlist',
          playlist_version_id: '00000000-0000-4000-8000-00000000d001',
          transition: 'fade',
          items: [
            { content_ref: 'slide-1', duration_ms: 4000 },
            { content_ref: 'slide-2', duration_ms: 4000 },
          ],
        },
        composition('main', 2688, 672, [
          {
            ...base,
            id: 'zone',
            type: 'playlist_zone',
            x: 0,
            y: 0,
            width: 1600,
            height: 672,
            z_index: 1,
            props: { content_ref: 'boucle' },
          },
          text('titre', 1660, 40, 980, 380, 'Soldes −30 %\njusqu’à dimanche', 110),
          clock('horloge', 2100, 480, 540, 150, 96),
        ]),
      ],
      root: 'main',
      needsVideo: false,
    },
    {
      id: 'led-3840x480',
      title: 'Bandeau LED très large 3840×480',
      display: { width: 3840, height: 480, orientation: 0 },
      contents: [
        image('bandeau', ASSETS.banner, 'cover'),
        composition('main', 3840, 480, [
          {
            ...base,
            id: 'fond',
            type: 'media_zone',
            x: 0,
            y: 0,
            width: 3840,
            height: 480,
            z_index: 1,
            props: { content_ref: 'bandeau', fit: 'cover' },
          },
          text(
            'message',
            80,
            40,
            3000,
            400,
            'Parking visiteurs niveau −1 · Accueil ouvert 8 h – 19 h',
            150,
          ),
        ]),
      ],
      root: 'main',
      needsVideo: false,
    },
    {
      id: 'led-768x2304',
      title: 'Totem LED vertical 768×2304',
      display: { width: 768, height: 2304, orientation: 0 },
      contents: [image('totem', ASSETS.portrait, 'contain')],
      root: 'totem',
      needsVideo: false,
    },
  ];
}
