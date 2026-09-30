/**
 * Programme d’un Display (PLN-005, PLN-010, PROD-003, FON-002, ADR-011) : contenu de repli,
 * simulation avec le moteur du manifest pour une période quelconque, et suivi distinct des
 * versions désirée, préparée et appliquée.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Type from 'typebox';
import type { ContentRef } from '@pixlova/contracts';
import { schema, withTenant, type Transaction } from '@pixlova/db';
import { evaluate, explain, loadSnapshot, prepareSnapshot } from '@pixlova/scheduling/compiler';
import { ApiError } from '../errors.js';
import { authorize, requestMeta, requireMember, type MemberContext } from '../http/context.js';
import type { Services } from '../http/services.js';
import { audit } from '../lib/audit.js';
import { contentInfos, recompile, referenceIssues } from './content-graph.js';
import { Strict, Uuid } from './schemas.js';

const HOUR = 3_600_000;
const MAX_RANGE = 31 * 24 * HOUR;
/** Horizon restant sous lequel l’épuisement est signalé (PLN-011). */
const HORIZON_WARNING = 48 * HOUR;
const Instant = Type.String({
  pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$',
});

async function loadDisplay(tx: Transaction, member: MemberContext, id: string) {
  const [display] = await tx
    .select()
    .from(schema.displays)
    .where(and(eq(schema.displays.id, id), isNull(schema.displays.deletedAt)));
  if (!display) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Display introuvable.');
  try {
    authorize(member, 'organization.read', { siteId: display.siteId });
  } catch {
    throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Display introuvable.');
  }
  return display;
}

function fallbackOf(display: typeof schema.displays.$inferSelect): ContentRef | null {
  if (display.fallbackMediaId) return { type: 'media', id: display.fallbackMediaId };
  if (display.fallbackCompositionId) {
    return { type: 'composition', id: display.fallbackCompositionId };
  }
  if (display.fallbackPlaylistId) return { type: 'playlist', id: display.fallbackPlaylistId };
  return null;
}

export function displayProgramRoutes(app: FastifyInstance, services: Services): void {
  app.put(
    '/displays/:id/fallback',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object(
          {
            content: Type.Union([
              Type.Object(
                {
                  type: Type.Union([
                    Type.Literal('media'),
                    Type.Literal('composition'),
                    Type.Literal('playlist'),
                  ]),
                  id: Uuid,
                },
                Strict,
              ),
              Type.Null(),
            ]),
          },
          Strict,
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const { content } = request.body as { content: ContentRef | null };
      return withTenant(services.db, member.organizationId, async (tx) => {
        const display = await loadDisplay(tx, member, id);
        authorize(member, 'player.configure', { siteId: display.siteId });
        if (content) {
          const infos = await contentInfos(tx, member, [content]);
          const issues = referenceIssues([content], infos, display.siteId);
          if (issues.length > 0) {
            throw new ApiError(
              422,
              'FALLBACK_INVALID',
              'Ce contenu ne peut pas servir de repli.',
              false,
              {
                issues,
              },
            );
          }
        }
        await tx
          .update(schema.displays)
          .set({
            fallbackMode: content ? 'content' : 'standby_screen',
            fallbackMediaId: content?.type === 'media' ? content.id : null,
            fallbackCompositionId: content?.type === 'composition' ? content.id : null,
            fallbackPlaylistId: content?.type === 'playlist' ? content.id : null,
            updatedAt: services.now(),
          })
          .where(eq(schema.displays.id, id));
        await recompile(tx, member, [id], 'display.fallback');
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'display.fallback_changed',
          permission: 'player.configure',
          targetType: 'display',
          targetId: id,
          result: 'success',
          ...requestMeta(request),
          metadata: { content_type: content?.type ?? null },
        });
        return { fallback: content };
      });
    },
  );

  /**
   * Simulation du programme (PLN-003, PLN-005) : même moteur que la compilation, sur les
   * données publiées courantes, pour une période passée ou future d’au plus 31 jours.
   */
  app.get(
    '/displays/:id/effective-program',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        querystring: Type.Object(
          { from: Type.Optional(Instant), until: Type.Optional(Instant) },
          Strict,
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const query = request.query as { from?: string; until?: string };
      const now = services.now();
      const from = query.from ? Date.parse(query.from) : Math.floor(now.getTime() / 1000) * 1000;
      const until = query.until ? Date.parse(query.until) : from + 24 * HOUR;
      if (!(from < until) || until - from > MAX_RANGE) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Période invalide (31 jours au plus).', false, {
          field: 'until',
        });
      }
      return withTenant(
        services.db,
        member.organizationId,
        async (tx) => {
          await loadDisplay(tx, member, id);
          const snapshot = await loadSnapshot(tx, id, new Date(from));
          if (!snapshot) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Display introuvable.');
          const prepared = prepareSnapshot(snapshot);
          const evaluated = evaluate(prepared, from, until);
          const entries = explain(evaluated.segments);
          const programIds = [
            ...new Set(
              entries.flatMap((e) => [
                ...(e.winner ? [e.winner.program_id] : []),
                ...e.masked.map((m) => m.program_id),
              ]),
            ),
          ];
          const programs = programIds.length
            ? await tx
                .select({
                  id: schema.programs.id,
                  name: schema.programs.name,
                  kind: schema.programs.kind,
                })
                .from(schema.programs)
                .where(inArray(schema.programs.id, programIds))
            : [];
          const refs = [
            ...entries.flatMap((e) => (e.winner ? [e.winner.content] : [])),
            ...(snapshot.display.fallback ? [snapshot.display.fallback] : []),
          ];
          const infos = await contentInfos(tx, member, refs);
          return {
            display_id: id,
            timezone: snapshot.display.timezone,
            from: new Date(from).toISOString(),
            until: new Date(until).toISOString(),
            assigned: snapshot.assignment !== null,
            fallback: snapshot.display.fallback,
            entries,
            programs: Object.fromEntries(
              programs.map((p) => [p.id, { name: p.name, kind: p.kind }]),
            ),
            contents: Object.fromEntries(
              [...infos].map(([key, info]) => [key, { name: info.name, status: info.status }]),
            ),
            issues: [...evaluated.issues, ...evaluated.resolver.issueList()],
          };
        },
        { isolationLevel: 'repeatable read' },
      );
    },
  );

  /** États désiré, préparé et appliqué, horizon et historique (FON-002, PROD-003). */
  app.get(
    '/displays/:id/delivery',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const now = services.now();
      return withTenant(services.db, member.organizationId, async (tx) => {
        const display = await loadDisplay(tx, member, id);
        const manifests = await tx
          .select({
            manifest: {
              id: schema.manifests.id,
              version: schema.manifests.version,
              generation: schema.manifests.assignmentGeneration,
              generatedAt: schema.manifests.generatedAt,
              scheduleUntil: schema.manifests.scheduleUntil,
              playerId: schema.manifests.playerId,
            },
            delivery: schema.manifestDeliveries,
          })
          .from(schema.manifests)
          .leftJoin(
            schema.manifestDeliveries,
            eq(schema.manifestDeliveries.manifestId, schema.manifests.id),
          )
          .where(eq(schema.manifests.displayId, id))
          .orderBy(desc(schema.manifests.version))
          .limit(20);
        const compilations = await tx
          .select()
          .from(schema.displayCompilations)
          .where(eq(schema.displayCompilations.displayId, id))
          .orderBy(desc(schema.displayCompilations.createdAt))
          .limit(20);
        const summary = (row: (typeof manifests)[number] | undefined) =>
          row && {
            manifest_id: row.manifest.id,
            version: row.manifest.version.toString(),
            assignment_generation: row.manifest.generation.toString(),
            generated_at: row.manifest.generatedAt.toISOString(),
            schedule_until: row.manifest.scheduleUntil.toISOString(),
            state: row.delivery?.state ?? null,
            received_at: row.delivery?.receivedAt?.toISOString() ?? null,
            ready_at: row.delivery?.readyAt?.toISOString() ?? null,
            applied_at: row.delivery?.appliedAt?.toISOString() ?? null,
            error_code: row.delivery?.errorCode ?? null,
            detail: row.delivery?.detail ?? null,
          };
        const desired = manifests[0];
        const prepared = manifests.find((m) =>
          ['ready', 'applied'].includes(m.delivery?.state ?? ''),
        );
        const applied = manifests.find((m) => m.delivery?.appliedAt);
        const horizon = desired ? desired.manifest.scheduleUntil.getTime() - now.getTime() : null;
        return {
          display_id: id,
          config_revision: display.configRevision.toString(),
          desired: summary(desired) ?? null,
          prepared: summary(prepared) ?? null,
          applied: summary(applied) ?? null,
          horizon: {
            until: desired?.manifest.scheduleUntil.toISOString() ?? null,
            exhausted_soon: horizon !== null && horizon < HORIZON_WARNING,
          },
          manifests: manifests.map((m) => summary(m)),
          compilations: compilations.map((c) => ({
            id: c.id,
            config_revision: c.configRevision.toString(),
            status: c.status,
            manifest_id: c.manifestId,
            issues: c.issues,
            window_from: c.windowFrom?.toISOString() ?? null,
            window_until: c.windowUntil?.toISOString() ?? null,
            created_at: c.createdAt.toISOString(),
          })),
          fallback: fallbackOf(display),
        };
      });
    },
  );

  /** Explication enregistrée d’une compilation (historique « pourquoi ce contenu »). */
  app.get(
    '/displays/:id/compilations/:compilationId',
    {
      schema: {
        params: Type.Object({ id: Uuid, compilationId: Uuid }, Strict),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const { id, compilationId } = request.params as { id: string; compilationId: string };
      return withTenant(services.db, member.organizationId, async (tx) => {
        await loadDisplay(tx, member, id);
        const [row] = await tx
          .select()
          .from(schema.displayCompilations)
          .where(
            and(
              eq(schema.displayCompilations.id, compilationId),
              eq(schema.displayCompilations.displayId, id),
            ),
          );
        if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Compilation introuvable.');
        return {
          id: row.id,
          status: row.status,
          config_revision: row.configRevision.toString(),
          issues: row.issues,
          explanation: row.explanation,
          created_at: row.createdAt.toISOString(),
        };
      });
    },
  );
}
