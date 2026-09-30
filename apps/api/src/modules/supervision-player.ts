import { createHash } from 'node:crypto';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Type from 'typebox';
import {
  CommandAckRequest,
  CommandResult,
  PlayerEventBatch,
  ScreenshotUploadRequest,
  StatusPayload,
  formatInstant,
} from '@pixlova/contracts';
import { schema, withTenant, type Transaction } from '@pixlova/db';
import { StorageUnavailableError } from '@pixlova/storage';
import { ApiError } from '../errors.js';
import { rateLimit } from '../http/context.js';
import type { Services } from '../http/services.js';
import { audit } from '../lib/audit.js';
import {
  OUTSTANDING_COMMAND_STATUSES,
  cloudEvent,
  screenshotObjectKey,
} from '../lib/supervision.js';
import { authenticatePlayer, type PlayerContext } from './player-api.js';
import { Strict, Uuid } from './schemas.js';

const UPLOAD_URL_SECONDS = 300;
const TERMINAL = ['success', 'failed', 'rejected', 'unknown', 'expired', 'cancelled'] as const;
const RESULT_SEVERITY = {
  success: 'info',
  failed: 'error',
  rejected: 'warning',
  expired: 'warning',
  unknown: 'warning',
} as const;

type CommandRow = typeof schema.playerCommands.$inferSelect;

function storageError(error: unknown): never {
  if (error instanceof StorageUnavailableError) {
    throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Stockage indisponible.', true);
  }
  throw error;
}

/** Displays affectés à ce Player, actuellement ou par le passé : seuls rattachements admis. */
async function playerDisplays(tx: Transaction, playerId: string): Promise<Set<string>> {
  const rows = await tx
    .selectDistinct({ displayId: schema.displayAssignments.displayId })
    .from(schema.displayAssignments)
    .innerJoin(
      schema.playerOutputs,
      eq(schema.playerOutputs.id, schema.displayAssignments.playerOutputId),
    )
    .where(eq(schema.playerOutputs.playerId, playerId));
  return new Set(rows.map((row) => row.displayId));
}

/** Commande du Player authentifié, verrouillée ; celle d’un autre Player est introuvable. */
async function lockCommand(
  tx: Transaction,
  player: PlayerContext,
  commandId: string,
): Promise<CommandRow> {
  const [command] = await tx
    .select()
    .from(schema.playerCommands)
    .where(
      and(
        eq(schema.playerCommands.id, commandId),
        eq(schema.playerCommands.playerId, player.playerId),
      ),
    )
    .for('update');
  if (!command) throw new ApiError(404, 'COMMAND_NOT_FOUND', 'Commande introuvable.');
  return command;
}

/**
 * Routes Player de supervision (ADR-014, PROTO-007, PROTO-008, PROTO-019, SUP-004). Le
 * Player ne voit que ses propres commandes et captures ; ses événements ne se rattachent
 * qu’aux Displays qui lui ont été affectés.
 */
export function supervisionPlayerRoutes(app: FastifyInstance, services: Services): void {
  /** Lot d’événements : dédupliqué par `(player_id, event_id)`, accusé par identifiant. */
  app.post('/events', { schema: { body: PlayerEventBatch } }, async (request) => {
    const player = await authenticatePlayer(request, services);
    await rateLimit(services, `player-events:${player.playerId}`, 120, 60);
    const body = request.body as PlayerEventBatch;
    const now = services.now();
    return withTenant(services.db, player.organizationId, async (tx) => {
      const displays = await playerDisplays(tx, player.playerId);
      const inserted = await tx
        .insert(schema.timelineEvents)
        .values(
          body.events.map((event) => ({
            organizationId: player.organizationId,
            source: 'player' as const,
            playerId: player.playerId,
            displayId: event.display_id && displays.has(event.display_id) ? event.display_id : null,
            eventId: event.event_id,
            bootId: event.boot_id,
            seq: event.seq,
            assignmentGeneration: event.assignment_generation,
            type: event.type,
            severity: event.severity,
            observedAt: new Date(event.observed_at),
            receivedAt: now,
            payload: event.payload,
          })),
        )
        .onConflictDoNothing({
          target: [schema.timelineEvents.playerId, schema.timelineEvents.eventId],
          where: sql`event_id is not null`,
        })
        .returning({ id: schema.timelineEvents.id });
      // Un lot rejoué (accusé perdu) n’insère rien : ses pertes sont déjà comptées.
      if (body.dropped_count > 0 && inserted.length > 0) {
        await cloudEvent(tx, {
          organizationId: player.organizationId,
          playerId: player.playerId,
          type: 'EVENTS_DROPPED',
          severity: 'warning',
          at: now,
          payload: { count: body.dropped_count },
        });
      }
      return { accepted: body.events.map((event) => event.event_id) };
    });
  });

  /** Statut complet (OBS-003) : un statut plus ancien que celui connu est ignoré. */
  app.post('/status', { schema: { body: StatusPayload } }, async (request, reply) => {
    const player = await authenticatePlayer(request, services);
    await rateLimit(services, `player-status:${player.playerId}`, 60, 60);
    const body = request.body as StatusPayload;
    const now = services.now();
    const observedAt = new Date(body.observed_at);
    const values = {
      statusObservedAt: observedAt,
      statusReceivedAt: now,
      rendererRestarts: body.renderer_restarts,
      diskFreeBytes: body.metrics.disk_free_bytes,
      diskTotalBytes: body.metrics.disk_total_bytes,
      payload: body,
    };
    await withTenant(services.db, player.organizationId, async (tx) => {
      const [stored] = await tx
        .insert(schema.playerStatus)
        .values({ playerId: player.playerId, organizationId: player.organizationId, ...values })
        .onConflictDoUpdate({
          target: schema.playerStatus.playerId,
          set: values,
          setWhere: sql`${schema.playerStatus.statusObservedAt} is null or ${schema.playerStatus.statusObservedAt} <= ${observedAt}`,
        })
        .returning({ playerId: schema.playerStatus.playerId });
      if (!stored) return;
      for (const output of body.outputs) {
        await tx
          .update(schema.playerOutputs)
          .set({ connected: output.connected, lastSeenAt: now })
          .where(
            and(
              eq(schema.playerOutputs.playerId, player.playerId),
              eq(schema.playerOutputs.outputKey, output.output_key),
            ),
          );
      }
    });
    return reply.status(204).send();
  });

  /**
   * Commandes à exécuter : enveloppes signées encore valides. Une commande non récupérée
   * avant son expiration passe `expired` ; une commande récupérée passe `sent`.
   */
  app.get('/commands', async (request) => {
    const player = await authenticatePlayer(request, services);
    const now = services.now();
    return withTenant(services.db, player.organizationId, async (tx) => {
      const expired = await tx
        .update(schema.playerCommands)
        .set({ status: 'expired', completedAt: now, updatedAt: now })
        .where(
          and(
            eq(schema.playerCommands.playerId, player.playerId),
            inArray(schema.playerCommands.status, [...OUTSTANDING_COMMAND_STATUSES]),
            lte(schema.playerCommands.expiresAt, now),
          ),
        )
        .returning();
      for (const command of expired) {
        await cloudEvent(tx, {
          organizationId: player.organizationId,
          playerId: player.playerId,
          displayId: command.displayId,
          type: 'COMMAND_EXPIRED',
          severity: 'warning',
          at: now,
          payload: { command_id: command.id, command_type: command.type },
        });
      }
      const commands = await tx
        .select()
        .from(schema.playerCommands)
        .where(
          and(
            eq(schema.playerCommands.playerId, player.playerId),
            inArray(schema.playerCommands.status, [...OUTSTANDING_COMMAND_STATUSES]),
            gt(schema.playerCommands.expiresAt, now),
          ),
        )
        .orderBy(asc(schema.playerCommands.issuedAt))
        .limit(20)
        .for('update');
      const fresh = commands.filter((c) => c.status === 'pending').map((c) => c.id);
      if (fresh.length > 0) {
        await tx
          .update(schema.playerCommands)
          .set({ status: 'sent', sentAt: now, updatedAt: now })
          .where(inArray(schema.playerCommands.id, fresh));
      }
      return { commands: commands.map((c) => c.envelope) };
    });
  });

  /** ACK : reçue et inscrite durablement par le Player, jamais « réussie ». Idempotent. */
  app.post(
    '/commands/:id/ack',
    { schema: { params: Type.Object({ id: Uuid }, Strict), body: CommandAckRequest } },
    async (request) => {
      const player = await authenticatePlayer(request, services);
      const { id } = request.params as { id: string };
      const now = services.now();
      return withTenant(services.db, player.organizationId, async (tx) => {
        const command = await lockCommand(tx, player, id);
        // Une commande expirée côté cloud a pu être lancée juste avant son échéance.
        const late = command.status === 'expired' && command.sentAt !== null;
        if (command.status !== 'sent' && !late) {
          if (command.status === 'pending' || command.status === 'cancelled') {
            throw new ApiError(409, 'COMMAND_STATE_CONFLICT', 'Commande non distribuée.');
          }
          return { status: command.status };
        }
        await tx
          .update(schema.playerCommands)
          .set({ status: 'acknowledged', acknowledgedAt: now, completedAt: null, updatedAt: now })
          .where(eq(schema.playerCommands.id, id));
        await cloudEvent(tx, {
          organizationId: player.organizationId,
          playerId: player.playerId,
          displayId: command.displayId,
          type: 'COMMAND_ACKNOWLEDGED',
          severity: 'info',
          at: now,
          payload: { command_id: id, command_type: command.type },
        });
        return { status: 'acknowledged' };
      });
    },
  );

  /**
   * Résultat d’exécution (PROTO-008) : accepté une seule fois, du seul Player destinataire.
   * Un résultat identique rejoué est idempotent ; un résultat différent est refusé.
   */
  app.post(
    '/commands/:id/result',
    { schema: { params: Type.Object({ id: Uuid }, Strict), body: CommandResult } },
    async (request) => {
      const player = await authenticatePlayer(request, services);
      const { id } = request.params as { id: string };
      const body = request.body as CommandResult;
      if (body.command_id !== id) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Identifiant de commande incohérent.', false, {
          field: 'command_id',
        });
      }
      const now = services.now();
      return withTenant(services.db, player.organizationId, async (tx) => {
        const command = await lockCommand(tx, player, id);
        const reported = command.acknowledgedAt !== null || command.sentAt !== null;
        if (
          (TERMINAL as readonly string[]).includes(command.status) &&
          command.status !== 'expired'
        ) {
          if (command.status === body.status && command.resultCode === body.code) {
            return { status: command.status };
          }
          throw new ApiError(
            409,
            'COMMAND_RESULT_CONFLICT',
            'Un autre résultat est déjà enregistré.',
          );
        }
        if (command.status === 'expired' && body.status === 'expired') {
          return { status: command.status };
        }
        if (!reported) {
          throw new ApiError(409, 'COMMAND_STATE_CONFLICT', 'Commande non distribuée.');
        }
        await tx
          .update(schema.playerCommands)
          .set({
            status: body.status,
            completedAt: now,
            resultCode: body.code,
            resultDetail: body.detail,
            updatedAt: now,
          })
          .where(eq(schema.playerCommands.id, id));
        await cloudEvent(tx, {
          organizationId: player.organizationId,
          playerId: player.playerId,
          displayId: command.displayId,
          type: 'COMMAND_COMPLETED',
          severity: RESULT_SEVERITY[body.status],
          at: now,
          payload: {
            command_id: id,
            command_type: command.type,
            status: body.status,
            code: body.code,
            finished_at: body.finished_at,
          },
        });
        return { status: body.status };
      });
    },
  );

  /**
   * Session d’envoi d’une capture (SUP-004) : seulement pour une capture demandée à ce
   * Player, non expirée, captures activées, taille bornée. Clé privée construite ici.
   */
  app.post(
    '/screenshots/upload-session',
    { schema: { body: ScreenshotUploadRequest } },
    async (request) => {
      const player = await authenticatePlayer(request, services);
      await rateLimit(services, `player-screenshot:${player.playerId}`, 30, 600);
      const body = request.body as ScreenshotUploadRequest;
      const now = services.now();
      const objectKey = await withTenant(services.db, player.organizationId, async (tx) => {
        const [organization] = await tx
          .select({ enabled: schema.organizations.screenshotsEnabled })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, player.organizationId));
        if (!organization?.enabled) {
          throw new ApiError(403, 'SCREENSHOTS_DISABLED', 'Captures désactivées.');
        }
        const [row] = await tx
          .select({ screenshot: schema.screenshots, command: schema.playerCommands })
          .from(schema.screenshots)
          .innerJoin(
            schema.playerCommands,
            eq(schema.playerCommands.id, schema.screenshots.commandId),
          )
          .where(
            and(
              eq(schema.screenshots.id, body.screenshot_id),
              eq(schema.screenshots.commandId, body.command_id),
              eq(schema.screenshots.playerId, player.playerId),
            ),
          )
          .for('update');
        if (!row) throw new ApiError(404, 'SCREENSHOT_NOT_FOUND', 'Capture non demandée.');
        const { screenshot, command } = row;
        if (
          screenshot.status === 'available' ||
          screenshot.expiresAt <= now ||
          !['sent', 'acknowledged'].includes(command.status)
        ) {
          throw new ApiError(409, 'SCREENSHOT_CLOSED', 'Capture expirée ou déjà reçue.');
        }
        const key = screenshotObjectKey(player.organizationId, screenshot.id);
        if (screenshot.status === 'uploading') {
          try {
            await services.storage.delete(screenshot.objectKey);
          } catch (error) {
            storageError(error);
          }
        }
        await tx
          .update(schema.screenshots)
          .set({
            status: 'uploading',
            objectKey: key,
            sizeBytes: body.size_bytes,
            sha256: body.sha256,
            capturedAt: new Date(body.captured_at),
          })
          .where(eq(schema.screenshots.id, screenshot.id));
        return key;
      });
      let signed;
      try {
        signed = await services.storage.presignPut(objectKey, {
          contentType: body.mime_type,
          contentLength: body.size_bytes,
          expiresInSeconds: UPLOAD_URL_SECONDS,
        });
      } catch (error) {
        storageError(error);
      }
      return {
        upload: { method: 'PUT' as const, url: signed.url, headers: signed.headers },
        expires_at: formatInstant(signed.expiresAt),
      };
    },
  );

  /**
   * Fin d’envoi : taille, empreinte SHA-256 et signature PNG vérifiées sur l’objet reçu.
   * Un objet non conforme est supprimé ; la capture reste en attente d’un nouvel envoi.
   */
  app.post(
    '/screenshots/:id/complete',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const player = await authenticatePlayer(request, services);
      const { id } = request.params as { id: string };
      const now = services.now();
      return withTenant(services.db, player.organizationId, async (tx) => {
        const [screenshot] = await tx
          .select()
          .from(schema.screenshots)
          .where(
            and(eq(schema.screenshots.id, id), eq(schema.screenshots.playerId, player.playerId)),
          )
          .for('update');
        if (!screenshot) throw new ApiError(404, 'SCREENSHOT_NOT_FOUND', 'Capture non demandée.');
        if (screenshot.status === 'available') return { status: 'available' };
        if (screenshot.status !== 'uploading' || screenshot.expiresAt <= now) {
          throw new ApiError(409, 'SCREENSHOT_CLOSED', 'Capture expirée ou non commencée.');
        }
        let bytes: Buffer;
        try {
          const head = await services.storage.head(screenshot.objectKey);
          if (!head) throw new ApiError(422, 'UPLOAD_INCOMPLETE', 'La capture n’a pas été reçue.');
          if (head.size !== screenshot.sizeBytes) {
            await services.storage.delete(screenshot.objectKey);
            throw new ApiError(422, 'UPLOAD_SIZE_MISMATCH', 'Taille reçue différente.');
          }
          const chunks: Buffer[] = [];
          for await (const chunk of await services.storage.read(screenshot.objectKey)) {
            chunks.push(chunk as Buffer);
          }
          bytes = Buffer.concat(chunks);
        } catch (error) {
          if (error instanceof ApiError) throw error;
          storageError(error);
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        if (sha256 !== screenshot.sha256 || !isPng(bytes)) {
          try {
            await services.storage.delete(screenshot.objectKey);
          } catch (error) {
            storageError(error);
          }
          throw new ApiError(422, 'CHECKSUM_MISMATCH', 'Empreinte ou format de capture invalide.');
        }
        await tx
          .update(schema.screenshots)
          .set({
            status: 'available',
            receivedAt: now,
            expiresAt: new Date(
              now.getTime() + services.supervision.screenshotRetentionHours * 3600_000,
            ),
          })
          .where(eq(schema.screenshots.id, id));
        await audit(tx, {
          organizationId: player.organizationId,
          actorType: 'player',
          actorId: player.playerId,
          action: 'screenshot.received',
          targetType: 'screenshot',
          targetId: id,
          result: 'success',
          metadata: { display_id: screenshot.displayId, size_bytes: bytes.length },
        });
        await cloudEvent(tx, {
          organizationId: player.organizationId,
          playerId: player.playerId,
          displayId: screenshot.displayId,
          type: 'SCREENSHOT_RECEIVED',
          severity: 'info',
          at: now,
          payload: { screenshot_id: id },
        });
        return { status: 'available' };
      });
    },
  );
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPng(bytes: Buffer): boolean {
  return bytes.length > PNG_SIGNATURE.length && bytes.subarray(0, 8).equals(PNG_SIGNATURE);
}
