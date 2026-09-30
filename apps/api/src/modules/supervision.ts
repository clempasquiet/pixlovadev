import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Type from 'typebox';
import {
  COMMAND_TYPES,
  formatInstant,
  type CommandPayload,
  type CommandType,
  type PlayerCapabilities,
  type StatusPayload,
} from '@pixlova/contracts';
import { schema, withTenant, type Transaction } from '@pixlova/db';
import { StorageUnavailableError } from '@pixlova/storage';
import { ApiError } from '../errors.js';
import {
  authorize,
  rateLimit,
  requestMeta,
  requireMember,
  type MemberContext,
} from '../http/context.js';
import type { Services } from '../http/services.js';
import { audit } from '../lib/audit.js';
import { idempotencyScope, idempotent } from '../lib/idempotency.js';
import { cloudEvent, screenshotObjectKey, signCommand } from '../lib/supervision.js';
import { activeAssignments, presence, siteCondition, visibleSites } from './fleet.js';
import { Strict, Uuid } from './schemas.js';

/** Types refusés tant que la distribution des releases n’existe pas (ADR-014). */
const NOT_AVAILABLE: readonly CommandType[] = ['UPDATE_PLAYER', 'ROLLBACK_PLAYER'];
const DISPLAY_SCOPED: readonly CommandType[] = ['RELOAD_CONTENT', 'TAKE_SCREENSHOT'];
const MAX_TTL_SECONDS = 24 * 3600;
const SCREENSHOT_URL_SECONDS = 60;
const CAPTURE_NOTICE = 'Image du renderer : ne prouve pas que l’écran est allumé ou visible.';

type CommandRow = typeof schema.playerCommands.$inferSelect;
type PlayerRow = typeof schema.players.$inferSelect;
type StatusRow = typeof schema.playerStatus.$inferSelect;
type HeartbeatDisplay = {
  display_id: string;
  assignment_generation: string;
  manifest_applied_version: string | null;
  playback: string;
};

const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;

function publicCommand(command: CommandRow) {
  return {
    id: command.id,
    player_id: command.playerId,
    display_id: command.displayId,
    assignment_generation: command.assignmentGeneration,
    type: command.type,
    status: command.status,
    requested_by: command.requestedBy,
    issued_at: command.issuedAt.toISOString(),
    expires_at: command.expiresAt.toISOString(),
    sent_at: iso(command.sentAt),
    acknowledged_at: iso(command.acknowledgedAt),
    completed_at: iso(command.completedAt),
    result_code: command.resultCode,
    result_detail: command.resultDetail,
  };
}

function publicScreenshot(
  screenshot: typeof schema.screenshots.$inferSelect,
  commandStatus: string | null,
) {
  return {
    id: screenshot.id,
    display_id: screenshot.displayId,
    player_id: screenshot.playerId,
    command_id: screenshot.commandId,
    command_status: commandStatus,
    status: screenshot.status,
    size_bytes: screenshot.status === 'available' ? screenshot.sizeBytes : null,
    captured_at: screenshot.status === 'available' ? iso(screenshot.capturedAt) : null,
    received_at: iso(screenshot.receivedAt),
    expires_at: screenshot.expiresAt.toISOString(),
    requested_by: screenshot.requestedBy,
    created_at: screenshot.createdAt.toISOString(),
    notice: CAPTURE_NOTICE,
  };
}

function capabilitiesOf(player: PlayerRow): Partial<PlayerCapabilities> {
  return player.capabilities as Partial<PlayerCapabilities>;
}

async function loadPlayer(tx: Transaction, id: string, lock = false): Promise<PlayerRow> {
  const query = tx
    .select()
    .from(schema.players)
    .where(and(eq(schema.players.id, id), isNull(schema.players.deletedAt)));
  const [player] = lock ? await query.for('update') : await query;
  if (!player) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Player introuvable.');
  return player;
}

async function loadDisplay(tx: Transaction, id: string) {
  const [display] = await tx
    .select()
    .from(schema.displays)
    .where(and(eq(schema.displays.id, id), isNull(schema.displays.deletedAt)));
  if (!display) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Display introuvable.');
  return display;
}

async function screenshotsEnabled(tx: Transaction, organizationId: string): Promise<boolean> {
  const [row] = await tx
    .select({ enabled: schema.organizations.screenshotsEnabled })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId));
  return row?.enabled ?? false;
}

/** Génération courante du Display sur l’une des sorties de ce Player, sinon `null`. */
async function currentGeneration(
  tx: Transaction,
  playerId: string,
  displayId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ generation: schema.displayAssignments.generation })
    .from(schema.displayAssignments)
    .innerJoin(
      schema.playerOutputs,
      eq(schema.playerOutputs.id, schema.displayAssignments.playerOutputId),
    )
    .where(
      and(
        eq(schema.displayAssignments.displayId, displayId),
        isNull(schema.displayAssignments.endedAt),
        eq(schema.playerOutputs.playerId, playerId),
      ),
    );
  return row ? String(row.generation) : null;
}

/**
 * Crée, signe et enregistre une commande (SUP-005, PROTO-007). La demande est auditée et
 * inscrite dans la timeline. Les contrôles de permission précèdent l’appel.
 */
async function issueCommand(
  tx: Transaction,
  services: Services,
  member: MemberContext,
  input: {
    player: PlayerRow;
    type: CommandType;
    displayId: string | null;
    ttlSeconds: number;
    params: Record<string, string>;
    permission: string;
  },
  meta: { requestId: string; ip: string | null },
): Promise<CommandRow> {
  const { player, type } = input;
  if (player.lifecycleStatus !== 'paired') {
    throw new ApiError(409, 'PLAYER_NOT_PAIRED', 'Ce Player est révoqué ou désactivé.');
  }
  let generation: string | null = null;
  if (DISPLAY_SCOPED.includes(type)) {
    if (!input.displayId) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Display requis pour cette commande.', false, {
        field: 'display_id',
      });
    }
    generation = await currentGeneration(tx, player.id, input.displayId);
    if (!generation) {
      throw new ApiError(409, 'DISPLAY_NOT_ASSIGNED', 'Ce Display n’est pas affecté à ce Player.');
    }
  } else if (input.displayId) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Cette commande vise le Player entier.', false, {
      field: 'display_id',
    });
  }
  const now = services.now();
  const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000);
  const id = randomUUID();
  const payload = {
    command_id: id,
    organization_id: member.organizationId,
    player_id: player.id,
    display_id: generation ? input.displayId : null,
    assignment_generation: generation,
    type,
    issued_at: formatInstant(now),
    expires_at: formatInstant(expiresAt),
    params: input.params,
  } as CommandPayload;
  const signed = signCommand(services, payload);
  const [command] = await tx
    .insert(schema.playerCommands)
    .values({
      id,
      organizationId: member.organizationId,
      playerId: player.id,
      displayId: payload.display_id,
      assignmentGeneration: generation,
      type,
      params: input.params,
      envelope: signed.envelope,
      payloadHash: signed.payloadHash,
      requestedBy: member.auth.user.id,
      issuedAt: now,
      expiresAt,
    })
    .returning();
  await audit(tx, {
    organizationId: member.organizationId,
    actorType: 'user',
    actorId: member.auth.user.id,
    action: 'player.command_requested',
    permission: input.permission,
    targetType: 'player',
    targetId: player.id,
    result: 'success',
    metadata: {
      command_id: id,
      type,
      display_id: payload.display_id,
      ttl_seconds: input.ttlSeconds,
    },
    ...meta,
  });
  await cloudEvent(tx, {
    organizationId: member.organizationId,
    playerId: player.id,
    displayId: payload.display_id,
    type: 'COMMAND_REQUESTED',
    severity: 'info',
    at: now,
    payload: { command_id: id, command_type: type },
  });
  return command!;
}

/** Lecture déclarée pour ce Display au dernier heartbeat, à la génération courante. */
function playbackOf(status: StatusRow | undefined, displayId: string, generation: string | null) {
  const entry = ((status?.displays ?? []) as HeartbeatDisplay[]).find(
    (d) => d.display_id === displayId,
  );
  if (!entry || entry.assignment_generation !== generation) {
    return { playback: 'unknown', manifest_applied_version: null };
  }
  return { playback: entry.playback, manifest_applied_version: entry.manifest_applied_version };
}

/** Dernier manifest désiré par Display (Player et génération courants) et sa livraison. */
async function desiredManifests(
  tx: Transaction,
  targets: { displayId: string; playerId: string; generation: bigint }[],
) {
  const result = new Map<
    string,
    {
      manifest_id: string;
      version: string;
      state: string | null;
      error_code: string | null;
      detail: string | null;
      updated_at: string | null;
    }
  >();
  if (targets.length === 0) return result;
  const rows = await tx
    .selectDistinctOn(
      [
        schema.manifests.displayId,
        schema.manifests.playerId,
        schema.manifests.assignmentGeneration,
      ],
      {
        manifest: schema.manifests,
        delivery: schema.manifestDeliveries,
      },
    )
    .from(schema.manifests)
    .leftJoin(
      schema.manifestDeliveries,
      and(
        eq(schema.manifestDeliveries.manifestId, schema.manifests.id),
        eq(schema.manifestDeliveries.playerId, schema.manifests.playerId),
      ),
    )
    .where(
      inArray(
        schema.manifests.displayId,
        targets.map((t) => t.displayId),
      ),
    )
    .orderBy(
      schema.manifests.displayId,
      schema.manifests.playerId,
      schema.manifests.assignmentGeneration,
      desc(schema.manifests.version),
    );
  for (const target of targets) {
    const row = rows.find(
      (r) =>
        r.manifest.displayId === target.displayId &&
        r.manifest.playerId === target.playerId &&
        r.manifest.assignmentGeneration === target.generation,
    );
    if (!row) continue;
    result.set(target.displayId, {
      manifest_id: row.manifest.id,
      version: String(row.manifest.version),
      state: row.delivery?.state ?? null,
      error_code: row.delivery?.errorCode ?? null,
      detail: row.delivery?.detail ?? null,
      updated_at: iso(row.delivery?.updatedAt),
    });
  }
  return result;
}

// Paramètres de requête reçus en texte : aucune coercition implicite (API-003).
const TimelineQuery = Type.Object(
  {
    before: Type.Optional(
      Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?Z$' }),
    ),
    limit: Type.Optional(Type.String({ pattern: '^(?:[1-9][0-9]?|1[0-9]{2}|200)$' })),
  },
  Strict,
);

interface TimelineEntry {
  source: 'player' | 'cloud' | 'delivery' | 'assignment';
  type: string;
  severity: string;
  observed_at: string;
  received_at: string | null;
  player_id: string | null;
  payload: Record<string, unknown>;
}

export function supervisionRoutes(app: FastifyInstance, services: Services): void {
  // --- Commandes (SUP-005, PROTO-007, PROTO-008) -----------------------------

  app.post(
    '/players/:id/commands',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object(
          {
            type: Type.Union(COMMAND_TYPES.map((t) => Type.Literal(t))),
            display_id: Type.Optional(Type.Union([Uuid, Type.Null()])),
            ttl_seconds: Type.Optional(Type.Integer({ minimum: 30, maximum: MAX_TTL_SECONDS })),
          },
          Strict,
        ),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const body = request.body as {
        type: CommandType;
        display_id?: string | null;
        ttl_seconds?: number;
      };
      const scope = idempotencyScope(
        request,
        member.organizationId,
        member.auth.user.id,
        'players.command',
      );
      const result = await withTenant(services.db, member.organizationId, async (tx) => {
        const player = await loadPlayer(tx, id, true);
        authorize(member, 'player.command', { siteId: player.siteId });
        if (body.type === 'REBOOT_HOST') {
          authorize(member, 'player.command.disruptive', { siteId: player.siteId });
        }
        return idempotent(tx, scope, async () => {
          await rateLimit(services, `commands:org:${member.organizationId}`, 120, 600);
          if (NOT_AVAILABLE.includes(body.type)) {
            throw new ApiError(
              422,
              'COMMAND_NOT_AVAILABLE',
              'Mises à jour et retours arrière distants indisponibles dans cette version.',
            );
          }
          if (body.type === 'TAKE_SCREENSHOT') {
            throw new ApiError(
              422,
              'COMMAND_NOT_AVAILABLE',
              'Demandez une capture depuis la fiche du Display.',
            );
          }
          if (body.type === 'REBOOT_HOST' && capabilitiesOf(player).reboot_host !== 'supported') {
            throw new ApiError(
              422,
              'CAPABILITY_UNSUPPORTED',
              'Ce Player ne déclare pas le redémarrage.',
            );
          }
          const command = await issueCommand(
            tx,
            services,
            member,
            {
              player,
              type: body.type,
              displayId: body.display_id ?? null,
              ttlSeconds: body.ttl_seconds ?? services.supervision.commandTtlSeconds,
              params: {},
              permission:
                body.type === 'REBOOT_HOST' ? 'player.command.disruptive' : 'player.command',
            },
            requestMeta(request),
          );
          return { status: 201, body: publicCommand(command) };
        });
      });
      return reply.status(result.status).send(result.body);
    },
  );

  app.get(
    '/players/:id/commands',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      return withTenant(services.db, member.organizationId, async (tx) => {
        const player = await loadPlayer(tx, id);
        authorize(member, 'organization.read', { siteId: player.siteId });
        const commands = await tx
          .select()
          .from(schema.playerCommands)
          .where(eq(schema.playerCommands.playerId, id))
          .orderBy(desc(schema.playerCommands.issuedAt))
          .limit(50);
        return {
          commands_available: services.supervision.commandKey !== null,
          items: commands.map(publicCommand),
        };
      });
    },
  );

  /** Annulation : seulement avant sa distribution au Player (état `pending`). */
  app.post(
    '/commands/:id/cancel',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const now = services.now();
      return withTenant(services.db, member.organizationId, async (tx) => {
        const [row] = await tx
          .select({ command: schema.playerCommands, siteId: schema.players.siteId })
          .from(schema.playerCommands)
          .innerJoin(schema.players, eq(schema.players.id, schema.playerCommands.playerId))
          .where(eq(schema.playerCommands.id, id))
          .for('update', { of: schema.playerCommands });
        if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Commande introuvable.');
        authorize(member, 'player.command', { siteId: row.siteId });
        if (row.command.status === 'cancelled') return publicCommand(row.command);
        if (row.command.status !== 'pending') {
          throw new ApiError(
            409,
            'COMMAND_NOT_CANCELLABLE',
            'La commande a déjà été transmise au Player.',
            false,
            { status: row.command.status },
          );
        }
        const [updated] = await tx
          .update(schema.playerCommands)
          .set({ status: 'cancelled', completedAt: now, updatedAt: now })
          .where(eq(schema.playerCommands.id, id))
          .returning();
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'player.command_cancelled',
          permission: 'player.command',
          targetType: 'player',
          targetId: row.command.playerId,
          result: 'success',
          metadata: { command_id: id, type: row.command.type },
          ...requestMeta(request),
        });
        await cloudEvent(tx, {
          organizationId: member.organizationId,
          playerId: row.command.playerId,
          displayId: row.command.displayId,
          type: 'COMMAND_CANCELLED',
          severity: 'info',
          at: now,
          payload: { command_id: id, command_type: row.command.type },
        });
        return publicCommand(updated!);
      });
    },
  );

  // --- Captures (SUP-004) ------------------------------------------------------

  app.post(
    '/displays/:id/screenshots',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const scope = idempotencyScope(
        request,
        member.organizationId,
        member.auth.user.id,
        'displays.screenshot',
      );
      const result = await withTenant(services.db, member.organizationId, async (tx) => {
        const display = await loadDisplay(tx, id);
        authorize(member, 'screenshots.request', { siteId: display.siteId });
        return idempotent(tx, scope, async () => {
          await rateLimit(services, `screenshots:org:${member.organizationId}`, 30, 600);
          if (!(await screenshotsEnabled(tx, member.organizationId))) {
            throw new ApiError(
              403,
              'SCREENSHOTS_DISABLED',
              'Captures désactivées pour cette organisation.',
            );
          }
          const current = (await activeAssignments(tx, [id])).get(id);
          if (!current) {
            throw new ApiError(
              409,
              'DISPLAY_NOT_ASSIGNED',
              'Ce Display n’est affecté à aucun Player.',
            );
          }
          const player = await loadPlayer(tx, current.player.id, true);
          if (capabilitiesOf(player).screenshot !== 'supported') {
            throw new ApiError(
              422,
              'CAPABILITY_UNSUPPORTED',
              'Ce Player ne permet pas la capture.',
            );
          }
          const screenshotId = randomUUID();
          const command = await issueCommand(
            tx,
            services,
            member,
            {
              player,
              type: 'TAKE_SCREENSHOT',
              displayId: id,
              ttlSeconds: services.supervision.commandTtlSeconds,
              params: { screenshot_id: screenshotId },
              permission: 'screenshots.request',
            },
            requestMeta(request),
          );
          const [screenshot] = await tx
            .insert(schema.screenshots)
            .values({
              id: screenshotId,
              organizationId: member.organizationId,
              playerId: player.id,
              displayId: id,
              commandId: command.id,
              objectKey: screenshotObjectKey(member.organizationId, screenshotId),
              expiresAt: new Date(
                command.expiresAt.getTime() +
                  services.supervision.screenshotRetentionHours * 3600_000,
              ),
              requestedBy: member.auth.user.id,
            })
            .returning();
          await audit(tx, {
            organizationId: member.organizationId,
            actorType: 'user',
            actorId: member.auth.user.id,
            action: 'screenshot.requested',
            permission: 'screenshots.request',
            targetType: 'display',
            targetId: id,
            result: 'success',
            metadata: { screenshot_id: screenshotId, command_id: command.id },
            ...requestMeta(request),
          });
          return {
            status: 201,
            body: {
              screenshot: publicScreenshot(screenshot!, command.status),
              command: publicCommand(command),
            },
          };
        });
      });
      return reply.status(result.status).send(result.body);
    },
  );

  app.get(
    '/displays/:id/screenshots',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const now = services.now();
      return withTenant(services.db, member.organizationId, async (tx) => {
        const display = await loadDisplay(tx, id);
        authorize(member, 'screenshots.read', { siteId: display.siteId });
        const rows = await tx
          .select({ screenshot: schema.screenshots, commandStatus: schema.playerCommands.status })
          .from(schema.screenshots)
          .innerJoin(
            schema.playerCommands,
            eq(schema.playerCommands.id, schema.screenshots.commandId),
          )
          .where(and(eq(schema.screenshots.displayId, id), gt(schema.screenshots.expiresAt, now)))
          .orderBy(desc(schema.screenshots.createdAt))
          .limit(20);
        return {
          enabled: await screenshotsEnabled(tx, member.organizationId),
          retention_hours: services.supervision.screenshotRetentionHours,
          items: rows.map((row) => publicScreenshot(row.screenshot, row.commandStatus)),
        };
      });
    },
  );

  /** URL de consultation courte ; chaque consultation est auditée (SUP-004). */
  app.get(
    '/screenshots/:id/url',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const now = services.now();
      const screenshot = await withTenant(services.db, member.organizationId, async (tx) => {
        const [row] = await tx
          .select({ screenshot: schema.screenshots, siteId: schema.displays.siteId })
          .from(schema.screenshots)
          .innerJoin(schema.displays, eq(schema.displays.id, schema.screenshots.displayId))
          .where(eq(schema.screenshots.id, id));
        if (!row || row.screenshot.status !== 'available' || row.screenshot.expiresAt <= now) {
          throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Capture introuvable ou expirée.');
        }
        authorize(member, 'screenshots.read', { siteId: row.siteId });
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'screenshot.viewed',
          permission: 'screenshots.read',
          targetType: 'screenshot',
          targetId: id,
          result: 'success',
          metadata: { display_id: row.screenshot.displayId },
          ...requestMeta(request),
        });
        return row.screenshot;
      });
      let signed;
      try {
        signed = await services.storage.presignGet(screenshot.objectKey, {
          expiresInSeconds: SCREENSHOT_URL_SECONDS,
        });
      } catch (error) {
        if (error instanceof StorageUnavailableError) {
          throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Stockage indisponible.', true);
        }
        throw error;
      }
      return {
        url: signed.url,
        expires_at: signed.expiresAt.toISOString(),
        captured_at: iso(screenshot.capturedAt),
        notice: CAPTURE_NOTICE,
      };
    },
  );

  // --- Vues de supervision (PROD-006, SUP-001, SUP-003, OBS-003) --------------

  /** Signaux distincts d’un Display, chacun daté ; jamais un voyant unique. */
  app.get(
    '/displays/:id/supervision',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      return withTenant(services.db, member.organizationId, async (tx) => {
        const display = await loadDisplay(tx, id);
        authorize(member, 'organization.read', { siteId: display.siteId });
        const current = (await activeAssignments(tx, [id])).get(id) ?? null;
        const player = current?.player ?? null;
        const [status] = player
          ? await tx
              .select()
              .from(schema.playerStatus)
              .where(eq(schema.playerStatus.playerId, player.id))
          : [];
        const generation = current ? String(current.assignment.generation) : null;
        const desired = current
          ? ((
              await desiredManifests(tx, [
                {
                  displayId: id,
                  playerId: current.player.id,
                  generation: current.assignment.generation,
                },
              ])
            ).get(id) ?? null)
          : null;
        const alertTargets = player ? [id, player.id] : [id];
        const alerts = await tx
          .select()
          .from(schema.alerts)
          .where(
            and(eq(schema.alerts.status, 'open'), inArray(schema.alerts.targetId, alertTargets)),
          )
          .orderBy(desc(schema.alerts.openedAt));
        const [latest] = await tx
          .select()
          .from(schema.screenshots)
          .where(
            and(
              eq(schema.screenshots.displayId, id),
              eq(schema.screenshots.status, 'available'),
              gt(schema.screenshots.expiresAt, services.now()),
            ),
          )
          .orderBy(desc(schema.screenshots.capturedAt))
          .limit(1);
        const state = player ? presence(player.lastSeenAt, services) : 'unknown';
        const payload = (status?.payload ?? null) as StatusPayload | null;
        const rendering = playbackOf(status, id, generation);
        return {
          display: { id: display.id, name: display.name, site_id: display.siteId },
          player: player
            ? {
                id: player.id,
                name: player.name,
                type: player.type,
                app_version: player.appVersion,
                output_key: current!.output.outputKey,
                generation,
              }
            : null,
          presence: {
            state,
            last_seen_at: iso(player?.lastSeenAt),
            timeout_seconds: services.security.presenceTimeoutSeconds,
          },
          health: status
            ? {
                current: state === 'online',
                renderer: status.renderer ?? 'unknown',
                heartbeat_received_at: iso(status.heartbeatReceivedAt),
                status_observed_at: iso(status.statusObservedAt),
                status_received_at: iso(status.statusReceivedAt),
                renderer_restarts: status.rendererRestarts,
                storage_persistent: payload?.storage_persistent ?? null,
                metrics: payload?.metrics ?? null,
                cache: payload?.cache ?? null,
              }
            : null,
          rendering: {
            current: state === 'online',
            reported_at: iso(status?.heartbeatReceivedAt),
            playback: rendering.playback,
            manifest_applied_version: rendering.manifest_applied_version,
            desired,
            in_sync:
              desired && rendering.manifest_applied_version !== null
                ? desired.version === rendering.manifest_applied_version
                : null,
          },
          output: current
            ? {
                output_key: current.output.outputKey,
                connected: current.output.connected,
                last_seen_at: iso(current.output.lastSeenAt),
              }
            : null,
          capture: {
            supported: player ? (capabilitiesOf(player).screenshot ?? 'unknown') : 'unknown',
            enabled: await screenshotsEnabled(tx, member.organizationId),
            latest: latest
              ? {
                  id: latest.id,
                  captured_at: iso(latest.capturedAt),
                  expires_at: latest.expiresAt.toISOString(),
                  notice: CAPTURE_NOTICE,
                }
              : null,
          },
          alerts: alerts.map((alert) => ({
            id: alert.id,
            rule: alert.rule,
            severity: alert.severity,
            target_type: alert.targetType,
            opened_at: alert.openedAt.toISOString(),
            suspected_platform: alert.suspectedPlatform,
          })),
        };
      });
    },
  );

  /**
   * Timeline d’un Display (SUP-003, OBS-001) : événements du Player et du cloud,
   * livraisons de manifests et affectations, triés par instant observé décroissant.
   */
  app.get(
    '/displays/:id/timeline',
    { schema: { params: Type.Object({ id: Uuid }, Strict), querystring: TimelineQuery } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const query = request.query as { before?: string; limit?: string };
      const limit = query.limit ? Number(query.limit) : 100;
      // Sans curseur : un an après l’instant courant (bornes d’horodatage PostgreSQL).
      const before = query.before
        ? new Date(query.before)
        : new Date(services.now().getTime() + 366 * 86_400_000);
      if (Number.isNaN(before.getTime())) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Instant invalide.', false, {
          field: 'before',
        });
      }
      return withTenant(services.db, member.organizationId, async (tx) => {
        const display = await loadDisplay(tx, id);
        authorize(member, 'organization.read', { siteId: display.siteId });
        const te = schema.timelineEvents;
        // Événements sans Display : ceux d’un Player pendant son affectation à ce Display.
        const events = await tx
          .select()
          .from(te)
          .where(
            and(
              lt(te.observedAt, before),
              or(
                eq(te.displayId, id),
                and(
                  isNull(te.displayId),
                  sql`exists (select 1 from ${schema.displayAssignments} da
                    join ${schema.playerOutputs} po on po.id = da.player_output_id
                    where da.display_id = ${id} and po.player_id = ${te.playerId}
                      and ${te.observedAt} >= da.started_at
                      and (da.ended_at is null or ${te.observedAt} <= da.ended_at))`,
                ),
              ),
            ),
          )
          .orderBy(desc(te.observedAt))
          .limit(limit);
        const deliveries = await tx
          .select({ delivery: schema.manifestDeliveries, version: schema.manifests.version })
          .from(schema.manifestDeliveries)
          .innerJoin(
            schema.manifests,
            eq(schema.manifests.id, schema.manifestDeliveries.manifestId),
          )
          .where(
            and(
              eq(schema.manifestDeliveries.displayId, id),
              lt(schema.manifestDeliveries.createdAt, before),
            ),
          )
          .orderBy(desc(schema.manifestDeliveries.createdAt))
          .limit(limit);
        const assignments = await tx
          .select({
            assignment: schema.displayAssignments,
            playerId: schema.playerOutputs.playerId,
            outputKey: schema.playerOutputs.outputKey,
          })
          .from(schema.displayAssignments)
          .innerJoin(
            schema.playerOutputs,
            eq(schema.playerOutputs.id, schema.displayAssignments.playerOutputId),
          )
          .where(
            and(
              eq(schema.displayAssignments.displayId, id),
              lt(schema.displayAssignments.startedAt, before),
            ),
          )
          .orderBy(desc(schema.displayAssignments.startedAt))
          .limit(limit);
        const entries: TimelineEntry[] = events.map((event) => ({
          source: event.source,
          type: event.type,
          severity: event.severity,
          observed_at: event.observedAt.toISOString(),
          received_at: event.receivedAt.toISOString(),
          player_id: event.playerId,
          payload: {
            ...(event.payload as Record<string, unknown>),
            ...(event.assignmentGeneration
              ? { assignment_generation: event.assignmentGeneration }
              : {}),
          },
        }));
        for (const { delivery, version } of deliveries) {
          const base = {
            source: 'delivery' as const,
            received_at: null,
            player_id: delivery.playerId,
            payload: {
              manifest_id: delivery.manifestId,
              version: String(version),
              assignment_generation: String(delivery.assignmentGeneration),
            },
          };
          const steps: [string, Date | null, string, Record<string, unknown>?][] = [
            ['MANIFEST_DESIRED', delivery.createdAt, 'info'],
            ['MANIFEST_RECEIVED', delivery.receivedAt, 'info'],
            ['MANIFEST_READY', delivery.readyAt, 'info'],
            ['MANIFEST_APPLIED', delivery.appliedAt, 'info'],
            [
              'MANIFEST_FAILED',
              delivery.failedAt,
              'error',
              { error_code: delivery.errorCode, detail: delivery.detail },
            ],
          ];
          for (const [type, at, severity, extra] of steps) {
            if (!at || at >= before) continue;
            entries.push({
              ...base,
              type,
              severity,
              observed_at: at.toISOString(),
              payload: { ...base.payload, ...extra },
            });
          }
        }
        for (const { assignment, playerId, outputKey } of assignments) {
          const payload = { generation: String(assignment.generation), output_key: outputKey };
          entries.push({
            source: 'assignment',
            type: 'ASSIGNMENT_STARTED',
            severity: 'info',
            observed_at: assignment.startedAt.toISOString(),
            received_at: null,
            player_id: playerId,
            payload,
          });
          if (assignment.endedAt && assignment.endedAt < before) {
            entries.push({
              source: 'assignment',
              type: 'ASSIGNMENT_ENDED',
              severity: 'info',
              observed_at: assignment.endedAt.toISOString(),
              received_at: null,
              player_id: playerId,
              payload,
            });
          }
        }
        entries.sort((a, b) =>
          a.observed_at < b.observed_at ? 1 : a.observed_at > b.observed_at ? -1 : 0,
        );
        const items = entries.slice(0, limit);
        return {
          items,
          next_before: items.length === limit ? items[items.length - 1]!.observed_at : null,
        };
      });
    },
  );

  /** Vue du parc (SUP-001) : un signal par colonne, filtrable, sans voyant unique. */
  app.get(
    '/fleet/overview',
    {
      schema: {
        querystring: Type.Object(
          {
            presence: Type.Optional(
              Type.Union([
                Type.Literal('online'),
                Type.Literal('offline'),
                Type.Literal('unknown'),
                Type.Literal('unassigned'),
              ]),
            ),
            site_id: Type.Optional(Uuid),
            attention: Type.Optional(Type.Literal('true')),
          },
          Strict,
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const query = request.query as {
        presence?: 'online' | 'offline' | 'unknown' | 'unassigned';
        site_id?: string;
        attention?: 'true';
      };
      const visible = visibleSites(member, 'organization.read');
      return withTenant(services.db, member.organizationId, async (tx) => {
        const displays = await tx
          .select()
          .from(schema.displays)
          .where(
            and(
              isNull(schema.displays.deletedAt),
              eq(schema.displays.lifecycleStatus, 'active'),
              siteCondition(schema.displays.siteId, visible),
              query.site_id ? eq(schema.displays.siteId, query.site_id) : undefined,
            ),
          )
          .orderBy(asc(schema.displays.name));
        const assignments = await activeAssignments(
          tx,
          displays.map((d) => d.id),
        );
        const playerIds = [...new Set([...assignments.values()].map((a) => a.player.id))];
        const statuses = playerIds.length
          ? await tx
              .select()
              .from(schema.playerStatus)
              .where(inArray(schema.playerStatus.playerId, playerIds))
          : [];
        const desired = await desiredManifests(
          tx,
          [...assignments.values()].map((a) => ({
            displayId: a.assignment.displayId,
            playerId: a.player.id,
            generation: a.assignment.generation,
          })),
        );
        const targets = [...displays.map((d) => d.id), ...playerIds];
        const alertRows = targets.length
          ? await tx
              .select({ targetId: schema.alerts.targetId, n: sql<number>`count(*)::int` })
              .from(schema.alerts)
              .where(
                and(eq(schema.alerts.status, 'open'), inArray(schema.alerts.targetId, targets)),
              )
              .groupBy(schema.alerts.targetId)
          : [];
        const alertCount = new Map(alertRows.map((row) => [row.targetId, row.n]));
        const all = displays.map((display) => {
          const current = assignments.get(display.id);
          const status = statuses.find((s) => s.playerId === current?.player.id);
          const generation = current ? String(current.assignment.generation) : null;
          const rendering = playbackOf(status, display.id, generation);
          const wanted = desired.get(display.id) ?? null;
          const state = current ? presence(current.player.lastSeenAt, services) : 'unassigned';
          return {
            display_id: display.id,
            name: display.name,
            site_id: display.siteId,
            player: current
              ? { id: current.player.id, name: current.player.name, type: current.player.type }
              : null,
            presence: state,
            last_seen_at: iso(current?.player.lastSeenAt),
            renderer: status?.renderer ?? 'unknown',
            playback: rendering.playback,
            output_connected: current ? current.output.connected : null,
            manifest: {
              desired_version: wanted?.version ?? null,
              applied_version: rendering.manifest_applied_version,
              delivery_state: wanted?.state ?? null,
            },
            open_alerts:
              (alertCount.get(display.id) ?? 0) +
              (current ? (alertCount.get(current.player.id) ?? 0) : 0),
          };
        });
        const counts = {
          displays: all.length,
          online: all.filter((d) => d.presence === 'online').length,
          offline: all.filter((d) => d.presence === 'offline').length,
          unknown: all.filter((d) => d.presence === 'unknown').length,
          unassigned: all.filter((d) => d.presence === 'unassigned').length,
          with_alerts: all.filter((d) => d.open_alerts > 0).length,
        };
        const items = all.filter(
          (d) =>
            (!query.presence || d.presence === query.presence) &&
            (!query.attention ||
              d.open_alerts > 0 ||
              d.presence === 'offline' ||
              d.manifest.delivery_state === 'failed'),
        );
        return { counts, items };
      });
    },
  );

  // --- Réglages (SUP-004) ------------------------------------------------------

  app.get('/supervision/settings', async (request) => {
    const member = await requireMember(request, services);
    authorize(member, 'organization.read');
    return withTenant(services.db, member.organizationId, async (tx) => ({
      screenshots_enabled: await screenshotsEnabled(tx, member.organizationId),
      screenshot_retention_hours: services.supervision.screenshotRetentionHours,
      command_ttl_seconds: services.supervision.commandTtlSeconds,
      commands_available: services.supervision.commandKey !== null,
    }));
  });

  app.put(
    '/supervision/settings',
    {
      schema: { body: Type.Object({ screenshots_enabled: Type.Boolean() }, Strict) },
    },
    async (request) => {
      const member = await requireMember(request, services);
      authorize(member, 'organization.manage');
      const body = request.body as { screenshots_enabled: boolean };
      return withTenant(services.db, member.organizationId, async (tx) => {
        await tx
          .update(schema.organizations)
          .set({ screenshotsEnabled: body.screenshots_enabled })
          .where(eq(schema.organizations.id, member.organizationId));
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'supervision.settings_updated',
          permission: 'organization.manage',
          targetType: 'organization',
          targetId: member.organizationId,
          result: 'success',
          metadata: { screenshots_enabled: body.screenshots_enabled },
          ...requestMeta(request),
        });
        return {
          screenshots_enabled: body.screenshots_enabled,
          screenshot_retention_hours: services.supervision.screenshotRetentionHours,
          command_ttl_seconds: services.supervision.commandTtlSeconds,
          commands_available: services.supervision.commandKey !== null,
        };
      });
    },
  );
}
