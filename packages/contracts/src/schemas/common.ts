/**
 * Primitives partagées par tous les contrats (DATA-001, API-003).
 *
 * Les formats sont exprimés par `pattern` plutôt que `format` : les validateurs
 * JSON Schema TypeScript (Ajv) et Rust (jsonschema) n’appliquent pas les mêmes
 * règles de `format`, alors que les expressions régulières ci-dessous restent
 * identiques dans les deux langages (aucun `\d`, aucune assertion arrière).
 */
import Type from 'typebox';

export const SCHEMA_BASE_URI = 'https://schemas.pixlova.com/v1/';

/** UUID en minuscules, forme canonique. */
export const Uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
});

/** Instant RFC 3339 en UTC (`Z` obligatoire), précision maximale à la microseconde. */
export const Instant = Type.String({
  pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$',
});

/** Entier monotone `bigint` sérialisé en chaîne décimale (≤ 2^63−1). */
export const VersionString = Type.String({ pattern: '^(0|[1-9][0-9]{0,18})$' });

export const Sha256Hex = Type.String({ pattern: '^[0-9a-f]{64}$' });

/** Nom de fuseau IANA (`Europe/Paris`, `UTC`). La validité est contrôlée par la base tz du compilateur. */
export const Timezone = Type.String({
  pattern: '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$',
  maxLength: 64,
});

export const MimeType = Type.String({
  pattern: '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$',
  maxLength: 127,
});

/** Dimension en pixels ; les limites qualifiées dépendent des capacités du Player (DSP-004). */
export const PixelSize = Type.Integer({ minimum: 1, maximum: 32767 });

export const Orientation = Type.Union([
  Type.Literal(0),
  Type.Literal(90),
  Type.Literal(180),
  Type.Literal(270),
]);

export const Fit = Type.Union([
  Type.Literal('contain'),
  Type.Literal('cover'),
  Type.Literal('stretch'),
]);

/** Durée en millisecondes entières, strictement positive, bornée à 24 h. */
export const DurationMs = Type.Integer({ minimum: 1, maximum: 86_400_000 });

export const SizeBytes = Type.Integer({ minimum: 0, maximum: 9_007_199_254_740_991 });

/** Couleur `#RRGGBB` ou `#RRGGBBAA`. */
export const Color = Type.String({ pattern: '^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$' });

/** Identifiant local à un document (élément de composition, contenu de manifest). */
export const LocalId = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$' });

/** Code machine en MAJUSCULES. */
export const Code = Type.String({ pattern: '^[A-Z][A-Z0-9_]{1,63}$' });

/** Texte de diagnostic borné ; jamais de secret. */
export const Detail = Type.String({ maxLength: 500 });

/** Capacité tri-état : une absence de mesure n’est ni un succès ni un zéro (WEBPLY-005). */
export const Support = Type.Union([
  Type.Literal('supported'),
  Type.Literal('unsupported'),
  Type.Literal('unknown'),
]);

export const Strict = { additionalProperties: false } as const;
