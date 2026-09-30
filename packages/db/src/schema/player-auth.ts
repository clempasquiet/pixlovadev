import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, organizationId, tenantPolicy } from './common.js';
import { players } from './fleet.js';
import { organizations, users } from './identity.js';

/**
 * Enregistrement d’un Player avant appairage (PROTO-001). Aucun tenant n’est choisi
 * par le Player : l’organisation n’est fixée qu’au moment de la réclamation par un
 * utilisateur autorisé. Table accessible au seul rôle système.
 */
export const pairingSessions = pgTable(
  'pairing_sessions',
  {
    id: id(),
    installationUuid: uuid('installation_uuid').notNull(),
    playerType: text('player_type', { enum: ['native', 'web'] }).notNull(),
    publicKey: text('public_key').notNull(),
    capabilities: jsonb('capabilities').notNull(),
    outputs: jsonb('outputs').notNull(),
    appVersion: text('app_version').notNull(),
    machineFingerprintHash: text('machine_fingerprint_hash'),
    codeHash: text('code_hash').notNull(),
    pollSecretHash: text('poll_secret_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: inet('ip'),
    createdAt: createdAt(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    claimedBy: uuid('claimed_by').references(() => users.id),
    organizationId: uuid('organization_id').references(() => organizations.id),
    playerId: uuid('player_id'),
    /** Première restitution de l’association au Player ; les reprises restent idempotentes. */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    // Un code en attente ne désigne qu’une seule installation.
    uniqueIndex('pairing_sessions_pending_code_unique')
      .on(t.codeHash)
      .where(sql`${t.claimedAt} is null`),
    index('pairing_sessions_expires_idx').on(t.expiresAt),
    check('pairing_sessions_type_check', sql`${t.playerType} in ('native', 'web')`),
    check(
      'pairing_sessions_claim_check',
      sql`(${t.claimedAt} is null) = (${t.organizationId} is null) and (${t.claimedAt} is null) = (${t.playerId} is null)`,
    ),
    // Défense en profondeur : aucun droit n’est accordé au rôle applicatif sur cette table.
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/** Clé publique d’un Player ; jamais de clé privée côté cloud (SEC-005). */
export const playerCredentials = pgTable(
  'player_credentials',
  {
    id: id(),
    organizationId: organizationId(),
    playerId: uuid('player_id').notNull(),
    credentialType: text('credential_type', { enum: ['ed25519'] }).notNull(),
    publicKey: text('public_key').notNull(),
    generation: integer('generation').notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'player_credentials_player_same_tenant_fk',
      columns: [t.organizationId, t.playerId],
      foreignColumns: [players.organizationId, players.id],
    }),
    unique('player_credentials_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('player_credentials_generation_unique').on(t.playerId, t.generation),
    uniqueIndex('player_credentials_one_active')
      .on(t.playerId)
      .where(sql`${t.revokedAt} is null`),
    check('player_credentials_type_check', sql`${t.credentialType} = 'ed25519'`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/** Challenge à usage unique, valable 60 secondes (PROTO-002). */
export const playerAuthChallenges = pgTable(
  'player_auth_challenges',
  {
    id: id(),
    organizationId: organizationId(),
    playerId: uuid('player_id').notNull(),
    document: jsonb('document').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'player_auth_challenges_player_same_tenant_fk',
      columns: [t.organizationId, t.playerId],
      foreignColumns: [players.organizationId, players.id],
    }),
    index('player_auth_challenges_player_idx').on(t.playerId, t.expiresAt),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/**
 * Jeton d’accès court et opaque. Chaque requête revérifie l’état du Player et la
 * génération du credential : une révocation prend effet immédiatement (PROTO-003).
 */
export const playerAccessTokens = pgTable(
  'player_access_tokens',
  {
    id: id(),
    organizationId: organizationId(),
    playerId: uuid('player_id').notNull(),
    credentialId: uuid('credential_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'player_access_tokens_player_same_tenant_fk',
      columns: [t.organizationId, t.playerId],
      foreignColumns: [players.organizationId, players.id],
    }),
    foreignKey({
      name: 'player_access_tokens_credential_same_tenant_fk',
      columns: [t.organizationId, t.credentialId],
      foreignColumns: [playerCredentials.organizationId, playerCredentials.id],
    }),
    uniqueIndex('player_access_tokens_hash_unique').on(t.tokenHash),
    index('player_access_tokens_player_idx').on(t.playerId, t.expiresAt),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/**
 * Clés d’idempotence des opérations sensibles (API-005) : même clé + même requête →
 * résultat connu ; même clé + corps différent → conflit.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: id(),
    organizationId: organizationId(),
    actorId: uuid('actor_id').notNull(),
    operation: text('operation').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ columns: [t.organizationId], foreignColumns: [organizations.id] }),
    uniqueIndex('idempotency_keys_scope_unique').on(
      t.organizationId,
      t.actorId,
      t.operation,
      t.key,
    ),
    index('idempotency_keys_created_idx').on(t.createdAt),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();
