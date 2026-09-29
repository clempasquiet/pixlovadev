import { sql } from 'drizzle-orm';
import { pgPolicy, pgRole, timestamp, uuid, type PgColumn } from 'drizzle-orm/pg-core';

/**
 * Rôles PostgreSQL (créés par `sql/bootstrap-roles.sql`, jamais par les migrations) :
 * - `pixlova_owner`  : propriétaire du schéma, exécute les migrations ;
 * - `pixlova_app`    : API et workers sous contexte tenant, soumis à RLS ;
 * - `pixlova_system` : opérations explicitement inter-tenants (BYPASSRLS).
 */
export const appRole = pgRole('pixlova_app').existing();

/**
 * Organisation active de la transaction, positionnée par `withTenant` via
 * `set_config('pixlova.organization_id', …, true)`. Absente → NULL → aucune ligne (fail closed).
 */
export const currentOrganization = sql`nullif(current_setting('pixlova.organization_id', true), '')::uuid`;

/** Politique RLS d’isolation par tenant (SEC-004), défense complémentaire des contrôles applicatifs. */
export function tenantPolicy(column: PgColumn) {
  return pgPolicy('tenant_isolation', {
    as: 'permissive',
    for: 'all',
    to: appRole,
    using: sql`${column} = ${currentOrganization}`,
    withCheck: sql`${column} = ${currentOrganization}`,
  });
}

export const id = () => uuid('id').primaryKey().defaultRandom();
export const organizationId = () => uuid('organization_id').notNull();
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
export const deletedAt = () => timestamp('deleted_at', { withTimezone: true });
