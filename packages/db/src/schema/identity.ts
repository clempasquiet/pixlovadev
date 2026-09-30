import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  char,
  foreignKey,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  appRole,
  createdAt,
  currentOrganization,
  deletedAt,
  id,
  organizationId,
  tenantPolicy,
  updatedAt,
} from './common.js';

export const organizations = pgTable(
  'organizations',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    country: char('country', { length: 2 }).notNull(),
    timezone: text('timezone').notNull(),
    status: text('status', { enum: ['active', 'suspended', 'deletion_pending', 'deleted'] })
      .notNull()
      .default('active'),
    /** Captures à la demande autorisées (SUP-004) ; désactivables par l’organisation. */
    screenshotsEnabled: boolean('screenshots_enabled').notNull().default(true),
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    uniqueIndex('organizations_slug_unique').on(t.slug),
    check(
      'organizations_status_check',
      sql`${t.status} in ('active', 'suspended', 'deletion_pending', 'deleted')`,
    ),
    check('organizations_country_check', sql`${t.country} ~ '^[A-Z]{2}$'`),
    pgPolicy('tenant_isolation', {
      as: 'permissive',
      for: 'all',
      to: appRole,
      using: sql`${t.id} = ${currentOrganization}`,
      withCheck: sql`${t.id} = ${currentOrganization}`,
    }),
  ],
).enableRLS();

/** Compte global : aucune propriété implicite des ressources de ses organisations (IAM-001). */
export const users = pgTable(
  'users',
  {
    id: id(),
    emailNormalized: text('email_normalized').notNull(),
    displayName: text('display_name'),
    passwordHash: text('password_hash'),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_email_normalized_unique').on(t.emailNormalized),
    check('users_status_check', sql`${t.status} in ('active', 'disabled')`),
    check('users_email_normalized_check', sql`${t.emailNormalized} = lower(${t.emailNormalized})`),
  ],
);

export const memberships = pgTable(
  'memberships',
  {
    id: id(),
    organizationId: organizationId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    status: text('status', { enum: ['active', 'suspended', 'revoked'] })
      .notNull()
      .default('active'),
    /** Emails d’alerte de supervision (SUP-006) ; désabonnement individuel. */
    alertEmails: boolean('alert_emails').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.organizationId], foreignColumns: [organizations.id] }),
    unique('memberships_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('memberships_org_user_unique').on(t.organizationId, t.userId),
    check('memberships_status_check', sql`${t.status} in ('active', 'suspended', 'revoked')`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/** Site avec fuseau optionnel ; hérité de l’organisation s’il est absent. */
export const sites = pgTable(
  'sites',
  {
    id: id(),
    organizationId: organizationId(),
    name: text('name').notNull(),
    timezone: text('timezone'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.organizationId], foreignColumns: [organizations.id] }),
    unique('sites_org_id_unique').on(t.organizationId, t.id),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();
