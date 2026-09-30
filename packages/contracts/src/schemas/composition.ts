import Type, { type Static } from 'typebox';
import { Color, DurationMs, Fit, LocalId, PixelSize, Strict, Timezone, Uuid } from './common.js';

/**
 * Document de composition **résolu** (PROTO-015), consommé par le moteur de rendu
 * et embarqué dans les manifests. Les références de médias y désignent des assets
 * (`asset_id`) et des contenus du manifest (`content_ref`) ; le document d’édition
 * du créateur, qui référence des médias de bibliothèque, relève de L04.
 *
 * Coordonnées et dimensions en pixels entiers : aucun arrondi n’est laissé au Player
 * (REN-002). Aucun script ni HTML n’est accepté.
 */
export const COMPOSITION_SCHEMA_VERSION = 1;

const FontFamily = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$' });
const Alignment = Type.Union([Type.Literal('left'), Type.Literal('center'), Type.Literal('right')]);
const Volume = Type.Number({ minimum: 0, maximum: 1 });

const ImageProps = Type.Object({ asset_id: Uuid, fit: Fit }, Strict);
const VideoProps = Type.Object(
  {
    asset_id: Uuid,
    fit: Fit,
    muted: Type.Boolean(),
    volume: Volume,
    loop: Type.Boolean(),
    start_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400_000 })),
    end_ms: Type.Optional(DurationMs),
  },
  Strict,
);
const TextProps = Type.Object(
  {
    text: Type.String({ maxLength: 2000 }),
    font_family: FontFamily,
    font_size_px: Type.Integer({ minimum: 1, maximum: 4000 }),
    font_weight: Type.Integer({ minimum: 100, maximum: 900, multipleOf: 100 }),
    color: Color,
    alignment: Alignment,
    vertical_alignment: Type.Optional(
      Type.Union([Type.Literal('top'), Type.Literal('middle'), Type.Literal('bottom')]),
    ),
    line_height: Type.Optional(Type.Number({ minimum: 0.5, maximum: 4 })),
    letter_spacing_px: Type.Optional(Type.Number({ minimum: -100, maximum: 1000 })),
  },
  Strict,
);
const ShapeProps = Type.Object(
  {
    shape: Type.Union([Type.Literal('rectangle'), Type.Literal('ellipse')]),
    fill: Type.Union([Color, Type.Null()]),
    stroke: Type.Union([Color, Type.Null()]),
    stroke_width_px: Type.Integer({ minimum: 0, maximum: 1000 }),
    corner_radius_px: Type.Optional(Type.Integer({ minimum: 0, maximum: 16383 })),
  },
  Strict,
);
const QrProps = Type.Object(
  {
    /** Charge utile déjà encodée (URL, texte, `mailto:`, `WIFI:`) ; validée à l’édition. */
    data: Type.String({ minLength: 1, maxLength: 1000 }),
    foreground: Color,
    background: Color,
    error_correction: Type.Union([
      Type.Literal('L'),
      Type.Literal('M'),
      Type.Literal('Q'),
      Type.Literal('H'),
    ]),
  },
  Strict,
);
const ClockProps = Type.Object(
  {
    format: Type.Union([
      Type.Literal('time_24h'),
      Type.Literal('time_24h_seconds'),
      Type.Literal('time_12h'),
      Type.Literal('date_short'),
      Type.Literal('date_long'),
      Type.Literal('date_time_24h'),
    ]),
    /** `null` : fuseau du Display. */
    timezone: Type.Union([Timezone, Type.Null()]),
    locale: Type.String({ pattern: '^[a-z]{2,3}(-[A-Z]{2})?$' }),
    font_family: FontFamily,
    font_size_px: Type.Integer({ minimum: 1, maximum: 4000 }),
    color: Color,
    alignment: Alignment,
  },
  Strict,
);
const MediaZoneProps = Type.Object({ content_ref: LocalId, fit: Fit }, Strict);
const PlaylistZoneProps = Type.Object({ content_ref: LocalId }, Strict);

function element<K extends string, P extends Type.TSchema>(kind: K, props: P) {
  return Type.Object(
    {
      id: LocalId,
      type: Type.Literal(kind),
      x: Type.Integer({ minimum: -32767, maximum: 32767 }),
      y: Type.Integer({ minimum: -32767, maximum: 32767 }),
      width: PixelSize,
      height: PixelSize,
      /** Degrés, sens horaire, autour du centre de l’élément. */
      rotation: Type.Number({ minimum: -360, maximum: 360 }),
      z_index: Type.Integer({ minimum: -10000, maximum: 10000 }),
      opacity: Type.Number({ minimum: 0, maximum: 1 }),
      visible: Type.Boolean(),
      /** État d’édition sans effet sur la lecture. */
      locked: Type.Boolean(),
      props,
    },
    Strict,
  );
}

export const CompositionElement = Type.Union([
  element('image', ImageProps),
  element('video', VideoProps),
  element('text', TextProps),
  element('shape', ShapeProps),
  element('qr', QrProps),
  element('clock', ClockProps),
  element('media_zone', MediaZoneProps),
  element('playlist_zone', PlaylistZoneProps),
]);
export type CompositionElement = Static<typeof CompositionElement>;

export const Composition = Type.Object(
  {
    schema_version: Type.Literal(COMPOSITION_SCHEMA_VERSION),
    canvas: Type.Object({ width: PixelSize, height: PixelSize, background: Color }, Strict),
    elements: Type.Array(CompositionElement, { maxItems: 200 }),
    settings: Type.Object(
      {
        /** Absente : durée empruntée à l’élément de playlist (CMP-004). */
        duration_ms: Type.Optional(DurationMs),
        audio_policy: Type.Union([Type.Literal('muted'), Type.Literal('single_source')]),
      },
      Strict,
    ),
  },
  { ...Strict, title: 'Composition' },
);
export type Composition = Static<typeof Composition>;
