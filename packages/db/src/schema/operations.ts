import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  inet,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appRole, createdAt, currentOrganization, id, tenantPolicy, updatedAt } from './common.js';
import { organizations } from './identity.js';

/**
 * Journal d’audit en ajout seul pour les comptes applicatifs (IAM-008, SEC-016) :
 * `pixlova_app` n’a que INSERT et SELECT (migration de droits). Aucun secret dans `metadata`.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: id(),
    /** NULL : action plateforme sans tenant, invisible des tenants. */
    organizationId: uuid('organization_id').references(() => organizations.id),
    actorType: text('actor_type', {
      enum: ['user', 'player', 'platform_user', 'system'],
    }).notNull(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    permission: text('permission'),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    result: text('result', { enum: ['success', 'denied', 'failed'] }).notNull(),
    reason: text('reason'),
    requestId: uuid('request_id'),
    ip: inet('ip'),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_org_created_idx').on(t.organizationId, t.createdAt, t.id),
    check(
      'audit_logs_actor_type_check',
      sql`${t.actorType} in ('user', 'player', 'platform_user', 'system')`,
    ),
    check('audit_logs_result_check', sql`${t.result} in ('success', 'denied', 'failed')`),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appRole,
      using: sql`${t.organizationId} = ${currentOrganization}`,
      withCheck: sql`${t.organizationId} = ${currentOrganization}`,
    }),
  ],
).enableRLS();

/**
 * Outbox transactionnelle (ARC-004) : écrite dans la transaction métier, relayée vers
 * les files par un dispatcher idempotent (rôle système). Livraison au moins une fois.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    organizationId: uuid('organization_id').references(() => organizations.id),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: createdAt(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
  },
  (t) => [
    index('outbox_events_pending_idx')
      .on(t.id)
      .where(sql`${t.dispatchedAt} is null`),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appRole,
      using: sql`${t.organizationId} = ${currentOrganization}`,
      withCheck: sql`${t.organizationId} = ${currentOrganization}`,
    }),
  ],
).enableRLS();

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed'] as const;

/**
 * File de tâches durable (ARC-004, ADR-009). La ligne est la source de vérité : écrite
 * dans la transaction métier, réclamée par un worker (`FOR UPDATE SKIP LOCKED`) sous un
 * bail qui expire en cas de panne. Une seule tâche active par (`kind`, `dedupe_key`).
 * `organization_id` NULL : tâche système, invisible du rôle applicatif.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    organizationId: uuid('organization_id').references(() => organizations.id),
    kind: text('kind').notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    state: text('state', { enum: JOB_STATES }).notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('jobs_active_dedupe_unique')
      .on(t.kind, t.dedupeKey)
      .where(sql`${t.state} in ('queued', 'running')`),
    index('jobs_queued_idx')
      .on(t.runAfter)
      .where(sql`${t.state} = 'queued'`),
    index('jobs_running_lease_idx')
      .on(t.leaseExpiresAt)
      .where(sql`${t.state} = 'running'`),
    index('jobs_org_kind_idx').on(t.organizationId, t.kind, t.createdAt),
    check('jobs_state_check', sql`${t.state} in ('queued', 'running', 'succeeded', 'failed')`),
    check('jobs_attempts_check', sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1`),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appRole,
      using: sql`${t.organizationId} = ${currentOrganization}`,
      withCheck: sql`${t.organizationId} = ${currentOrganization}`,
    }),
  ],
).enableRLS();

/**
 * Compteurs d’usage réconciliables (DATA-008) : `observed_value` consommé, `reserved_value`
 * réservé par des opérations en cours. Toute réservation se fait sous verrou de la ligne.
 */
export const usageCounters = pgTable(
  'usage_counters',
  {
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id),
    category: text('category', { enum: ['storage_bytes'] }).notNull(),
    observedValue: bigint('observed_value', { mode: 'number' }).notNull().default(0),
    reservedValue: bigint('reserved_value', { mode: 'number' }).notNull().default(0),
    measuredAt: timestamp('measured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.category] }),
    check('usage_counters_category_check', sql`${t.category} in ('storage_bytes')`),
    check('usage_counters_values_check', sql`${t.observedValue} >= 0 and ${t.reservedValue} >= 0`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();
