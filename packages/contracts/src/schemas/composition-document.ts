import Type, { type Static } from 'typebox';
import type { QualifiedFontName } from '../fonts.js';
import { Color, DurationMs, Fit, LocalId, PixelSize, Strict, Timezone, Uuid } from './common.js';

/**
 * Document d’**édition** d’une composition (CMP-001, CMP-002, ADR-010). Il référence
 * des médias de la bibliothèque (`media_id`, `null` tant qu’un placeholder n’est pas
 * rempli) et porte des informations d’édition sans effet sur la lecture. Il est converti
 * en document résolu (`composition.json`) par `resolveCompositionDocument`.
 */
export const COMPOSITION_DOCUMENT_VERSION = 1;

const FontName = Type.Union([
  Type.Literal('Inter'),
  Type.Literal('Roboto'),
  Type.Literal('Open Sans'),
  Type.Literal('Montserrat'),
  Type.Literal('Playfair Display'),
  Type.Literal('Roboto Mono'),
]);
// Le schéma et le catalogue des polices restent alignés (vérifié à la compilation).
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const fontsAligned: SameKeys<Static<typeof FontName>, QualifiedFontName> = true;
void fontsAligned;
const Alignment = Type.Union([Type.Literal('left'), Type.Literal('center'), Type.Literal('right')]);
const Volume = Type.Number({ minimum: 0, maximum: 1 });
const MediaRef = Type.Union([Uuid, Type.Null()]);

const ImageProps = Type.Object({ media_id: MediaRef, fit: Fit }, Strict);
const VideoProps = Type.Object(
  {
    media_id: MediaRef,
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
    font_family: FontName,
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
    timezone: Type.Union([Timezone, Type.Null()]),
    locale: Type.String({ pattern: '^[a-z]{2,3}(-[A-Z]{2})?$' }),
    font_family: FontName,
    font_size_px: Type.Integer({ minimum: 1, maximum: 4000 }),
    color: Color,
    alignment: Alignment,
  },
  Strict,
);

function element<K extends string, P extends Type.TSchema>(kind: K, props: P) {
  return Type.Object(
    {
      id: LocalId,
      type: Type.Literal(kind),
      /** Nom affiché dans la liste des calques. */
      name: Type.Optional(Type.String({ maxLength: 80 })),
      /** Clé de placeholder d’un template (logo, nom, couleur principale…). */
      placeholder: Type.Optional(LocalId),
      x: Type.Integer({ minimum: -32767, maximum: 32767 }),
      y: Type.Integer({ minimum: -32767, maximum: 32767 }),
      width: PixelSize,
      height: PixelSize,
      rotation: Type.Number({ minimum: -360, maximum: 360 }),
      z_index: Type.Integer({ minimum: -10000, maximum: 10000 }),
      opacity: Type.Number({ minimum: 0, maximum: 1 }),
      visible: Type.Boolean(),
      locked: Type.Boolean(),
      props,
    },
    Strict,
  );
}

export const DocumentElement = Type.Union([
  element('image', ImageProps),
  element('video', VideoProps),
  element('text', TextProps),
  element('shape', ShapeProps),
  element('qr', QrProps),
  element('clock', ClockProps),
]);
export type DocumentElement = Static<typeof DocumentElement>;

export const CompositionDocument = Type.Object(
  {
    schema_version: Type.Literal(COMPOSITION_DOCUMENT_VERSION),
    canvas: Type.Object({ width: PixelSize, height: PixelSize, background: Color }, Strict),
    elements: Type.Array(DocumentElement, { maxItems: 200 }),
    settings: Type.Object(
      {
        /** Absente : durée empruntée à l’élément de playlist (CMP-004). */
        duration_ms: Type.Optional(DurationMs),
        audio_policy: Type.Union([Type.Literal('muted'), Type.Literal('single_source')]),
      },
      Strict,
    ),
  },
  { ...Strict, title: 'CompositionDocument' },
);
export type CompositionDocument = Static<typeof CompositionDocument>;

export const TemplatePlaceholder = Type.Object(
  {
    key: LocalId,
    type: Type.Union([Type.Literal('text'), Type.Literal('image'), Type.Literal('color')]),
    label: Type.String({ minLength: 1, maxLength: 80 }),
    /** Valeur par défaut (texte ou couleur) ; une image n’a pas de défaut. */
    default: Type.Optional(Type.String({ maxLength: 2000 })),
  },
  Strict,
);
export type TemplatePlaceholder = Static<typeof TemplatePlaceholder>;

export const TEMPLATE_CATEGORIES = [
  'restauration',
  'hotellerie',
  'retail',
  'immobilier',
  'evenementiel',
] as const;

/** Template plateforme (TPL-001) : consultable par tous, instanciable selon les droits. */
export const CompositionTemplate = Type.Object(
  {
    key: LocalId,
    version: Type.Integer({ minimum: 1 }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    category: Type.Union([
      Type.Literal('restauration'),
      Type.Literal('hotellerie'),
      Type.Literal('retail'),
      Type.Literal('immobilier'),
      Type.Literal('evenementiel'),
    ]),
    description: Type.String({ maxLength: 500 }),
    required_features: Type.Array(Type.String({ pattern: '^[a-z][a-z_]{1,40}$' }), {
      maxItems: 10,
    }),
    placeholders: Type.Array(TemplatePlaceholder, { maxItems: 20 }),
    document: CompositionDocument,
  },
  { ...Strict, title: 'CompositionTemplate' },
);
export type CompositionTemplate = Static<typeof CompositionTemplate>;
