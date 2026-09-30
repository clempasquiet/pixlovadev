import Type, { type Static } from 'typebox';
import { DurationMs, Instant, Strict, Timezone, Uuid } from './common.js';

/**
 * Documents éditoriaux de programmation (PLN-001 à PLN-009, ADR-011) : brouillons validés
 * par ces schémas, figés en versions immuables à la publication. Ils désignent des contenus
 * logiques ; la compilation retient leur dernière version publiée.
 */
export const PLAYLIST_DOCUMENT_VERSION = 1;
export const PROGRAM_DOCUMENT_VERSION = 1;

export const ContentType = Type.Union([
  Type.Literal('media'),
  Type.Literal('composition'),
  Type.Literal('playlist'),
]);
export type ContentType = Static<typeof ContentType>;

export const ContentRef = Type.Object({ type: ContentType, id: Uuid }, Strict);
export type ContentRef = Static<typeof ContentRef>;

/** Élément de playlist : média ou composition (une playlist s’imbrique via une zone). */
export const PlaylistItem = Type.Object(
  {
    id: Uuid,
    content: Type.Object(
      { type: Type.Union([Type.Literal('media'), Type.Literal('composition')]), id: Uuid },
      Strict,
    ),
    /** `null` : durée de la vidéo ou de la composition ; obligatoire pour une image. */
    duration_ms: Type.Union([DurationMs, Type.Null()]),
    enabled: Type.Boolean(),
    valid_from: Type.Union([Instant, Type.Null()]),
    valid_until: Type.Union([Instant, Type.Null()]),
  },
  Strict,
);
export type PlaylistItem = Static<typeof PlaylistItem>;

export const PlaylistDocument = Type.Object(
  {
    schema_version: Type.Literal(PLAYLIST_DOCUMENT_VERSION),
    transition: Type.Union([Type.Literal('cut'), Type.Literal('fade')]),
    items: Type.Array(PlaylistItem, { maxItems: 200 }),
  },
  { ...Strict, title: 'PlaylistDocument' },
);
export type PlaylistDocument = Static<typeof PlaylistDocument>;

export const Target = Type.Union([
  Type.Object({ type: Type.Literal('organization') }, Strict),
  Type.Object({ type: Type.Literal('site'), id: Uuid }, Strict),
  Type.Object({ type: Type.Literal('group'), id: Uuid }, Strict),
  Type.Object({ type: Type.Literal('display'), id: Uuid }, Strict),
]);
export type Target = Static<typeof Target>;

export const Targeting = Type.Object(
  {
    include: Type.Array(Target, { maxItems: 100 }),
    /** Les exclusions priment sur les inclusions (PLN-007). */
    exclude: Type.Array(Target, { maxItems: 100 }),
  },
  Strict,
);
export type Targeting = Static<typeof Targeting>;

const LocalDate = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' });
const LocalTime = Type.String({ pattern: '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$' });
const Weekday = Type.Integer({ minimum: 1, maximum: 7 });

export const ScheduleRuleDocument = Type.Object(
  {
    id: Uuid,
    content: ContentRef,
    /** Bande « planning ordinaire » (PLN-008). */
    priority: Type.Integer({ minimum: 0, maximum: 19 }),
    /** Jours ISO (1 = lundi) du début de l’occurrence. */
    weekdays: Type.Array(Weekday, { minItems: 1, maxItems: 7, uniqueItems: true }),
    start_time: LocalTime,
    /** Une fin inférieure ou égale au début traverse minuit ; `24:00` admis. */
    end_time: LocalTime,
    start_date: Type.Union([LocalDate, Type.Null()]),
    end_date: Type.Union([LocalDate, Type.Null()]),
  },
  Strict,
);
export type ScheduleRuleDocument = Static<typeof ScheduleRuleDocument>;

export const ScheduleExceptionDocument = Type.Object(
  {
    id: Uuid,
    date: LocalDate,
    rule_id: Type.Union([Uuid, Type.Null()]),
    action: Type.Union([Type.Literal('skip'), Type.Literal('replace')]),
    content: Type.Union([ContentRef, Type.Null()]),
  },
  Strict,
);
export type ScheduleExceptionDocument = Static<typeof ScheduleExceptionDocument>;

const ScheduleDocument = Type.Object(
  {
    schema_version: Type.Literal(PROGRAM_DOCUMENT_VERSION),
    kind: Type.Literal('schedule'),
    /** `null` : fuseau effectif de chaque Display (PLN-003). */
    timezone: Type.Union([Timezone, Type.Null()]),
    targets: Targeting,
    rules: Type.Array(ScheduleRuleDocument, { maxItems: 100 }),
    exceptions: Type.Array(ScheduleExceptionDocument, { maxItems: 200 }),
  },
  Strict,
);
const CampaignDocument = Type.Object(
  {
    schema_version: Type.Literal(PROGRAM_DOCUMENT_VERSION),
    kind: Type.Literal('campaign'),
    /** Brouillon : champs incomplets admis ; exigés à la publication. */
    content: Type.Union([ContentRef, Type.Null()]),
    starts_at: Type.Union([Instant, Type.Null()]),
    ends_at: Type.Union([Instant, Type.Null()]),
    priority: Type.Integer({ minimum: 20, maximum: 79 }),
    targets: Targeting,
  },
  Strict,
);
const OverrideDocument = Type.Object(
  {
    schema_version: Type.Literal(PROGRAM_DOCUMENT_VERSION),
    kind: Type.Literal('override'),
    content: ContentRef,
    starts_at: Instant,
    ends_at: Instant,
    /** 80–99 ; 100 : urgence, soumise à une permission explicite. */
    priority: Type.Integer({ minimum: 80, maximum: 100 }),
    targets: Targeting,
  },
  Strict,
);

export const ProgramDocument = Type.Union([ScheduleDocument, CampaignDocument, OverrideDocument], {
  title: 'ProgramDocument',
});
export type ProgramDocument = Static<typeof ProgramDocument>;
export type ScheduleDocument = Extract<ProgramDocument, { kind: 'schedule' }>;
export type CampaignDocument = Extract<ProgramDocument, { kind: 'campaign' }>;
export type OverrideDocument = Extract<ProgramDocument, { kind: 'override' }>;
export type ProgramKind = ProgramDocument['kind'];
