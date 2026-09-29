import Type, { type Static } from 'typebox';
import { Code, Detail, Instant, Strict, Uuid, VersionString } from './common.js';
import { protectedHeader, SignatureB64u } from './manifest.js';

export const COMMAND_ENVELOPE_TYPE = 'SIGNAGE_COMMAND_V1';

/** Commandes V1 (PROTO-007). Aucune commande shell ni terminal libre (SUP-005). */
export const COMMAND_TYPES = [
  'FORCE_SYNC',
  'RELOAD_CONTENT',
  'GET_STATUS',
  'TAKE_SCREENSHOT',
  'RESTART_RENDERER',
  'CLEAR_UNUSED_CACHE',
  'UPDATE_PLAYER',
  'ROLLBACK_PLAYER',
  'REBOOT_HOST',
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

const Empty = Type.Object({}, Strict);

function command<K extends CommandType, P extends Type.TSchema>(
  kind: K,
  params: P,
  displayScoped: boolean,
) {
  return Type.Object(
    {
      command_id: Uuid,
      organization_id: Uuid,
      player_id: Uuid,
      display_id: displayScoped ? Uuid : Type.Null(),
      assignment_generation: displayScoped ? VersionString : Type.Null(),
      type: Type.Literal(kind),
      issued_at: Instant,
      expires_at: Instant,
      params,
    },
    Strict,
  );
}

export const CommandPayload = Type.Union(
  [
    command('FORCE_SYNC', Empty, false),
    command('RELOAD_CONTENT', Empty, true),
    command('GET_STATUS', Empty, false),
    command('TAKE_SCREENSHOT', Type.Object({ screenshot_id: Uuid }, Strict), true),
    command('RESTART_RENDERER', Empty, false),
    command('CLEAR_UNUSED_CACHE', Empty, false),
    command('UPDATE_PLAYER', Type.Object({ release_id: Uuid }, Strict), false),
    command('ROLLBACK_PLAYER', Empty, false),
    command('REBOOT_HOST', Empty, false),
  ],
  { title: 'CommandPayload' },
);
export type CommandPayload = Static<typeof CommandPayload>;

export const SignedCommand = Type.Object(
  {
    protected: protectedHeader(COMMAND_ENVELOPE_TYPE),
    payload: CommandPayload,
    signature: SignatureB64u,
  },
  { ...Strict, title: 'SignedCommand' },
);
export type SignedCommand = Static<typeof SignedCommand>;

/**
 * Résultat d’exécution (PROTO-008). `unknown` couvre un effet non vérifiable
 * après crash (par exemple un reboot lancé sans confirmation par boot ID).
 */
export const CommandResult = Type.Object(
  {
    command_id: Uuid,
    status: Type.Union([
      Type.Literal('success'),
      Type.Literal('failed'),
      Type.Literal('rejected'),
      Type.Literal('expired'),
      Type.Literal('unknown'),
    ]),
    finished_at: Instant,
    code: Type.Union([Code, Type.Null()]),
    detail: Type.Union([Detail, Type.Null()]),
  },
  { ...Strict, title: 'CommandResult' },
);
export type CommandResult = Static<typeof CommandResult>;
