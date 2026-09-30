import { and, desc, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Type from 'typebox';
import {
  applyTemplate,
  COMPOSITION_DOCUMENT_VERSION,
  describeErrors,
  documentMediaIds,
  lintCompositionDocument,
  validator,
  type CompositionDocument,
  type CompositionIssue,
} from '@pixlova/contracts';
import { schema, withTenant, type Transaction } from '@pixlova/db';
import { siteFilter } from '@pixlova/permissions';
import { findTemplate, TEMPLATES } from '@pixlova/templates';
import { ApiError } from '../errors.js';
import { authorize, requestMeta, requireMember, type MemberContext } from '../http/context.js';
import type { Services } from '../http/services.js';
import { audit } from '../lib/audit.js';
import { idempotencyScope, idempotent } from '../lib/idempotency.js';
import { Strict, Uuid } from './schemas.js';

type CompositionRow = typeof schema.compositions.$inferSelect;

const NONE = '00000000-0000-0000-0000-000000000000';
const Name = Type.String({ minLength: 1, maxLength: 120 });
const Dimension = Type.Integer({ minimum: 1, maximum: 32767 });
const Color = Type.String({ pattern: '^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$' });
const validateDocument = validator('composition-document.json');

function visibleSites(member: MemberContext): string[] | 'all' {
  return siteFilter(member.grants, 'organization.read');
}

function canSee(member: MemberContext, siteId: string | null): boolean {
  const visible = visibleSites(member);
  return visible === 'all' || (siteId !== null && visible.includes(siteId));
}

/** Document d’édition reçu du client : schéma strict (contrats partagés), sinon 400. */
function parseDocument(value: unknown): CompositionDocument {
  if (!validateDocument(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Document de composition invalide.', false, {
      detail: describeErrors(validateDocument.errors).slice(0, 500),
    });
  }
  return value as CompositionDocument;
}

function emptyDocument(width: number, height: number, background: string): CompositionDocument {
  return {
    schema_version: COMPOSITION_DOCUMENT_VERSION,
    canvas: { width, height, background },
    elements: [],
    settings: { audio_policy: 'muted' },
  };
}

function publicComposition(row: CompositionRow) {
  return {
    id: row.id,
    name: row.name,
    site_id: row.siteId,
    width: row.width,
    height: row.height,
    draft_revision: row.draftRevision,
    has_unpublished_changes: row.hasUnpublishedChanges,
    published_version: row.publishedVersion,
    published_at: row.publishedAt?.toISOString() ?? null,
    source_template: row.sourceTemplateKey
      ? { key: row.sourceTemplateKey, version: row.sourceTemplateVersion }
      : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

async function loadComposition(
  tx: Transaction,
  member: MemberContext,
  id: string,
  lock = false,
): Promise<CompositionRow> {
  const query = tx
    .select()
    .from(schema.compositions)
    .where(and(eq(schema.compositions.id, id), isNull(schema.compositions.deletedAt)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row || !canSee(member, row.siteId)) {
    throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Composition introuvable.');
  }
  return row;
}

async function assertSite(tx: Transaction, siteId: string): Promise<void> {
  const [site] = await tx
    .select({ id: schema.sites.id })
    .from(schema.sites)
    .where(and(eq(schema.sites.id, siteId), isNull(schema.sites.deletedAt)));
  if (!site)
    throw new ApiError(422, 'VALIDATION_ERROR', 'Site inconnu.', false, { field: 'site_id' });
}

/**
 * Contrôles liés à la bibliothèque avant publication (MED-007, CMP-005) : chaque média
 * existe dans le tenant, est visible de l’auteur, compatible avec le périmètre de la
 * composition, prêt, hors corbeille et du type de l’élément.
 */
async function mediaIssues(
  tx: Transaction,
  member: MemberContext,
  composition: CompositionRow,
  document: CompositionDocument,
): Promise<CompositionIssue[]> {
  const ids = documentMediaIds(document);
  if (ids.length === 0) return [];
  const rows = await tx.select().from(schema.media).where(inArray(schema.media.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const issues: CompositionIssue[] = [];
  for (const element of document.elements) {
    if (element.type !== 'image' && element.type !== 'video') continue;
    const mediaId = element.props.media_id;
    if (!mediaId) continue;
    const row = byId.get(mediaId);
    const issue = (code: string, message: string) =>
      issues.push({ severity: 'error', code, element_id: element.id, message });
    if (!row || !canSee(member, row.siteId)) issue('MEDIA_NOT_FOUND', 'Média introuvable.');
    else if (row.deletedAt || row.purgeStartedAt)
      issue('MEDIA_DELETED', `« ${row.name} » est dans la corbeille.`);
    else if (row.siteId !== null && row.siteId !== composition.siteId) {
      issue(
        'MEDIA_SCOPE_MISMATCH',
        `« ${row.name} » appartient à un autre site que la composition.`,
      );
    } else if (row.type !== element.type) {
      issue(
        'MEDIA_TYPE_MISMATCH',
        `« ${row.name} » n’est pas ${element.type === 'image' ? 'une image' : 'une vidéo'}.`,
      );
    } else if (row.status !== 'ready') {
      issue(
        'MEDIA_NOT_READY',
        row.status === 'error'
          ? `« ${row.name} » est en erreur de préparation.`
          : `« ${row.name} » est encore en préparation.`,
      );
    }
  }
  return issues;
}

async function publishVersion(
  tx: Transaction,
  services: Services,
  member: MemberContext,
  composition: CompositionRow,
  document: CompositionDocument,
  restoredFrom: number | null,
) {
  const issues = [
    ...lintCompositionDocument(document),
    ...(await mediaIssues(tx, member, composition, document)),
  ];
  const errors = issues.filter((issue) => issue.severity === 'error');
  if (errors.length > 0) {
    throw new ApiError(
      422,
      'COMPOSITION_INVALID',
      'La composition ne peut pas être publiée.',
      false,
      {
        issues: errors,
      },
    );
  }
  const now = services.now();
  const version = (composition.publishedVersion ?? 0) + 1;
  const [created] = await tx
    .insert(schema.compositionVersions)
    .values({
      organizationId: member.organizationId,
      compositionId: composition.id,
      version,
      schemaVersion: document.schema_version,
      document,
      restoredFrom,
      publishedBy: member.auth.user.id,
    })
    .returning();
  const mediaIds = documentMediaIds(document);
  if (mediaIds.length > 0) {
    await tx.insert(schema.contentDependencies).values(
      mediaIds.map((mediaId) => ({
        organizationId: member.organizationId,
        compositionVersionId: created!.id,
        mediaId,
      })),
    );
  }
  return {
    created: created!,
    now,
    warnings: issues.filter((issue) => issue.severity === 'warning'),
  };
}

export function compositionRoutes(app: FastifyInstance, services: Services): void {
  app.get(
    '/compositions',
    {
      schema: {
        querystring: Type.Object(
          {
            q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
            limit: Type.Optional(Type.String({ pattern: '^(?:[1-9][0-9]?|100)$' })),
          },
          Strict,
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const query = request.query as { q?: string; limit?: string };
      const visible = visibleSites(member);
      const c = schema.compositions;
      const conditions: (SQL | undefined)[] = [
        isNull(c.deletedAt),
        visible === 'all' ? undefined : inArray(c.siteId, visible.length ? visible : [NONE]),
        query.q ? ilike(c.name, `%${query.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`) : undefined,
      ];
      const rows = await withTenant(services.db, member.organizationId, (tx) =>
        tx
          .select()
          .from(c)
          .where(and(...conditions))
          .orderBy(desc(c.updatedAt), desc(c.id))
          .limit(query.limit ? Number(query.limit) : 100),
      );
      return { items: rows.map(publicComposition) };
    },
  );

  app.post(
    '/compositions',
    {
      schema: {
        body: Type.Object(
          {
            name: Name,
            width: Dimension,
            height: Dimension,
            background: Type.Optional(Color),
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
        width: number;
        height: number;
        background?: string;
        site_id?: string | null;
      };
      const siteId = body.site_id ?? null;
      authorize(member, 'content.manage', { siteId });
      const scope = idempotencyScope(
        request,
        member.organizationId,
        member.auth.user.id,
        'compositions.create',
      );
      const result = await withTenant(services.db, member.organizationId, (tx) =>
        idempotent(tx, scope, async () => {
          if (siteId) await assertSite(tx, siteId);
          const [row] = await tx
            .insert(schema.compositions)
            .values({
              organizationId: member.organizationId,
              siteId,
              name: body.name.trim(),
              width: body.width,
              height: body.height,
              draftDocument: emptyDocument(body.width, body.height, body.background ?? '#101820'),
              createdBy: member.auth.user.id,
              updatedBy: member.auth.user.id,
            })
            .returning();
          await audit(tx, {
            organizationId: member.organizationId,
            actorType: 'user',
            actorId: member.auth.user.id,
            action: 'composition.created',
            permission: 'content.manage',
            targetType: 'composition',
            targetId: row!.id,
            result: 'success',
            ...requestMeta(request),
            metadata: { width: body.width, height: body.height },
          });
          return { status: 201, body: publicComposition(row!) };
        }),
      );
      return reply.status(result.status).send(result.body);
    },
  );

  app.get(
    '/compositions/:id',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      return withTenant(services.db, member.organizationId, async (tx) => {
        const row = await loadComposition(tx, member, id);
        const document = row.draftDocument as CompositionDocument;
        return {
          ...publicComposition(row),
          document,
          issues: [
            ...lintCompositionDocument(document),
            ...(await mediaIssues(tx, member, row, document)),
          ],
        };
      });
    },
  );

  /** Enregistrement du brouillon, contrôle de concurrence optimiste (CMP-007). */
  app.put(
    '/compositions/:id/draft',
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
        const row = await loadComposition(tx, member, id, true);
        authorize(member, 'content.manage', { siteId: row.siteId });
        if (row.draftRevision !== body.revision) {
          throw new ApiError(
            409,
            'COMPOSITION_CONFLICT',
            'La composition a été modifiée entre-temps. Rechargez-la avant d’enregistrer.',
            false,
            { current_revision: row.draftRevision },
          );
        }
        const [updated] = await tx
          .update(schema.compositions)
          .set({
            draftDocument: document,
            draftRevision: row.draftRevision + 1,
            width: document.canvas.width,
            height: document.canvas.height,
            hasUnpublishedChanges: true,
            ...(body.name ? { name: body.name.trim() } : {}),
            updatedBy: member.auth.user.id,
            updatedAt: services.now(),
          })
          .where(eq(schema.compositions.id, id))
          .returning();
        return {
          ...publicComposition(updated!),
          issues: [
            ...lintCompositionDocument(document),
            ...(await mediaIssues(tx, member, updated!, document)),
          ],
        };
      });
    },
  );

  /** Publication : version immuable du brouillon vu par l’utilisateur (révision exigée). */
  app.post(
    '/compositions/:id/publish',
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
        const row = await loadComposition(tx, member, id, true);
        authorize(member, 'content.manage', { siteId: row.siteId });
        if (row.draftRevision !== revision) {
          throw new ApiError(
            409,
            'COMPOSITION_CONFLICT',
            'Le brouillon a changé : rechargez-le avant de publier.',
            false,
            {
              current_revision: row.draftRevision,
            },
          );
        }
        const document = parseDocument(row.draftDocument);
        const published = await publishVersion(tx, services, member, row, document, null);
        const [updated] = await tx
          .update(schema.compositions)
          .set({
            publishedVersion: published.created.version,
            publishedVersionId: published.created.id,
            publishedAt: published.now,
            hasUnpublishedChanges: false,
            updatedAt: published.now,
          })
          .where(eq(schema.compositions.id, id))
          .returning();
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'composition.published',
          permission: 'content.manage',
          targetType: 'composition',
          targetId: id,
          result: 'success',
          ...requestMeta(request),
          metadata: { version: published.created.version, elements: document.elements.length },
        });
        return {
          composition: publicComposition(updated!),
          version: published.created.version,
          warnings: published.warnings,
        };
      });
      return reply.status(201).send(result);
    },
  );

  app.get(
    '/compositions/:id/versions',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      return withTenant(services.db, member.organizationId, async (tx) => {
        await loadComposition(tx, member, id);
        const rows = await tx
          .select({
            id: schema.compositionVersions.id,
            version: schema.compositionVersions.version,
            restoredFrom: schema.compositionVersions.restoredFrom,
            createdAt: schema.compositionVersions.createdAt,
            publishedBy: schema.users.displayName,
          })
          .from(schema.compositionVersions)
          .leftJoin(schema.users, eq(schema.users.id, schema.compositionVersions.publishedBy))
          .where(eq(schema.compositionVersions.compositionId, id))
          .orderBy(desc(schema.compositionVersions.version));
        return {
          items: rows.map((row) => ({
            id: row.id,
            version: row.version,
            restored_from: row.restoredFrom,
            published_at: row.createdAt.toISOString(),
            published_by: row.publishedBy,
          })),
        };
      });
    },
  );

  app.get(
    '/compositions/:id/versions/:version',
    {
      schema: {
        params: Type.Object(
          { id: Uuid, version: Type.String({ pattern: '^[1-9][0-9]{0,8}$' }) },
          Strict,
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const { id, version } = request.params as { id: string; version: string };
      return withTenant(services.db, member.organizationId, async (tx) => {
        await loadComposition(tx, member, id);
        const [row] = await tx
          .select()
          .from(schema.compositionVersions)
          .where(
            and(
              eq(schema.compositionVersions.compositionId, id),
              eq(schema.compositionVersions.version, Number(version)),
            ),
          );
        if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Version introuvable.');
        return {
          version: row.version,
          published_at: row.createdAt.toISOString(),
          document: row.document,
        };
      });
    },
  );

  /** Retour à une version antérieure : nouvelle version publiée n+1, brouillon remis à ce contenu. */
  app.post(
    '/compositions/:id/restore-version',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object({ version: Type.Integer({ minimum: 1 }) }, Strict),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const { version } = request.body as { version: number };
      const result = await withTenant(services.db, member.organizationId, async (tx) => {
        const row = await loadComposition(tx, member, id, true);
        authorize(member, 'content.manage', { siteId: row.siteId });
        const [source] = await tx
          .select()
          .from(schema.compositionVersions)
          .where(
            and(
              eq(schema.compositionVersions.compositionId, id),
              eq(schema.compositionVersions.version, version),
            ),
          );
        if (!source) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Version introuvable.');
        const document = parseDocument(source.document);
        const published = await publishVersion(tx, services, member, row, document, version);
        const [updated] = await tx
          .update(schema.compositions)
          .set({
            draftDocument: document,
            draftRevision: row.draftRevision + 1,
            width: document.canvas.width,
            height: document.canvas.height,
            publishedVersion: published.created.version,
            publishedVersionId: published.created.id,
            publishedAt: published.now,
            hasUnpublishedChanges: false,
            updatedBy: member.auth.user.id,
            updatedAt: published.now,
          })
          .where(eq(schema.compositions.id, id))
          .returning();
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'composition.version_restored',
          permission: 'content.manage',
          targetType: 'composition',
          targetId: id,
          result: 'success',
          ...requestMeta(request),
          metadata: { restored_from: version, version: published.created.version },
        });
        return { composition: publicComposition(updated!), version: published.created.version };
      });
      return reply.status(201).send(result);
    },
  );

  app.post(
    '/compositions/:id/duplicate',
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
      const copy = await withTenant(services.db, member.organizationId, async (tx) => {
        const row = await loadComposition(tx, member, id);
        authorize(member, 'content.manage', { siteId: row.siteId });
        const [created] = await tx
          .insert(schema.compositions)
          .values({
            organizationId: member.organizationId,
            siteId: row.siteId,
            name: name.trim(),
            width: row.width,
            height: row.height,
            draftDocument: row.draftDocument,
            sourceTemplateKey: row.sourceTemplateKey,
            sourceTemplateVersion: row.sourceTemplateVersion,
            createdBy: member.auth.user.id,
            updatedBy: member.auth.user.id,
          })
          .returning();
        return created!;
      });
      return reply.status(201).send(publicComposition(copy));
    },
  );

  app.delete(
    '/compositions/:id',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      await withTenant(services.db, member.organizationId, async (tx) => {
        const row = await loadComposition(tx, member, id, true);
        authorize(member, 'content.manage', { siteId: row.siteId });
        // Les versions publiées sont conservées ; les références par playlists arrivent avec L05.
        await tx
          .update(schema.compositions)
          .set({ deletedAt: services.now(), updatedBy: member.auth.user.id })
          .where(eq(schema.compositions.id, id));
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'composition.deleted',
          permission: 'content.manage',
          targetType: 'composition',
          targetId: id,
          result: 'success',
          ...requestMeta(request),
          metadata: { name: row.name },
        });
      });
      return reply.status(204).send();
    },
  );

  // --- Templates (TPL-001, TPL-002) ------------------------------------------------------------
  app.get('/templates', async (request) => {
    const member = await requireMember(request, services);
    const features = await services.entitlements.features(member.organizationId);
    return {
      items: TEMPLATES.map((template) => ({
        ...template,
        available: template.required_features.every((feature) => features.includes(feature)),
      })),
    };
  });

  app.post(
    '/templates/:key/instantiate',
    {
      schema: {
        params: Type.Object(
          { key: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$' }) },
          Strict,
        ),
        body: Type.Object(
          {
            name: Name,
            site_id: Type.Optional(Type.Union([Uuid, Type.Null()])),
            values: Type.Optional(
              Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 2000 })),
            ),
          },
          Strict,
        ),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { key } = request.params as { key: string };
      const body = request.body as {
        name: string;
        site_id?: string | null;
        values?: Record<string, string>;
      };
      const template = findTemplate(key);
      if (!template) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Template introuvable.');
      const siteId = body.site_id ?? null;
      authorize(member, 'content.manage', { siteId });
      // Droit vérifié au serveur (TPL-001) : la consultation reste ouverte, pas la duplication.
      const features = await services.entitlements.features(member.organizationId);
      const missing = template.required_features.filter((feature) => !features.includes(feature));
      if (missing.length > 0) {
        throw new ApiError(
          403,
          'ENTITLEMENT_REQUIRED',
          'Les templates sont inclus dans les offres payantes.',
          false,
          {
            features: missing,
          },
        );
      }
      const values = body.values ?? {};
      const known = new Map(
        template.placeholders.map((placeholder) => [placeholder.key, placeholder]),
      );
      for (const [placeholderKey, value] of Object.entries(values)) {
        const placeholder = known.get(placeholderKey);
        if (!placeholder) {
          throw new ApiError(422, 'VALIDATION_ERROR', `Placeholder inconnu : ${placeholderKey}.`);
        }
        if (placeholder.type === 'image' && !/^[0-9a-f-]{36}$/.test(value)) {
          throw new ApiError(422, 'VALIDATION_ERROR', `Média invalide pour ${placeholder.label}.`);
        }
      }
      const document = parseDocument(applyTemplate(template, values));
      const scope = idempotencyScope(
        request,
        member.organizationId,
        member.auth.user.id,
        'templates.instantiate',
      );
      const result = await withTenant(services.db, member.organizationId, (tx) =>
        idempotent(tx, scope, async () => {
          if (siteId) await assertSite(tx, siteId);
          // Une image de placeholder doit être un média visible de ce tenant (aucune dépendance inaccessible).
          const mediaIds = documentMediaIds(document);
          if (mediaIds.length > 0) {
            const rows = await tx
              .select({
                id: schema.media.id,
                siteId: schema.media.siteId,
                deletedAt: schema.media.deletedAt,
              })
              .from(schema.media)
              .where(inArray(schema.media.id, mediaIds));
            const usable = new Set(
              rows
                .filter((row) => !row.deletedAt && canSee(member, row.siteId))
                .map((row) => row.id),
            );
            if (mediaIds.some((mediaId) => !usable.has(mediaId))) {
              throw new ApiError(422, 'VALIDATION_ERROR', 'Un média choisi est introuvable.');
            }
          }
          const [row] = await tx
            .insert(schema.compositions)
            .values({
              organizationId: member.organizationId,
              siteId,
              name: body.name.trim(),
              width: document.canvas.width,
              height: document.canvas.height,
              draftDocument: document,
              sourceTemplateKey: template.key,
              sourceTemplateVersion: template.version,
              createdBy: member.auth.user.id,
              updatedBy: member.auth.user.id,
            })
            .returning();
          await audit(tx, {
            organizationId: member.organizationId,
            actorType: 'user',
            actorId: member.auth.user.id,
            action: 'template.instantiated',
            permission: 'content.manage',
            targetType: 'composition',
            targetId: row!.id,
            result: 'success',
            ...requestMeta(request),
            metadata: { template: template.key, template_version: template.version },
          });
          return { status: 201, body: publicComposition(row!) };
        }),
      );
      return reply.status(result.status).send(result.body);
    },
  );
}

/** Utilisations d’un média par les compositions (ADR-010) ; les versions publiées bloquent. */
export async function compositionUsages(
  tx: Transaction,
  mediaId: string,
): Promise<
  {
    type: 'composition_version' | 'composition_draft';
    id: string;
    name: string;
    version: number | null;
    blocking: boolean;
  }[]
> {
  const published = await tx
    .select({
      compositionId: schema.compositions.id,
      name: schema.compositions.name,
      version: schema.compositionVersions.version,
    })
    .from(schema.contentDependencies)
    .innerJoin(
      schema.compositionVersions,
      eq(schema.compositionVersions.id, schema.contentDependencies.compositionVersionId),
    )
    .innerJoin(
      schema.compositions,
      eq(schema.compositions.id, schema.compositionVersions.compositionId),
    )
    .where(eq(schema.contentDependencies.mediaId, mediaId))
    .orderBy(schema.compositions.name, schema.compositionVersions.version);
  const drafts = await tx
    .select({ id: schema.compositions.id, name: schema.compositions.name })
    .from(schema.compositions)
    .where(
      and(
        isNull(schema.compositions.deletedAt),
        sql`jsonb_path_exists(${schema.compositions.draftDocument}, '$.elements[*].props.media_id ? (@ == $id)', jsonb_build_object('id', ${mediaId}::text))`,
      ),
    );
  return [
    ...published.map((row) => ({
      type: 'composition_version' as const,
      id: row.compositionId,
      name: row.name,
      version: row.version,
      blocking: true,
    })),
    ...drafts.map((row) => ({
      type: 'composition_draft' as const,
      id: row.id,
      name: row.name,
      version: null,
      blocking: false,
    })),
  ];
}
