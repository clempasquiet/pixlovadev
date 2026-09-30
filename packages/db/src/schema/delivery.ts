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
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, organizationId, tenantPolicy, updatedAt } from './common.js';
import { displays, players } from './fleet.js';
import { mediaAssets } from './media.js';

/**
 * Manifest signé (PROTO-009, DATA-010, ADR-011), immuable : ni UPDATE ni DELETE pour le
 * rôle applicatif. `id` est le `manifest_id` signé ; `envelope` conserve exactement les
 * octets distribués. Aucune URL de média n’y figure.
 */
export const manifests = pgTable(
  'manifests',
  {
    id: uuid('id').primaryKey(),
    organizationId: organizationId(),
    displayId: uuid('display_id').notNull(),
    playerId: uuid('player_id').notNull(),
    version: bigint('version', { mode: 'bigint' }).notNull(),
    assignmentGeneration: bigint('assignment_generation', { mode: 'bigint' }).notNull(),
    configRevision: bigint('config_revision', { mode: 'bigint' }).notNull(),
    schemaVersion: integer('schema_version').notNull(),
    payloadHash: text('payload_hash').notNull(),
    /** Empreinte des entrées compilées, hors fenêtre temporelle (idempotence). */
    inputHash: text('input_hash').notNull(),
    keyId: text('key_id').notNull(),
    envelope: text('envelope').notNull(),
    generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    scheduleUntil: timestamp('schedule_until', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'manifests_display_same_tenant_fk',
      columns: [t.organizationId, t.displayId],
      foreignColumns: [displays.organizationId, displays.id],
    }),
    foreignKey({
      name: 'manifests_player_same_tenant_fk',
      columns: [t.organizationId, t.playerId],
      foreignColumns: [players.organizationId, players.id],
    }),
    unique('manifests_org_id_unique').on(t.organizationId, t.id),
    unique('manifests_display_version_unique').on(t.displayId, t.version),
    index('manifests_display_version_idx').on(t.displayId, t.version.desc()),
    check('manifests_version_check', sql`${t.version} >= 1`),
    check('manifests_hash_format', sql`${t.payloadHash} ~ '^[0-9a-f]{64}$'`),
    check('manifests_window_check', sql`${t.validFrom} < ${t.scheduleUntil}`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/** Assets requis par un manifest : autorisation des URLs (PROTO-004) et épinglage (NAT-009). */
export const manifestAssets = pgTable(
  'manifest_assets',
  {
    organizationId: organizationId(),
    manifestId: uuid('manifest_id').notNull(),
    mediaAssetId: uuid('media_asset_id').notNull(),
    required: boolean('required').notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.manifestId, t.mediaAssetId] }),
    foreignKey({
      name: 'manifest_assets_manifest_same_tenant_fk',
      columns: [t.organizationId, t.manifestId],
      foreignColumns: [manifests.organizationId, manifests.id],
    }),
    foreignKey({
      name: 'manifest_assets_asset_same_tenant_fk',
      columns: [t.organizationId, t.mediaAssetId],
      foreignColumns: [mediaAssets.organizationId, mediaAssets.id],
    }),
    index('manifest_assets_asset_idx').on(t.organizationId, t.mediaAssetId),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

export const DELIVERY_STATES = [
  'desired',
  'received',
  'downloading',
  'ready',
  'applied',
  'failed',
  'superseded',
] as const;

/**
 * Suivi d’un manifest pour un Player et une génération d’affectation (FON-002). Seul le
 * Player déclare `downloading`, `ready`, `applied` et `failed`.
 */
export const manifestDeliveries = pgTable(
  'manifest_deliveries',
  {
    id: id(),
    organizationId: organizationId(),
    manifestId: uuid('manifest_id').notNull(),
    displayId: uuid('display_id').notNull(),
    playerId: uuid('player_id').notNull(),
    assignmentGeneration: bigint('assignment_generation', { mode: 'bigint' }).notNull(),
    state: text('state', { enum: DELIVERY_STATES }).notNull().default('desired'),
    errorCode: text('error_code'),
    detail: text('detail'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    readyAt: timestamp('ready_at', { withTimezone: true }),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'manifest_deliveries_manifest_same_tenant_fk',
      columns: [t.organizationId, t.manifestId],
      foreignColumns: [manifests.organizationId, manifests.id],
    }),
    foreignKey({
      name: 'manifest_deliveries_display_same_tenant_fk',
      columns: [t.organizationId, t.displayId],
      foreignColumns: [displays.organizationId, displays.id],
    }),
    foreignKey({
      name: 'manifest_deliveries_player_same_tenant_fk',
      columns: [t.organizationId, t.playerId],
      foreignColumns: [players.organizationId, players.id],
    }),
    unique('manifest_deliveries_manifest_player_unique').on(t.manifestId, t.playerId),
    index('manifest_deliveries_display_idx').on(t.organizationId, t.displayId, t.createdAt),
    check(
      'manifest_deliveries_state_check',
      sql`${t.state} in ('desired', 'received', 'downloading', 'ready', 'applied', 'failed', 'superseded')`,
    ),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

export const COMPILATION_STATUSES = [
  'published',
  'unchanged',
  'superseded',
  'rejected',
  'unassigned',
] as const;

/** Historique des compilations d’un Display, avec causes de refus et explication (PLN-005). */
export const displayCompilations = pgTable(
  'display_compilations',
  {
    id: id(),
    organizationId: organizationId(),
    displayId: uuid('display_id').notNull(),
    configRevision: bigint('config_revision', { mode: 'bigint' }).notNull(),
    status: text('status', { enum: COMPILATION_STATUSES }).notNull(),
    inputHash: text('input_hash'),
    manifestId: uuid('manifest_id'),
    issues: jsonb('issues')
      .notNull()
      .default(sql`'[]'::jsonb`),
    explanation: jsonb('explanation'),
    windowFrom: timestamp('window_from', { withTimezone: true }),
    windowUntil: timestamp('window_until', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'display_compilations_display_same_tenant_fk',
      columns: [t.organizationId, t.displayId],
      foreignColumns: [displays.organizationId, displays.id],
    }),
    foreignKey({
      name: 'display_compilations_manifest_same_tenant_fk',
      columns: [t.organizationId, t.manifestId],
      foreignColumns: [manifests.organizationId, manifests.id],
    }),
    index('display_compilations_display_idx').on(t.organizationId, t.displayId, t.createdAt),
    check(
      'display_compilations_status_check',
      sql`${t.status} in ('published', 'unchanged', 'superseded', 'rejected', 'unassigned')`,
    ),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();
