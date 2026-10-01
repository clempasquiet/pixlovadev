import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, organizationId, tenantPolicy, updatedAt } from './common.js';
import { players } from './fleet.js';
import { platformUsers } from './platform.js';

export const RELEASE_STATUSES = ['draft', 'published', 'blocked'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

/**
 * Registre des releases du Player natif (ADM-004, ADM-005, PLY-005, ADR-019). Ligne
 * globale, sans tenant : l’identifiant est le `release_id` signé, les métadonnées et
 * l’enveloppe sont immuables. Un brouillon attend son paquet vérifié ; seule une release
 * publiée est distribuée ; une release bloquée ne l’est plus et déclenche le retour
 * arrière des Players qui l’exécutent. Écrite par le seul rôle `pixlova_platform`.
 */
export const playerReleases = pgTable(
  'player_releases',
  {
    id: uuid('id').primaryKey(),
    version: text('version').notNull(),
    versionMajor: integer('version_major').notNull(),
    versionMinor: integer('version_minor').notNull(),
    versionPatch: integer('version_patch').notNull(),
    /** Canal unique en V1 ; bêta et déploiements progressifs relèvent de V1.5. */
    channel: text('channel', { enum: ['stable'] })
      .notNull()
      .default('stable'),
    os: text('os', { enum: ['linux', 'windows'] }).notNull(),
    architecture: text('architecture', { enum: ['x86_64', 'aarch64'] }).notNull(),
    sha256: text('sha256').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    keyId: text('key_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    /** Enveloppe `SIGNAGE_RELEASE_V1` telle que signée, transmise aux Players sans réécriture. */
    envelope: text('envelope').notNull(),
    protocolMin: integer('protocol_min').notNull(),
    protocolMax: integer('protocol_max').notNull(),
    sqliteSchema: integer('sqlite_schema').notNull(),
    sqliteReaderLevel: integer('sqlite_reader_level').notNull(),
    rendererBuild: text('renderer_build').notNull(),
    /** Paquet vérifié (taille, SHA-256) dans le stockage privé ; NULL tant qu’absent. */
    artifactKey: text('artifact_key'),
    status: text('status', { enum: RELEASE_STATUSES }).notNull().default('draft'),
    notes: text('notes'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => platformUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: uuid('published_by').references(() => platformUsers.id),
    blockedAt: timestamp('blocked_at', { withTimezone: true }),
    blockedBy: uuid('blocked_by').references(() => platformUsers.id),
    blockReason: text('block_reason'),
  },
  (t) => [
    uniqueIndex('player_releases_platform_version_unique').on(t.os, t.architecture, t.version),
    index('player_releases_desired_idx').on(
      t.os,
      t.architecture,
      t.status,
      t.versionMajor,
      t.versionMinor,
      t.versionPatch,
    ),
    check('player_releases_status_check', sql`${t.status} in ('draft', 'published', 'blocked')`),
    check('player_releases_channel_check', sql`${t.channel} = 'stable'`),
    check('player_releases_os_check', sql`${t.os} in ('linux', 'windows')`),
    check('player_releases_architecture_check', sql`${t.architecture} in ('x86_64', 'aarch64')`),
    check('player_releases_sha256_check', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'player_releases_version_check',
      sql`${t.version} = ${t.versionMajor} || '.' || ${t.versionMinor} || '.' || ${t.versionPatch}`,
    ),
    // Aucune release distribuable sans paquet vérifié.
    check(
      'player_releases_artifact_check',
      sql`${t.status} = 'draft' or ${t.artifactKey} is not null`,
    ),
    check(
      'player_releases_published_check',
      sql`${t.status} = 'draft' or ${t.publishedAt} is not null`,
    ),
    check(
      'player_releases_blocked_check',
      sql`(${t.status} = 'blocked') = (${t.blockedAt} is not null)`,
    ),
  ],
);

export const UPDATE_REPORT_STATES = ['installed', 'promoted', 'rolled_back', 'failed'] as const;

/**
 * Dernier état d’une mise à jour déclaré par un Player natif pour une release (PLY-005) :
 * version souhaitée, installée et résultat du déploiement deviennent visibles. Une
 * déclaration plus ancienne que celle connue est ignorée.
 */
export const playerUpdateReports = pgTable(
  'player_update_reports',
  {
    id: id(),
    organizationId: organizationId(),
    playerId: uuid('player_id').notNull(),
    /** Release déclarée par le Player ; une version installée hors registre reste admise. */
    releaseId: uuid('release_id').notNull(),
    version: text('version').notNull(),
    state: text('state', { enum: UPDATE_REPORT_STATES }).notNull(),
    code: text('code'),
    detail: text('detail'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'player_update_reports_player_same_tenant_fk',
      columns: [t.organizationId, t.playerId],
      foreignColumns: [players.organizationId, players.id],
    }),
    uniqueIndex('player_update_reports_player_release_unique').on(t.playerId, t.releaseId),
    index('player_update_reports_release_idx').on(t.releaseId, t.state),
    check(
      'player_update_reports_state_check',
      sql`${t.state} in ('installed', 'promoted', 'rolled_back', 'failed')`,
    ),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();
