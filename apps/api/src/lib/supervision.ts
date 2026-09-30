import { randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  COMMAND_ENVELOPE_TYPE,
  canonicalSha256,
  signEnvelope,
  type CommandPayload,
} from '@pixlova/contracts';
import { schema, type Transaction } from '@pixlova/db';
import { ApiError } from '../errors.js';
import type { Services } from '../http/services.js';

type Severity = (typeof schema.TIMELINE_SEVERITIES)[number];
type EventPayload = Record<string, string | number | boolean | null>;

/**
 * Événement de la timeline émis par le cloud (ADR-014) : présence, commandes, incidents.
 * `observed_at` = `received_at` : l’instant est celui du serveur.
 */
export async function cloudEvent(
  tx: Transaction,
  event: {
    organizationId: string;
    playerId?: string | null;
    displayId?: string | null;
    type: string;
    severity: Severity;
    at: Date;
    payload?: EventPayload;
  },
): Promise<void> {
  await tx.insert(schema.timelineEvents).values({
    organizationId: event.organizationId,
    source: 'cloud',
    playerId: event.playerId ?? null,
    displayId: event.displayId ?? null,
    type: event.type,
    severity: event.severity,
    observedAt: event.at,
    receivedAt: event.at,
    payload: event.payload ?? {},
  });
}

/** Commandes qu’un Player doit encore récupérer ou confirmer. */
export const OUTSTANDING_COMMAND_STATUSES = ['pending', 'sent'] as const;

export async function outstandingCommandCount(
  tx: Transaction,
  playerId: string,
  now: Date,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.playerCommands)
    .where(
      and(
        eq(schema.playerCommands.playerId, playerId),
        inArray(schema.playerCommands.status, [...OUTSTANDING_COMMAND_STATUSES]),
        gt(schema.playerCommands.expiresAt, now),
      ),
    );
  return Math.min(row?.n ?? 0, 1000);
}

/** Clé privée d’une capture : jeton aléatoire par envoi, jamais fournie par le Player. */
export function screenshotObjectKey(organizationId: string, screenshotId: string): string {
  return `org/${organizationId}/screenshots/${screenshotId}-${randomBytes(8).toString('hex')}.png`;
}

/**
 * Signe une commande avec la clé de commande (distincte de la clé des manifests). Sans
 * clé configurée, les commandes distantes sont indisponibles.
 */
export function signCommand(
  services: Services,
  payload: CommandPayload,
): { envelope: string; payloadHash: string } {
  const key = services.supervision.commandKey;
  if (!key) {
    throw new ApiError(
      503,
      'COMMANDS_UNAVAILABLE',
      'Les commandes distantes ne sont pas configurées sur ce serveur.',
    );
  }
  const envelope = signEnvelope(COMMAND_ENVELOPE_TYPE, key.kid, payload, key.secretKey);
  return { envelope: JSON.stringify(envelope), payloadHash: canonicalSha256(payload) };
}
