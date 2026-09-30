import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, organizationId, tenantPolicy, updatedAt } from './common.js';
import { displays, players } from './fleet.js';
import { organizations, users } from './identity.js';

/**
 * Dernier état connu d’un Player (SUP-001, OBS-003, ADR-014) : une ligne par Player.
 * Le heartbeat (30 s) met à jour le renderer et la lecture par Display ; le statut
 * complet (moins fréquent) met à jour les mesures. Mesures `NULL` = non disponibles.
 */
export const playerStatus = pgTable(
  'player_status',
  {
    playerId: uuid('player_id').primaryKey(),
    organizationId: organizationId(),
    heartbeatReceivedAt: timestamp('heartbeat_received_at', { withTimezone: true }),
    renderer: text('renderer'),
    /** Lecture déclarée par Display au dernier heartbeat. */
    displays: jsonb('displays')
      .notNull()
      .default(sql`'[]'::jsonb`),
    statusObservedAt: timestamp('status_observed_at', { withTimezone: true }),
    statusReceivedAt: timestamp('status_received_at', { withTimezone: true }),
    rendererRestarts: integer('renderer_restarts'),
    diskFreeBytes: bigint('disk_free_bytes', { mode: 'number' }),
    diskTotalBytes: bigint('disk_total_bytes', { mode: 'number' }),
    /** Dernier statut complet (`PlayerStatus`). */
    payload: jsonb('payload'),
  },
  (t) => [
    foreignKey({
      name: 'player_status_player_same_tenant_fk',
      columns: [t.organizationId, t.playerId],
      foreignColumns: [players.organizationId, players.id],
    }),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

export const TIMELINE_SEVERITIES = ['info', 'warning', 'error', 'critical'] as const;

/**
 * Événements de la timeline (PROTO-019, SUP-003, OBS-001) : ceux du Player (dédupliqués
 * par `(player_id, event_id)`) et ceux du cloud (présence, commandes, incidents).
 * `observed_at` est l’instant de l’événement, `received_at` celui de la réception.
 */
export const timelineEvents = pgTable(
  'timeline_events',
  {
    id: id(),
    organizationId: organizationId(),
    source: text('source', { enum: ['player', 'cloud'] }).notNull(),
    playerId: uuid('player_id'),
    displayId: uuid('display_id'),
    eventId: uuid('event_id'),
    bootId: uuid('boot_id'),
    seq: bigint('seq', { mode: 'number' }),
    assignmentGeneration: text('assignment_generation'),
    type: text('type').notNull(),
    severity: text('severity', { enum: TIMELINE_SEVERITIES }).notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    foreignKey({
      name: 'timeline_events_player_same_tenant_fk',
      columns: [t.organizationId, t.playerId],
      foreignColumns: [players.organizationId, players.id],
    }),
    foreignKey({
      name: 'timeline_events_display_same_tenant_fk',
      columns: [t.organizationId, t.displayId],
      foreignColumns: [displays.organizationId, displays.id],
    }),
    uniqueIndex('timeline_events_player_event_unique')
      .on(t.playerId, t.eventId)
      .where(sql`${t.eventId} is not null`),
    index('timeline_events_display_idx').on(t.organizationId, t.displayId, t.observedAt),
    index('timeline_events_player_idx').on(t.organizationId, t.playerId, t.observedAt),
    check('timeline_events_source_check', sql`${t.source} in ('player', 'cloud')`),
    check(
      'timeline_events_severity_check',
      sql`${t.severity} in ('info', 'warning', 'error', 'critical')`,
    ),
    check(
      'timeline_events_player_source_check',
      sql`${t.source} = 'cloud' or (${t.eventId} is not null and ${t.playerId} is not null)`,
    ),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

export const COMMAND_STATUSES = [
  'pending',
  'sent',
  'acknowledged',
  'success',
  'failed',
  'rejected',
  'expired',
  'cancelled',
  'unknown',
] as const;

/**
 * Commande distante (SUP-005, PROTO-007, PROTO-008). `envelope` conserve l’enveloppe
 * signée distribuée ; l’ACK n’est jamais un succès ; le résultat vient du Player.
 */
export const playerCommands = pgTable(
  'player_commands',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId(),
    playerId: uuid('player_id').notNull(),
    displayId: uuid('display_id'),
    assignmentGeneration: text('assignment_generation'),
    type: text('type').notNull(),
    params: jsonb('params')
      .notNull()
      .default(sql`'{}'::jsonb`),
    envelope: text('envelope').notNull(),
    payloadHash: text('payload_hash').notNull(),
    status: text('status', { enum: COMMAND_STATUSES }).notNull().default('pending'),
    requestedBy: uuid('requested_by'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    resultCode: text('result_code'),
    resultDetail: text('result_detail'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'player_commands_player_same_tenant_fk',
      columns: [t.organizationId, t.playerId],
      foreignColumns: [players.organizationId, players.id],
    }),
    foreignKey({
      name: 'player_commands_display_same_tenant_fk',
      columns: [t.organizationId, t.displayId],
      foreignColumns: [displays.organizationId, displays.id],
    }),
    foreignKey({ columns: [t.requestedBy], foreignColumns: [users.id] }),
    unique('player_commands_org_id_unique').on(t.organizationId, t.id),
    index('player_commands_player_status_idx').on(t.playerId, t.status, t.expiresAt),
    index('player_commands_org_created_idx').on(t.organizationId, t.createdAt),
    check(
      'player_commands_status_check',
      sql`${t.status} in ('pending', 'sent', 'acknowledged', 'success', 'failed', 'rejected', 'expired', 'cancelled', 'unknown')`,
    ),
    check('player_commands_window_check', sql`${t.issuedAt} < ${t.expiresAt}`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/**
 * Capture à la demande (SUP-004) : privée, liée à sa commande, supprimée à expiration.
 * `captured_at` est l’instant réel de l’image, jamais présentée comme un flux direct.
 */
export const screenshots = pgTable(
  'screenshots',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId(),
    playerId: uuid('player_id').notNull(),
    displayId: uuid('display_id').notNull(),
    commandId: uuid('command_id').notNull(),
    objectKey: text('object_key').notNull(),
    status: text('status', { enum: ['requested', 'uploading', 'available'] })
      .notNull()
      .default('requested'),
    sizeBytes: integer('size_bytes'),
    sha256: text('sha256'),
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    requestedBy: uuid('requested_by'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'screenshots_command_same_tenant_fk',
      columns: [t.organizationId, t.commandId],
      foreignColumns: [playerCommands.organizationId, playerCommands.id],
    }),
    foreignKey({
      name: 'screenshots_display_same_tenant_fk',
      columns: [t.organizationId, t.displayId],
      foreignColumns: [displays.organizationId, displays.id],
    }),
    foreignKey({ columns: [t.requestedBy], foreignColumns: [users.id] }),
    unique('screenshots_command_unique').on(t.commandId),
    index('screenshots_display_idx').on(t.organizationId, t.displayId, t.createdAt),
    index('screenshots_expires_idx').on(t.expiresAt),
    check('screenshots_status_check', sql`${t.status} in ('requested', 'uploading', 'available')`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

export const ALERT_RULES = [
  'player_offline',
  'manifest_not_applied',
  'delivery_failed',
  'playback_errors',
  'disk_low',
] as const;

/**
 * Incident d’alerte (SUP-006, SUP-007, OBS-010) : au plus un incident ouvert par règle et
 * cible ; les notifications d’ouverture et de résolution sont envoyées une fois.
 */
export const alerts = pgTable(
  'alerts',
  {
    id: id(),
    organizationId: organizationId(),
    rule: text('rule', { enum: ALERT_RULES }).notNull(),
    severity: text('severity', { enum: ['warning', 'error', 'critical'] }).notNull(),
    targetType: text('target_type', { enum: ['player', 'display'] }).notNull(),
    targetId: uuid('target_id').notNull(),
    siteId: uuid('site_id'),
    status: text('status', { enum: ['open', 'resolved'] })
      .notNull()
      .default('open'),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** Condition de résolution vue pour la première fois (période stable). */
    clearingSince: timestamp('clearing_since', { withTimezone: true }),
    notifiedOpenAt: timestamp('notified_open_at', { withTimezone: true }),
    notifiedResolvedAt: timestamp('notified_resolved_at', { withTimezone: true }),
    /** Panne commune probable côté plateforme : notifications retenues. */
    suspectedPlatform: boolean('suspected_platform').notNull().default(false),
    details: jsonb('details')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.organizationId], foreignColumns: [organizations.id] }),
    uniqueIndex('alerts_open_unique')
      .on(t.organizationId, t.rule, t.targetId)
      .where(sql`${t.status} = 'open'`),
    index('alerts_org_status_idx').on(t.organizationId, t.status, t.openedAt),
    check(
      'alerts_rule_check',
      sql`${t.rule} in ('player_offline', 'manifest_not_applied', 'delivery_failed', 'playback_errors', 'disk_low')`,
    ),
    check('alerts_status_check', sql`${t.status} in ('open', 'resolved')`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/**
 * Fenêtre de maintenance (SUP-008) : suspend les notifications, jamais la collecte, les
 * incidents ni la présence réelle. Portée : organisation, site ou Display.
 */
export const maintenanceWindows = pgTable(
  'maintenance_windows',
  {
    id: id(),
    organizationId: organizationId(),
    scopeType: text('scope_type', { enum: ['organization', 'site', 'display'] }).notNull(),
    scopeId: uuid('scope_id'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by').notNull(),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.organizationId], foreignColumns: [organizations.id] }),
    foreignKey({ columns: [t.createdBy], foreignColumns: [users.id] }),
    index('maintenance_windows_org_idx').on(t.organizationId, t.endsAt),
    check('maintenance_windows_period_check', sql`${t.startsAt} < ${t.endsAt}`),
    check(
      'maintenance_windows_scope_check',
      sql`(${t.scopeType} = 'organization') = (${t.scopeId} is null)`,
    ),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();
