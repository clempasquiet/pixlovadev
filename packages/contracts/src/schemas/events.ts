import Type, { type Static } from 'typebox';
import { Code, Instant, Strict, Uuid, VersionString } from './common.js';

/**
 * Événement journalisé localement puis transmis après reconnexion (PROTO-019).
 * Le cloud ajoute `received_at` et déduplique par `(player_id, event_id)`.
 */
export const PlayerEvent = Type.Object(
  {
    event_id: Uuid,
    boot_id: Uuid,
    seq: Type.Integer({ minimum: 0, maximum: 9_007_199_254_740_991 }),
    observed_at: Instant,
    type: Code,
    severity: Type.Union([
      Type.Literal('info'),
      Type.Literal('warning'),
      Type.Literal('error'),
      Type.Literal('critical'),
    ]),
    display_id: Type.Union([Uuid, Type.Null()]),
    assignment_generation: Type.Union([VersionString, Type.Null()]),
    payload: Type.Record(
      Type.String({ pattern: '^[a-z][a-z0-9_]{0,63}$' }),
      Type.Union([Type.String({ maxLength: 500 }), Type.Number(), Type.Boolean(), Type.Null()]),
      { maxProperties: 32 },
    ),
  },
  Strict,
);
export type PlayerEvent = Static<typeof PlayerEvent>;

export const PlayerEventBatch = Type.Object(
  {
    events: Type.Array(PlayerEvent, { minItems: 1, maxItems: 500 }),
    /** Événements éliminés par le budget local depuis le dernier lot acquitté. */
    dropped_count: Type.Integer({ minimum: 0, maximum: 9_007_199_254_740_991 }),
  },
  { ...Strict, title: 'PlayerEventBatch' },
);
export type PlayerEventBatch = Static<typeof PlayerEventBatch>;
