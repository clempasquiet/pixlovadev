import { parseInstantMicros } from './instant.js';
import {
  COMMAND_ENVELOPE_TYPE,
  type CommandPayload,
  type PlayerCapabilities,
} from './schemas/index.js';
import { verifyEnvelope, type EnvelopeErrorCode, type TrustStore } from './signature.js';
import { describeErrors, validator } from './validate.js';

/** Durée de validité maximale d’une commande. */
export const MAX_COMMAND_LIFETIME_MICROS = 24 * 3600 * 1_000_000;

export type CommandVerification =
  | { ok: true; command: CommandPayload; commandHash: string }
  | {
      ok: false;
      code: EnvelopeErrorCode | 'SCHEMA_INVALID' | 'SEMANTIC_INVALID';
      reason?: 'COMMAND_WINDOW_INVALID';
      detail: string;
    };

export function verifyCommand(
  raw: string,
  trust: TrustStore,
  maxBytes = 64 * 1024,
): CommandVerification {
  const envelope = verifyEnvelope(raw, COMMAND_ENVELOPE_TYPE, trust, maxBytes);
  if (!envelope.ok) return envelope;
  const validate = validator('command-payload.json');
  if (!validate(envelope.envelope.payload)) {
    return { ok: false, code: 'SCHEMA_INVALID', detail: describeErrors(validate.errors) };
  }
  const command = envelope.envelope.payload as unknown as CommandPayload;
  const issued = parseInstantMicros(command.issued_at);
  const expires = parseInstantMicros(command.expires_at);
  if (
    issued === null ||
    expires === null ||
    !(issued < expires) ||
    expires - issued > MAX_COMMAND_LIFETIME_MICROS
  ) {
    return {
      ok: false,
      code: 'SEMANTIC_INVALID',
      reason: 'COMMAND_WINDOW_INVALID',
      detail: 'fenêtre issued_at/expires_at invalide',
    };
  }
  return { ok: true, command, commandHash: envelope.envelope.payloadHash };
}

export interface CommandContext {
  organization_id: string;
  player_id: string;
  /** Génération d’affectation courante par Display. */
  assignments: ReadonlyMap<string, string>;
  /** Commandes déjà inscrites durablement : identifiant → empreinte. */
  seen: ReadonlyMap<string, string>;
  capabilities: Pick<PlayerCapabilities, 'reboot_host' | 'screenshot'>;
}

export type CommandRejection =
  | 'WRONG_ORGANIZATION'
  | 'WRONG_PLAYER'
  | 'COMMAND_CONFLICT'
  | 'COMMAND_EXPIRED'
  | 'WRONG_DISPLAY'
  | 'STALE_ASSIGNMENT'
  | 'CAPABILITY_UNSUPPORTED';

export type CommandDecision =
  | { decision: 'execute' }
  | { decision: 'duplicate' }
  | { decision: 'reject'; code: CommandRejection };

/**
 * Décision d’exécution (PROTO-008, SEC-010). Un doublon renvoie le résultat connu
 * sans ré-exécuter ; un même identifiant au contenu différent est refusé ;
 * une commande expirée n’est jamais lancée.
 */
export function evaluateCommand(
  command: CommandPayload,
  commandHash: string,
  context: CommandContext,
  now: string,
): CommandDecision {
  if (command.organization_id !== context.organization_id) {
    return { decision: 'reject', code: 'WRONG_ORGANIZATION' };
  }
  if (command.player_id !== context.player_id) return { decision: 'reject', code: 'WRONG_PLAYER' };
  const known = context.seen.get(command.command_id);
  if (known !== undefined) {
    return known === commandHash
      ? { decision: 'duplicate' }
      : { decision: 'reject', code: 'COMMAND_CONFLICT' };
  }
  const nowMicros = parseInstantMicros(now);
  if (nowMicros === null) throw new Error(`Instant courant invalide : ${now}`);
  if (nowMicros >= parseInstantMicros(command.expires_at)!) {
    return { decision: 'reject', code: 'COMMAND_EXPIRED' };
  }
  if (command.display_id !== null) {
    const generation = context.assignments.get(command.display_id);
    if (generation === undefined) return { decision: 'reject', code: 'WRONG_DISPLAY' };
    if (generation !== command.assignment_generation) {
      return { decision: 'reject', code: 'STALE_ASSIGNMENT' };
    }
  }
  if (command.type === 'REBOOT_HOST' && context.capabilities.reboot_host !== 'supported') {
    return { decision: 'reject', code: 'CAPABILITY_UNSUPPORTED' };
  }
  if (command.type === 'TAKE_SCREENSHOT' && context.capabilities.screenshot !== 'supported') {
    return { decision: 'reject', code: 'CAPABILITY_UNSUPPORTED' };
  }
  return { decision: 'execute' };
}
