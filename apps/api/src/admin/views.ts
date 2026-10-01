import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Type from 'typebox';
import { platformCan } from '@pixlova/permissions';
import { TEMPLATES } from '@pixlova/templates';
import { ApiError } from '../errors.js';
import { Email, Strict, Uuid } from '../modules/schemas.js';
import { platformAudit, requirePermission, supportReason } from './context.js';
import type { AdminServices } from './services.js';

type Row = Record<string, unknown>;

async function rows<T extends Row = Row>(
  services: AdminServices,
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  const result = await services.platform.execute(query);
  return result.rows as T[];
}

const iso = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString()
    : value
      ? new Date(String(value)).toISOString()
      : null;
const num = (value: unknown): number => Number(value ?? 0);

/** Adresse partiellement masquée : le support n’en voit que ce qu’il faut pour confirmer. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'•'.repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

/**
 * Abonnement d’une organisation pour BillingAdmin (ADM-004, BILL-019) : projection locale,
 * demandes récentes et codes utilisés. Aucun moyen de paiement ni URL de paiement.
 */
async function organizationSubscription(services: AdminServices, organizationId: string) {
  const environment = services.billingEnvironment ?? 'test';
  const [customer] = await rows(
    services,
    sql`SELECT stripe_customer_id, sync_status, sync_error, last_synced_at
        FROM billing_customers WHERE organization_id = ${organizationId} AND environment = ${environment}`,
  );
  const subscriptions = await rows(
    services,
    sql`SELECT s.stripe_subscription_id, s.stripe_status, s.extra_display_slots,
          s.current_period_end, s.cancel_at_period_end, s.grace_until, s.pending_update,
          s.last_synced_at, p.key AS plan_key, p.version AS plan_version, p.name AS plan_name
        FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.organization_id = ${organizationId} AND s.environment = ${environment}
        ORDER BY s.stripe_created_at DESC LIMIT 5`,
  );
  const changes = await rows(
    services,
    sql`SELECT c.id, c.kind, c.status, c.extra_display_slots, c.effective_at, c.selection_status,
          c.failure_reason, c.applied_at, c.created_at, p.key AS plan_key
        FROM billing_changes c LEFT JOIN plans p ON p.id = c.plan_id
        WHERE c.organization_id = ${organizationId} AND c.environment = ${environment}
        ORDER BY c.created_at DESC LIMIT 10`,
  );
  const redemptions = await rows(
    services,
    sql`SELECT code_snapshot, stripe_promotion_code_id, percent_off, amount_off_minor, currency,
          duration, applied_at, ends_at
        FROM promotion_redemptions
        WHERE organization_id = ${organizationId} AND environment = ${environment}
        ORDER BY applied_at DESC LIMIT 10`,
  );
  return {
    available: true,
    environment,
    customer: customer
      ? {
          stripe_customer_id: customer.stripe_customer_id,
          sync_status: customer.sync_status,
          sync_error: customer.sync_error,
          last_synced_at: iso(customer.last_synced_at),
        }
      : null,
    subscriptions: subscriptions.map((s) => ({
      stripe_subscription_id: s.stripe_subscription_id,
      status: s.stripe_status,
      plan: { key: s.plan_key, version: num(s.plan_version), name: s.plan_name },
      extra_display_slots: num(s.extra_display_slots),
      current_period_end: iso(s.current_period_end),
      cancel_at_period_end: s.cancel_at_period_end,
      grace_until: iso(s.grace_until),
      pending_update: s.pending_update,
      last_synced_at: iso(s.last_synced_at),
    })),
    changes: changes.map((c) => ({
      id: c.id,
      kind: c.kind,
      status: c.status,
      plan_key: c.plan_key ?? null,
      extra_display_slots: num(c.extra_display_slots),
      effective_at: iso(c.effective_at),
      selection_status: c.selection_status ?? null,
      failure_reason: c.failure_reason ?? null,
      applied_at: iso(c.applied_at),
      created_at: iso(c.created_at),
    })),
    promotion_redemptions: redemptions.map((r) => ({
      code: r.code_snapshot ?? null,
      promotion_code_id: r.stripe_promotion_code_id ?? null,
      percent_off: r.percent_off === null ? null : Number(r.percent_off),
      amount_off_minor: r.amount_off_minor === null ? null : num(r.amount_off_minor),
      currency: r.currency ?? null,
      duration: r.duration ?? null,
      applied_at: iso(r.applied_at),
      ends_at: iso(r.ends_at),
    })),
  };
}

export function adminViewRoutes(app: FastifyInstance, services: AdminServices): void {
  // --- Facturation (BillingAdmin, ADM-004, BILL-019) ---------------------------------------
  app.get('/billing', async (request) => {
    const context = await requirePermission(request, services, 'platform.billing.read');
    const environment = services.billingEnvironment ?? 'test';
    const byPlan = await rows(
      services,
      sql`SELECT p.key AS plan_key, s.stripe_status, count(*) AS n
          FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.environment = ${environment}
          GROUP BY p.key, s.stripe_status ORDER BY p.key, s.stripe_status`,
    );
    const codes = await rows(
      services,
      sql`SELECT coalesce(code_snapshot, stripe_coupon_id, '—') AS code, count(*) AS uses,
            count(DISTINCT organization_id) AS organizations, max(applied_at) AS last_used_at
          FROM promotion_redemptions WHERE environment = ${environment}
          GROUP BY 1 ORDER BY uses DESC, code LIMIT 50`,
    );
    const [counts] = await rows(
      services,
      sql`SELECT
          (SELECT count(*) FROM billing_customers
             WHERE environment = ${environment} AND sync_status = 'error') AS customers_sync_error,
          (SELECT count(*) FROM stripe_webhook_events
             WHERE environment = ${environment} AND status = 'failed') AS events_failed,
          (SELECT count(*) FROM stripe_webhook_events
             WHERE environment = ${environment} AND status = 'received') AS events_pending,
          (SELECT count(*) FROM billing_changes
             WHERE environment = ${environment} AND status = 'scheduled') AS changes_scheduled,
          (SELECT count(*) FROM billing_changes
             WHERE environment = ${environment} AND selection_status = 'invalid') AS selections_invalid`,
    );
    const failedEvents = await rows(
      services,
      sql`SELECT stripe_event_id, type, stripe_customer_id, attempts, error, received_at
          FROM stripe_webhook_events
          WHERE environment = ${environment} AND status = 'failed'
          ORDER BY received_at DESC LIMIT 20`,
    );
    await platformAudit(services.platform, request, context, {
      action: 'platform.billing.viewed',
      permission: 'platform.billing.read',
      targetType: 'billing',
      targetId: null,
      result: 'success',
    });
    return {
      environment,
      subscriptions: byPlan.map((r) => ({
        plan_key: r.plan_key,
        status: r.stripe_status,
        count: num(r.n),
      })),
      promotion_codes: codes.map((r) => ({
        code: r.code,
        uses: num(r.uses),
        organizations: num(r.organizations),
        last_used_at: iso(r.last_used_at),
      })),
      customers_sync_error: num(counts!.customers_sync_error),
      events: { failed: num(counts!.events_failed), pending: num(counts!.events_pending) },
      changes_scheduled: num(counts!.changes_scheduled),
      selections_invalid: num(counts!.selections_invalid),
      failed_events: failedEvents.map((e) => ({
        stripe_event_id: e.stripe_event_id,
        type: e.type,
        stripe_customer_id: e.stripe_customer_id,
        attempts: num(e.attempts),
        error: e.error,
        received_at: iso(e.received_at),
      })),
    };
  });

  // --- Santé de la plateforme (Operator) -------------------------------------------------
  app.get('/health', async (request) => {
    await requirePermission(request, services, 'platform.health.read');
    const presence = services.config.presenceTimeoutSeconds;
    const [counts] = await rows(
      services,
      sql`SELECT
        (SELECT count(*) FROM organizations WHERE deleted_at IS NULL) AS organizations,
        (SELECT count(*) FROM users WHERE status = 'active') AS users,
        (SELECT count(*) FROM players WHERE lifecycle_status = 'paired') AS players,
        (SELECT count(*) FROM players WHERE lifecycle_status = 'paired'
           AND last_seen_at > now() - make_interval(secs => ${presence})) AS players_online,
        (SELECT count(*) FROM alerts WHERE status = 'open') AS incidents_open,
        (SELECT count(*) FROM alerts WHERE status = 'open' AND suspected_platform) AS incidents_platform,
        (SELECT count(*) FROM email_outbox WHERE sent_at IS NULL) AS emails_pending,
        (SELECT count(*) FROM email_outbox WHERE sent_at IS NULL AND attempts > 0) AS emails_failing,
        (SELECT min(created_at) FROM email_outbox WHERE sent_at IS NULL) AS emails_oldest,
        (SELECT count(*) FROM jobs WHERE state = 'running' AND lease_expires_at < now()) AS jobs_stale,
        (SELECT count(*) FROM jobs WHERE state = 'failed'
           AND finished_at > now() - interval '24 hours') AS jobs_failed_24h,
        (SELECT count(*) FROM drizzle.__drizzle_migrations) AS migrations,
        (SELECT max(created_at) FROM drizzle.__drizzle_migrations) AS migrated_at`,
    );
    const queues = await rows(
      services,
      sql`SELECT kind, state, count(*) AS count FROM jobs
          WHERE state IN ('queued', 'running') OR finished_at > now() - interval '24 hours'
          GROUP BY kind, state ORDER BY kind, state`,
    );
    return {
      observed_at: services.now().toISOString(),
      organizations: num(counts!.organizations),
      active_users: num(counts!.users),
      players: { paired: num(counts!.players), online: num(counts!.players_online) },
      incidents: {
        open: num(counts!.incidents_open),
        suspected_platform: num(counts!.incidents_platform),
      },
      emails: {
        pending: num(counts!.emails_pending),
        failing: num(counts!.emails_failing),
        oldest_pending_at: iso(counts!.emails_oldest),
      },
      jobs: {
        stale_leases: num(counts!.jobs_stale),
        failed_last_24h: num(counts!.jobs_failed_24h),
        by_kind: queues.map((q) => ({ kind: q.kind, state: q.state, count: num(q.count) })),
      },
      schema: {
        migrations_applied: num(counts!.migrations),
        // Horodatage d’écriture de la dernière migration (millisecondes du journal drizzle).
        last_migration_at: counts!.migrated_at
          ? new Date(num(counts!.migrated_at)).toISOString()
          : null,
      },
    };
  });

  // --- Organisations ---------------------------------------------------------------------
  app.get(
    '/organizations',
    {
      schema: {
        querystring: Type.Object({ q: Type.Optional(Type.String({ maxLength: 100 })) }, Strict),
      },
    },
    async (request) => {
      await requirePermission(request, services, 'platform.organizations.read');
      const q = ((request.query as { q?: string }).q ?? '').trim();
      const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const found = await rows(
        services,
        sql`SELECT o.id, o.name, o.slug, o.status, o.country, o.created_at,
            (SELECT count(*) FROM memberships m WHERE m.organization_id = o.id AND m.status = 'active') AS members,
            (SELECT count(*) FROM displays d WHERE d.organization_id = o.id AND d.lifecycle_status = 'active') AS displays,
            (SELECT count(*) FROM players p WHERE p.organization_id = o.id AND p.lifecycle_status = 'paired') AS players
          FROM organizations o
          WHERE o.deleted_at IS NULL
            AND (${q} = '' OR o.name ILIKE ${pattern} OR o.slug ILIKE ${pattern} OR o.id::text = ${q})
          ORDER BY o.created_at DESC LIMIT 50`,
      );
      return {
        items: found.map((o) => ({
          id: o.id,
          name: o.name,
          slug: o.slug,
          status: o.status,
          country: o.country,
          created_at: iso(o.created_at),
          members: num(o.members),
          active_displays: num(o.displays),
          paired_players: num(o.players),
        })),
      };
    },
  );

  app.get(
    '/organizations/:id',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const context = await requirePermission(request, services, 'platform.organizations.read');
      const reason = supportReason(request);
      const { id } = request.params as { id: string };
      const [organization] = await rows(
        services,
        sql`SELECT id, name, slug, status, country, timezone, screenshots_enabled, created_at
            FROM organizations WHERE id = ${id} AND deleted_at IS NULL`,
      );
      if (!organization) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Organisation introuvable.');
      const members = await rows(
        services,
        sql`SELECT m.id, m.status, u.email_normalized, u.mfa_enabled,
              coalesce(array_agg(g.role_key ORDER BY g.role_key) FILTER (WHERE g.role_key IS NOT NULL), '{}') AS roles
            FROM memberships m
            JOIN users u ON u.id = m.user_id
            LEFT JOIN membership_grants g ON g.membership_id = m.id
            WHERE m.organization_id = ${id}
            GROUP BY m.id, m.status, u.email_normalized, u.mfa_enabled
            ORDER BY m.created_at`,
      );
      const [usage] = await rows(
        services,
        sql`SELECT
            (SELECT count(*) FROM sites WHERE organization_id = ${id} AND deleted_at IS NULL) AS sites,
            (SELECT count(*) FROM displays WHERE organization_id = ${id} AND lifecycle_status = 'active') AS displays,
            (SELECT observed_value FROM usage_counters WHERE organization_id = ${id} AND category = 'storage_bytes') AS storage_used,
            (SELECT reserved_value FROM usage_counters WHERE organization_id = ${id} AND category = 'storage_bytes') AS storage_reserved`,
      );
      const entitlements = platformCan(context.roles, 'platform.entitlements.read')
        ? {
            max_users: await services.entitlements.maxUsers(id),
            display_slots: await services.entitlements.displaySlots(id),
            storage_bytes: await services.entitlements.storageBytes(id),
            features: [...(await services.entitlements.features(id))],
          }
        : null;
      await platformAudit(services.platform, request, context, {
        action: 'platform.organization.viewed',
        permission: 'platform.organizations.read',
        targetType: 'organization',
        targetId: id,
        result: 'success',
        reason,
      });
      return {
        organization: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          status: organization.status,
          country: organization.country,
          timezone: organization.timezone,
          screenshots_enabled: organization.screenshots_enabled,
          created_at: iso(organization.created_at),
        },
        members: members.map((m) => ({
          membership_id: m.id,
          status: m.status,
          email: maskEmail(String(m.email_normalized)),
          mfa_enabled: m.mfa_enabled,
          roles: m.roles,
        })),
        usage: {
          sites: num(usage!.sites),
          active_displays: num(usage!.displays),
          active_members: members.filter((m) => m.status === 'active').length,
          storage_used_bytes: num(usage!.storage_used),
          storage_reserved_bytes: num(usage!.storage_reserved),
        },
        entitlements,
        subscription: platformCan(context.roles, 'platform.billing.read')
          ? await organizationSubscription(services, id)
          : { available: false, reason: 'Consultation de la facturation non autorisée.' },
      };
    },
  );

  app.get(
    '/organizations/:id/fleet',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const context = await requirePermission(
        request,
        services,
        'platform.organizations.diagnostics',
      );
      const reason = supportReason(request);
      const { id } = request.params as { id: string };
      const presence = services.config.presenceTimeoutSeconds;
      const players = await rows(
        services,
        sql`SELECT p.id, p.name, p.type, p.lifecycle_status, p.app_version, p.os, p.architecture,
              p.last_seen_at, s.renderer, s.disk_free_bytes, s.disk_total_bytes, s.renderer_restarts,
              s.status_received_at,
              (p.last_seen_at > now() - make_interval(secs => ${presence})) AS online
            FROM players p LEFT JOIN player_status s ON s.player_id = p.id
            WHERE p.organization_id = ${id} AND p.lifecycle_status <> 'deleted'
            ORDER BY p.name`,
      );
      const displays = await rows(
        services,
        sql`SELECT d.id, d.name, d.width, d.height, d.lifecycle_status, d.manifest_version,
              o.output_key, o.player_id
            FROM displays d
            LEFT JOIN display_assignments a ON a.display_id = d.id AND a.ended_at IS NULL
            LEFT JOIN player_outputs o ON o.id = a.player_output_id
            WHERE d.organization_id = ${id} AND d.lifecycle_status <> 'archived'
            ORDER BY d.name`,
      );
      const incidents = await rows(
        services,
        sql`SELECT id, rule, severity, target_type, target_id, opened_at, suspected_platform
            FROM alerts WHERE organization_id = ${id} AND status = 'open' ORDER BY opened_at DESC`,
      );
      await platformAudit(services.platform, request, context, {
        action: 'platform.organization.diagnostics_viewed',
        permission: 'platform.organizations.diagnostics',
        targetType: 'organization',
        targetId: id,
        result: 'success',
        reason,
      });
      return {
        players: players.map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          lifecycle_status: p.lifecycle_status,
          app_version: p.app_version,
          os: p.os,
          architecture: p.architecture,
          last_seen_at: iso(p.last_seen_at),
          online: p.online === true,
          renderer: p.renderer ?? null,
          renderer_restarts: p.renderer_restarts ?? null,
          disk_free_bytes: p.disk_free_bytes === null ? null : num(p.disk_free_bytes),
          disk_total_bytes: p.disk_total_bytes === null ? null : num(p.disk_total_bytes),
          status_received_at: iso(p.status_received_at),
        })),
        displays: displays.map((d) => ({
          id: d.id,
          name: d.name,
          width: d.width,
          height: d.height,
          lifecycle_status: d.lifecycle_status,
          manifest_version: d.manifest_version === null ? null : String(d.manifest_version),
          assigned_player_id: d.player_id ?? null,
          output_key: d.output_key ?? null,
        })),
        incidents: incidents.map((i) => ({
          id: i.id,
          rule: i.rule,
          severity: i.severity,
          target_type: i.target_type,
          target_id: i.target_id,
          opened_at: iso(i.opened_at),
          suspected_platform: i.suspected_platform,
        })),
      };
    },
  );

  // --- Incidents et tâches (Operator, Support) --------------------------------------------
  app.get('/incidents', async (request) => {
    await requirePermission(request, services, 'platform.incidents.read');
    const open = await rows(
      services,
      sql`SELECT a.id, a.organization_id, o.name AS organization_name, a.rule, a.severity,
            a.target_type, a.opened_at, a.suspected_platform
          FROM alerts a JOIN organizations o ON o.id = a.organization_id
          WHERE a.status = 'open' ORDER BY a.suspected_platform DESC, a.opened_at DESC LIMIT 200`,
    );
    return {
      items: open.map((i) => ({
        id: i.id,
        organization_id: i.organization_id,
        organization_name: i.organization_name,
        rule: i.rule,
        severity: i.severity,
        target_type: i.target_type,
        opened_at: iso(i.opened_at),
        suspected_platform: i.suspected_platform,
      })),
    };
  });

  app.get('/jobs', async (request) => {
    await requirePermission(request, services, 'platform.jobs.read');
    const failed = await rows(
      services,
      sql`SELECT j.id, j.organization_id, o.name AS organization_name, j.kind, j.attempts,
            j.max_attempts, j.last_error, j.finished_at, j.created_at
          FROM jobs j LEFT JOIN organizations o ON o.id = j.organization_id
          WHERE j.state = 'failed' ORDER BY j.finished_at DESC NULLS LAST LIMIT 100`,
    );
    return {
      items: failed.map((j) => ({
        id: j.id,
        organization_id: j.organization_id ?? null,
        organization_name: j.organization_name ?? null,
        kind: j.kind,
        attempts: num(j.attempts),
        max_attempts: num(j.max_attempts),
        last_error: j.last_error ? String(j.last_error).slice(0, 300) : null,
        finished_at: iso(j.finished_at),
        created_at: iso(j.created_at),
      })),
    };
  });

  // --- Comptes clients : recherche par adresse exacte seulement ---------------------------
  app.get(
    '/customers',
    { schema: { querystring: Type.Object({ email: Email }, Strict) } },
    async (request) => {
      const context = await requirePermission(request, services, 'platform.customers.lookup');
      const reason = supportReason(request);
      const email = (request.query as { email: string }).email.trim().toLowerCase();
      const [user] = await rows(
        services,
        sql`SELECT id, email_normalized, display_name, status, email_verified_at, mfa_enabled, created_at
            FROM users WHERE email_normalized = ${email}`,
      );
      await platformAudit(services.platform, request, context, {
        action: 'platform.customer.lookup',
        permission: 'platform.customers.lookup',
        targetType: 'user',
        targetId: (user?.id as string | undefined) ?? null,
        result: 'success',
        reason,
        metadata: { found: Boolean(user) },
      });
      if (!user) return { customer: null };
      return { customer: await describeCustomer(services, String(user.id)) };
    },
  );

  // --- Journal d’audit de la plateforme ----------------------------------------------------
  app.get(
    '/audit',
    {
      schema: {
        querystring: Type.Object(
          {
            before: Type.Optional(Type.String({ maxLength: 40 })),
            action: Type.Optional(Type.String({ maxLength: 80 })),
          },
          Strict,
        ),
      },
    },
    async (request) => {
      await requirePermission(request, services, 'platform.audit.read');
      const { before, action } = request.query as { before?: string; action?: string };
      const cursor = before ? new Date(before) : null;
      if (cursor && Number.isNaN(cursor.getTime())) {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Curseur invalide.');
      }
      const entries = await rows(
        services,
        sql`SELECT a.id, a.created_at, a.action, a.permission, a.target_type, a.target_id, a.result,
              a.reason, a.metadata, a.ip, u.email_normalized AS actor_email
            FROM audit_logs a LEFT JOIN platform_users u ON u.id = a.actor_id
            WHERE a.actor_type = 'platform_user'
              AND (${cursor}::timestamptz IS NULL OR a.created_at < ${cursor}::timestamptz)
              AND (${action ?? ''} = '' OR a.action = ${action ?? ''})
            ORDER BY a.created_at DESC LIMIT 100`,
      );
      return {
        items: entries.map((e) => ({
          id: e.id,
          created_at: iso(e.created_at),
          actor_email: e.actor_email ?? null,
          action: e.action,
          permission: e.permission,
          target_type: e.target_type,
          target_id: e.target_id,
          result: e.result,
          reason: e.reason,
          metadata: e.metadata,
          ip: e.ip ?? null,
        })),
      };
    },
  );

  // --- Catalogue de templates (versionné avec le code, ADR-010) ----------------------------
  app.get('/templates', async (request) => {
    await requirePermission(request, services, 'platform.templates.read');
    return {
      source: 'code',
      items: TEMPLATES.map((t) => ({
        key: t.key,
        version: t.version,
        name: t.name,
        category: t.category,
        description: t.description,
        required_features: t.required_features,
        canvas: { width: t.document.canvas.width, height: t.document.canvas.height },
      })),
    };
  });
}

/** Fiche de support d’un compte client : état, sécurité, appartenances. */
export async function describeCustomer(services: AdminServices, userId: string) {
  const [user] = await rows(
    services,
    sql`SELECT id, email_normalized, display_name, status, email_verified_at, mfa_enabled, created_at
        FROM users WHERE id = ${userId}`,
  );
  if (!user) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Compte introuvable.');
  const [sessions] = await rows(
    services,
    sql`SELECT count(*) AS active, max(last_seen_at) AS last_seen FROM user_sessions
        WHERE user_id = ${userId} AND revoked_at IS NULL AND expires_at > now() AND idle_expires_at > now()`,
  );
  const memberships = await rows(
    services,
    sql`SELECT m.organization_id, o.name AS organization_name, m.status,
          coalesce(array_agg(g.role_key ORDER BY g.role_key) FILTER (WHERE g.role_key IS NOT NULL), '{}') AS roles
        FROM memberships m JOIN organizations o ON o.id = m.organization_id
        LEFT JOIN membership_grants g ON g.membership_id = m.id
        WHERE m.user_id = ${userId}
        GROUP BY m.organization_id, o.name, m.status ORDER BY o.name`,
  );
  return {
    id: user.id as string,
    email: user.email_normalized as string,
    display_name: (user.display_name as string | null) ?? null,
    status: user.status as string,
    email_verified: user.email_verified_at !== null,
    mfa_enabled: user.mfa_enabled === true,
    created_at: iso(user.created_at),
    active_sessions: num(sessions!.active),
    last_seen_at: iso(sessions!.last_seen),
    memberships: memberships.map((m) => ({
      organization_id: m.organization_id,
      organization_name: m.organization_name,
      status: m.status,
      roles: m.roles,
    })),
  };
}
