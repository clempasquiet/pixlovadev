import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  inet,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, id, updatedAt } from './common.js';

/**
 * Rôles plateforme (ADM-002). Ils n’ont aucun lien avec les rôles d’organisation : un
 * Owner d’organisation n’obtient aucun droit plateforme (ADR-016).
 */
export const PLATFORM_ROLES = [
  'super_admin',
  'support',
  'billing_admin',
  'operations',
  'content_admin',
] as const;

/**
 * Opérateurs de la plateforme, distincts des comptes clients (`users`). Un compte créé
 * est `pending` jusqu’à son activation (mot de passe et TOTP) par code à usage unique.
 * Tables sans tenant, accessibles au seul rôle `pixlova_platform` (migration de droits).
 */
export const platformUsers = pgTable(
  'platform_users',
  {
    id: id(),
    emailNormalized: text('email_normalized').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash'),
    status: text('status', { enum: ['pending', 'active', 'disabled'] })
      .notNull()
      .default('pending'),
    createdBy: uuid('created_by').references((): AnyPgColumn => platformUsers.id),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_users_email_unique').on(t.emailNormalized),
    check('platform_users_status_check', sql`${t.status} in ('pending', 'active', 'disabled')`),
    check(
      'platform_users_email_normalized_check',
      sql`${t.emailNormalized} = lower(${t.emailNormalized})`,
    ),
  ],
);

export const platformUserRoles = pgTable(
  'platform_user_roles',
  {
    platformUserId: uuid('platform_user_id')
      .notNull()
      .references(() => platformUsers.id),
    role: text('role', { enum: PLATFORM_ROLES }).notNull(),
    grantedBy: uuid('granted_by').references(() => platformUsers.id),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.platformUserId, t.role] }),
    check(
      'platform_user_roles_role_check',
      sql`${t.role} in ('super_admin', 'support', 'billing_admin', 'operations', 'content_admin')`,
    ),
  ],
);

/** Sessions courtes et révocables ; seule l’empreinte du jeton est stockée. */
export const platformSessions = pgTable(
  'platform_sessions',
  {
    id: id(),
    platformUserId: uuid('platform_user_id')
      .notNull()
      .references(() => platformUsers.id),
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    authenticatedAt: timestamp('authenticated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Second facteur validé ; NULL : seules les routes de second facteur sont ouvertes. */
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    uniqueIndex('platform_sessions_token_hash_unique').on(t.tokenHash),
    index('platform_sessions_user_idx').on(t.platformUserId, t.expiresAt),
  ],
);

/** TOTP obligatoire (ADM-002), secret chiffré ; un seul facteur actif par opérateur. */
export const platformMfaCredentials = pgTable(
  'platform_mfa_credentials',
  {
    id: id(),
    platformUserId: uuid('platform_user_id')
      .notNull()
      .references(() => platformUsers.id),
    encryptedSecret: text('encrypted_secret').notNull(),
    lastUsedStep: bigint('last_used_step', { mode: 'number' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('platform_mfa_credentials_one_active')
      .on(t.platformUserId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/**
 * Codes d’activation à usage unique : premier accès ou réinitialisation des facteurs
 * d’un opérateur. Remis hors bande par le SuperAdmin qui les émet ; jamais par email.
 */
export const platformActivationTokens = pgTable(
  'platform_activation_tokens',
  {
    id: id(),
    platformUserId: uuid('platform_user_id')
      .notNull()
      .references(() => platformUsers.id),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => platformUsers.id),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('platform_activation_tokens_hash_unique').on(t.tokenHash),
    index('platform_activation_tokens_user_idx').on(t.platformUserId),
  ],
);
