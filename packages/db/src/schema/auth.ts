import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  customType,
  index,
  inet,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id } from './common.js';
import { users } from './identity.js';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * Sessions utilisateur révocables (SEC-002, IAM-007). Seule l’empreinte SHA-256 du
 * jeton est stockée ; le jeton brut ne quitte que le cookie `HttpOnly`.
 * Table globale (compte), sans tenant : les droits sont recalculés à chaque requête.
 */
export const userSessions = pgTable(
  'user_sessions',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull(),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** Expiration d’inactivité, repoussée à l’usage. */
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    /** Expiration absolue, jamais repoussée. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Dernière saisie du mot de passe : réauthentification récente des actions sensibles. */
    authenticatedAt: timestamp('authenticated_at', { withTimezone: true }).notNull().defaultNow(),
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true }),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason'),
  },
  (t) => [
    uniqueIndex('user_sessions_token_hash_unique').on(t.tokenHash),
    index('user_sessions_user_idx').on(t.userId, t.expiresAt),
  ],
);

/** Jetons à usage unique : vérification d’email et réinitialisation du mot de passe. */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    purpose: text('purpose', { enum: ['email_verification', 'password_reset'] }).notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('auth_tokens_token_hash_unique').on(t.tokenHash),
    index('auth_tokens_user_purpose_idx').on(t.userId, t.purpose),
    check(
      'auth_tokens_purpose_check',
      sql`${t.purpose} in ('email_verification', 'password_reset')`,
    ),
  ],
);

/** Secret TOTP chiffré (AES-256-GCM) ; un seul facteur actif par utilisateur. */
export const mfaCredentials = pgTable(
  'mfa_credentials',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    type: text('type', { enum: ['totp'] }).notNull(),
    encryptedSecret: text('encrypted_secret').notNull(),
    /** Dernier pas TOTP accepté : un code ne sert qu’une fois. */
    lastUsedStep: bigint('last_used_step', { mode: 'number' }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('mfa_credentials_one_active')
      .on(t.userId)
      .where(sql`${t.revokedAt} is null`),
    check('mfa_credentials_type_check', sql`${t.type} = 'totp'`),
  ],
);

/** Codes de secours hachés, consommables une fois. */
export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('mfa_recovery_codes_hash_unique').on(t.userId, t.codeHash)],
);

/**
 * Emails à envoyer, écrits dans la transaction métier (outbox dédiée). Le contenu,
 * qui peut porter un lien à jeton, est chiffré et purgé après envoi.
 */
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    template: text('template').notNull(),
    recipient: text('recipient').notNull(),
    payloadEncrypted: bytea('payload_encrypted'),
    createdAt: createdAt(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
  },
  (t) => [
    index('email_outbox_pending_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.sentAt} is null`),
  ],
);
