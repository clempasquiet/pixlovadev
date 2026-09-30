import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Type from 'typebox';
import { schema, withTenant, type Transaction } from '@pixlova/db';
import { ApiError } from '../errors.js';
import { authorize, requestMeta, requireMember, type MemberContext } from '../http/context.js';
import type { Services } from '../http/services.js';
import { audit } from '../lib/audit.js';
import { visibleSites } from './fleet.js';
import { Strict, Uuid } from './schemas.js';

/** Durée maximale d’une fenêtre de maintenance [à valider]. */
const MAX_MAINTENANCE_DAYS = 14;
const NONE = '00000000-0000-0000-0000-000000000000';

type AlertRow = typeof schema.alerts.$inferSelect;
type WindowRow = typeof schema.maintenanceWindows.$inferSelect;

function publicAlert(alert: AlertRow) {
  const details = alert.details as Record<string, unknown>;
  return {
    id: alert.id,
    rule: alert.rule,
    severity: alert.severity,
    status: alert.status,
    target_type: alert.targetType,
    target_id: alert.targetId,
    target_name: typeof details.name === 'string' ? details.name : null,
    site_id: alert.siteId,
    opened_at: alert.openedAt.toISOString(),
    resolved_at: alert.resolvedAt?.toISOString() ?? null,
    clearing_since: alert.clearingSince?.toISOString() ?? null,
    notified_at: alert.notifiedOpenAt?.toISOString() ?? null,
    suspected_platform: alert.suspectedPlatform,
    details,
  };
}

function publicWindow(window: WindowRow, now: Date) {
  return {
    id: window.id,
    scope_type: window.scopeType,
    scope_id: window.scopeId,
    starts_at: window.startsAt.toISOString(),
    ends_at: window.endsAt.toISOString(),
    reason: window.reason,
    created_by: window.createdBy,
    cancelled_at: window.cancelledAt?.toISOString() ?? null,
    active: !window.cancelledAt && window.startsAt <= now && window.endsAt > now,
  };
}

/** Site de la portée d’une fenêtre (`null` : organisation entière). */
async function scopeSite(
  tx: Transaction,
  scopeType: WindowRow['scopeType'],
  scopeId: string | null,
): Promise<string | null> {
  if (scopeType === 'organization') return null;
  if (scopeType === 'site') {
    const [site] = await tx
      .select({ id: schema.sites.id })
      .from(schema.sites)
      .where(and(eq(schema.sites.id, scopeId!), isNull(schema.sites.deletedAt)));
    if (!site) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Site introuvable.');
    return site.id;
  }
  const [display] = await tx
    .select({ siteId: schema.displays.siteId })
    .from(schema.displays)
    .where(and(eq(schema.displays.id, scopeId!), isNull(schema.displays.deletedAt)));
  if (!display) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Display introuvable.');
  return display.siteId;
}

function siteVisible(visible: string[] | 'all', siteId: string | null): boolean {
  return visible === 'all' || (siteId !== null && visible.includes(siteId));
}

/**
 * Incidents, fenêtres de maintenance et préférence d’emails d’alerte (SUP-006 à SUP-008,
 * ADR-014). Les incidents sont ouverts et résolus par le worker ; l’API les expose.
 */
export function incidentRoutes(app: FastifyInstance, services: Services): void {
  app.get(
    '/alerts',
    {
      schema: {
        querystring: Type.Object(
          {
            status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('resolved')])),
            target_id: Type.Optional(Uuid),
          },
          Strict,
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const query = request.query as { status?: 'open' | 'resolved'; target_id?: string };
      const visible = visibleSites(member, 'organization.read');
      return withTenant(services.db, member.organizationId, async (tx) => {
        const rows = await tx
          .select()
          .from(schema.alerts)
          .where(
            and(
              eq(schema.alerts.status, query.status ?? 'open'),
              query.target_id ? eq(schema.alerts.targetId, query.target_id) : undefined,
              visible === 'all'
                ? undefined
                : inArray(schema.alerts.siteId, visible.length ? visible : [NONE]),
            ),
          )
          .orderBy(desc(schema.alerts.openedAt))
          .limit(200);
        return { items: rows.map(publicAlert) };
      });
    },
  );

  app.get('/maintenance-windows', async (request) => {
    const member = await requireMember(request, services);
    const visible = visibleSites(member, 'organization.read');
    const now = services.now();
    return withTenant(services.db, member.organizationId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.maintenanceWindows)
        .where(
          and(
            isNull(schema.maintenanceWindows.cancelledAt),
            gt(schema.maintenanceWindows.endsAt, now),
          ),
        )
        .orderBy(schema.maintenanceWindows.startsAt);
      const items = [];
      for (const row of rows) {
        const siteId = await scopeSite(tx, row.scopeType, row.scopeId).catch(() => null);
        if (row.scopeType === 'organization' || siteVisible(visible, siteId)) {
          items.push(publicWindow(row, now));
        }
      }
      return { items };
    });
  });

  /** Fenêtre bornée : suspend les notifications, jamais la collecte ni les incidents. */
  app.post(
    '/maintenance-windows',
    {
      schema: {
        body: Type.Object(
          {
            scope_type: Type.Union([
              Type.Literal('organization'),
              Type.Literal('site'),
              Type.Literal('display'),
            ]),
            scope_id: Type.Union([Uuid, Type.Null()]),
            starts_at: Type.String({ minLength: 20, maxLength: 40 }),
            ends_at: Type.String({ minLength: 20, maxLength: 40 }),
            reason: Type.String({ minLength: 1, maxLength: 500 }),
          },
          Strict,
        ),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const body = request.body as {
        scope_type: WindowRow['scopeType'];
        scope_id: string | null;
        starts_at: string;
        ends_at: string;
        reason: string;
      };
      const startsAt = new Date(body.starts_at);
      const endsAt = new Date(body.ends_at);
      const now = services.now();
      const invalid = (field: string, message: string) =>
        new ApiError(422, 'VALIDATION_ERROR', message, false, { field });
      if ((body.scope_type === 'organization') !== (body.scope_id === null)) {
        throw invalid('scope_id', 'Portée incohérente.');
      }
      if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
        throw invalid('starts_at', 'Dates invalides.');
      }
      if (endsAt <= startsAt || endsAt <= now)
        throw invalid('ends_at', 'Fin déjà passée ou avant le début.');
      if (endsAt.getTime() - startsAt.getTime() > MAX_MAINTENANCE_DAYS * 86_400_000) {
        throw invalid('ends_at', `Durée limitée à ${MAX_MAINTENANCE_DAYS} jours.`);
      }
      const created = await withTenant(services.db, member.organizationId, async (tx) => {
        const siteId = await scopeSite(tx, body.scope_type, body.scope_id);
        authorize(member, 'player.configure', { siteId });
        const [row] = await tx
          .insert(schema.maintenanceWindows)
          .values({
            organizationId: member.organizationId,
            scopeType: body.scope_type,
            scopeId: body.scope_id,
            startsAt,
            endsAt,
            reason: body.reason.trim(),
            createdBy: member.auth.user.id,
          })
          .returning();
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'maintenance.created',
          permission: 'player.configure',
          targetType: body.scope_type,
          targetId: body.scope_id ?? member.organizationId,
          result: 'success',
          metadata: { window_id: row!.id, starts_at: body.starts_at, ends_at: body.ends_at },
          ...requestMeta(request),
        });
        return row!;
      });
      return reply.status(201).send(publicWindow(created, now));
    },
  );

  app.post(
    '/maintenance-windows/:id/cancel',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const now = services.now();
      return withTenant(services.db, member.organizationId, async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.maintenanceWindows)
          .where(eq(schema.maintenanceWindows.id, id))
          .for('update');
        if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Fenêtre introuvable.');
        authorize(member, 'player.configure', {
          siteId: await scopeSite(tx, row.scopeType, row.scopeId).catch(() => null),
        });
        if (row.cancelledAt) return publicWindow(row, now);
        const [updated] = await tx
          .update(schema.maintenanceWindows)
          .set({ cancelledAt: now })
          .where(eq(schema.maintenanceWindows.id, id))
          .returning();
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'maintenance.cancelled',
          permission: 'player.configure',
          targetType: row.scopeType,
          targetId: row.scopeId ?? member.organizationId,
          result: 'success',
          metadata: { window_id: id },
          ...requestMeta(request),
        });
        return publicWindow(updated!, now);
      });
    },
  );

  // --- Préférence individuelle (désabonnement des emails d’alerte) ----------------------

  const preference = (member: MemberContext) =>
    withTenant(services.db, member.organizationId, async (tx) => {
      const [row] = await tx
        .select({ alertEmails: schema.memberships.alertEmails })
        .from(schema.memberships)
        .where(eq(schema.memberships.id, member.membershipId));
      return { alert_emails: row?.alertEmails ?? false };
    });

  app.get('/supervision/preferences', async (request) =>
    preference(await requireMember(request, services)),
  );

  app.put(
    '/supervision/preferences',
    { schema: { body: Type.Object({ alert_emails: Type.Boolean() }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const body = request.body as { alert_emails: boolean };
      await withTenant(services.db, member.organizationId, (tx) =>
        tx
          .update(schema.memberships)
          .set({ alertEmails: body.alert_emails })
          .where(
            and(
              eq(schema.memberships.id, member.membershipId),
              eq(schema.memberships.userId, member.auth.user.id),
            ),
          ),
      );
      return preference(member);
    },
  );
}
