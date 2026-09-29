import Type, { type Static } from 'typebox';
import {
  DurationMs,
  Fit,
  Instant,
  LocalId,
  MimeType,
  Orientation,
  PixelSize,
  Sha256Hex,
  SizeBytes,
  Strict,
  Timezone,
  Uuid,
  VersionString,
} from './common.js';
import { Composition } from './composition.js';

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_ENVELOPE_TYPE = 'SIGNAGE_MANIFEST_V1';

export const ManifestAsset = Type.Object(
  {
    id: Uuid,
    variant: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }),
    mime_type: MimeType,
    size_bytes: SizeBytes,
    sha256: Sha256Hex,
  },
  Strict,
);
export type ManifestAsset = Static<typeof ManifestAsset>;

const MediaContent = Type.Object(
  {
    id: LocalId,
    type: Type.Literal('media'),
    media_kind: Type.Union([Type.Literal('image'), Type.Literal('video')]),
    asset_id: Uuid,
    duration_ms: DurationMs,
    fit: Fit,
    muted: Type.Boolean(),
  },
  Strict,
);
const CompositionContent = Type.Object(
  {
    id: LocalId,
    type: Type.Literal('composition'),
    composition_version_id: Uuid,
    duration_ms: DurationMs,
    document: Composition,
  },
  Strict,
);
const PlaylistContent = Type.Object(
  {
    id: LocalId,
    type: Type.Literal('playlist'),
    playlist_version_id: Uuid,
    transition: Type.Union([Type.Literal('cut'), Type.Literal('fade')]),
    /** Séquence déjà filtrée par le compilateur (PROTO-016) ; le Player ne réévalue pas les validités. */
    items: Type.Array(Type.Object({ content_ref: LocalId, duration_ms: DurationMs }, Strict), {
      minItems: 1,
      maxItems: 500,
    }),
  },
  Strict,
);
export const ManifestContent = Type.Union([MediaContent, CompositionContent, PlaylistContent]);
export type ManifestContent = Static<typeof ManifestContent>;

export const SourceType = Type.Union([
  Type.Literal('schedule'),
  Type.Literal('campaign'),
  Type.Literal('override'),
  Type.Literal('emergency'),
]);
export type SourceType = Static<typeof SourceType>;

export const TimelineEntry = Type.Object(
  {
    /** Intervalle semi-ouvert `[starts_at, ends_at)` (PROTO-018). */
    starts_at: Instant,
    ends_at: Instant,
    content_ref: LocalId,
    source: Type.Object(
      {
        type: SourceType,
        id: Uuid,
        priority: Type.Integer({ minimum: 0, maximum: 100 }),
        revision: VersionString,
      },
      Strict,
    ),
  },
  Strict,
);
export type TimelineEntry = Static<typeof TimelineEntry>;

export const ManifestPayload = Type.Object(
  {
    schema_version: Type.Literal(MANIFEST_SCHEMA_VERSION),
    manifest_id: Uuid,
    organization_id: Uuid,
    display_id: Uuid,
    player_id: Uuid,
    version: VersionString,
    assignment_generation: VersionString,
    config_revision: VersionString,
    generated_at: Instant,
    valid_from: Instant,
    activate_before: Instant,
    schedule_until: Instant,
    display: Type.Object(
      {
        width: PixelSize,
        height: PixelSize,
        orientation: Orientation,
        fit: Fit,
        timezone: Timezone,
      },
      Strict,
    ),
    required_capabilities: Type.Object(
      {
        render_schema: Type.Integer({ minimum: 1, maximum: 1000 }),
        image_types: Type.Array(MimeType, { maxItems: 32 }),
        video_profiles: Type.Array(Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,63}$' }), {
          maxItems: 32,
        }),
      },
      Strict,
    ),
    assets: Type.Array(ManifestAsset, { maxItems: 5000 }),
    contents: Type.Array(ManifestContent, { maxItems: 5000 }),
    timeline: Type.Array(TimelineEntry, { maxItems: 20000 }),
    fallback: Type.Object(
      {
        /** `null` : écran local d’attente explicite (PLN-010). */
        content_ref: Type.Union([LocalId, Type.Null()]),
        after_schedule: Type.Union([Type.Literal('play_fallback'), Type.Literal('standby_screen')]),
      },
      Strict,
    ),
  },
  { ...Strict, title: 'ManifestPayload' },
);
export type ManifestPayload = Static<typeof ManifestPayload>;

/** En-tête protégé commun aux enveloppes signées (PROTO-011). */
export function protectedHeader<T extends string>(type: T) {
  return Type.Object(
    {
      type: Type.Literal(type),
      alg: Type.Literal('Ed25519'),
      kid: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{2,63}$' }),
    },
    Strict,
  );
}

/** Signature Ed25519 encodée en base64url sans remplissage (64 octets → 86 caractères). */
export const SignatureB64u = Type.String({ pattern: '^[A-Za-z0-9_-]{85}[AQgw]$' });

export const SignedManifest = Type.Object(
  {
    protected: protectedHeader(MANIFEST_ENVELOPE_TYPE),
    payload: ManifestPayload,
    signature: SignatureB64u,
  },
  { ...Strict, title: 'SignedManifest' },
);
export type SignedManifest = Static<typeof SignedManifest>;
