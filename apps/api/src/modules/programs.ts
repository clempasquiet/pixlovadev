/**
 * Plannings, campagnes et overrides (PLN-003 à PLN-009, PAR-005, ADR-011). Brouillon sous
 * concurrence optimiste, validation complète avant publication (règles locales, contenus,
 * cibles dans le périmètre de l’auteur), versions immuables, annulation traçable. Toute
 * décision qui change la diffusion demande une recompilation dans sa transaction.
 */
import { and, desc, eq, ilike, inArray, isNull, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Type from 'typebox';
import {
  describeErrors,
  PROGRAM_DOCUMENT_VERSION,
  validator,
  type ContentRef,
  type ProgramDocument,
  type Targeting,
} from '@pixlova/contracts';
import { schema, withTenant, type Transaction } from '@pixlova/db';
import type { Permission } from '@pixlova/permissions';
import { siteFilter } from '@pixlova/permissions';
import { isValidTimezone, parseLocalDate } from '@pixlova/scheduling';
import { ApiError } from '../errors.js';
import { authorize, requestMeta, requireMember, type MemberContext } from '../http/context.js';
import type { Services } from '../http/services.js';
import { audit } from '../lib/audit.js';
import { idempotencyScope, idempotent } from '../lib/idempotency.js';
import {
  canSeeSite,
  checkTargets,
  contentInfos,
  recompile,
  referenceIssues,
  type GraphIssue,
} from './content-graph.js';
import { Strict, Uuid } from './schemas.js';

type ProgramRow = typeof schema.programs.$inferSelect;
type Kind = ProgramRow['kind'];

const NONE = '00000000-0000-0000-0000-000000000000';
const Name = Type.String({ minLength: 1, maxLength: 120 });
const validateDocument = validator('program-document.json');
/** Durée maximale d’un override [à valider] (ADR-011). */
export const MAX_OVERRIDE_MS = 7 * 86_400_000;

const LABEL: Record<Kind, string> = {
  schedule: 'Planning',
  campaign: 'Campagne',
  override: 'Diffusion immédiate',
};

function parseDocument(value: unknown, kind: Kind): ProgramDocument {
  if (!validateDocument(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Document de programme invalide.', false, {
      detail: describeErrors(validateDocument.errors).slice(0, 500),
    });
  }
  const document = value as ProgramDocument;
  if (document.kind !== kind) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Type de programme inattendu.', false, {
      field: 'kind',
    });
  }
  return document;
}

const NO_TARGETS: Targeting = { include: [], exclude: [] };

function emptyDocument(kind: Exclude<Kind, 'override'>): ProgramDocument {
  return kind === 'schedule'
    ? {
        schema_version: PROGRAM_DOCUMENT_VERSION,
        kind,
        timezone: null,
        targets: NO_TARGETS,
        rules: [],
        exceptions: [],
      }
    : {
        schema_version: PROGRAM_DOCUMENT_VERSION,
        kind,
        content: null,
        starts_at: null,
        ends_at: null,
        priority: 50,
        targets: NO_TARGETS,
      };
}

export type ProgramStatus = 'draft' | 'published' | 'scheduled' | 'active' | 'ended' | 'cancelled';

function statusOf(row: ProgramRow, published: ProgramDocument | null, now: Date): ProgramStatus {
  if (row.cancelledAt) return 'cancelled';
  if (!published) return 'draft';
  if (published.kind === 'schedule') return 'published';
  const starts = published.starts_at ? Date.parse(published.starts_at) : 0;
  const ends = published.ends_at ? Date.parse(published.ends_at) : 0;
  if (now.getTime() < starts) return 'scheduled';
  if (now.getTime() >= ends) return 'ended';
  return 'active';
}

function publicProgram(row: ProgramRow, published: ProgramDocument | null, now: Date) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    site_id: row.siteId,
    status: statusOf(row, published, now),
    draft_revision: row.draftRevision,
    has_unpublished_changes: row.hasUnpublishedChanges,
    published_version: row.publishedVersion,
    published_at: row.publishedAt?.toISOString() ?? null,
    cancelled_at: row.cancelledAt?.toISOString() ?? null,
    published:
      published && published.kind !== 'schedule'
        ? {
            content: published.content,
            starts_at: published.starts_at,
            ends_at: published.ends_at,
            priority: published.priority,
          }
        : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function refsOf(document: ProgramDocument): ContentRef[] {
  if (document.kind === 'schedule') {
    return [
      ...document.rules.map((rule) => rule.content),
      ...document.exceptions.flatMap((exception) => (exception.content ? [exception.content] : [])),
    ];
  }
  return document.content ? [document.content] : [];
}

/** Anomalies propres au document (PLN-003, PLN-006, PLN-009), sans accès base. */
function documentIssues(document: ProgramDocument, now: Date): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const error = (code: string, ref: string | null, message: string) =>
    issues.push({ severity: 'error', code, ref, message });
  if (document.targets.include.length === 0) {
    error('TARGETS_REQUIRED', null, 'Choisissez au moins une cible.');
  }
  if (document.kind === 'schedule') {
    if (document.timezone !== null && !isValidTimezone(document.timezone)) {
      error('TIMEZONE_INVALID', null, `Fuseau inconnu : ${document.timezone}.`);
    }
    if (document.rules.length === 0) error('RULES_REQUIRED', null, 'Ajoutez au moins un créneau.');
    const ruleIds = new Set<string>();
    for (const rule of document.rules) {
      if (ruleIds.has(rule.id)) error('DUPLICATE_RULE_ID', rule.id, 'Créneau en double.');
      ruleIds.add(rule.id);
      if (rule.start_time === '24:00') {
        error('TIME_INVALID', rule.id, 'Un créneau ne peut pas commencer à 24:00.');
      }
      if (rule.start_time === rule.end_time) {
        issues.push({
          severity: 'warning',
          code: 'FULL_DAY',
          ref: rule.id,
          message: 'Début et fin identiques : le créneau dure 24 heures.',
        });
      }
      const start = rule.start_date === null ? null : parseLocalDate(rule.start_date);
      const end = rule.end_date === null ? null : parseLocalDate(rule.end_date);
      if (
        (rule.start_date !== null && start === null) ||
        (rule.end_date !== null && end === null)
      ) {
        error('DATE_INVALID', rule.id, 'Date inexistante.');
      } else if (start !== null && end !== null && end < start) {
        error('DATE_RANGE_INVALID', rule.id, 'La date de fin précède la date de début.');
      }
    }
    const exceptionKeys = new Set<string>();
    for (const exception of document.exceptions) {
      if (parseLocalDate(exception.date) === null) {
        error('DATE_INVALID', exception.id, 'Date d’exception inexistante.');
      }
      if (exception.rule_id !== null && !ruleIds.has(exception.rule_id)) {
        error('RULE_NOT_FOUND', exception.id, 'L’exception vise un créneau supprimé.');
      }
      if (exception.action === 'replace' && !exception.content) {
        error('CONTENT_REQUIRED', exception.id, 'Choisissez le contenu de remplacement.');
      }
      if (exception.action === 'skip' && exception.content) {
        error('CONTENT_UNEXPECTED', exception.id, 'Une omission ne porte pas de contenu.');
      }
      const key = `${exception.date}|${exception.rule_id ?? '*'}`;
      if (exceptionKeys.has(key)) {
        error('DUPLICATE_EXCEPTION', exception.id, 'Deux exceptions visent le même jour.');
      }
      exceptionKeys.add(key);
    }
    return issues;
  }
  if (!document.content) error('CONTENT_REQUIRED', null, 'Choisissez un contenu.');
  if (!document.starts_at || !document.ends_at) {
    error('PERIOD_REQUIRED', null, 'Indiquez le début et la fin.');
    return issues;
  }
  const starts = Date.parse(document.starts_at);
  const ends = Date.parse(document.ends_at);
  if (ends <= starts) error('PERIOD_INVALID', null, 'La fin précède le début.');
  if (ends <= now.getTime()) error('PERIOD_ENDED', null, 'La période est déjà terminée.');
  if (document.kind === 'override' && ends - starts > MAX_OVERRIDE_MS) {
    error('OVERRIDE_TOO_LONG', null, 'Une diffusion immédiate dure au plus 7 jours.');
  }
  return issues;
}

async function programIssues(
  tx: Transaction,
  member: MemberContext,
  row: { siteId: string | null },
  document: ProgramDocument,
  now: Date,
): Promise<{ issues: GraphIssue[]; displays: { id: string; name: string }[] }> {
  const refs = refsOf(document);
  const infos = await contentInfos(tx, member, refs);
  const targets = await checkTargets(tx, document.targets, row.siteId);
  const issues = [
    ...documentIssues(document, now),
    ...referenceIssues(refs, infos, row.siteId),
    ...targets.issues,
  ];
  if (targets.displays.length === 0 && document.targets.include.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'NO_DISPLAY_TARGETED',
      ref: null,
      message: 'Aucun Display ne correspond aux cibles actuellement.',
    });
  }
  return { issues, displays: targets.displays };
}

function publishPermission(kind: Kind, document: ProgramDocument): Permission {
  if (kind !== 'override') return 'content.publish';
  return document.kind === 'override' && document.priority === 100
    ? 'override.emergency'
    : 'override.create';
}

async function loadProgram(
  tx: Transaction,
  member: MemberContext,
  kind: Kind,
  id: string,
  lock = false,
): Promise<{ row: ProgramRow; published: ProgramDocument | null }> {
  const query = tx
    .select({ row: schema.programs, published: schema.programVersions.document })
    .from(schema.programs)
    .leftJoin(
      schema.programVersions,
      eq(schema.programVersions.id, schema.programs.publishedVersionId),
    )
    .where(
      and(
        eq(schema.programs.id, id),
        eq(schema.programs.kind, kind),
        isNull(schema.programs.deletedAt),
      ),
    );
  const [found] = lock ? await query.for('update', { of: schema.programs }) : await query;
  if (!found || !canSeeSite(member, found.row.siteId)) {
    throw new ApiError(404, 'RESOURCE_NOT_FOUND', `${LABEL[kind]} introuvable.`);
  }
  return { row: found.row, published: (found.published as ProgramDocument | null) ?? null };
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

function effectiveUntil(document: ProgramDocument): Date | null {
  return document.kind !== 'schedule' && document.ends_at ? new Date(document.ends_at) : null;
}

/** Crée la version publiée, ses dépendances typées et met à jour le programme. */
async function publishDocument(
  tx: Transaction,
  member: MemberContext,
  row: ProgramRow,
  document: ProgramDocument,
  now: Date,
): Promise<{ row: ProgramRow; version: number }> {
  const version = (row.publishedVersion ?? 0) + 1;
  const [created] = await tx
    .insert(schema.programVersions)
    .values({
      organizationId: member.organizationId,
      programId: row.id,
      version,
      schemaVersion: document.schema_version,
      document,
      publishedBy: member.auth.user.id,
    })
    .returning();
  const refs = [...new Map(refsOf(document).map((r) => [`${r.type}:${r.id}`, r])).values()];
  if (refs.length > 0) {
    await tx.insert(schema.contentDependencies).values(
      refs.map((ref) => ({
        organizationId: member.organizationId,
        programVersionId: created!.id,
        ...(ref.type === 'media'
          ? { mediaId: ref.id }
          : ref.type === 'composition'
            ? { compositionId: ref.id }
            : { playlistId: ref.id }),
      })),
    );
  }
  const [updated] = await tx
    .update(schema.programs)
    .set({
      publishedVersion: version,
      publishedVersionId: created!.id,
      publishedAt: now,
      effectiveUntil: effectiveUntil(document),
      cancelledAt: null,
      cancelledBy: null,
      hasUnpublishedChanges: false,
      updatedAt: now,
    })
    .where(eq(schema.programs.id, row.id))
    .returning();
  await recompile(tx, member, 'all', `${row.kind}.published`);
  return { row: updated!, version };
}

function invalid(issues: GraphIssue[]): never {
  throw new ApiError(422, 'PROGRAM_INVALID', 'Le programme ne peut pas être publié.', false, {
    issues: issues.filter((issue) => issue.severity === 'error'),
  });
}

/** Routes d’un type de programme éditable en brouillon (planning ou campagne). */
function editableRoutes(
  app: FastifyInstance,
  services: Services,
  kind: Exclude<Kind, 'override'>,
  base: string,
): void {
  app.get(
    base,
    {
      schema: {
        querystring: Type.Object(
          { q: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) },
          Strict,
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const query = request.query as { q?: string };
      const visible = siteFilter(member.grants, 'organization.read');
      const p = schema.programs;
      const conditions: (SQL | undefined)[] = [
        eq(p.kind, kind),
        isNull(p.deletedAt),
        visible === 'all' ? undefined : inArray(p.siteId, visible.length ? visible : [NONE]),
        query.q ? ilike(p.name, `%${query.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`) : undefined,
      ];
      const rows = await withTenant(services.db, member.organizationId, (tx) =>
        tx
          .select({ row: p, published: schema.programVersions.document })
          .from(p)
          .leftJoin(schema.programVersions, eq(schema.programVersions.id, p.publishedVersionId))
          .where(and(...conditions))
          .orderBy(desc(p.updatedAt), desc(p.id))
          .limit(200),
      );
      const now = services.now();
      return {
        items: rows.map(({ row, published }) =>
          publicProgram(row, published as ProgramDocument | null, now),
        ),
      };
    },
  );

  app.post(
    base,
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
      authorize(member, 'content.publish', { siteId });
      const scope = idempotencyScope(
        request,
        member.organizationId,
        member.auth.user.id,
        `${kind}s.create`,
      );
      const result = await withTenant(services.db, member.organizationId, (tx) =>
        idempotent(tx, scope, async () => {
          if (siteId) await assertSite(tx, siteId);
          const [row] = await tx
            .insert(schema.programs)
            .values({
              organizationId: member.organizationId,
              siteId,
              kind,
              name: body.name.trim(),
              draftDocument: emptyDocument(kind),
              createdBy: member.auth.user.id,
              updatedBy: member.auth.user.id,
            })
            .returning();
          await audit(tx, {
            organizationId: member.organizationId,
            actorType: 'user',
            actorId: member.auth.user.id,
            action: `${kind}.created`,
            permission: 'content.publish',
            targetType: kind,
            targetId: row!.id,
            result: 'success',
            ...requestMeta(request),
          });
          return { status: 201, body: publicProgram(row!, null, services.now()) };
        }),
      );
      return reply.status(result.status).send(result.body);
    },
  );

  app.get(
    `${base}/:id`,
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const now = services.now();
      return withTenant(services.db, member.organizationId, async (tx) => {
        const { row, published } = await loadProgram(tx, member, kind, id);
        const document = parseDocument(row.draftDocument, kind);
        const checked = await programIssues(tx, member, row, document, now);
        const infos = await contentInfos(tx, member, refsOf(document));
        return {
          ...publicProgram(row, published, now),
          document,
          references: Object.fromEntries(
            [...infos].map(([key, info]) => [key, { name: info.name, status: info.status }]),
          ),
          targets: { count: checked.displays.length, displays: checked.displays },
          issues: checked.issues,
        };
      });
    },
  );

  app.put(
    `${base}/:id/draft`,
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
      const document = parseDocument(body.document, kind);
      const now = services.now();
      return withTenant(services.db, member.organizationId, async (tx) => {
        const { row, published } = await loadProgram(tx, member, kind, id, true);
        authorize(member, 'content.publish', { siteId: row.siteId });
        if (row.draftRevision !== body.revision) {
          throw new ApiError(
            409,
            'PROGRAM_CONFLICT',
            'Le programme a été modifié entre-temps. Rechargez-le avant d’enregistrer.',
            false,
            { current_revision: row.draftRevision },
          );
        }
        const [updated] = await tx
          .update(schema.programs)
          .set({
            draftDocument: document,
            draftRevision: row.draftRevision + 1,
            hasUnpublishedChanges: true,
            ...(body.name ? { name: body.name.trim() } : {}),
            updatedBy: member.auth.user.id,
            updatedAt: now,
          })
          .where(eq(schema.programs.id, id))
          .returning();
        const checked = await programIssues(tx, member, updated!, document, now);
        return {
          ...publicProgram(updated!, published, now),
          targets: { count: checked.displays.length, displays: checked.displays },
          issues: checked.issues,
        };
      });
    },
  );

  app.post(
    `${base}/:id/publish`,
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
      const now = services.now();
      const result = await withTenant(services.db, member.organizationId, async (tx) => {
        const { row, published } = await loadProgram(tx, member, kind, id, true);
        authorize(member, 'content.publish', { siteId: row.siteId });
        if (row.draftRevision !== revision) {
          throw new ApiError(
            409,
            'PROGRAM_CONFLICT',
            'Le brouillon a changé : rechargez-le avant de publier.',
            false,
            { current_revision: row.draftRevision },
          );
        }
        const document = parseDocument(row.draftDocument, kind);
        const checked = await programIssues(tx, member, row, document, now);
        // Publication idempotente : la même révision déjà publiée et active est renvoyée.
        if (!row.hasUnpublishedChanges && published && !row.cancelledAt) {
          return {
            status: 200,
            body: {
              program: publicProgram(row, published, now),
              version: row.publishedVersion,
              targets: { count: checked.displays.length, displays: checked.displays },
              warnings: [],
            },
          };
        }
        if (checked.issues.some((issue) => issue.severity === 'error')) invalid(checked.issues);
        const done = await publishDocument(tx, member, row, document, now);
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: `${kind}.published`,
          permission: 'content.publish',
          targetType: kind,
          targetId: id,
          result: 'success',
          ...requestMeta(request),
          metadata: { version: done.version, displays: checked.displays.length },
        });
        return {
          status: 201,
          body: {
            program: publicProgram(done.row, document, now),
            version: done.version,
            targets: { count: checked.displays.length, displays: checked.displays },
            warnings: checked.issues.filter((issue) => issue.severity === 'warning'),
          },
        };
      });
      return reply.status(result.status).send(result.body);
    },
  );

  app.get(
    `${base}/:id/versions`,
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      return withTenant(services.db, member.organizationId, async (tx) => {
        await loadProgram(tx, member, kind, id);
        const rows = await tx
          .select()
          .from(schema.programVersions)
          .where(eq(schema.programVersions.programId, id))
          .orderBy(desc(schema.programVersions.version));
        return {
          items: rows.map((v) => ({
            id: v.id,
            version: v.version,
            published_at: v.createdAt.toISOString(),
            published_by: v.publishedBy,
          })),
        };
      });
    },
  );

  app.delete(
    `${base}/:id`,
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      await withTenant(services.db, member.organizationId, async (tx) => {
        const { row } = await loadProgram(tx, member, kind, id, true);
        authorize(member, 'content.publish', { siteId: row.siteId });
        const now = services.now();
        await tx
          .update(schema.programs)
          .set({ deletedAt: now, updatedAt: now, updatedBy: member.auth.user.id })
          .where(eq(schema.programs.id, id));
        if (row.publishedVersionId && !row.cancelledAt) {
          await recompile(tx, member, 'all', `${kind}.deleted`);
        }
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: `${kind}.deleted`,
          permission: 'content.publish',
          targetType: kind,
          targetId: id,
          result: 'success',
          ...requestMeta(request),
        });
      });
      return reply.status(204).send();
    },
  );
}

/** Arrêt traçable (PLN-006, PLN-009) : le moteur recalcule la source courante. */
function cancelRoute(app: FastifyInstance, services: Services, kind: Kind, path: string): void {
  app.post(path, { schema: { params: Type.Object({ id: Uuid }, Strict) } }, async (request) => {
    const member = await requireMember(request, services);
    const { id } = request.params as { id: string };
    const now = services.now();
    return withTenant(services.db, member.organizationId, async (tx) => {
      const { row, published } = await loadProgram(tx, member, kind, id, true);
      const permission = published ? publishPermission(kind, published) : 'content.publish';
      authorize(member, permission, { siteId: row.siteId });
      if (row.cancelledAt) return publicProgram(row, published, now);
      if (!published) {
        throw new ApiError(409, 'PROGRAM_NOT_PUBLISHED', 'Ce programme n’est pas publié.');
      }
      const [updated] = await tx
        .update(schema.programs)
        .set({ cancelledAt: now, cancelledBy: member.auth.user.id, updatedAt: now })
        .where(eq(schema.programs.id, id))
        .returning();
      await recompile(tx, member, 'all', `${kind}.cancelled`);
      await audit(tx, {
        organizationId: member.organizationId,
        actorType: 'user',
        actorId: member.auth.user.id,
        action: `${kind}.cancelled`,
        permission,
        targetType: kind,
        targetId: id,
        result: 'success',
        ...requestMeta(request),
      });
      return publicProgram(updated!, published, now);
    });
  });
}

const ContentRefBody = Type.Object(
  {
    type: Type.Union([
      Type.Literal('media'),
      Type.Literal('composition'),
      Type.Literal('playlist'),
    ]),
    id: Uuid,
  },
  Strict,
);
const Instant = Type.String({
  pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?Z$',
});

export function programRoutes(app: FastifyInstance, services: Services): void {
  editableRoutes(app, services, 'schedule', '/schedules');
  editableRoutes(app, services, 'campaign', '/campaigns');
  cancelRoute(app, services, 'schedule', '/schedules/:id/deactivate');
  cancelRoute(app, services, 'campaign', '/campaigns/:id/cancel');
  cancelRoute(app, services, 'override', '/overrides/:id/cancel');

  /** Aperçu des Displays visés avant publication (PLN-007). */
  app.post(
    '/targets/preview',
    {
      schema: {
        body: Type.Object(
          { site_id: Type.Union([Uuid, Type.Null()]), targets: Type.Unknown() },
          Strict,
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const body = request.body as { site_id: string | null; targets: unknown };
      const probe = {
        schema_version: 1,
        kind: 'campaign',
        content: null,
        starts_at: null,
        ends_at: null,
        priority: 50,
        targets: body.targets,
      };
      const targets = parseDocument(probe, 'campaign').targets;
      if (!canSeeSite(member, body.site_id)) {
        throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Site introuvable.');
      }
      return withTenant(services.db, member.organizationId, async (tx) => {
        const checked = await checkTargets(tx, targets, body.site_id);
        return {
          count: checked.displays.length,
          displays: checked.displays,
          issues: checked.issues,
        };
      });
    },
  );

  /** « Diffuser maintenant » (PAR-005) : override créé et publié en une opération. */
  app.post(
    '/overrides',
    {
      schema: {
        body: Type.Object(
          {
            name: Type.Optional(Name),
            site_id: Type.Optional(Type.Union([Uuid, Type.Null()])),
            content: ContentRefBody,
            starts_at: Type.Optional(Instant),
            ends_at: Instant,
            priority: Type.Optional(Type.Integer({ minimum: 80, maximum: 100 })),
            targets: Type.Unknown(),
          },
          Strict,
        ),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const body = request.body as {
        name?: string;
        site_id?: string | null;
        content: ContentRef;
        starts_at?: string;
        ends_at: string;
        priority?: number;
        targets: unknown;
      };
      const now = services.now();
      const siteId = body.site_id ?? null;
      const document = parseDocument(
        {
          schema_version: PROGRAM_DOCUMENT_VERSION,
          kind: 'override',
          content: body.content,
          starts_at: body.starts_at ?? now.toISOString().replace(/\.[0-9]{3}Z$/, 'Z'),
          ends_at: body.ends_at,
          priority: body.priority ?? 90,
          targets: body.targets,
        },
        'override',
      );
      authorize(member, publishPermission('override', document), { siteId });
      const scope = idempotencyScope(
        request,
        member.organizationId,
        member.auth.user.id,
        'overrides.create',
      );
      const result = await withTenant(services.db, member.organizationId, (tx) =>
        idempotent(tx, scope, async () => {
          if (siteId) await assertSite(tx, siteId);
          const checked = await programIssues(tx, member, { siteId }, document, now);
          if (checked.issues.some((issue) => issue.severity === 'error')) invalid(checked.issues);
          const infos = await contentInfos(tx, member, [body.content]);
          const [row] = await tx
            .insert(schema.programs)
            .values({
              organizationId: member.organizationId,
              siteId,
              kind: 'override',
              name:
                body.name?.trim() ||
                `Diffusion immédiate — ${[...infos.values()][0]?.name ?? 'contenu'}`.slice(0, 120),
              draftDocument: document,
              createdBy: member.auth.user.id,
              updatedBy: member.auth.user.id,
            })
            .returning();
          const done = await publishDocument(tx, member, row!, document, now);
          await audit(tx, {
            organizationId: member.organizationId,
            actorType: 'user',
            actorId: member.auth.user.id,
            action: 'override.created',
            permission: publishPermission('override', document),
            targetType: 'override',
            targetId: row!.id,
            result: 'success',
            ...requestMeta(request),
            metadata: {
              priority: document.kind === 'override' ? document.priority : null,
              displays: checked.displays.length,
            },
          });
          return {
            status: 201,
            body: {
              override: publicProgram(done.row, document, now),
              targets: { count: checked.displays.length, displays: checked.displays },
              // L’heure de retour à la programmation (PAR-005) ; l’application effective sur
              // chaque Player reste un état distinct, suivi par Display.
              returns_at: document.kind === 'override' ? document.ends_at : null,
              warnings: checked.issues.filter((issue) => issue.severity === 'warning'),
            },
          };
        }),
      );
      return reply.status(result.status).send(result.body);
    },
  );

  app.get(
    '/overrides',
    {
      schema: {
        querystring: Type.Object({ active: Type.Optional(Type.Literal('true')) }, Strict),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      const query = request.query as { active?: 'true' };
      const visible = siteFilter(member.grants, 'organization.read');
      const p = schema.programs;
      const now = services.now();
      const rows = await withTenant(services.db, member.organizationId, (tx) =>
        tx
          .select({ row: p, published: schema.programVersions.document })
          .from(p)
          .leftJoin(schema.programVersions, eq(schema.programVersions.id, p.publishedVersionId))
          .where(
            and(
              eq(p.kind, 'override'),
              isNull(p.deletedAt),
              visible === 'all' ? undefined : inArray(p.siteId, visible.length ? visible : [NONE]),
            ),
          )
          .orderBy(desc(p.createdAt), desc(p.id))
          .limit(100),
      );
      const items = rows.map(({ row, published }) =>
        publicProgram(row, published as ProgramDocument | null, now),
      );
      return {
        items: query.active
          ? items.filter((item) => item.status === 'active' || item.status === 'scheduled')
          : items,
      };
    },
  );
}
