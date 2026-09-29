import Type, { type Static } from 'typebox';
import {
  Instant,
  Orientation,
  PixelSize,
  Strict,
  Timezone,
  Uuid,
  VersionString,
} from './common.js';

/**
 * Affectation d’un Display à une sortie de Player (DSP-002, DATA-006).
 * `generation` croît à chaque réaffectation ; une affectation close ne redevient jamais active.
 */
export const DisplayAssignment = Type.Object(
  {
    id: Uuid,
    organization_id: Uuid,
    display_id: Uuid,
    player_id: Uuid,
    player_output_id: Uuid,
    generation: VersionString,
    started_at: Instant,
    ended_at: Type.Union([Instant, Type.Null()]),
  },
  { ...Strict, title: 'DisplayAssignment' },
);
export type DisplayAssignment = Static<typeof DisplayAssignment>;

export const DisplayLifecycle = Type.Union([
  Type.Literal('active'),
  Type.Literal('inactive'),
  Type.Literal('archived'),
]);

/** Écran logique durable (PLY-001/DSP-001, DSP-004). Résolution libre, sans hypothèse 16:9. */
export const Display = Type.Object(
  {
    id: Uuid,
    organization_id: Uuid,
    site_id: Uuid,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    width: PixelSize,
    height: PixelSize,
    orientation: Orientation,
    /** `null` : fuseau hérité du site puis de l’organisation. */
    timezone: Type.Union([Timezone, Type.Null()]),
    lifecycle_status: DisplayLifecycle,
    assignment_generation: VersionString,
    active_assignment: Type.Union([DisplayAssignment, Type.Null()]),
  },
  { ...Strict, title: 'Display' },
);
export type Display = Static<typeof Display>;
