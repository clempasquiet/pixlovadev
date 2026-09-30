import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Type from 'typebox';
import {
  normalizePairingCode,
  type OutputReport,
  type PlayerCapabilities,
} from '@pixlova/contracts';
import { schema, withTenant, type Transaction } from '@pixlova/db';
import { siteFilter, type Permission } from '@pixlova/permissions';
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
import { assertTimezone } from './organizations.js';
import { pairingCodeHash } from './player-api.js';
import { recompile } from './content-graph.js';
import { Strict, Uuid } from './schemas.js';

const Name = Type.String({ minLength: 1, maxLength: 120 });
const Dimension = Type.Integer({ minimum: 1, maximum: 32767 });
const OrientationInput = Type.Union([
  Type.Literal(0),
  Type.Literal(90),
  Type.Literal(180),
  Type.Literal(270),
]);
const TimezoneInput = Type.Union([Type.String({ minLength: 1, maxLength: 64 }), Type.Null()]);

type PlayerRow = typeof schema.players.$inferSelect;
type DisplayRow = typeof schema.displays.$inferSelect;

/** Présence vue du serveur (SUP-001, DATA-005) : jamais déduite d’une absence de mesure. */
export function presence(
  lastSeenAt: Date | null,
  services: Services,
): 'online' | 'offline' | 'unknown' {
  if (!lastSeenAt) return 'unknown';
  return services.now().getTime() - lastSeenAt.getTime() <=
    services.security.presenceTimeoutSeconds * 1000
    ? 'online'
    : 'offline';
}

const NONE = '00000000-0000-0000-0000-000000000000';

function visibleSites(member: MemberContext, permission: Permission): string[] | 'all' {
  return siteFilter(member.grants, permission);
}

function siteCondition(
  column: typeof schema.displays.siteId | typeof schema.players.siteId,
  visible: string[] | 'all',
) {
  return visible === 'all' ? undefined : inArray(column, visible.length ? visible : [NONE]);
}

async function lockOrganization(tx: Transaction, organizationId: string): Promise<void> {
  await tx
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .for('update');
}

async function assertSite(tx: Transaction, siteId: string): Promise<void> {
  const [site] = await tx
    .select({ id: schema.sites.id })
    .from(schema.sites)
    .where(and(eq(schema.sites.id, siteId), isNull(schema.sites.deletedAt)));
  if (!site)
    throw new ApiError(422, 'VALIDATION_ERROR', 'Site inconnu.', false, { field: 'site_id' });
}

/**
 * Contrôle des slots sous verrou de l’organisation (BILL-002, BILL-004) : aucune
 * création facturable implicite, aucune course sur le dernier slot.
 */
async function assertSlotAvailable(
  tx: Transaction,
  services: Services,
  organizationId: string,
): Promise<void> {
  await lockOrganization(tx, organizationId);
  const allowed = await services.entitlements.displaySlots(organizationId);
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.displays)
    .where(and(eq(schema.displays.lifecycleStatus, 'active'), isNull(schema.displays.deletedAt)));
  if ((row?.n ?? 0) >= allowed) {
    throw new ApiError(
      409,
      'DISPLAY_LIMIT_REACHED',
      'Aucune licence de Display disponible.',
      false,
      { allowed, active: row?.n ?? 0 },
    );
  }
}

function publicPlayer(player: PlayerRow, services: Services) {
  const capabilities = player.capabilities as Partial<PlayerCapabilities>;
  return {
    id: player.id,
    name: player.name,
    site_id: player.siteId,
    type: player.type,
    lifecycle_status: player.lifecycleStatus,
    app_version: player.appVersion,
    os: player.os,
    architecture: player.architecture,
    presence: presence(player.lastSeenAt, services),
    last_seen_at: player.lastSeenAt?.toISOString() ?? null,
    capabilities: {
      max_canvas: capabilities.max_canvas ?? null,
      screenshot: capabilities.screenshot ?? 'unknown',
      reboot_host: capabilities.reboot_host ?? 'unknown',
      multi_output: capabilities.multi_output ?? 'unknown',
    },
    created_at: player.createdAt.toISOString(),
  };
}

function publicDisplay(display: DisplayRow) {
  return {
    id: display.id,
    site_id: display.siteId,
    name: display.name,
    width: display.width,
    height: display.height,
    orientation: display.orientation,
    timezone: display.timezone,
    lifecycle_status: display.lifecycleStatus,
    fallback_mode: display.fallbackMode,
    assignment_generation: String(display.assignmentGeneration),
    created_at: display.createdAt.toISOString(),
  };
}

/** Compatibilité déclarée (DSP-004) : explicite avant publication, jamais bloquante sans mesure. */
function compatibility(
  display: DisplayRow,
  player: PlayerRow | null,
): 'ok' | 'exceeds_max_canvas' | 'unknown' {
  const max = (player?.capabilities as Partial<PlayerCapabilities> | undefined)?.max_canvas;
  if (!player || !max) return 'unknown';
  const quarter = display.orientation === 90 || display.orientation === 270;
  const width = quarter ? display.height : display.width;
  const height = quarter ? display.width : display.height;
  return width <= max.width && height <= max.height ? 'ok' : 'exceeds_max_canvas';
}

async function activeAssignments(tx: Transaction, displayIds: string[]) {
  if (displayIds.length === 0)
    return new Map<
      string,
      {
        assignment: typeof schema.displayAssignments.$inferSelect;
        output: typeof schema.playerOutputs.$inferSelect;
        player: PlayerRow;
      }
    >();
  const rows = await tx
    .select({
      assignment: schema.displayAssignments,
      output: schema.playerOutputs,
      player: schema.players,
    })
    .from(schema.displayAssignments)
    .innerJoin(
      schema.playerOutputs,
      eq(schema.playerOutputs.id, schema.displayAssignments.playerOutputId),
    )
    .innerJoin(schema.players, eq(schema.players.id, schema.playerOutputs.playerId))
    .where(
      and(
        inArray(schema.displayAssignments.displayId, displayIds),
        isNull(schema.displayAssignments.endedAt),
      ),
    );
  return new Map(rows.map((row) => [row.assignment.displayId, row]));
}

export function fleetRoutes(app: FastifyInstance, services: Services): void {
  // --- Appairage (PLY-002, PROTO-001 étape 3) --------------------------------

  app.post(
    '/players/pair',
    {
      schema: {
        body: Type.Object(
          { code: Type.String({ minLength: 8, maxLength: 16 }), name: Name, site_id: Uuid },
          Strict,
        ),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const body = request.body as { code: string; name: string; site_id: string };
      authorize(member, 'player.pair', { siteId: body.site_id });
      const scope = idempotencyScope(
        request,
        member.organizationId,
        member.auth.user.id,
        'players.pair',
      );
      await rateLimit(services, `pair-claim:user:${member.auth.user.id}`, 10, 600);
      await rateLimit(services, `pair-claim:org:${member.organizationId}`, 30, 600);
      const code = normalizePairingCode(body.code);
      if (!code) throw new ApiError(404, 'PAIRING_CODE_INVALID', 'Code d’appairage inconnu.');
      const now = services.now();
      // Le code précède tout tenant : réclamation par le rôle système, sous verrou de la session.
      const result = await services.system.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('pixlova.organization_id', ${member.organizationId}, true)`,
        );
        return idempotent(tx, scope, async () => {
          const [site] = await tx
            .select({ id: schema.sites.id })
            .from(schema.sites)
            .where(
              and(
                eq(schema.sites.id, body.site_id),
                eq(schema.sites.organizationId, member.organizationId),
                isNull(schema.sites.deletedAt),
              ),
            );
          if (!site)
            throw new ApiError(422, 'VALIDATION_ERROR', 'Site inconnu.', false, {
              field: 'site_id',
            });
          const [session] = await tx
            .select()
            .from(schema.pairingSessions)
            .where(
              and(
                eq(schema.pairingSessions.codeHash, pairingCodeHash(code)),
                isNull(schema.pairingSessions.claimedAt),
              ),
            )
            .for('update');
          if (!session)
            throw new ApiError(
              404,
              'PAIRING_CODE_INVALID',
              'Code d’appairage inconnu ou déjà utilisé.',
            );
          if (session.expiresAt <= now)
            throw new ApiError(409, 'PAIRING_EXPIRED', 'Code d’appairage expiré.');
          const capabilities = session.capabilities as PlayerCapabilities;
          const playerId = randomUUID();
          const [player] = await tx
            .insert(schema.players)
            .values({
              id: playerId,
              organizationId: member.organizationId,
              siteId: body.site_id,
              name: body.name.trim(),
              type: session.playerType,
              installationUuid: session.installationUuid,
              machineFingerprintHash: session.machineFingerprintHash,
              appVersion: session.appVersion,
              os: capabilities.os.family,
              architecture: capabilities.architecture,
              capabilities,
            })
            .returning();
          for (const output of session.outputs as OutputReport[]) {
            await tx.insert(schema.playerOutputs).values({
              organizationId: member.organizationId,
              playerId,
              outputKey: output.output_key,
              connectorType: output.connector_type,
              width: output.width,
              height: output.height,
              refreshRate: output.refresh_hz,
              connected: output.connected,
            });
          }
          await tx.insert(schema.playerCredentials).values({
            organizationId: member.organizationId,
            playerId,
            credentialType: 'ed25519',
            publicKey: session.publicKey,
            generation: 1,
          });
          await tx
            .update(schema.pairingSessions)
            .set({
              claimedAt: now,
              claimedBy: member.auth.user.id,
              organizationId: member.organizationId,
              playerId,
            })
            .where(eq(schema.pairingSessions.id, session.id));
          // Rapprochement suggéré seulement : l’empreinte ne transfère aucun droit (PLY-003).
          const previous = session.machineFingerprintHash
            ? await tx
                .select({ id: schema.players.id, name: schema.players.name })
                .from(schema.players)
                .where(
                  and(
                    eq(schema.players.organizationId, member.organizationId),
                    eq(schema.players.machineFingerprintHash, session.machineFingerprintHash),
                    sql`${schema.players.id} <> ${playerId}`,
                  ),
                )
            : [];
          await audit(tx, {
            organizationId: member.organizationId,
            actorType: 'user',
            actorId: member.auth.user.id,
            action: 'player.paired',
            permission: 'player.pair',
            targetType: 'player',
            targetId: playerId,
            result: 'success',
            metadata: {
              site_id: body.site_id,
              type: session.playerType,
              installation_id: session.installationUuid,
            },
            ...requestMeta(request),
          });
          return {
            status: 201,
            body: {
              player: publicPlayer(player!, services),
              possible_previous_installations: previous,
            },
          };
        });
      });
      return reply.status(result.status).send(result.body);
    },
  );

  // --- Players ----------------------------------------------------------------

  app.get('/players', async (request) => {
    const member = await requireMember(request, services);
    const visible = visibleSites(member, 'organization.read');
    return withTenant(services.db, member.organizationId, async (tx) => {
      const players = await tx
        .select()
        .from(schema.players)
        .where(and(isNull(schema.players.deletedAt), siteCondition(schema.players.siteId, visible)))
        .orderBy(asc(schema.players.name));
      const outputs = players.length
        ? await tx
            .select({
              output: schema.playerOutputs,
              displayId: schema.displayAssignments.displayId,
            })
            .from(schema.playerOutputs)
            .leftJoin(
              schema.displayAssignments,
              and(
                eq(schema.displayAssignments.playerOutputId, schema.playerOutputs.id),
                isNull(schema.displayAssignments.endedAt),
              ),
            )
            .where(
              inArray(
                schema.playerOutputs.playerId,
                players.map((p) => p.id),
              ),
            )
            .orderBy(asc(schema.playerOutputs.outputKey))
        : [];
      return {
        items: players.map((player) => ({
          ...publicPlayer(player, services),
          outputs: outputs
            .filter((o) => o.output.playerId === player.id)
            .map((o) => ({
              id: o.output.id,
              output_key: o.output.outputKey,
              width: o.output.width,
              height: o.output.height,
              connected: o.output.connected,
              display_id: o.displayId,
            })),
        })),
      };
    });
  });

  app.patch(
    '/players/:id',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object(
          { name: Type.Optional(Name), site_id: Type.Optional(Uuid) },
          { ...Strict, minProperties: 1 },
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const body = request.body as { name?: string; site_id?: string };
      return withTenant(services.db, member.organizationId, async (tx) => {
        const [player] = await tx
          .select()
          .from(schema.players)
          .where(and(eq(schema.players.id, id), isNull(schema.players.deletedAt)));
        if (!player) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Player introuvable.');
        authorize(member, 'player.configure', { siteId: player.siteId });
        if (body.site_id) {
          authorize(member, 'player.configure', { siteId: body.site_id });
          await assertSite(tx, body.site_id);
        }
        const [updated] = await tx
          .update(schema.players)
          .set({
            ...(body.name ? { name: body.name.trim() } : {}),
            ...(body.site_id ? { siteId: body.site_id } : {}),
            updatedAt: services.now(),
          })
          .where(eq(schema.players.id, id))
          .returning();
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'player.updated',
          permission: 'player.configure',
          targetType: 'player',
          targetId: id,
          result: 'success',
          metadata: { fields: Object.keys(body) },
          ...requestMeta(request),
        });
        return publicPlayer(updated!, services);
      });
    },
  );

  /**
   * Révocation (PLY-003, PROTO-003) : credentials et jetons invalidés, affectations
   * closes et historisées. Les Displays et leur programmation sont conservés. Un
   * Player hors ligne peut continuer à lire son cache : le cloud ne prétend pas l’avoir effacé.
   */
  app.post(
    '/players/:id/revoke',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const now = services.now();
      return withTenant(services.db, member.organizationId, async (tx) => {
        const [player] = await tx
          .select()
          .from(schema.players)
          .where(and(eq(schema.players.id, id), isNull(schema.players.deletedAt)))
          .for('update');
        if (!player) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Player introuvable.');
        authorize(member, 'player.configure', { siteId: player.siteId });
        if (player.lifecycleStatus === 'revoked')
          return { ...publicPlayer(player, services), ended_assignments: 0 };
        await tx
          .update(schema.players)
          .set({ lifecycleStatus: 'revoked', updatedAt: now })
          .where(eq(schema.players.id, id));
        await tx
          .update(schema.playerCredentials)
          .set({ revokedAt: now })
          .where(
            and(
              eq(schema.playerCredentials.playerId, id),
              isNull(schema.playerCredentials.revokedAt),
            ),
          );
        await tx
          .update(schema.playerAccessTokens)
          .set({ revokedAt: now })
          .where(
            and(
              eq(schema.playerAccessTokens.playerId, id),
              isNull(schema.playerAccessTokens.revokedAt),
            ),
          );
        const outputs = await tx
          .select({ id: schema.playerOutputs.id })
          .from(schema.playerOutputs)
          .where(eq(schema.playerOutputs.playerId, id));
        const ended = outputs.length
          ? await tx
              .update(schema.displayAssignments)
              .set({ endedAt: now })
              .where(
                and(
                  inArray(
                    schema.displayAssignments.playerOutputId,
                    outputs.map((o) => o.id),
                  ),
                  isNull(schema.displayAssignments.endedAt),
                ),
              )
              .returning({ displayId: schema.displayAssignments.displayId })
          : [];
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'player.revoked',
          permission: 'player.configure',
          targetType: 'player',
          targetId: id,
          result: 'success',
          metadata: { ended_display_ids: ended.map((e) => e.displayId) },
          ...requestMeta(request),
        });
        const [updated] = await tx.select().from(schema.players).where(eq(schema.players.id, id));
        return { ...publicPlayer(updated!, services), ended_assignments: ended.length };
      });
    },
  );

  // --- Displays -----------------------------------------------------------------

  app.get('/displays', async (request) => {
    const member = await requireMember(request, services);
    const visible = visibleSites(member, 'organization.read');
    return withTenant(services.db, member.organizationId, async (tx) => {
      const displays = await tx
        .select()
        .from(schema.displays)
        .where(
          and(isNull(schema.displays.deletedAt), siteCondition(schema.displays.siteId, visible)),
        )
        .orderBy(asc(schema.displays.name));
      const assignments = await activeAssignments(
        tx,
        displays.map((d) => d.id),
      );
      const allowed = await services.entitlements.displaySlots(member.organizationId);
      const [active] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.displays)
        .where(
          and(eq(schema.displays.lifecycleStatus, 'active'), isNull(schema.displays.deletedAt)),
        );
      return {
        slots: { allowed, active: active?.n ?? 0 },
        items: displays.map((display) => {
          const current = assignments.get(display.id);
          return {
            ...publicDisplay(display),
            assignment: current
              ? {
                  player_id: current.player.id,
                  player_name: current.player.name,
                  player_output_id: current.output.id,
                  output_key: current.output.outputKey,
                  presence: presence(current.player.lastSeenAt, services),
                  last_seen_at: current.player.lastSeenAt?.toISOString() ?? null,
                }
              : null,
          };
        }),
      };
    });
  });

  app.post(
    '/displays',
    {
      schema: {
        body: Type.Object(
          {
            site_id: Uuid,
            name: Name,
            width: Dimension,
            height: Dimension,
            orientation: Type.Optional(OrientationInput),
            timezone: Type.Optional(TimezoneInput),
          },
          Strict,
        ),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const body = request.body as {
        site_id: string;
        name: string;
        width: number;
        height: number;
        orientation?: number;
        timezone?: string | null;
      };
      authorize(member, 'player.configure', { siteId: body.site_id });
      if (body.timezone) assertTimezone(body.timezone);
      const display = await withTenant(services.db, member.organizationId, async (tx) => {
        await assertSite(tx, body.site_id);
        await assertSlotAvailable(tx, services, member.organizationId);
        const [created] = await tx
          .insert(schema.displays)
          .values({
            organizationId: member.organizationId,
            siteId: body.site_id,
            name: body.name.trim(),
            width: body.width,
            height: body.height,
            orientation: body.orientation ?? 0,
            timezone: body.timezone ?? null,
          })
          .returning();
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'display.created',
          permission: 'player.configure',
          targetType: 'display',
          targetId: created!.id,
          result: 'success',
          metadata: { width: body.width, height: body.height, orientation: body.orientation ?? 0 },
          ...requestMeta(request),
        });
        return created!;
      });
      return reply.status(201).send(publicDisplay(display));
    },
  );

  app.get(
    '/displays/:id',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      return withTenant(services.db, member.organizationId, async (tx) => {
        const [display] = await tx
          .select()
          .from(schema.displays)
          .where(and(eq(schema.displays.id, id), isNull(schema.displays.deletedAt)));
        if (!display) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Display introuvable.');
        authorize(member, 'organization.read', { siteId: display.siteId });
        const current = (await activeAssignments(tx, [id])).get(id) ?? null;
        const history = await tx
          .select({
            assignment: schema.displayAssignments,
            outputKey: schema.playerOutputs.outputKey,
            playerId: schema.players.id,
            playerName: schema.players.name,
          })
          .from(schema.displayAssignments)
          .innerJoin(
            schema.playerOutputs,
            eq(schema.playerOutputs.id, schema.displayAssignments.playerOutputId),
          )
          .innerJoin(schema.players, eq(schema.players.id, schema.playerOutputs.playerId))
          .where(eq(schema.displayAssignments.displayId, id))
          .orderBy(desc(schema.displayAssignments.generation));
        const groups = await tx
          .select({ id: schema.displayGroups.id, name: schema.displayGroups.name })
          .from(schema.displayGroupMembers)
          .innerJoin(
            schema.displayGroups,
            eq(schema.displayGroups.id, schema.displayGroupMembers.groupId),
          )
          .where(eq(schema.displayGroupMembers.displayId, id));
        return {
          ...publicDisplay(display),
          compatibility: compatibility(display, current?.player ?? null),
          groups,
          assignment: current
            ? {
                player: publicPlayer(current.player, services),
                player_output_id: current.output.id,
                output_key: current.output.outputKey,
                output_connected: current.output.connected,
                generation: String(current.assignment.generation),
                started_at: current.assignment.startedAt.toISOString(),
              }
            : null,
          history: history.map((row) => ({
            generation: String(row.assignment.generation),
            player_id: row.playerId,
            player_name: row.playerName,
            output_key: row.outputKey,
            started_at: row.assignment.startedAt.toISOString(),
            ended_at: row.assignment.endedAt?.toISOString() ?? null,
          })),
        };
      });
    },
  );

  app.patch(
    '/displays/:id',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object(
          {
            name: Type.Optional(Name),
            site_id: Type.Optional(Uuid),
            width: Type.Optional(Dimension),
            height: Type.Optional(Dimension),
            orientation: Type.Optional(OrientationInput),
            timezone: Type.Optional(TimezoneInput),
            lifecycle_status: Type.Optional(
              Type.Union([Type.Literal('active'), Type.Literal('inactive')]),
            ),
          },
          { ...Strict, minProperties: 1 },
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const body = request.body as Partial<{
        name: string;
        site_id: string;
        width: number;
        height: number;
        orientation: number;
        timezone: string | null;
        lifecycle_status: 'active' | 'inactive';
      }>;
      if (body.timezone) assertTimezone(body.timezone);
      return withTenant(services.db, member.organizationId, async (tx) => {
        const [display] = await tx
          .select()
          .from(schema.displays)
          .where(and(eq(schema.displays.id, id), isNull(schema.displays.deletedAt)))
          .for('update');
        if (!display) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Display introuvable.');
        authorize(member, 'player.configure', { siteId: display.siteId });
        if (body.site_id && body.site_id !== display.siteId) {
          authorize(member, 'player.configure', { siteId: body.site_id });
          await assertSite(tx, body.site_id);
        }
        if (body.lifecycle_status === 'active' && display.lifecycleStatus !== 'active') {
          await assertSlotAvailable(tx, services, member.organizationId);
        }
        // La désactivation libère le slot sans supprimer le Display ni sa programmation (DSP-006).
        const [updated] = await tx
          .update(schema.displays)
          .set({
            ...(body.name ? { name: body.name.trim() } : {}),
            ...(body.site_id ? { siteId: body.site_id } : {}),
            ...(body.width ? { width: body.width } : {}),
            ...(body.height ? { height: body.height } : {}),
            ...(body.orientation !== undefined ? { orientation: body.orientation } : {}),
            ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
            ...(body.lifecycle_status ? { lifecycleStatus: body.lifecycle_status } : {}),
            updatedAt: services.now(),
          })
          .where(eq(schema.displays.id, id))
          .returning();
        // Site, fuseau ou état d’activité changent la programmation (ADR-011).
        await recompile(tx, member, [id], 'display.updated');
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action:
            body.lifecycle_status && body.lifecycle_status !== display.lifecycleStatus
              ? `display.${body.lifecycle_status === 'active' ? 'activated' : 'deactivated'}`
              : 'display.updated',
          permission: 'player.configure',
          targetType: 'display',
          targetId: id,
          result: 'success',
          metadata: { fields: Object.keys(body) },
          ...requestMeta(request),
        });
        return publicDisplay(updated!);
      });
    },
  );

  /**
   * Affectation ou transfert transactionnel (DSP-002, DSP-003, DATA-006) : verrou du
   * Display, clôture de l’ancienne affectation, génération incrémentée, nouvelle
   * affectation. Aucune période avec deux affectations actives ; `display_id`, contenus
   * et historique conservés ; les autres sorties de l’ancien Player ne sont pas touchées.
   */
  app.put(
    '/displays/:id/assignment',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object({ player_output_id: Uuid }, Strict),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const { player_output_id: outputId } = request.body as { player_output_id: string };
      const scope = idempotencyScope(
        request,
        member.organizationId,
        member.auth.user.id,
        'displays.assign',
      );
      const now = services.now();
      const result = await withTenant(services.db, member.organizationId, (tx) =>
        idempotent(tx, scope, async () => {
          // Verrou de la sortie cible : deux Displays ne peuvent pas la prendre en même temps.
          await tx
            .select({ id: schema.playerOutputs.id })
            .from(schema.playerOutputs)
            .where(eq(schema.playerOutputs.id, outputId))
            .for('update');
          const [display] = await tx
            .select()
            .from(schema.displays)
            .where(and(eq(schema.displays.id, id), isNull(schema.displays.deletedAt)))
            .for('update');
          if (!display) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Display introuvable.');
          authorize(member, 'player.pair', { siteId: display.siteId });
          if (display.lifecycleStatus !== 'active')
            throw new ApiError(409, 'DISPLAY_INACTIVE', 'Activez le Display avant de l’affecter.');
          const [target] = await tx
            .select({ output: schema.playerOutputs, player: schema.players })
            .from(schema.playerOutputs)
            .innerJoin(schema.players, eq(schema.players.id, schema.playerOutputs.playerId))
            .where(eq(schema.playerOutputs.id, outputId));
          if (!target) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Sortie introuvable.');
          authorize(member, 'player.pair', { siteId: target.player.siteId });
          if (target.player.lifecycleStatus !== 'paired')
            throw new ApiError(409, 'PLAYER_REVOKED', 'Ce Player est révoqué ou désactivé.');
          const [occupied] = await tx
            .select({ displayId: schema.displayAssignments.displayId })
            .from(schema.displayAssignments)
            .where(
              and(
                eq(schema.displayAssignments.playerOutputId, outputId),
                isNull(schema.displayAssignments.endedAt),
              ),
            );
          if (occupied && occupied.displayId !== id) {
            throw new ApiError(
              409,
              'ASSIGNMENT_CONFLICT',
              'Cette sortie affiche déjà un autre Display.',
              false,
              { display_id: occupied.displayId },
            );
          }
          const [current] = await tx
            .select()
            .from(schema.displayAssignments)
            .where(
              and(
                eq(schema.displayAssignments.displayId, id),
                isNull(schema.displayAssignments.endedAt),
              ),
            );
          if (current?.playerOutputId === outputId) {
            return {
              status: 200,
              body: {
                display_id: id,
                player_output_id: outputId,
                generation: String(current.generation),
                previous: null,
              },
            };
          }
          if (current)
            await tx
              .update(schema.displayAssignments)
              .set({ endedAt: now })
              .where(eq(schema.displayAssignments.id, current.id));
          const generation = display.assignmentGeneration + 1n;
          await tx.insert(schema.displayAssignments).values({
            organizationId: member.organizationId,
            displayId: id,
            playerOutputId: outputId,
            generation,
            startedAt: now,
            assignedBy: member.auth.user.id,
          });
          await tx
            .update(schema.displays)
            .set({ assignmentGeneration: generation, updatedAt: now })
            .where(eq(schema.displays.id, id));
          await tx.insert(schema.outboxEvents).values({
            organizationId: member.organizationId,
            aggregateType: 'display',
            aggregateId: id,
            eventType: 'display.assignment_changed',
            payload: {
              display_id: id,
              generation: String(generation),
              player_id: target.player.id,
              previous_output_id: current?.playerOutputId ?? null,
            },
          });
          await recompile(tx, member, [id], 'display.assignment_changed');
          await audit(tx, {
            organizationId: member.organizationId,
            actorType: 'user',
            actorId: member.auth.user.id,
            action: current ? 'display.player_replaced' : 'display.assigned',
            permission: 'player.pair',
            targetType: 'display',
            targetId: id,
            result: 'success',
            metadata: {
              generation: String(generation),
              player_output_id: outputId,
              previous_output_id: current?.playerOutputId ?? null,
            },
            ...requestMeta(request),
          });
          return {
            status: current ? 200 : 201,
            body: {
              display_id: id,
              player_output_id: outputId,
              generation: String(generation),
              previous: current
                ? {
                    player_output_id: current.playerOutputId,
                    generation: String(current.generation),
                  }
                : null,
            },
          };
        }),
      );
      return reply.status(result.status).send(result.body);
    },
  );

  app.delete(
    '/displays/:id/assignment',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      await withTenant(services.db, member.organizationId, async (tx) => {
        const [display] = await tx
          .select()
          .from(schema.displays)
          .where(and(eq(schema.displays.id, id), isNull(schema.displays.deletedAt)))
          .for('update');
        if (!display) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Display introuvable.');
        authorize(member, 'player.pair', { siteId: display.siteId });
        const ended = await tx
          .update(schema.displayAssignments)
          .set({ endedAt: services.now() })
          .where(
            and(
              eq(schema.displayAssignments.displayId, id),
              isNull(schema.displayAssignments.endedAt),
            ),
          )
          .returning({ id: schema.displayAssignments.id });
        if (ended.length === 0)
          throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Ce Display n’est pas affecté.');
        await recompile(tx, member, [id], 'display.unassigned');
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'display.unassigned',
          permission: 'player.pair',
          targetType: 'display',
          targetId: id,
          result: 'success',
          ...requestMeta(request),
        });
      });
      return reply.status(204).send();
    },
  );

  // --- Groupes de Displays (ciblage, sans synchronisation) ------------------------

  app.get('/display-groups', async (request) => {
    const member = await requireMember(request, services);
    authorize(member, 'organization.read');
    return withTenant(services.db, member.organizationId, async (tx) => {
      const groups = await tx
        .select()
        .from(schema.displayGroups)
        .orderBy(asc(schema.displayGroups.name));
      const members = await tx.select().from(schema.displayGroupMembers);
      return {
        items: groups.map((group) => ({
          id: group.id,
          name: group.name,
          description: group.description,
          display_ids: members.filter((m) => m.groupId === group.id).map((m) => m.displayId),
        })),
      };
    });
  });

  app.post(
    '/display-groups',
    {
      schema: {
        body: Type.Object(
          { name: Name, description: Type.Optional(Type.String({ maxLength: 500 })) },
          Strict,
        ),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      authorize(member, 'player.configure');
      const body = request.body as { name: string; description?: string };
      const group = await withTenant(services.db, member.organizationId, async (tx) => {
        const [created] = await tx
          .insert(schema.displayGroups)
          .values({
            organizationId: member.organizationId,
            name: body.name.trim(),
            description: body.description ?? null,
          })
          .returning();
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'display_group.created',
          permission: 'player.configure',
          targetType: 'display_group',
          targetId: created!.id,
          result: 'success',
          ...requestMeta(request),
        });
        return created!;
      });
      return reply
        .status(201)
        .send({ id: group.id, name: group.name, description: group.description, display_ids: [] });
    },
  );

  app.put(
    '/display-groups/:id/members',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object(
          { display_ids: Type.Array(Uuid, { maxItems: 1000, uniqueItems: true }) },
          Strict,
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      authorize(member, 'player.configure');
      const { id } = request.params as { id: string };
      const { display_ids: displayIds } = request.body as { display_ids: string[] };
      return withTenant(services.db, member.organizationId, async (tx) => {
        const [group] = await tx
          .select()
          .from(schema.displayGroups)
          .where(eq(schema.displayGroups.id, id))
          .for('update');
        if (!group) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Groupe introuvable.');
        if (displayIds.length) {
          const found = await tx
            .select({ id: schema.displays.id })
            .from(schema.displays)
            .where(and(inArray(schema.displays.id, displayIds), isNull(schema.displays.deletedAt)));
          // Opération atomique : refus global si un Display est inconnu (IAM-005).
          if (found.length !== displayIds.length)
            throw new ApiError(422, 'VALIDATION_ERROR', 'Display inconnu dans la sélection.');
        }
        await tx
          .delete(schema.displayGroupMembers)
          .where(eq(schema.displayGroupMembers.groupId, id));
        if (displayIds.length) {
          await tx.insert(schema.displayGroupMembers).values(
            displayIds.map((displayId) => ({
              organizationId: member.organizationId,
              groupId: id,
              displayId,
            })),
          );
        }
        // Appartenances réévaluées à chaque compilation (PLN-007).
        await recompile(tx, member, 'all', 'display_group.members_changed');
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'display_group.members_changed',
          permission: 'player.configure',
          targetType: 'display_group',
          targetId: id,
          result: 'success',
          metadata: { count: displayIds.length },
          ...requestMeta(request),
        });
        return { id, display_ids: displayIds };
      });
    },
  );
}
