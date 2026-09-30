/**
 * Playlists (PLN-001, PLN-002, ADR-011) : brouillon sous concurrence optimiste, validation
 * avant publication (contenus publiables, durées, cycles), versions immuables et graphe
 * de dépendances typé. Toute publication ou suppression demande une recompilation.
 */
import { and, desc, eq, ilike, inArray, isNull, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Type from 'typebox';
import {
  describeErrors,
  PLAYLIST_DOCUMENT_VERSION,
  validator,
  type ContentRef,
  type PlaylistDocument,
} from '@pixlova/contracts';
import { schema, withTenant, type Transaction } from '@pixlova/db';
import { siteFilter } from '@pixlova/permissions';
import { ApiError } from '../errors.js';
import { authorize, requestMeta, requireMember, type MemberContext } from '../http/context.js';
import type { Services } from '../http/services.js';
import { audit } from '../lib/audit.js';
import { idempotencyScope, idempotent } from '../lib/idempotency.js';
import {
  canSeeSite,
  contentInfos,
  cycleIssues,
  recompile,
  referenceIssues,
  type ContentInfo,
  type GraphIssue,
} from './content-graph.js';
import { Strict, Uuid } from './schemas.js';

type PlaylistRow = typeof schema.playlists.$inferSelect;

const NONE = '00000000-0000-0000-0000-000000000000';
const Name = Type.String({ minLength: 1, maxLength: 120 });
const validateDocument = validator('playlist-document.json');

function parseDocument(value: unknown): PlaylistDocument {
  if (!validateDocument(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Document de playlist invalide.', false, {
      detail: describeErrors(validateDocument.errors).slice(0, 500),
    });
  }
  return value as PlaylistDocument;
}

export function emptyPlaylist(): PlaylistDocument {
  return { schema_version: PLAYLIST_DOCUMENT_VERSION, transition: 'cut', items: [] };
}

function publicPlaylist(row: PlaylistRow) {
  return {
    id: row.id,
    name: row.name,
    site_id: row.siteId,
    draft_revision: row.draftRevision,
    has_unpublished_changes: row.hasUnpublishedChanges,
    published_version: row.publishedVersion,
    published_at: row.publishedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function refsOf(document: PlaylistDocument): ContentRef[] {
  return document.items.map((item) => item.content);
}

/** Anomalies d’un brouillon : structure, durées (PLN-001), contenus et cycles. */
async function playlistIssues(
  tx: Transaction,
  member: MemberContext,
  row: PlaylistRow,
  document: PlaylistDocument,
  infos: Map<string, ContentInfo>,
): Promise<GraphIssue[]> {
  const issues: GraphIssue[] = [];
  const ids = new Set<string>();
  for (const item of document.items) {
    const issue = (code: string, message: string) =>
      issues.push({ severity: 'error', code, ref: item.id, message });
    if (ids.has(item.id)) issue('DUPLICATE_ITEM_ID', 'Identifiant d’élément en double.');
    ids.add(item.id);
    if (
      item.valid_from !== null &&
      item.valid_until !== null &&
      Date.parse(item.valid_until) <= Date.parse(item.valid_from)
    ) {
      issue('VALIDITY_INVALID', 'La fin de validité précède son début.');
    }
    const info = infos.get(`${item.content.type}:${item.content.id}`);
    if (item.duration_ms === null && info) {
      if (info.type === 'media' && info.media_type === 'image') {
        issue('DURATION_REQUIRED', `Indiquez une durée pour l’image « ${info.name} ».`);
      }
      if (info.type === 'composition' && info.publishable && info.duration_ms === null) {
        issue(
          'DURATION_REQUIRED',
          `« ${info.name} » n’a pas de durée propre : indiquez-la dans la playlist.`,
        );
      }
    }
  }
  const active = document.items.filter((item) => item.enabled);
  if (active.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'PLAYLIST_EMPTY',
      ref: null,
      message: 'Aucun élément actif : la playlist cédera la place au niveau inférieur ou au repli.',
    });
  }
  issues.push(...referenceIssues(refsOf(document), infos, row.siteId));
  issues.push(...(await cycleIssues(tx, { type: 'playlist', id: row.id }, refsOf(document))));
  void member;
  return issues;
}

async function loadPlaylist(
  tx: Transaction,
  member: MemberContext,
  id: string,
  lock = false,
): Promise<PlaylistRow> {
  const query = tx
    .select()
    .from(schema.playlists)
    .where(and(eq(schema.playlists.id, id), isNull(schema.playlists.deletedAt)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row || !canSeeSite(member, row.siteId)) {
    throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Playlist introuvable.');
  }
  return row;
}

async function assertSite(tx: Transaction, siteId: string): Promise<void> {
  const [site] = await tx
    .select({ id: schema.sites.id })
    .from(schema.sites)
    .where(and(eq(schema.sites.id, siteId), isNull(schema.sites.deletedAt)));
  if (!site) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Site inconnu.', false, { field: 'site_id' });
  }
}

function conflict(current: number): never {
  throw new ApiError(
    409,
    'PLAYLIST_CONFLICT',
    'La playlist a été modifiée entre-temps. Rechargez-la avant d’enregistrer.',
    false,
    { current_revision: current },
  );
}

function referencesOf(infos: Map<string, ContentInfo>) {
  return Object.fromEntries(
    [...infos.entries()].map(([key, info]) => [
      key,
      {
        name: info.name,
        type: info.type,
        media_type: info.media_type,
        status: info.status,
        duration_ms: info.duration_ms,
      },
    ]),
  );
}

export function playlistRoutes(app: FastifyInstance, services: Services): void {
  app.get(
    '/playlists',
    {
      schema: {
        querystring: Type.Object(
          {
            q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
            published: Type.Optional(Type.Literal('true')),
          },
          Strict,
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const query = request.query as { q?: string; published?: 'true' };
      const visible = siteFilter(member.grants, 'organization.read');
      const p = schema.playlists;
      const conditions: (SQL | undefined)[] = [
        isNull(p.deletedAt),
        visible === 'all' ? undefined : inArray(p.siteId, visible.length ? visible : [NONE]),
        query.q ? ilike(p.name, `%${query.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`) : undefined,
      ];
      const rows = await withTenant(services.db, member.organizationId, (tx) =>
        tx
          .select()
          .from(p)
          .where(and(...conditions))
          .orderBy(desc(p.updatedAt), desc(p.id))
          .limit(200),
      );
      return {
        items: rows
          .filter((row) => !query.published || row.publishedVersionId !== null)
          .map((row) => ({
            ...publicPlaylist(row),
            item_count: (row.draftDocument as PlaylistDocument).items.length,
          })),
      };
    },
  );

  app.post(
    '/playlists',
    {
      schema: {
        body: Type.Object(
          { name: Name, site_id: Type.Optional(Type.Union([Uuid, Type.Null()])) },
          Strict,
        ),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const body = request.body as { name: string; site_id?: string | null };
      const siteId = body.site_id ?? null;
      authorize(member, 'content.manage', { siteId });
      const scope = idempotencyScope(
        request,
        member.organizationId,
        member.auth.user.id,
        'playlists.create',
      );
      const result = await withTenant(services.db, member.organizationId, (tx) =>
        idempotent(tx, scope, async () => {
          if (siteId) await assertSite(tx, siteId);
          const [row] = await tx
            .insert(schema.playlists)
            .values({
              organizationId: member.organizationId,
              siteId,
              name: body.name.trim(),
              draftDocument: emptyPlaylist(),
              createdBy: member.auth.user.id,
              updatedBy: member.auth.user.id,
            })
            .returning();
          await audit(tx, {
            organizationId: member.organizationId,
            actorType: 'user',
            actorId: member.auth.user.id,
            action: 'playlist.created',
            permission: 'content.manage',
            targetType: 'playlist',
            targetId: row!.id,
            result: 'success',
            ...requestMeta(request),
          });
          return { status: 201, body: publicPlaylist(row!) };
        }),
      );
      return reply.status(result.status).send(result.body);
    },
  );

  app.get(
    '/playlists/:id',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      return withTenant(services.db, member.organizationId, async (tx) => {
        const row = await loadPlaylist(tx, member, id);
        const document = parseDocument(row.draftDocument);
        const infos = await contentInfos(tx, member, refsOf(document));
        return {
          ...publicPlaylist(row),
          document,
          references: referencesOf(infos),
          issues: await playlistIssues(tx, member, row, document, infos),
        };
      });
    },
  );

  app.put(
    '/playlists/:id/draft',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object(
          {
            revision: Type.Integer({ minimum: 1 }),
            name: Type.Optional(Name),
            document: Type.Unknown(),
          },
          Strict,
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const body = request.body as { revision: number; name?: string; document: unknown };
      const document = parseDocument(body.document);
      return withTenant(services.db, member.organizationId, async (tx) => {
        const row = await loadPlaylist(tx, member, id, true);
        authorize(member, 'content.manage', { siteId: row.siteId });
        if (row.draftRevision !== body.revision) conflict(row.draftRevision);
        const [updated] = await tx
          .update(schema.playlists)
          .set({
            draftDocument: document,
            draftRevision: row.draftRevision + 1,
            hasUnpublishedChanges: true,
            ...(body.name ? { name: body.name.trim() } : {}),
            updatedBy: member.auth.user.id,
            updatedAt: services.now(),
          })
          .where(eq(schema.playlists.id, id))
          .returning();
        const infos = await contentInfos(tx, member, refsOf(document));
        return {
          ...publicPlaylist(updated!),
          references: referencesOf(infos),
          issues: await playlistIssues(tx, member, updated!, document, infos),
        };
      });
    },
  );

  /** Publication idempotente d’une révision précise du brouillon (API-004). */
  app.post(
    '/playlists/:id/publish',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object({ revision: Type.Integer({ minimum: 1 }) }, Strict),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const { revision } = request.body as { revision: number };
      const result = await withTenant(services.db, member.organizationId, async (tx) => {
        const row = await loadPlaylist(tx, member, id, true);
        authorize(member, 'content.manage', { siteId: row.siteId });
        if (row.draftRevision !== revision) conflict(row.draftRevision);
        if (!row.hasUnpublishedChanges && row.publishedVersion !== null) {
          return {
            status: 200,
            body: { playlist: publicPlaylist(row), version: row.publishedVersion, warnings: [] },
          };
        }
        const document = parseDocument(row.draftDocument);
        const infos = await contentInfos(tx, member, refsOf(document));
        const issues = await playlistIssues(tx, member, row, document, infos);
        const errors = issues.filter((issue) => issue.severity === 'error');
        if (errors.length > 0) {
          throw new ApiError(
            422,
            'PLAYLIST_INVALID',
            'La playlist ne peut pas être publiée.',
            false,
            {
              issues: errors,
            },
          );
        }
        const now = services.now();
        const version = (row.publishedVersion ?? 0) + 1;
        const [created] = await tx
          .insert(schema.playlistVersions)
          .values({
            organizationId: member.organizationId,
            playlistId: id,
            version,
            schemaVersion: document.schema_version,
            document,
            publishedBy: member.auth.user.id,
          })
          .returning();
        const targets = [
          ...new Map(refsOf(document).map((r) => [`${r.type}:${r.id}`, r])).values(),
        ];
        if (targets.length > 0) {
          await tx.insert(schema.contentDependencies).values(
            targets.map((ref) => ({
              organizationId: member.organizationId,
              playlistVersionId: created!.id,
              ...(ref.type === 'media' ? { mediaId: ref.id } : { compositionId: ref.id }),
            })),
          );
        }
        const [updated] = await tx
          .update(schema.playlists)
          .set({
            publishedVersion: version,
            publishedVersionId: created!.id,
            publishedAt: now,
            hasUnpublishedChanges: false,
            updatedAt: now,
          })
          .where(eq(schema.playlists.id, id))
          .returning();
        await recompile(tx, member, 'all', 'playlist.published');
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'playlist.published',
          permission: 'content.manage',
          targetType: 'playlist',
          targetId: id,
          result: 'success',
          ...requestMeta(request),
          metadata: { version, items: document.items.length },
        });
        return {
          status: 201,
          body: {
            playlist: publicPlaylist(updated!),
            version,
            warnings: issues.filter((issue) => issue.severity === 'warning'),
          },
        };
      });
      return reply.status(result.status).send(result.body);
    },
  );

  app.get(
    '/playlists/:id/versions',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      return withTenant(services.db, member.organizationId, async (tx) => {
        await loadPlaylist(tx, member, id);
        const rows = await tx
          .select()
          .from(schema.playlistVersions)
          .where(eq(schema.playlistVersions.playlistId, id))
          .orderBy(desc(schema.playlistVersions.version));
        return {
          items: rows.map((v) => ({
            id: v.id,
            version: v.version,
            item_count: (v.document as PlaylistDocument).items.length,
            published_at: v.createdAt.toISOString(),
            published_by: v.publishedBy,
          })),
        };
      });
    },
  );

  app.post(
    '/playlists/:id/duplicate',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object({ name: Name }, Strict),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const { name } = request.body as { name: string };
      const created = await withTenant(services.db, member.organizationId, async (tx) => {
        const row = await loadPlaylist(tx, member, id);
        authorize(member, 'content.manage', { siteId: row.siteId });
        const [copy] = await tx
          .insert(schema.playlists)
          .values({
            organizationId: member.organizationId,
            siteId: row.siteId,
            name: name.trim(),
            draftDocument: row.draftDocument,
            createdBy: member.auth.user.id,
            updatedBy: member.auth.user.id,
          })
          .returning();
        return copy!;
      });
      return reply.status(201).send(publicPlaylist(created));
    },
  );

  app.delete(
    '/playlists/:id',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      await withTenant(services.db, member.organizationId, async (tx) => {
        const row = await loadPlaylist(tx, member, id, true);
        authorize(member, 'content.manage', { siteId: row.siteId });
        const now = services.now();
        await tx
          .update(schema.playlists)
          .set({ deletedAt: now, updatedAt: now, updatedBy: member.auth.user.id })
          .where(eq(schema.playlists.id, id));
        if (row.publishedVersionId) await recompile(tx, member, 'all', 'playlist.deleted');
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'playlist.deleted',
          permission: 'content.manage',
          targetType: 'playlist',
          targetId: id,
          result: 'success',
          ...requestMeta(request),
        });
      });
      return reply.status(204).send();
    },
  );
}
