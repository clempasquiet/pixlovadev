import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, organizationId, tenantPolicy, updatedAt } from './common.js';
import { sites, users } from './identity.js';
import { media } from './media.js';

/**
 * Composition (CMP-001, CMP-007, ADR-010) : brouillon modifiable sous contrôle de
 * concurrence optimiste (`draft_revision`) et pointeur vers la dernière version publiée.
 * `width`/`height` reflètent le canvas du brouillon pour les listes.
 */
export const compositions = pgTable(
  'compositions',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: uuid('site_id'),
    name: text('name').notNull(),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    draftDocument: jsonb('draft_document').notNull(),
    draftRevision: integer('draft_revision').notNull().default(1),
    /** Le brouillon diffère de la dernière version publiée. */
    hasUnpublishedChanges: boolean('has_unpublished_changes').notNull().default(true),
    publishedVersion: integer('published_version'),
    publishedVersionId: uuid('published_version_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    sourceTemplateKey: text('source_template_key'),
    sourceTemplateVersion: integer('source_template_version'),
    createdBy: uuid('created_by').references(() => users.id),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'compositions_site_same_tenant_fk',
      columns: [t.organizationId, t.siteId],
      foreignColumns: [sites.organizationId, sites.id],
    }),
    unique('compositions_org_id_unique').on(t.organizationId, t.id),
    index('compositions_org_updated_idx').on(t.organizationId, t.updatedAt, t.id),
    check('compositions_revision_check', sql`${t.draftRevision} >= 1`),
    check(
      'compositions_dimensions_check',
      sql`${t.width} between 1 and 32767 and ${t.height} between 1 and 32767`,
    ),
    check(
      'compositions_published_pair',
      sql`(${t.publishedVersion} is null) = (${t.publishedVersionId} is null)`,
    ),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/**
 * Version publiée, immuable (CMP-007) : le rôle applicatif n’a ni UPDATE ni DELETE sur
 * cette table (migration de droits). Une restauration crée une nouvelle version.
 */
export const compositionVersions = pgTable(
  'composition_versions',
  {
    id: id(),
    organizationId: organizationId(),
    compositionId: uuid('composition_id').notNull(),
    version: integer('version').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    document: jsonb('document').notNull(),
    /** Version restaurée, si la publication est un retour arrière. */
    restoredFrom: integer('restored_from'),
    publishedBy: uuid('published_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'composition_versions_composition_same_tenant_fk',
      columns: [t.organizationId, t.compositionId],
      foreignColumns: [compositions.organizationId, compositions.id],
    }),
    unique('composition_versions_org_id_unique').on(t.organizationId, t.id),
    unique('composition_versions_number_unique').on(t.compositionId, t.version),
    check('composition_versions_version_check', sql`${t.version} >= 1`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/**
 * Playlist (PLN-001, ADR-011) : brouillon JSON (`playlist-document.json`) sous concurrence
 * optimiste, versions publiées immuables. Même règle de visibilité par site que les médias.
 */
export const playlists = pgTable(
  'playlists',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: uuid('site_id'),
    name: text('name').notNull(),
    draftDocument: jsonb('draft_document').notNull(),
    draftRevision: integer('draft_revision').notNull().default(1),
    hasUnpublishedChanges: boolean('has_unpublished_changes').notNull().default(true),
    publishedVersion: integer('published_version'),
    publishedVersionId: uuid('published_version_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'playlists_site_same_tenant_fk',
      columns: [t.organizationId, t.siteId],
      foreignColumns: [sites.organizationId, sites.id],
    }),
    unique('playlists_org_id_unique').on(t.organizationId, t.id),
    index('playlists_org_updated_idx').on(t.organizationId, t.updatedAt, t.id),
    check('playlists_revision_check', sql`${t.draftRevision} >= 1`),
    check(
      'playlists_published_pair',
      sql`(${t.publishedVersion} is null) = (${t.publishedVersionId} is null)`,
    ),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/** Version publiée d’une playlist, immuable (ajout seul pour le rôle applicatif). */
export const playlistVersions = pgTable(
  'playlist_versions',
  {
    id: id(),
    organizationId: organizationId(),
    playlistId: uuid('playlist_id').notNull(),
    version: integer('version').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    document: jsonb('document').notNull(),
    publishedBy: uuid('published_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'playlist_versions_playlist_same_tenant_fk',
      columns: [t.organizationId, t.playlistId],
      foreignColumns: [playlists.organizationId, playlists.id],
    }),
    unique('playlist_versions_org_id_unique').on(t.organizationId, t.id),
    unique('playlist_versions_number_unique').on(t.playlistId, t.version),
    check('playlist_versions_version_check', sql`${t.version} >= 1`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

export const PROGRAM_KINDS = ['schedule', 'campaign', 'override'] as const;

/**
 * Programme de diffusion (PLN-003 à PLN-009, ADR-011) : planning, campagne ou override.
 * `effective_until` borne la dernière version publiée (`null` : planning sans fin) et
 * permet à la compilation d’ignorer les campagnes et overrides terminés.
 */
export const programs = pgTable(
  'programs',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: uuid('site_id'),
    kind: text('kind', { enum: PROGRAM_KINDS }).notNull(),
    name: text('name').notNull(),
    draftDocument: jsonb('draft_document').notNull(),
    draftRevision: integer('draft_revision').notNull().default(1),
    hasUnpublishedChanges: boolean('has_unpublished_changes').notNull().default(true),
    publishedVersion: integer('published_version'),
    publishedVersionId: uuid('published_version_id'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    effectiveUntil: timestamp('effective_until', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => users.id),
    createdBy: uuid('created_by').references(() => users.id),
    updatedBy: uuid('updated_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'programs_site_same_tenant_fk',
      columns: [t.organizationId, t.siteId],
      foreignColumns: [sites.organizationId, sites.id],
    }),
    unique('programs_org_id_unique').on(t.organizationId, t.id),
    index('programs_org_kind_updated_idx').on(t.organizationId, t.kind, t.updatedAt, t.id),
    index('programs_org_live_idx')
      .on(t.organizationId, t.effectiveUntil)
      .where(
        sql`${t.publishedVersionId} is not null and ${t.cancelledAt} is null and ${t.deletedAt} is null`,
      ),
    check('programs_kind_check', sql`${t.kind} in ('schedule', 'campaign', 'override')`),
    check('programs_revision_check', sql`${t.draftRevision} >= 1`),
    check(
      'programs_published_pair',
      sql`(${t.publishedVersion} is null) = (${t.publishedVersionId} is null)`,
    ),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/** Version publiée d’un programme, immuable ; référencée par les timelines des manifests. */
export const programVersions = pgTable(
  'program_versions',
  {
    id: id(),
    organizationId: organizationId(),
    programId: uuid('program_id').notNull(),
    version: integer('version').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    document: jsonb('document').notNull(),
    publishedBy: uuid('published_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'program_versions_program_same_tenant_fk',
      columns: [t.organizationId, t.programId],
      foreignColumns: [programs.organizationId, programs.id],
    }),
    unique('program_versions_org_id_unique').on(t.organizationId, t.id),
    unique('program_versions_number_unique').on(t.programId, t.version),
    check('program_versions_version_check', sql`${t.version} >= 1`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

/**
 * Graphe des dépendances des versions publiées (CMP-005, MED-008, DATA-003) : clés
 * étrangères typées exclusives, exactement une source (version de composition, de playlist
 * ou de programme) et exactement une cible (média, composition ou playlist).
 */
export const contentDependencies = pgTable(
  'content_dependencies',
  {
    id: id(),
    organizationId: organizationId(),
    compositionVersionId: uuid('composition_version_id'),
    playlistVersionId: uuid('playlist_version_id'),
    programVersionId: uuid('program_version_id'),
    mediaId: uuid('media_id'),
    compositionId: uuid('composition_id'),
    playlistId: uuid('playlist_id'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('content_dependencies_edge_unique')
      .on(
        t.compositionVersionId,
        t.playlistVersionId,
        t.programVersionId,
        t.mediaId,
        t.compositionId,
        t.playlistId,
      )
      .nullsNotDistinct(),
    foreignKey({
      name: 'content_dependencies_version_same_tenant_fk',
      columns: [t.organizationId, t.compositionVersionId],
      foreignColumns: [compositionVersions.organizationId, compositionVersions.id],
    }),
    foreignKey({
      name: 'content_dependencies_playlist_version_same_tenant_fk',
      columns: [t.organizationId, t.playlistVersionId],
      foreignColumns: [playlistVersions.organizationId, playlistVersions.id],
    }),
    foreignKey({
      name: 'content_dependencies_program_version_same_tenant_fk',
      columns: [t.organizationId, t.programVersionId],
      foreignColumns: [programVersions.organizationId, programVersions.id],
    }),
    foreignKey({
      name: 'content_dependencies_media_same_tenant_fk',
      columns: [t.organizationId, t.mediaId],
      foreignColumns: [media.organizationId, media.id],
    }),
    foreignKey({
      name: 'content_dependencies_composition_same_tenant_fk',
      columns: [t.organizationId, t.compositionId],
      foreignColumns: [compositions.organizationId, compositions.id],
    }),
    foreignKey({
      name: 'content_dependencies_playlist_same_tenant_fk',
      columns: [t.organizationId, t.playlistId],
      foreignColumns: [playlists.organizationId, playlists.id],
    }),
    check(
      'content_dependencies_one_source',
      sql`num_nonnulls(${t.compositionVersionId}, ${t.playlistVersionId}, ${t.programVersionId}) = 1`,
    ),
    check(
      'content_dependencies_one_target',
      sql`num_nonnulls(${t.mediaId}, ${t.compositionId}, ${t.playlistId}) = 1`,
    ),
    index('content_dependencies_media_idx').on(t.organizationId, t.mediaId),
    index('content_dependencies_composition_idx').on(t.organizationId, t.compositionId),
    index('content_dependencies_playlist_idx').on(t.organizationId, t.playlistId),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();
