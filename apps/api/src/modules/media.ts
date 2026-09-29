import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Type from 'typebox';
import { maxBytesFor, mediaCategoryOf, ACCEPTED_MEDIA_MIME_TYPES } from '@pixlova/contracts';
import {
  adjustUsage,
  enqueueJob,
  lockUsage,
  schema,
  withTenant,
  type Transaction,
} from '@pixlova/db';
import { siteFilter } from '@pixlova/permissions';
import { StorageUnavailableError, uploadObjectKey } from '@pixlova/storage';
import { ApiError } from '../errors.js';
import {
  authorize,
  rateLimit,
  requestMeta,
  requireMember,
  type MemberContext,
} from '../http/context.js';
import type { Services } from '../http/services.js';
import { audit } from '../lib/audit.js';
import { idempotencyScope, idempotent } from '../lib/idempotency.js';
import { compositionUsages } from './compositions.js';
import { Strict, Uuid } from './schemas.js';

/** Noms des tâches du worker média (apps/workers). */
const MEDIA_INGEST = 'media.ingest';
const MEDIA_PURGE = 'media.purge';
const NONE = '00000000-0000-0000-0000-000000000000';
/** Médias jamais reçus : exclus de la corbeille visible, purgés par le worker. */
const DISCARDED = ['UPLOAD_ABORTED', 'UPLOAD_EXPIRED'];

type MediaRow = typeof schema.media.$inferSelect;
type AssetRow = typeof schema.mediaAssets.$inferSelect;
type FolderRow = typeof schema.mediaFolders.$inferSelect;

const Name = Type.String({ minLength: 1, maxLength: 200 });
const Sha256 = Type.String({ pattern: '^[0-9a-f]{64}$' });
const TagName = Type.String({ minLength: 1, maxLength: 50 });
const Variant = Type.Union([
  Type.Literal('original'),
  Type.Literal('playback'),
  Type.Literal('thumbnail'),
]);

function visibleSites(member: MemberContext): string[] | 'all' {
  return siteFilter(member.grants, 'organization.read');
}

/**
 * Visibilité par site (ADR-009) : `site_id` NULL est réservé aux grants d’organisation ;
 * sinon le site doit être couvert par un grant de lecture.
 */
function siteVisible(
  column: typeof schema.media.siteId | typeof schema.mediaFolders.siteId,
  visible: string[] | 'all',
): SQL | undefined {
  return visible === 'all' ? undefined : inArray(column, visible.length ? visible : [NONE]);
}

function canSee(member: MemberContext, siteId: string | null): boolean {
  const visible = visibleSites(member);
  return visible === 'all' || (siteId !== null && visible.includes(siteId));
}

/** Nom de fichier affichable : sans chemin, sans caractère de contrôle. */
function cleanFilename(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? '';
  const cleaned = [...base]
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .trim()
    .slice(0, 255);
  return cleaned || 'fichier';
}

function storageError(error: unknown): never {
  if (error instanceof StorageUnavailableError) {
    throw new ApiError(
      503,
      'STORAGE_UNAVAILABLE',
      'Stockage momentanément indisponible. Réessayez.',
      true,
    );
  }
  throw error;
}

/**
 * Références d’un média (MED-008, MED-009, ADR-010) : versions publiées de compositions
 * (bloquantes : suppression forcée requise) et brouillons (signalés, non bloquants).
 * Les playlists (L05) s’ajouteront ici.
 */
export async function mediaUsages(tx: Transaction, mediaId: string) {
  return compositionUsages(tx, mediaId);
}

function publicMedia(
  media: MediaRow,
  extra: { thumbnailUrl?: string | null; tags?: string[] } = {},
) {
  return {
    id: media.id,
    name: media.name,
    type: media.type,
    status: media.status,
    site_id: media.siteId,
    folder_id: media.folderId,
    mime_type: media.mimeType ?? media.declaredMimeType,
    original_filename: media.originalFilename,
    size_bytes: media.sizeBytes,
    checksum_sha256: media.checksumSha256,
    width: media.width,
    height: media.height,
    duration_ms: media.durationMs,
    error: media.errorCode ? { code: media.errorCode, message: media.errorDetail } : null,
    tags: extra.tags ?? [],
    thumbnail_url: extra.thumbnailUrl ?? null,
    created_at: media.createdAt.toISOString(),
    updated_at: media.updatedAt.toISOString(),
    deleted_at: media.deletedAt?.toISOString() ?? null,
    purge_after: media.purgeAfter?.toISOString() ?? null,
    purging: media.purgeStartedAt !== null,
  };
}

function publicAsset(asset: AssetRow) {
  return {
    variant: asset.variant,
    profile: asset.profile,
    mime_type: asset.mimeType,
    size_bytes: asset.sizeBytes,
    checksum_sha256: asset.checksumSha256,
    width: asset.width,
    height: asset.height,
    duration_ms: asset.durationMs,
    created_at: asset.createdAt.toISOString(),
  };
}

function publicFolder(folder: FolderRow) {
  return {
    id: folder.id,
    name: folder.name,
    parent_id: folder.parentId,
    site_id: folder.siteId,
    created_at: folder.createdAt.toISOString(),
  };
}

async function loadMedia(
  tx: Transaction,
  member: MemberContext,
  id: string,
  lock = false,
): Promise<MediaRow> {
  const query = tx.select().from(schema.media).where(eq(schema.media.id, id));
  const [media] = lock ? await query.for('update') : await query;
  // Hors périmètre ou inexistant : même réponse (aucune divulgation).
  if (!media || !canSee(member, media.siteId)) {
    throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Média introuvable.');
  }
  return media;
}

async function loadFolder(
  tx: Transaction,
  member: MemberContext,
  id: string,
  lock = false,
): Promise<FolderRow> {
  const query = tx.select().from(schema.mediaFolders).where(eq(schema.mediaFolders.id, id));
  const [folder] = lock ? await query.for('update') : await query;
  if (!folder || !canSee(member, folder.siteId)) {
    throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Dossier introuvable.');
  }
  return folder;
}

async function assertSite(tx: Transaction, siteId: string): Promise<void> {
  const [site] = await tx
    .select({ id: schema.sites.id })
    .from(schema.sites)
    .where(and(eq(schema.sites.id, siteId), isNull(schema.sites.deletedAt)));
  if (!site)
    throw new ApiError(422, 'VALIDATION_ERROR', 'Site inconnu.', false, { field: 'site_id' });
}

async function tagsOf(tx: Transaction, mediaIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (mediaIds.length === 0) return result;
  const rows = await tx
    .select({ mediaId: schema.mediaTags.mediaId, name: schema.tags.name })
    .from(schema.mediaTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.mediaTags.tagId))
    .where(inArray(schema.mediaTags.mediaId, mediaIds))
    .orderBy(asc(schema.tags.name));
  for (const row of rows) result.set(row.mediaId, [...(result.get(row.mediaId) ?? []), row.name]);
  return result;
}

async function setTags(
  tx: Transaction,
  organizationId: string,
  mediaId: string,
  names: string[],
): Promise<void> {
  // Première graphie conservée ; les doublons à la casse près sont ignorés.
  const unique = new Map<string, string>();
  for (const raw of names) {
    const name = raw.trim();
    if (name && !unique.has(name.toLowerCase())) unique.set(name.toLowerCase(), name);
  }
  await tx.delete(schema.mediaTags).where(eq(schema.mediaTags.mediaId, mediaId));
  for (const name of unique.values()) {
    await tx.execute(
      sql`insert into tags (organization_id, name) values (${organizationId}, ${name})
          on conflict (organization_id, lower(name)) do nothing`,
    );
    const [tag] = await tx
      .select({ id: schema.tags.id })
      .from(schema.tags)
      .where(
        and(
          eq(schema.tags.organizationId, organizationId),
          sql`lower(${schema.tags.name}) = lower(${name})`,
        ),
      );
    if (tag)
      await tx
        .insert(schema.mediaTags)
        .values({ organizationId, mediaId, tagId: tag.id })
        .onConflictDoNothing();
  }
}

/** URL de lecture temporaire d’un objet autorisé (ARC-005) ; jamais d’URL permanente. */
async function previewUrl(
  services: Services,
  key: string,
): Promise<{ url: string; expiresAt: Date }> {
  try {
    const signed = await services.storage.presignGet(key, {
      expiresInSeconds: services.media.previewUrlSeconds,
    });
    return { url: signed.url, expiresAt: signed.expiresAt };
  } catch (error) {
    storageError(error);
  }
}

async function thumbnails(
  tx: Transaction,
  services: Services,
  media: MediaRow[],
): Promise<Map<string, string>> {
  const ids = media.filter((m) => m.status === 'ready' && !m.purgeStartedAt).map((m) => m.id);
  const result = new Map<string, string>();
  if (ids.length === 0) return result;
  const rows = await tx
    .select({ mediaId: schema.mediaAssets.mediaId, key: schema.mediaAssets.storageKey })
    .from(schema.mediaAssets)
    .where(
      and(inArray(schema.mediaAssets.mediaId, ids), eq(schema.mediaAssets.variant, 'thumbnail')),
    );
  for (const row of rows) result.set(row.mediaId, (await previewUrl(services, row.key)).url);
  return result;
}

function decodeCursor(cursor: string): { t: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      t?: unknown;
      id?: unknown;
    };
    if (
      typeof value.t === 'string' &&
      typeof value.id === 'string' &&
      !Number.isNaN(Date.parse(value.t)) &&
      /^[0-9a-f-]{36}$/.test(value.id)
    ) {
      return { t: value.t, id: value.id };
    }
  } catch {
    // curseur invalide
  }
  throw new ApiError(400, 'VALIDATION_ERROR', 'Curseur invalide.');
}

export function mediaRoutes(app: FastifyInstance, services: Services): void {
  // --- Upload direct (MED-002, API-007) -----------------------------------------------------
  app.post(
    '/media/upload-session',
    {
      schema: {
        body: Type.Object(
          {
            filename: Type.String({ minLength: 1, maxLength: 1024 }),
            name: Type.Optional(Name),
            mime_type: Type.String({ minLength: 1, maxLength: 100 }),
            size_bytes: Type.Integer({ minimum: 1, maximum: 1_000_000_000_000 }),
            site_id: Type.Optional(Type.Union([Uuid, Type.Null()])),
            folder_id: Type.Optional(Type.Union([Uuid, Type.Null()])),
            checksum_sha256: Type.Optional(Sha256),
          },
          Strict,
        ),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const body = request.body as {
        filename: string;
        name?: string;
        mime_type: string;
        size_bytes: number;
        site_id?: string | null;
        folder_id?: string | null;
        checksum_sha256?: string;
      };
      const category = mediaCategoryOf(body.mime_type);
      if (!category) {
        throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Format non accepté.', false, {
          accepted: Object.keys(ACCEPTED_MEDIA_MIME_TYPES),
        });
      }
      const maxBytes = maxBytesFor(category, services.media.limits);
      if (body.size_bytes > maxBytes) {
        throw new ApiError(413, 'FILE_TOO_LARGE', 'Fichier trop volumineux.', false, {
          max_bytes: maxBytes,
        });
      }
      await rateLimit(services, `upload:user:${member.auth.user.id}`, 300, 3600);
      const scope = idempotencyScope(
        request,
        member.organizationId,
        member.auth.user.id,
        'media.upload_session',
      );
      const now = services.now();
      const result = await withTenant(services.db, member.organizationId, (tx) =>
        idempotent(tx, scope, async () => {
          let siteId = body.site_id ?? null;
          let folderId: string | null = null;
          if (body.folder_id) {
            const folder = await loadFolder(tx, member, body.folder_id);
            if (body.site_id !== undefined && body.site_id !== folder.siteId) {
              throw new ApiError(
                422,
                'VALIDATION_ERROR',
                'Le dossier appartient à un autre périmètre.',
                false,
                { field: 'folder_id' },
              );
            }
            siteId = folder.siteId;
            folderId = folder.id;
          }
          authorize(member, 'content.manage', { siteId });
          if (siteId) await assertSite(tx, siteId);

          // Réservation du quota sous verrou (DATA-008) : aucune course sur les derniers octets.
          const usage = await lockUsage(tx, member.organizationId, 'storage_bytes');
          const limit = await services.entitlements.storageBytes(member.organizationId);
          if (usage.observed + usage.reserved + body.size_bytes > limit) {
            throw new ApiError(
              409,
              'STORAGE_QUOTA_EXCEEDED',
              'Espace de stockage insuffisant.',
              false,
              {
                limit_bytes: limit,
                used_bytes: usage.observed,
                reserved_bytes: usage.reserved,
              },
            );
          }
          await adjustUsage(
            tx,
            member.organizationId,
            'storage_bytes',
            { reserved: body.size_bytes },
            now,
          );

          const filename = cleanFilename(body.filename);
          const [media] = await tx
            .insert(schema.media)
            .values({
              organizationId: member.organizationId,
              siteId,
              folderId,
              name: body.name?.trim() || filename,
              type: category,
              status: 'uploading',
              declaredMimeType: body.mime_type,
              originalFilename: filename,
              createdBy: member.auth.user.id,
            })
            .returning();
          const uploadId = crypto.randomUUID();
          const objectKey = uploadObjectKey(member.organizationId, uploadId);
          await tx.insert(schema.uploadSessions).values({
            id: uploadId,
            organizationId: member.organizationId,
            mediaId: media!.id,
            objectKey,
            declaredSize: body.size_bytes,
            declaredMimeType: body.mime_type,
            clientChecksumSha256: body.checksum_sha256 ?? null,
            reservedBytes: body.size_bytes,
            expiresAt: new Date(now.getTime() + services.media.uploadUrlMinutes * 60_000),
            createdBy: member.auth.user.id,
          });
          let signed;
          try {
            signed = await services.storage.presignPut(objectKey, {
              contentType: body.mime_type,
              contentLength: body.size_bytes,
              expiresInSeconds: services.media.uploadUrlMinutes * 60,
            });
          } catch (error) {
            storageError(error);
          }
          await audit(tx, {
            organizationId: member.organizationId,
            actorType: 'user',
            actorId: member.auth.user.id,
            action: 'media.upload_started',
            permission: 'content.manage',
            targetType: 'media',
            targetId: media!.id,
            result: 'success',
            ...requestMeta(request),
            metadata: { mime_type: body.mime_type, size_bytes: body.size_bytes },
          });
          return {
            status: 201,
            body: {
              upload_id: uploadId,
              media: publicMedia(media!),
              upload: {
                method: signed.method,
                url: signed.url,
                headers: signed.headers,
                expires_at: signed.expiresAt.toISOString(),
              },
            },
          };
        }),
      );
      return reply.status(result.status).send(result.body);
    },
  );

  async function loadSession(tx: Transaction, member: MemberContext, id: string) {
    const [session] = await tx
      .select()
      .from(schema.uploadSessions)
      .where(eq(schema.uploadSessions.id, id))
      .for('update');
    if (!session) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Envoi introuvable.');
    const media = await loadMedia(tx, member, session.mediaId, true);
    authorize(member, 'content.manage', { siteId: media.siteId });
    return { session, media };
  }

  /** Finalisation : l’objet reçu est vérifié avant toute exploitation (API-007). */
  app.post(
    '/media/upload-session/:id/complete',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const now = services.now();
      const media = await withTenant(services.db, member.organizationId, async (tx) => {
        const { session, media } = await loadSession(tx, member, id);
        if (session.state === 'completed') return media;
        if (session.state !== 'pending') {
          throw new ApiError(
            409,
            'UPLOAD_SESSION_CLOSED',
            'Cet envoi a été abandonné ou a expiré.',
          );
        }
        let head;
        try {
          head = await services.storage.head(session.objectKey);
        } catch (error) {
          storageError(error);
        }
        if (!head) throw new ApiError(422, 'UPLOAD_INCOMPLETE', 'Le fichier n’a pas été reçu.');
        if (head.size !== session.declaredSize) {
          throw new ApiError(
            422,
            'UPLOAD_SIZE_MISMATCH',
            'Taille reçue différente de la taille annoncée.',
            false,
            {
              declared_bytes: session.declaredSize,
              received_bytes: head.size,
            },
          );
        }
        await tx
          .update(schema.uploadSessions)
          .set({ state: 'completed', completedAt: now })
          .where(eq(schema.uploadSessions.id, session.id));
        await adjustUsage(
          tx,
          member.organizationId,
          'storage_bytes',
          { reserved: -session.reservedBytes, observed: session.declaredSize },
          now,
        );
        const [updated] = await tx
          .update(schema.media)
          .set({ status: 'processing', quotaBytes: session.declaredSize, updatedAt: now })
          .where(eq(schema.media.id, media.id))
          .returning();
        await enqueueJob(tx, {
          organizationId: member.organizationId,
          kind: MEDIA_INGEST,
          dedupeKey: media.id,
          payload: { mediaId: media.id },
        });
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'media.uploaded',
          permission: 'content.manage',
          targetType: 'media',
          targetId: media.id,
          result: 'success',
          ...requestMeta(request),
          metadata: { size_bytes: session.declaredSize },
        });
        return updated!;
      });
      return reply.status(202).send(publicMedia(media));
    },
  );

  app.post(
    '/media/upload-session/:id/abort',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const now = services.now();
      await withTenant(services.db, member.organizationId, async (tx) => {
        const { session, media } = await loadSession(tx, member, id);
        if (session.state === 'aborted') return;
        if (session.state !== 'pending') {
          throw new ApiError(
            409,
            'UPLOAD_SESSION_CLOSED',
            'Cet envoi est déjà finalisé ou expiré.',
          );
        }
        await abortSession(tx, member.organizationId, session, media.id, now);
      });
      return reply.status(204).send();
    },
  );

  // --- Bibliothèque (MED-001) --------------------------------------------------------------
  app.get(
    '/media',
    {
      schema: {
        querystring: Type.Object(
          {
            folder_id: Type.Optional(Type.Union([Uuid, Type.Literal('root')])),
            type: Type.Optional(Type.Union([Type.Literal('image'), Type.Literal('video')])),
            status: Type.Optional(Type.Union(schema.MEDIA_STATUSES.map((s) => Type.Literal(s)))),
            tag: Type.Optional(TagName),
            q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
            trash: Type.Optional(Type.Literal('true')),
            limit: Type.Optional(Type.String({ pattern: '^(?:[1-9][0-9]?|100)$' })),
            cursor: Type.Optional(Type.String({ maxLength: 200 })),
          },
          Strict,
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const query = request.query as {
        folder_id?: string;
        type?: 'image' | 'video';
        status?: (typeof schema.MEDIA_STATUSES)[number];
        tag?: string;
        q?: string;
        trash?: 'true';
        limit?: string;
        cursor?: string;
      };
      const limit = query.limit ? Number(query.limit) : 50;
      const cursor = query.cursor ? decodeCursor(query.cursor) : null;
      const m = schema.media;
      return withTenant(services.db, member.organizationId, async (tx) => {
        const conditions: (SQL | undefined)[] = [
          siteVisible(m.siteId, visibleSites(member)),
          query.trash
            ? and(
                isNotNull(m.deletedAt),
                or(isNull(m.errorCode), notInArray(m.errorCode, DISCARDED)),
              )
            : isNull(m.deletedAt),
          query.folder_id === 'root'
            ? isNull(m.folderId)
            : query.folder_id
              ? eq(m.folderId, query.folder_id)
              : undefined,
          query.type ? eq(m.type, query.type) : undefined,
          query.status ? eq(m.status, query.status) : undefined,
          query.q ? ilike(m.name, `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : undefined,
          query.tag
            ? sql`exists (select 1 from media_tags mt join tags t on t.id = mt.tag_id where mt.media_id = ${m.id} and lower(t.name) = lower(${query.tag}))`
            : undefined,
          cursor
            ? sql`(${m.createdAt}, ${m.id}) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)`
            : undefined,
        ];
        const rows = await tx
          .select()
          .from(m)
          .where(and(...conditions))
          .orderBy(desc(m.createdAt), desc(m.id))
          .limit(limit + 1);
        const page = rows.slice(0, limit);
        const tags = await tagsOf(
          tx,
          page.map((row) => row.id),
        );
        const thumbs = await thumbnails(tx, services, page);
        const last = page.at(-1);
        return {
          items: page.map((row) =>
            publicMedia(row, {
              tags: tags.get(row.id) ?? [],
              thumbnailUrl: thumbs.get(row.id) ?? null,
            }),
          ),
          has_more: rows.length > limit,
          next_cursor:
            rows.length > limit && last
              ? Buffer.from(
                  JSON.stringify({ t: last.createdAt.toISOString(), id: last.id }),
                ).toString('base64url')
              : null,
        };
      });
    },
  );

  app.get('/media/usage', async (request) => {
    const member = await requireMember(request, services);
    const limit = await services.entitlements.storageBytes(member.organizationId);
    const usage = await withTenant(services.db, member.organizationId, (tx) =>
      lockUsage(tx, member.organizationId, 'storage_bytes'),
    );
    return { limit_bytes: limit, used_bytes: usage.observed, reserved_bytes: usage.reserved };
  });

  app.get(
    '/media/:id',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      return withTenant(services.db, member.organizationId, async (tx) => {
        const media = await loadMedia(tx, member, id);
        const assets = await tx
          .select()
          .from(schema.mediaAssets)
          .where(eq(schema.mediaAssets.mediaId, id))
          .orderBy(asc(schema.mediaAssets.variant));
        const tags = await tagsOf(tx, [id]);
        const thumbs = await thumbnails(tx, services, [media]);
        return {
          ...publicMedia(media, { tags: tags.get(id) ?? [], thumbnailUrl: thumbs.get(id) ?? null }),
          assets: assets.map(publicAsset),
          usages: await mediaUsages(tx, id),
        };
      });
    },
  );

  app.get(
    '/media/:id/usages',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      return withTenant(services.db, member.organizationId, async (tx) => {
        await loadMedia(tx, member, id);
        return { items: await mediaUsages(tx, id) };
      });
    },
  );

  /** URL temporaire d’une variante, après contrôle du tenant et du site (SEC-003). */
  app.get(
    '/media/:id/assets/:variant/url',
    { schema: { params: Type.Object({ id: Uuid, variant: Variant }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id, variant } = request.params as {
        id: string;
        variant: 'original' | 'playback' | 'thumbnail';
      };
      const asset = await withTenant(services.db, member.organizationId, async (tx) => {
        const media = await loadMedia(tx, member, id);
        if (media.purgeStartedAt)
          throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Variante indisponible.');
        const [row] = await tx
          .select()
          .from(schema.mediaAssets)
          .where(and(eq(schema.mediaAssets.mediaId, id), eq(schema.mediaAssets.variant, variant)));
        if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Variante indisponible.');
        return row;
      });
      const signed = await previewUrl(services, asset.storageKey);
      return {
        url: signed.url,
        expires_at: signed.expiresAt.toISOString(),
        mime_type: asset.mimeType,
        size_bytes: asset.sizeBytes,
        checksum_sha256: asset.checksumSha256,
        accepts_ranges: true,
      };
    },
  );

  app.patch(
    '/media/:id',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object(
          {
            name: Type.Optional(Name),
            folder_id: Type.Optional(Type.Union([Uuid, Type.Null()])),
            tags: Type.Optional(Type.Array(TagName, { maxItems: 20 })),
          },
          { ...Strict, minProperties: 1 },
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const body = request.body as { name?: string; folder_id?: string | null; tags?: string[] };
      return withTenant(services.db, member.organizationId, async (tx) => {
        const media = await loadMedia(tx, member, id, true);
        authorize(member, 'content.manage', { siteId: media.siteId });
        if (media.deletedAt)
          throw new ApiError(409, 'MEDIA_IN_TRASH', 'Restaurez le média avant de le modifier.');
        if (body.folder_id) {
          const folder = await loadFolder(tx, member, body.folder_id);
          if (folder.siteId !== media.siteId) {
            throw new ApiError(
              422,
              'VALIDATION_ERROR',
              'Le dossier appartient à un autre périmètre.',
              false,
              { field: 'folder_id' },
            );
          }
        }
        const [updated] = await tx
          .update(schema.media)
          .set({
            ...(body.name !== undefined ? { name: body.name.trim() } : {}),
            ...(body.folder_id !== undefined ? { folderId: body.folder_id } : {}),
            updatedAt: services.now(),
          })
          .where(eq(schema.media.id, id))
          .returning();
        if (body.tags) await setTags(tx, member.organizationId, id, body.tags);
        const tags = await tagsOf(tx, [id]);
        return publicMedia(updated!, { tags: tags.get(id) ?? [] });
      });
    },
  );

  // --- Corbeille, restauration, purge (MED-008, MED-009) -------------------------------------
  app.delete(
    '/media/:id',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        querystring: Type.Object({ force: Type.Optional(Type.Literal('true')) }, Strict),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const force = (request.query as { force?: string }).force === 'true';
      const now = services.now();
      await withTenant(services.db, member.organizationId, async (tx) => {
        const media = await loadMedia(tx, member, id, true);
        authorize(member, 'content.manage', { siteId: media.siteId });
        if (media.deletedAt) return;
        const usages = (await mediaUsages(tx, id)).filter((usage) => usage.blocking);
        if (usages.length > 0) {
          if (!force) {
            throw new ApiError(
              409,
              'MEDIA_IN_USE',
              'Ce média est utilisé par des contenus.',
              false,
              { usages },
            );
          }
          authorize(member, 'content.force_delete', { siteId: media.siteId });
        }
        if (media.status === 'uploading') {
          const [session] = await tx
            .select()
            .from(schema.uploadSessions)
            .where(
              and(
                eq(schema.uploadSessions.mediaId, id),
                eq(schema.uploadSessions.state, 'pending'),
              ),
            )
            .for('update');
          if (session) {
            await abortSession(tx, member.organizationId, session, id, now);
            return;
          }
        }
        await tx
          .update(schema.media)
          .set({
            deletedAt: now,
            deletedBy: member.auth.user.id,
            purgeAfter: new Date(now.getTime() + services.media.trashRetentionDays * 86_400_000),
            updatedAt: now,
          })
          .where(eq(schema.media.id, id));
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: usages.length > 0 ? 'media.force_deleted' : 'media.deleted',
          permission: usages.length > 0 ? 'content.force_delete' : 'content.manage',
          targetType: 'media',
          targetId: id,
          result: 'success',
          ...requestMeta(request),
          metadata: { name: media.name, usages: usages.length },
        });
      });
      return reply.status(204).send();
    },
  );

  app.post(
    '/media/:id/restore',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      return withTenant(services.db, member.organizationId, async (tx) => {
        const media = await loadMedia(tx, member, id, true);
        authorize(member, 'content.manage', { siteId: media.siteId });
        if (!media.deletedAt) return publicMedia(media);
        if (media.purgeStartedAt) {
          throw new ApiError(
            409,
            'MEDIA_PURGING',
            'Suppression définitive en cours : restauration impossible.',
          );
        }
        if (media.errorCode && DISCARDED.includes(media.errorCode)) {
          throw new ApiError(409, 'MEDIA_NOT_RESTORABLE', 'Ce fichier n’a jamais été reçu.');
        }
        const [restored] = await tx
          .update(schema.media)
          .set({ deletedAt: null, deletedBy: null, purgeAfter: null, updatedAt: services.now() })
          .where(eq(schema.media.id, id))
          .returning();
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'media.restored',
          permission: 'content.manage',
          targetType: 'media',
          targetId: id,
          result: 'success',
          ...requestMeta(request),
        });
        const tags = await tagsOf(tx, [id]);
        return publicMedia(restored!, { tags: tags.get(id) ?? [] });
      });
    },
  );

  app.post(
    '/media/:id/purge',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const now = services.now();
      const media = await withTenant(services.db, member.organizationId, async (tx) => {
        const media = await loadMedia(tx, member, id, true);
        authorize(member, 'content.manage', { siteId: media.siteId });
        if (!media.deletedAt) {
          throw new ApiError(
            409,
            'MEDIA_NOT_IN_TRASH',
            'Placez d’abord le média dans la corbeille.',
          );
        }
        // Les versions publiées qui le référencent protègent le binaire (MED-006).
        const blocking = (await mediaUsages(tx, id)).filter((usage) => usage.blocking);
        if (blocking.length > 0) {
          throw new ApiError(
            409,
            'MEDIA_REFERENCED',
            'Des versions publiées utilisent ce média : sa suppression définitive est impossible.',
            false,
            { usages: blocking },
          );
        }
        const [updated] = await tx
          .update(schema.media)
          .set({ purgeAfter: now, updatedAt: now })
          .where(eq(schema.media.id, id))
          .returning();
        await enqueueJob(tx, {
          organizationId: member.organizationId,
          kind: MEDIA_PURGE,
          dedupeKey: id,
          payload: { mediaId: id },
        });
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'media.purge_requested',
          permission: 'content.manage',
          targetType: 'media',
          targetId: id,
          result: 'success',
          ...requestMeta(request),
          metadata: { name: media.name },
        });
        return updated!;
      });
      return reply.status(202).send(publicMedia(media));
    },
  );

  /** Nouvel essai contrôlé après échec de préparation (MED-003). */
  app.post(
    '/media/:id/retry',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const media = await withTenant(services.db, member.organizationId, async (tx) => {
        const media = await loadMedia(tx, member, id, true);
        authorize(member, 'content.manage', { siteId: media.siteId });
        if (media.deletedAt)
          throw new ApiError(409, 'MEDIA_IN_TRASH', 'Restaurez le média avant de réessayer.');
        if (media.status !== 'error' || (media.errorCode && DISCARDED.includes(media.errorCode))) {
          throw new ApiError(409, 'MEDIA_NOT_RETRYABLE', 'Aucune préparation en échec à relancer.');
        }
        const [updated] = await tx
          .update(schema.media)
          .set({
            status: 'processing',
            errorCode: null,
            errorDetail: null,
            updatedAt: services.now(),
          })
          .where(eq(schema.media.id, id))
          .returning();
        await enqueueJob(tx, {
          organizationId: member.organizationId,
          kind: MEDIA_INGEST,
          dedupeKey: id,
          payload: { mediaId: id },
        });
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'media.retry',
          permission: 'content.manage',
          targetType: 'media',
          targetId: id,
          result: 'success',
          ...requestMeta(request),
          metadata: { previous_error: media.errorCode },
        });
        return updated!;
      });
      return reply.status(202).send(publicMedia(media));
    },
  );

  // --- Dossiers et tags -------------------------------------------------------------------
  app.get('/media-folders', async (request) => {
    const member = await requireMember(request, services);
    return withTenant(services.db, member.organizationId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.mediaFolders)
        .where(siteVisible(schema.mediaFolders.siteId, visibleSites(member)))
        .orderBy(asc(schema.mediaFolders.name));
      return { items: rows.map(publicFolder) };
    });
  });

  app.post(
    '/media-folders',
    {
      schema: {
        body: Type.Object(
          {
            name: Type.String({ minLength: 1, maxLength: 100 }),
            parent_id: Type.Optional(Type.Union([Uuid, Type.Null()])),
            site_id: Type.Optional(Type.Union([Uuid, Type.Null()])),
          },
          Strict,
        ),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const body = request.body as {
        name: string;
        parent_id?: string | null;
        site_id?: string | null;
      };
      const folder = await withTenant(services.db, member.organizationId, async (tx) => {
        let siteId = body.site_id ?? null;
        if (body.parent_id) {
          const parent = await loadFolder(tx, member, body.parent_id);
          if (body.site_id !== undefined && body.site_id !== parent.siteId) {
            throw new ApiError(
              422,
              'VALIDATION_ERROR',
              'Le dossier parent appartient à un autre périmètre.',
              false,
              { field: 'parent_id' },
            );
          }
          siteId = parent.siteId;
        }
        authorize(member, 'content.manage', { siteId });
        if (siteId) await assertSite(tx, siteId);
        return insertFolder(tx, {
          organizationId: member.organizationId,
          siteId,
          parentId: body.parent_id ?? null,
          name: body.name.trim(),
        });
      });
      return reply.status(201).send(publicFolder(folder));
    },
  );

  app.patch(
    '/media-folders/:id',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object(
          {
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
            parent_id: Type.Optional(Type.Union([Uuid, Type.Null()])),
          },
          { ...Strict, minProperties: 1 },
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const body = request.body as { name?: string; parent_id?: string | null };
      return withTenant(services.db, member.organizationId, async (tx) => {
        // Verrou de l’arborescence de l’organisation : deux déplacements croisés ne créent pas de cycle.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext('media_folders:' || ${member.organizationId}))`,
        );
        const folder = await loadFolder(tx, member, id, true);
        authorize(member, 'content.manage', { siteId: folder.siteId });
        if (body.parent_id) {
          const parent = await loadFolder(tx, member, body.parent_id);
          if (parent.siteId !== folder.siteId) {
            throw new ApiError(
              422,
              'VALIDATION_ERROR',
              'Le dossier parent appartient à un autre périmètre.',
              false,
              { field: 'parent_id' },
            );
          }
          const cycle = await tx.execute<{ id: string }>(sql`
            with recursive ancestors(id, parent_id) as (
              select id, parent_id from media_folders where id = ${body.parent_id}
              union all
              select f.id, f.parent_id from media_folders f join ancestors a on f.id = a.parent_id
            )
            select id from ancestors where id = ${id} limit 1`);
          if (cycle.rows.length > 0) {
            throw new ApiError(
              422,
              'FOLDER_CYCLE',
              'Un dossier ne peut pas être placé dans lui-même ou dans un de ses sous-dossiers.',
            );
          }
        }
        try {
          const [updated] = await tx
            .update(schema.mediaFolders)
            .set({
              ...(body.name !== undefined ? { name: body.name.trim() } : {}),
              ...(body.parent_id !== undefined ? { parentId: body.parent_id } : {}),
              updatedAt: services.now(),
            })
            .where(eq(schema.mediaFolders.id, id))
            .returning();
          return publicFolder(updated!);
        } catch (error) {
          throw folderConflict(error);
        }
      });
    },
  );

  app.delete(
    '/media-folders/:id',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      await withTenant(services.db, member.organizationId, async (tx) => {
        const folder = await loadFolder(tx, member, id, true);
        authorize(member, 'content.manage', { siteId: folder.siteId });
        const [child] = await tx
          .select({ id: schema.mediaFolders.id })
          .from(schema.mediaFolders)
          .where(eq(schema.mediaFolders.parentId, id))
          .limit(1);
        const [live] = await tx
          .select({ id: schema.media.id })
          .from(schema.media)
          .where(and(eq(schema.media.folderId, id), isNull(schema.media.deletedAt)))
          .limit(1);
        if (child || live)
          throw new ApiError(409, 'FOLDER_NOT_EMPTY', 'Le dossier n’est pas vide.');
        // Les médias en corbeille reviendront à la racine s’ils sont restaurés.
        await tx.update(schema.media).set({ folderId: null }).where(eq(schema.media.folderId, id));
        await tx.delete(schema.mediaFolders).where(eq(schema.mediaFolders.id, id));
      });
      return reply.status(204).send();
    },
  );

  app.get('/tags', async (request) => {
    const member = await requireMember(request, services);
    const visible = visibleSites(member);
    return withTenant(services.db, member.organizationId, async (tx) => {
      const rows =
        visible === 'all'
          ? await tx
              .select({ name: schema.tags.name })
              .from(schema.tags)
              .orderBy(asc(schema.tags.name))
          : await tx
              .selectDistinct({ name: schema.tags.name })
              .from(schema.tags)
              .innerJoin(schema.mediaTags, eq(schema.mediaTags.tagId, schema.tags.id))
              .innerJoin(schema.media, eq(schema.media.id, schema.mediaTags.mediaId))
              .where(inArray(schema.media.siteId, visible.length ? visible : [NONE]))
              .orderBy(asc(schema.tags.name));
      return { items: rows.map((row) => row.name) };
    });
  });
}

function folderConflict(error: unknown): unknown {
  if (
    (error as { code?: string; cause?: { code?: string } }).code === '23505' ||
    (error as { cause?: { code?: string } }).cause?.code === '23505'
  ) {
    return new ApiError(409, 'FOLDER_NAME_TAKEN', 'Un dossier porte déjà ce nom à cet endroit.');
  }
  return error;
}

async function insertFolder(
  tx: Transaction,
  values: { organizationId: string; siteId: string | null; parentId: string | null; name: string },
): Promise<FolderRow> {
  try {
    const [folder] = await tx.insert(schema.mediaFolders).values(values).returning();
    return folder!;
  } catch (error) {
    throw folderConflict(error);
  }
}

/** Abandon d’un envoi : réservation libérée, média écarté puis purgé par le worker. */
async function abortSession(
  tx: Transaction,
  organizationId: string,
  session: typeof schema.uploadSessions.$inferSelect,
  mediaId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(schema.uploadSessions)
    .set({ state: 'aborted' })
    .where(eq(schema.uploadSessions.id, session.id));
  await adjustUsage(tx, organizationId, 'storage_bytes', { reserved: -session.reservedBytes }, now);
  await tx
    .update(schema.media)
    .set({
      status: 'error',
      errorCode: 'UPLOAD_ABORTED',
      errorDetail: 'Envoi annulé.',
      deletedAt: now,
      purgeAfter: now,
      updatedAt: now,
    })
    .where(eq(schema.media.id, mediaId));
}
