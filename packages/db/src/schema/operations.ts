import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  inet,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { appRole, createdAt, currentOrganization, id } from './common.js';
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
