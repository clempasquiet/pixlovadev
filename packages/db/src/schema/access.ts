import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, organizationId, tenantPolicy } from './common.js';
import { memberships, organizations, sites, users } from './identity.js';

/** Rôles système V1 (ADR-007) ; la définition des permissions vit dans `@pixlova/permissions`. */
const ROLE_KEYS_SQL = sql.raw(
  `('Owner', 'Admin', 'ContentManager', 'Operator', 'Technician', 'Viewer', 'BillingManager')`,
);

/** Rôle attribué à une appartenance, sur l’organisation ou sur des sites (IAM-003, IAM-005). */
export const membershipGrants = pgTable(
  'membership_grants',
  {
    id: id(),
    organizationId: organizationId(),
    membershipId: uuid('membership_id').notNull(),
    roleKey: text('role_key').notNull(),
    scopeType: text('scope_type', { enum: ['organization', 'sites'] }).notNull(),
    createdAt: createdAt(),
    createdBy: uuid('created_by').references(() => users.id),
  },
  (t) => [
    foreignKey({
      name: 'membership_grants_membership_same_tenant_fk',
      columns: [t.organizationId, t.membershipId],
      foreignColumns: [memberships.organizationId, memberships.id],
    }).onDelete('cascade'),
    unique('membership_grants_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('membership_grants_role_scope_unique').on(t.membershipId, t.roleKey, t.scopeType),
    check('membership_grants_role_check', sql`${t.roleKey} in ${ROLE_KEYS_SQL}`),
    check('membership_grants_scope_check', sql`${t.scopeType} in ('organization', 'sites')`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/** Scope par site normalisé : aucune liste JSON impossible à contraindre. */
export const membershipGrantSites = pgTable(
  'membership_grant_sites',
  {
    organizationId: organizationId(),
    grantId: uuid('grant_id').notNull(),
    siteId: uuid('site_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.grantId, t.siteId] }),
    foreignKey({
      name: 'membership_grant_sites_grant_same_tenant_fk',
      columns: [t.organizationId, t.grantId],
      foreignColumns: [membershipGrants.organizationId, membershipGrants.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'membership_grant_sites_site_same_tenant_fk',
      columns: [t.organizationId, t.siteId],
      foreignColumns: [sites.organizationId, sites.id],
    }),
    index('membership_grant_sites_site_idx').on(t.organizationId, t.siteId),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/**
 * Invitation à usage unique, expirante et révocable (IAM-002). L’acceptation, faite par
 * un compte qui n’appartient pas encore au tenant, passe par le rôle système.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: id(),
    organizationId: organizationId(),
    emailNormalized: text('email_normalized').notNull(),
    roleKey: text('role_key').notNull(),
    scopeType: text('scope_type', { enum: ['organization', 'sites'] }).notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.organizationId], foreignColumns: [organizations.id] }),
    unique('invitations_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('invitations_token_hash_unique').on(t.tokenHash),
    // Un renvoi ne crée pas plusieurs invitations actives pour la même adresse.
    uniqueIndex('invitations_one_pending')
      .on(t.organizationId, t.emailNormalized)
      .where(sql`${t.acceptedAt} is null and ${t.revokedAt} is null`),
    check('invitations_role_check', sql`${t.roleKey} in ${ROLE_KEYS_SQL}`),
    check('invitations_scope_check', sql`${t.scopeType} in ('organization', 'sites')`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

export const invitationSites = pgTable(
  'invitation_sites',
  {
    organizationId: organizationId(),
    invitationId: uuid('invitation_id').notNull(),
    siteId: uuid('site_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.invitationId, t.siteId] }),
    foreignKey({
      name: 'invitation_sites_invitation_same_tenant_fk',
      columns: [t.organizationId, t.invitationId],
      foreignColumns: [invitations.organizationId, invitations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'invitation_sites_site_same_tenant_fk',
      columns: [t.organizationId, t.siteId],
      foreignColumns: [sites.organizationId, sites.id],
    }),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();
