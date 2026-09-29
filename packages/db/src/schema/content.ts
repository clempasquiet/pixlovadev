import { sql } from 'drizzle-orm';
import {
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
 * Graphe des dépendances des versions publiées (CMP-005, MED-008, DATA-003) : clés
 * étrangères typées, sans référence polymorphique. L05 y ajoute playlists et compositions
 * imbriquées avec une contrainte « exactement une cible ».
 */
export const contentDependencies = pgTable(
  'content_dependencies',
  {
    organizationId: organizationId(),
    compositionVersionId: uuid('composition_version_id').notNull(),
    mediaId: uuid('media_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.compositionVersionId, t.mediaId] }),
    foreignKey({
      name: 'content_dependencies_version_same_tenant_fk',
      columns: [t.organizationId, t.compositionVersionId],
      foreignColumns: [compositionVersions.organizationId, compositionVersions.id],
    }),
    foreignKey({
      name: 'content_dependencies_media_same_tenant_fk',
      columns: [t.organizationId, t.mediaId],
      foreignColumns: [media.organizationId, media.id],
    }),
    index('content_dependencies_media_idx').on(t.organizationId, t.mediaId),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();
