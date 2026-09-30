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
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, deletedAt, id, organizationId, tenantPolicy, updatedAt } from './common.js';
import { organizations, sites, users } from './identity.js';

/**
 * Installation Player (PLY-001). `id` permanent, jamais réutilisé ; l’empreinte machine
 * n’est ni unique ni une preuve d’authentification (PLY-003).
 */
export const players = pgTable(
  'players',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: uuid('site_id'),
    name: text('name').notNull(),
    type: text('type', { enum: ['native', 'web'] }).notNull(),
    lifecycleStatus: text('lifecycle_status', {
      enum: ['paired', 'disabled', 'revoked', 'deleted'],
    })
      .notNull()
      .default('paired'),
    installationUuid: uuid('installation_uuid').notNull(),
    machineUuid: uuid('machine_uuid'),
    machineFingerprintHash: text('machine_fingerprint_hash'),
    appVersion: text('app_version'),
    os: text('os'),
    architecture: text('architecture'),
    capabilities: jsonb('capabilities')
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.organizationId], foreignColumns: [organizations.id] }),
    foreignKey({
      name: 'players_site_same_tenant_fk',
      columns: [t.organizationId, t.siteId],
      foreignColumns: [sites.organizationId, sites.id],
    }),
    unique('players_org_id_unique').on(t.organizationId, t.id),
    index('players_org_last_seen_idx').on(t.organizationId, t.lastSeenAt),
    check('players_type_check', sql`${t.type} in ('native', 'web')`),
    check(
      'players_lifecycle_check',
      sql`${t.lifecycleStatus} in ('paired', 'disabled', 'revoked', 'deleted')`,
    ),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/** Sortie de rendu d’un Player ; un changement d’EDID ne crée pas un nouveau Display (DSP-005). */
export const playerOutputs = pgTable(
  'player_outputs',
  {
    id: id(),
    organizationId: organizationId(),
    playerId: uuid('player_id').notNull(),
    outputKey: text('output_key').notNull(),
    connectorType: text('connector_type'),
    width: integer('width'),
    height: integer('height'),
    refreshRate: real('refresh_rate'),
    /** NULL : inconnu (Player Web, plateforme sans détection). */
    connected: boolean('connected'),
    capabilities: jsonb('capabilities')
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'player_outputs_player_same_tenant_fk',
      columns: [t.organizationId, t.playerId],
      foreignColumns: [players.organizationId, players.id],
    }),
    unique('player_outputs_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('player_outputs_player_key_unique').on(t.playerId, t.outputKey),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/** Écran logique durable (DSP-001, DSP-004) : résolution libre, programmation indépendante du matériel. */
export const displays = pgTable(
  'displays',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: uuid('site_id').notNull(),
    name: text('name').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    orientation: integer('orientation').notNull().default(0),
    timezone: text('timezone'),
    lifecycleStatus: text('lifecycle_status', { enum: ['active', 'inactive', 'archived'] })
      .notNull()
      .default('active'),
    /** Repli local sans contenu programmé (PLN-010) ; le contenu de repli arrive avec L05. */
    fallbackMode: text('fallback_mode', { enum: ['standby_screen'] })
      .notNull()
      .default('standby_screen'),
    /** Incrémentée à chaque (ré)affectation (DATA-006). */
    assignmentGeneration: bigint('assignment_generation', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    foreignKey({
      name: 'displays_site_same_tenant_fk',
      columns: [t.organizationId, t.siteId],
      foreignColumns: [sites.organizationId, sites.id],
    }),
    unique('displays_org_id_unique').on(t.organizationId, t.id),
    index('displays_org_site_idx').on(t.organizationId, t.siteId),
    check('displays_width_check', sql`${t.width} between 1 and 32767`),
    check('displays_height_check', sql`${t.height} between 1 and 32767`),
    check('displays_orientation_check', sql`${t.orientation} in (0, 90, 180, 270)`),
    check(
      'displays_lifecycle_check',
      sql`${t.lifecycleStatus} in ('active', 'inactive', 'archived')`,
    ),
    check('displays_generation_check', sql`${t.assignmentGeneration} >= 0`),
    check('displays_fallback_check', sql`${t.fallbackMode} in ('standby_screen')`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/**
 * Affectation historisée Display → sortie (DSP-002, DSP-003). Au plus une affectation
 * active par Display et par sortie, garanti par index uniques partiels même sous concurrence.
 */
export const displayAssignments = pgTable(
  'display_assignments',
  {
    id: id(),
    organizationId: organizationId(),
    displayId: uuid('display_id').notNull(),
    playerOutputId: uuid('player_output_id').notNull(),
    generation: bigint('generation', { mode: 'bigint' }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    assignedBy: uuid('assigned_by').references(() => users.id),
  },
  (t) => [
    foreignKey({
      name: 'display_assignments_display_same_tenant_fk',
      columns: [t.organizationId, t.displayId],
      foreignColumns: [displays.organizationId, displays.id],
    }),
    foreignKey({
      name: 'display_assignments_output_same_tenant_fk',
      columns: [t.organizationId, t.playerOutputId],
      foreignColumns: [playerOutputs.organizationId, playerOutputs.id],
    }),
    uniqueIndex('display_one_active_assignment')
      .on(t.displayId)
      .where(sql`${t.endedAt} is null`),
    uniqueIndex('output_one_active_assignment')
      .on(t.playerOutputId)
      .where(sql`${t.endedAt} is null`),
    uniqueIndex('display_assignment_generation_unique').on(t.displayId, t.generation),
    check('display_assignments_generation_check', sql`${t.generation} >= 1`),
    check(
      'display_assignments_period_check',
      sql`${t.endedAt} is null or ${t.endedAt} >= ${t.startedAt}`,
    ),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/** Groupe de ciblage V1, sans garantie de synchronisation. */
export const displayGroups = pgTable(
  'display_groups',
  {
    id: id(),
    organizationId: organizationId(),
    name: text('name').notNull(),
    description: text('description'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({ columns: [t.organizationId], foreignColumns: [organizations.id] }),
    unique('display_groups_org_id_unique').on(t.organizationId, t.id),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

export const displayGroupMembers = pgTable(
  'display_group_members',
  {
    organizationId: organizationId(),
    groupId: uuid('group_id').notNull(),
    displayId: uuid('display_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.displayId] }),
    foreignKey({
      name: 'display_group_members_group_same_tenant_fk',
      columns: [t.organizationId, t.groupId],
      foreignColumns: [displayGroups.organizationId, displayGroups.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'display_group_members_display_same_tenant_fk',
      columns: [t.organizationId, t.displayId],
      foreignColumns: [displays.organizationId, displays.id],
    }),
    index('display_group_members_display_idx').on(t.organizationId, t.displayId),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();
