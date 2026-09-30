/**
 * Alertes et incidents (SUP-006 à SUP-008, OBS-010, OBS-011, ADR-014).
 *
 * Évaluation périodique, idempotente, sous verrou consultatif : une seule instance du
 * worker l’exécute à la fois. Lectures inter-tenants par le rôle système ; chaque
 * transition d’incident est écrite sous le tenant (RLS), avec son événement de timeline et,
 * le cas échéant, sa notification en outbox dans la même transaction.
 */
import { schema, withTenant, type Transaction } from '@pixlova/db';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { WorkerContext } from '../context.js';

type Rule = (typeof schema.ALERT_RULES)[number];
type AlertRow = typeof schema.alerts.$inferSelect;

/** Seuils [à valider] ; surchargeables par l’environnement du worker. */
export interface AlertingConfig {
  presenceTimeoutSeconds: number;
  offlineMinutes: number;
  /** Contact rétabli et stable pendant cette durée avant résolution. */
  offlineClearSeconds: number;
  manifestMinutes: number;
  playbackErrorThreshold: number;
  playbackWindowMinutes: number;
  diskOpenRatio: number;
  diskClearRatio: number;
  reminderHours: number;
  platformRatio: number;
  platformMinPlayers: number;
  platformWindowMinutes: number;
}

export const DEFAULT_ALERTING: AlertingConfig = {
  presenceTimeoutSeconds: 90,
  offlineMinutes: 5,
  offlineClearSeconds: 120,
  manifestMinutes: 10,
  playbackErrorThreshold: 3,
  playbackWindowMinutes: 15,
  diskOpenRatio: 0.9,
  diskClearRatio: 0.85,
  reminderHours: 24,
  platformRatio: 0.3,
  platformMinPlayers: 10,
  platformWindowMinutes: 5,
};

/** Types d’événements comptés par la règle `playback_errors`. */
export const PLAYBACK_ERROR_EVENTS = ['PLAYBACK_ERROR', 'ASSET_DOWNLOAD_FAILED', 'MANIFEST_FAILED'];

const SEVERITY: Record<Rule, 'warning' | 'error'> = {
  player_offline: 'warning',
  manifest_not_applied: 'warning',
  delivery_failed: 'error',
  playback_errors: 'warning',
  disk_low: 'warning',
};

/** Clé du verrou consultatif de l’évaluation (constante applicative). */
const LOCK_KEY = 7_014_001;

interface Candidate {
  organizationId: string;
  rule: Rule;
  targetType: 'player' | 'display';
  targetId: string;
  siteId: string | null;
  /** Condition d’ouverture (ou de maintien). */
  firing: boolean;
  /** Condition de résolution (hystérésis) ; `false` si la mesure manque. */
  clear: boolean;
  /** Displays concernés (maintenance au niveau Display). */
  displays: string[];
  details: Record<string, string | number | null>;
}

export interface EvaluationReport {
  opened: number;
  resolved: number;
  notified: number;
  suspectedPlatform: boolean;
}

const key = (org: string, rule: string, target: string) => `${org}|${rule}|${target}`;

export async function evaluateAlerts(ctx: WorkerContext): Promise<EvaluationReport | null> {
  const config = ctx.alerting ?? DEFAULT_ALERTING;
  return ctx.systemDb.transaction(async (lock) => {
    const result = await lock.execute(sql`select pg_try_advisory_xact_lock(${LOCK_KEY}) as locked`);
    if (!(result.rows[0] as { locked?: boolean } | undefined)?.locked) return null;
    return evaluate(ctx, config);
  });
}

async function evaluate(ctx: WorkerContext, config: AlertingConfig): Promise<EvaluationReport> {
  const now = ctx.now();
  const db = ctx.systemDb;
  const presenceMs = config.presenceTimeoutSeconds * 1000;
  const players = await db
    .select({
      id: schema.players.id,
      organizationId: schema.players.organizationId,
      siteId: schema.players.siteId,
      name: schema.players.name,
      lastSeenAt: schema.players.lastSeenAt,
      diskFree: schema.playerStatus.diskFreeBytes,
      diskTotal: schema.playerStatus.diskTotalBytes,
    })
    .from(schema.players)
    .leftJoin(schema.playerStatus, eq(schema.playerStatus.playerId, schema.players.id))
    .where(
      and(
        eq(schema.players.lifecycleStatus, 'paired'),
        isNull(schema.players.deletedAt),
        isNotNull(schema.players.lastSeenAt),
      ),
    );
  const assignments = await db
    .select({
      displayId: schema.displayAssignments.displayId,
      organizationId: schema.displayAssignments.organizationId,
      generation: schema.displayAssignments.generation,
      playerId: schema.playerOutputs.playerId,
      siteId: schema.displays.siteId,
      name: schema.displays.name,
    })
    .from(schema.displayAssignments)
    .innerJoin(
      schema.playerOutputs,
      eq(schema.playerOutputs.id, schema.displayAssignments.playerOutputId),
    )
    .innerJoin(schema.displays, eq(schema.displays.id, schema.displayAssignments.displayId))
    .where(and(isNull(schema.displayAssignments.endedAt), isNull(schema.displays.deletedAt)));
  const desired = assignments.length
    ? await db
        .selectDistinctOn(
          [
            schema.manifests.displayId,
            schema.manifests.playerId,
            schema.manifests.assignmentGeneration,
          ],
          {
            displayId: schema.manifests.displayId,
            playerId: schema.manifests.playerId,
            generation: schema.manifests.assignmentGeneration,
            manifestId: schema.manifests.id,
            version: schema.manifests.version,
            state: schema.manifestDeliveries.state,
            errorCode: schema.manifestDeliveries.errorCode,
            since: schema.manifestDeliveries.createdAt,
          },
        )
        .from(schema.manifests)
        .innerJoin(
          schema.manifestDeliveries,
          and(
            eq(schema.manifestDeliveries.manifestId, schema.manifests.id),
            eq(schema.manifestDeliveries.playerId, schema.manifests.playerId),
          ),
        )
        .where(
          inArray(
            schema.manifests.displayId,
            assignments.map((a) => a.displayId),
          ),
        )
        .orderBy(
          schema.manifests.displayId,
          schema.manifests.playerId,
          schema.manifests.assignmentGeneration,
          desc(schema.manifests.version),
        )
    : [];
  const windowStart = new Date(now.getTime() - config.playbackWindowMinutes * 60_000);
  const errorCounts = await db
    .select({
      displayId: schema.timelineEvents.displayId,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.timelineEvents)
    .where(
      and(
        isNotNull(schema.timelineEvents.displayId),
        inArray(schema.timelineEvents.type, PLAYBACK_ERROR_EVENTS),
        gt(schema.timelineEvents.observedAt, windowStart),
      ),
    )
    .groupBy(schema.timelineEvents.displayId);
  const errors = new Map(errorCounts.map((row) => [row.displayId!, row.n]));
  const openAlerts = await db.select().from(schema.alerts).where(eq(schema.alerts.status, 'open'));
  const maintenance = await db
    .select()
    .from(schema.maintenanceWindows)
    .where(
      and(
        isNull(schema.maintenanceWindows.cancelledAt),
        lte(schema.maintenanceWindows.startsAt, now),
        gt(schema.maintenanceWindows.endsAt, now),
      ),
    );

  // --- Conditions par règle et cible -----------------------------------------------------
  const candidates = new Map<string, Candidate>();
  const add = (candidate: Candidate) =>
    candidates.set(key(candidate.organizationId, candidate.rule, candidate.targetId), candidate);
  const online = new Map<string, boolean>();
  const displaysOf = new Map<string, string[]>();
  for (const a of assignments) {
    displaysOf.set(a.playerId, [...(displaysOf.get(a.playerId) ?? []), a.displayId]);
  }
  for (const player of players) {
    const silentMs = now.getTime() - player.lastSeenAt!.getTime();
    online.set(player.id, silentMs <= presenceMs);
    const base = {
      organizationId: player.organizationId,
      targetType: 'player' as const,
      targetId: player.id,
      siteId: player.siteId,
      displays: displaysOf.get(player.id) ?? [],
    };
    add({
      ...base,
      rule: 'player_offline',
      firing: silentMs > config.offlineMinutes * 60_000,
      clear: silentMs <= presenceMs,
      details: { name: player.name, last_seen_at: player.lastSeenAt!.toISOString() },
    });
    const measured = player.diskFree !== null && player.diskTotal !== null && player.diskTotal > 0;
    const used = measured ? 1 - player.diskFree! / player.diskTotal! : null;
    add({
      ...base,
      rule: 'disk_low',
      firing: used !== null && used > config.diskOpenRatio,
      clear: used !== null && used < config.diskClearRatio,
      details: {
        name: player.name,
        used_ratio: used === null ? null : Math.round(used * 1000) / 1000,
      },
    });
  }
  for (const a of assignments) {
    const wanted = desired.find(
      (d) =>
        d.displayId === a.displayId && d.playerId === a.playerId && d.generation === a.generation,
    );
    const base = {
      organizationId: a.organizationId,
      targetType: 'display' as const,
      targetId: a.displayId,
      siteId: a.siteId,
      displays: [a.displayId],
    };
    const details = {
      name: a.name,
      manifest_id: wanted?.manifestId ?? null,
      version: wanted ? String(wanted.version) : null,
      state: wanted?.state ?? null,
    };
    const pendingForMs = wanted ? now.getTime() - wanted.since.getTime() : 0;
    add({
      ...base,
      rule: 'manifest_not_applied',
      firing:
        !!wanted &&
        !['applied', 'failed', 'superseded'].includes(wanted.state) &&
        pendingForMs > config.manifestMinutes * 60_000 &&
        online.get(a.playerId) === true,
      clear: !wanted || wanted.state === 'applied',
      details,
    });
    add({
      ...base,
      rule: 'delivery_failed',
      firing: wanted?.state === 'failed',
      clear: !wanted || wanted.state === 'applied',
      details: { ...details, error_code: wanted?.errorCode ?? null },
    });
    const count = errors.get(a.displayId) ?? 0;
    add({
      ...base,
      rule: 'playback_errors',
      firing: count >= config.playbackErrorThreshold,
      clear: count === 0,
      details: { name: a.name, errors: count, window_minutes: config.playbackWindowMinutes },
    });
  }

  // --- Corrélation plateforme --------------------------------------------------------------
  const recentWindowMs = (config.offlineMinutes + config.platformWindowMinutes) * 60_000;
  const active = players.filter((p) => now.getTime() - p.lastSeenAt!.getTime() <= 86_400_000);
  const recentlyLost = active.filter((p) => {
    const silent = now.getTime() - p.lastSeenAt!.getTime();
    return silent > presenceMs && silent <= recentWindowMs;
  });
  const suspectedPlatform =
    recentlyLost.length >= config.platformMinPlayers &&
    recentlyLost.length > config.platformRatio * active.length;
  if (suspectedPlatform) {
    ctx.logger.warn(
      { lost: recentlyLost.length, active: active.length },
      'panne commune probable : notifications player_offline retenues',
    );
  }

  const inMaintenance = (c: {
    organizationId: string;
    siteId: string | null;
    displays: string[];
  }) =>
    maintenance.some(
      (m) =>
        m.organizationId === c.organizationId &&
        (m.scopeType === 'organization' ||
          (m.scopeType === 'site' && m.scopeId === c.siteId) ||
          (m.scopeType === 'display' && c.displays.includes(m.scopeId!))),
    );

  // --- Transitions ----------------------------------------------------------------------
  const report: EvaluationReport = { opened: 0, resolved: 0, notified: 0, suspectedPlatform };
  const open = new Map(openAlerts.map((a) => [key(a.organizationId, a.rule, a.targetId), a]));
  for (const [id, candidate] of candidates) {
    if (open.has(id) || !candidate.firing) continue;
    const opened = await withTenant(ctx.appDb, candidate.organizationId, async (tx) => {
      const [row] = await tx
        .insert(schema.alerts)
        .values({
          organizationId: candidate.organizationId,
          rule: candidate.rule,
          severity: SEVERITY[candidate.rule],
          targetType: candidate.targetType,
          targetId: candidate.targetId,
          siteId: candidate.siteId,
          openedAt: now,
          suspectedPlatform: suspectedPlatform && candidate.rule === 'player_offline',
          details: candidate.details,
        })
        .onConflictDoNothing()
        .returning();
      if (row) await incidentEvent(tx, row, 'INCIDENT_OPENED', now);
      return row ?? null;
    });
    if (opened) {
      open.set(id, opened);
      report.opened += 1;
    }
  }
  for (const [id, alert] of open) {
    const candidate = candidates.get(id);
    // Cible disparue (Player révoqué, Display désaffecté) : incident clos.
    const gone = !candidate;
    if (gone || candidate.clear) {
      const stable =
        alert.rule === 'player_offline' && !gone
          ? alert.clearingSince &&
            now.getTime() - alert.clearingSince.getTime() >= config.offlineClearSeconds * 1000
          : true;
      if (!stable) {
        if (!alert.clearingSince) await setClearing(ctx, alert, now);
        continue;
      }
      await resolve(ctx, alert, now, gone);
      report.resolved += 1;
      open.delete(id);
    } else if (alert.clearingSince) {
      await setClearing(ctx, alert, null);
    }
  }

  // --- Notifications (au plus une ouverture, une résolution, un rappel par période) -------
  const reminderMs = config.reminderHours * 3_600_000;
  for (const [id, alert] of open) {
    const candidate = candidates.get(id);
    const suspected =
      alert.suspectedPlatform ||
      (suspectedPlatform && alert.rule === 'player_offline' && !alert.notifiedOpenAt);
    const target = candidate ?? {
      organizationId: alert.organizationId,
      siteId: alert.siteId,
      displays: alert.targetType === 'display' ? [alert.targetId] : [],
    };
    if (suspected || inMaintenance(target)) {
      if (suspected && !alert.suspectedPlatform) await markSuspected(ctx, alert);
      continue;
    }
    const kind = !alert.notifiedOpenAt
      ? 'opened'
      : alert.lastNotifiedAt && now.getTime() - alert.lastNotifiedAt.getTime() >= reminderMs
        ? 'reminder'
        : null;
    if (!kind) continue;
    await notify(ctx, alert, kind, now);
    report.notified += 1;
  }
  return report;
}

async function incidentEvent(
  tx: Transaction,
  alert: AlertRow,
  type: 'INCIDENT_OPENED' | 'INCIDENT_RESOLVED',
  at: Date,
): Promise<void> {
  await tx.insert(schema.timelineEvents).values({
    organizationId: alert.organizationId,
    source: 'cloud',
    playerId: alert.targetType === 'player' ? alert.targetId : null,
    displayId: alert.targetType === 'display' ? alert.targetId : null,
    type,
    severity: type === 'INCIDENT_OPENED' ? alert.severity : 'info',
    observedAt: at,
    receivedAt: at,
    payload: { alert_id: alert.id, rule: alert.rule },
  });
}

async function setClearing(ctx: WorkerContext, alert: AlertRow, since: Date | null) {
  await withTenant(ctx.appDb, alert.organizationId, (tx) =>
    tx
      .update(schema.alerts)
      .set({ clearingSince: since, updatedAt: ctx.now() })
      .where(eq(schema.alerts.id, alert.id)),
  );
}

async function markSuspected(ctx: WorkerContext, alert: AlertRow) {
  await withTenant(ctx.appDb, alert.organizationId, (tx) =>
    tx
      .update(schema.alerts)
      .set({ suspectedPlatform: true, updatedAt: ctx.now() })
      .where(eq(schema.alerts.id, alert.id)),
  );
}

/** Notification transactionnelle : l’API la transforme en emails pour les destinataires. */
async function queueNotification(
  tx: Transaction,
  alert: AlertRow,
  kind: 'opened' | 'resolved' | 'reminder',
): Promise<void> {
  await tx.insert(schema.outboxEvents).values({
    organizationId: alert.organizationId,
    aggregateType: 'alert',
    aggregateId: alert.id,
    eventType: ALERT_NOTIFICATION,
    payload: { alert_id: alert.id, kind },
  });
}

export const ALERT_NOTIFICATION = 'alert.notification';

async function notify(
  ctx: WorkerContext,
  alert: AlertRow,
  kind: 'opened' | 'reminder',
  now: Date,
): Promise<void> {
  await withTenant(ctx.appDb, alert.organizationId, async (tx) => {
    const [updated] = await tx
      .update(schema.alerts)
      .set({
        ...(kind === 'opened' ? { notifiedOpenAt: now } : {}),
        lastNotifiedAt: now,
        updatedAt: now,
      })
      .where(and(eq(schema.alerts.id, alert.id), eq(schema.alerts.status, 'open')))
      .returning();
    if (updated) await queueNotification(tx, updated, kind);
  });
}

async function resolve(ctx: WorkerContext, alert: AlertRow, now: Date, gone: boolean) {
  await withTenant(ctx.appDb, alert.organizationId, async (tx) => {
    const [resolved] = await tx
      .update(schema.alerts)
      .set({
        status: 'resolved',
        resolvedAt: now,
        clearingSince: null,
        // Une ouverture annoncée est toujours suivie de l’annonce de sa résolution.
        ...(alert.notifiedOpenAt ? { notifiedResolvedAt: now } : {}),
        details: gone ? { ...(alert.details as object), resolution: 'target_gone' } : alert.details,
        updatedAt: now,
      })
      .where(and(eq(schema.alerts.id, alert.id), eq(schema.alerts.status, 'open')))
      .returning();
    if (!resolved) return;
    await incidentEvent(tx, resolved, 'INCIDENT_RESOLVED', now);
    if (resolved.notifiedOpenAt) await queueNotification(tx, resolved, 'resolved');
  });
}

/**
 * Présence perdue (SUP-002) : un événement par coupure, daté de l’échéance de présence,
 * pour la timeline. La reprise est tracée par l’API au heartbeat suivant.
 */
export async function recordPresenceLost(ctx: WorkerContext): Promise<number> {
  const config = ctx.alerting ?? DEFAULT_ALERTING;
  const now = ctx.now();
  const presenceMs = config.presenceTimeoutSeconds * 1000;
  const lost = await ctx.systemDb
    .select({
      id: schema.players.id,
      organizationId: schema.players.organizationId,
      lastSeenAt: schema.players.lastSeenAt,
    })
    .from(schema.players)
    .where(
      and(
        eq(schema.players.lifecycleStatus, 'paired'),
        isNull(schema.players.deletedAt),
        isNotNull(schema.players.lastSeenAt),
        lte(schema.players.lastSeenAt, new Date(now.getTime() - presenceMs)),
        gt(schema.players.lastSeenAt, new Date(now.getTime() - 7 * 86_400_000)),
        sql`not exists (select 1 from ${schema.timelineEvents} te
          where te.player_id = ${schema.players.id} and te.type = 'PRESENCE_LOST'
            and te.observed_at >= ${schema.players.lastSeenAt})`,
      ),
    )
    .limit(500);
  for (const player of lost) {
    const at = new Date(player.lastSeenAt!.getTime() + presenceMs);
    await withTenant(ctx.appDb, player.organizationId, (tx) =>
      tx.insert(schema.timelineEvents).values({
        organizationId: player.organizationId,
        source: 'cloud',
        playerId: player.id,
        type: 'PRESENCE_LOST',
        severity: 'warning',
        observedAt: at,
        receivedAt: now,
        payload: { last_seen_at: player.lastSeenAt!.toISOString() },
      }),
    );
  }
  return lost.length;
}
