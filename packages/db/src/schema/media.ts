import { sql } from 'drizzle-orm';
import {
  bigint,
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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, id, organizationId, tenantPolicy, updatedAt } from './common.js';
import { sites, users } from './identity.js';

/**
 * Dossier de bibliothèque (MED-001). `site_id` NULL : dossier de niveau organisation.
 * Les cycles sont refusés par le service sous verrou (DATA : interdire cycles et parent
 * d’un autre tenant, ce dernier point garanti par la FK composite).
 */
export const mediaFolders = pgTable(
  'media_folders',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: uuid('site_id'),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'media_folders_site_same_tenant_fk',
      columns: [t.organizationId, t.siteId],
      foreignColumns: [sites.organizationId, sites.id],
    }),
    foreignKey({
      name: 'media_folders_parent_same_tenant_fk',
      columns: [t.organizationId, t.parentId],
      foreignColumns: [t.organizationId, t.id],
    }),
    unique('media_folders_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('media_folders_name_unique').on(
      t.organizationId,
      sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`lower(${t.name})`,
    ),
    check('media_folders_not_own_parent', sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

export const MEDIA_STATUSES = ['uploading', 'processing', 'ready', 'error'] as const;
export const MEDIA_TYPES = ['image', 'video'] as const;

/**
 * Média logique (MED-001, MED-005). Les champs calculés (type détecté, taille, checksum,
 * dimensions, durée) ne sont écrits que par le pipeline, jamais par le client.
 * La corbeille est `deleted_at` ; `purge_after` borne la rétention (MED-008).
 * `quota_bytes` : octets imputés au quota de stockage de l’organisation (ADR-009).
 */
export const media = pgTable(
  'media',
  {
    id: id(),
    organizationId: organizationId(),
    siteId: uuid('site_id'),
    folderId: uuid('folder_id'),
    name: text('name').notNull(),
    type: text('type', { enum: MEDIA_TYPES }).notNull(),
    status: text('status', { enum: MEDIA_STATUSES }).notNull().default('uploading'),
    declaredMimeType: text('declared_mime_type').notNull(),
    mimeType: text('mime_type'),
    originalFilename: text('original_filename').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    checksumSha256: text('checksum_sha256'),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    errorCode: text('error_code'),
    errorDetail: text('error_detail'),
    quotaBytes: bigint('quota_bytes', { mode: 'number' }).notNull().default(0),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id),
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'media_site_same_tenant_fk',
      columns: [t.organizationId, t.siteId],
      foreignColumns: [sites.organizationId, sites.id],
    }),
    foreignKey({
      name: 'media_folder_same_tenant_fk',
      columns: [t.organizationId, t.folderId],
      foreignColumns: [mediaFolders.organizationId, mediaFolders.id],
    }),
    unique('media_org_id_unique').on(t.organizationId, t.id),
    index('media_org_status_deleted_idx').on(t.organizationId, t.status, t.deletedAt),
    index('media_org_created_idx').on(t.organizationId, t.createdAt, t.id),
    index('media_org_folder_idx').on(t.organizationId, t.folderId),
    index('media_purge_idx')
      .on(t.purgeAfter)
      .where(sql`${t.deletedAt} is not null`),
    check('media_type_check', sql`${t.type} in ('image', 'video')`),
    check('media_status_check', sql`${t.status} in ('uploading', 'processing', 'ready', 'error')`),
    check('media_sizes_check', sql`${t.sizeBytes} is null or ${t.sizeBytes} >= 0`),
    check('media_quota_check', sql`${t.quotaBytes} >= 0`),
    check(
      'media_checksum_format',
      sql`${t.checksumSha256} is null or ${t.checksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'media_ready_complete',
      sql`${t.status} <> 'ready' or (${t.checksumSha256} is not null and ${t.sizeBytes} is not null and ${t.mimeType} is not null)`,
    ),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

export const UPLOAD_STATES = ['pending', 'completed', 'aborted', 'expired'] as const;

/**
 * Session d’upload direct (MED-002, API-007). L’objet `object_key` est une quarantaine :
 * le pipeline en copie le contenu vérifié vers la clé définitive. `reserved_bytes` est
 * réservé dans `usage_counters` jusqu’à finalisation ou abandon (DATA-008).
 */
export const uploadSessions = pgTable(
  'upload_sessions',
  {
    id: id(),
    organizationId: organizationId(),
    mediaId: uuid('media_id').notNull(),
    objectKey: text('object_key').notNull(),
    declaredSize: bigint('declared_size', { mode: 'number' }).notNull(),
    declaredMimeType: text('declared_mime_type').notNull(),
    clientChecksumSha256: text('client_checksum_sha256'),
    reservedBytes: bigint('reserved_bytes', { mode: 'number' }).notNull(),
    state: text('state', { enum: UPLOAD_STATES }).notNull().default('pending'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Objet de quarantaine supprimé du stockage (après expiration de l’URL signée). */
    cleanedAt: timestamp('cleaned_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'upload_sessions_media_same_tenant_fk',
      columns: [t.organizationId, t.mediaId],
      foreignColumns: [media.organizationId, media.id],
    }),
    unique('upload_sessions_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('upload_sessions_object_key_unique').on(t.objectKey),
    uniqueIndex('upload_sessions_media_unique').on(t.mediaId),
    index('upload_sessions_pending_idx')
      .on(t.expiresAt)
      .where(sql`${t.state} = 'pending'`),
    index('upload_sessions_uncleaned_idx')
      .on(t.expiresAt)
      .where(sql`${t.cleanedAt} is null`),
    check(
      'upload_sessions_state_check',
      sql`${t.state} in ('pending', 'completed', 'aborted', 'expired')`,
    ),
    check('upload_sessions_sizes_check', sql`${t.declaredSize} > 0 and ${t.reservedBytes} >= 0`),
    check(
      'upload_sessions_checksum_format',
      sql`${t.clientChecksumSha256} is null or ${t.clientChecksumSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

export const MEDIA_VARIANTS = ['original', 'playback', 'thumbnail'] as const;

/**
 * Binaire immuable d’un média (MED-005, SEC-008). Une ligne n’existe qu’une fois l’objet
 * écrit et son checksum calculé ; elle ne change jamais sous le même identifiant.
 * `playback` peut partager la clé de `original` quand aucun transcodage n’est nécessaire.
 */
export const mediaAssets = pgTable(
  'media_assets',
  {
    id: id(),
    organizationId: organizationId(),
    mediaId: uuid('media_id').notNull(),
    variant: text('variant', { enum: MEDIA_VARIANTS }).notNull(),
    profile: text('profile').notNull(),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    checksumSha256: text('checksum_sha256').notNull(),
    width: integer('width'),
    height: integer('height'),
    durationMs: integer('duration_ms'),
    codecMetadata: jsonb('codec_metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'media_assets_media_same_tenant_fk',
      columns: [t.organizationId, t.mediaId],
      foreignColumns: [media.organizationId, media.id],
    }),
    unique('media_assets_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('media_assets_media_variant_unique').on(t.mediaId, t.variant),
    check('media_assets_variant_check', sql`${t.variant} in ('original', 'playback', 'thumbnail')`),
    check('media_assets_size_check', sql`${t.sizeBytes} >= 0`),
    check('media_assets_checksum_format', sql`${t.checksumSha256} ~ '^[0-9a-f]{64}$'`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

export const tags = pgTable(
  'tags',
  {
    id: id(),
    organizationId: organizationId(),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('tags_org_id_unique').on(t.organizationId, t.id),
    uniqueIndex('tags_org_name_unique').on(t.organizationId, sql`lower(${t.name})`),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();

export const mediaTags = pgTable(
  'media_tags',
  {
    organizationId: organizationId(),
    mediaId: uuid('media_id').notNull(),
    tagId: uuid('tag_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.mediaId, t.tagId] }),
    foreignKey({
      name: 'media_tags_media_same_tenant_fk',
      columns: [t.organizationId, t.mediaId],
      foreignColumns: [media.organizationId, media.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'media_tags_tag_same_tenant_fk',
      columns: [t.organizationId, t.tagId],
      foreignColumns: [tags.organizationId, tags.id],
    }).onDelete('cascade'),
    index('media_tags_tag_idx').on(t.organizationId, t.tagId),
    tenantPolicy(t.organizationId),
  ],
).enableRLS();
