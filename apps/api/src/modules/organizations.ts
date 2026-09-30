import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Type from 'typebox';
import { schema, withTenant } from '@pixlova/db';
import { effectivePermissions, siteFilter } from '@pixlova/permissions';
import { ApiError } from '../errors.js';
import { authorize, requestMeta, requireMember, requireUser } from '../http/context.js';
import type { Services } from '../http/services.js';
import { audit } from '../lib/audit.js';
import { Strict, Uuid } from './schemas.js';

const Name = Type.String({ minLength: 1, maxLength: 120 });
const Country = Type.String({ pattern: '^[A-Z]{2}$' });
const TimezoneName = Type.String({ minLength: 1, maxLength: 64 });

export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Fuseau horaire IANA inconnu.', false, {
      field: 'timezone',
    });
  }
}

function assertCountry(country: string): void {
  const names = new Intl.DisplayNames(['fr'], { type: 'region', fallback: 'none' });
  if (!names.of(country))
    throw new ApiError(422, 'VALIDATION_ERROR', 'Code pays ISO 3166-1 inconnu.', false, {
      field: 'country',
    });
}

function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `${base || 'organisation'}-${randomBytes(4).toString('hex')}`;
}

function publicSite(site: typeof schema.sites.$inferSelect) {
  return {
    id: site.id,
    name: site.name,
    timezone: site.timezone,
    created_at: site.createdAt.toISOString(),
  };
}

export function organizationRoutes(app: FastifyInstance, services: Services): void {
  /**
   * Création atomique (PAR-001) : organisation, appartenance, rôle Owner et site principal.
   * L’offre Free s’applique par défaut ; ses droits sont projetés par L08.
   */
  app.post(
    '/organizations',
    {
      schema: {
        body: Type.Object({ name: Name, country: Country, timezone: TimezoneName }, Strict),
      },
    },
    async (request, reply) => {
      const auth = await requireUser(request, services);
      const body = request.body as { name: string; country: string; timezone: string };
      assertTimezone(body.timezone);
      assertCountry(body.country);
      const organizationId = randomUUID();
      const organization = await withTenant(services.db, organizationId, async (tx) => {
        const [created] = await tx
          .insert(schema.organizations)
          .values({
            id: organizationId,
            name: body.name.trim(),
            slug: slugify(body.name),
            country: body.country,
            timezone: body.timezone,
          })
          .returning();
        const [membership] = await tx
          .insert(schema.memberships)
          .values({ organizationId, userId: auth.user.id })
          .returning({ id: schema.memberships.id });
        await tx.insert(schema.membershipGrants).values({
          organizationId,
          membershipId: membership!.id,
          roleKey: 'Owner',
          scopeType: 'organization',
          createdBy: auth.user.id,
        });
        await tx.insert(schema.sites).values({ organizationId, name: 'Site principal' });
        await audit(tx, {
          organizationId,
          actorType: 'user',
          actorId: auth.user.id,
          action: 'organization.created',
          targetType: 'organization',
          targetId: organizationId,
          result: 'success',
          metadata: { country: body.country, timezone: body.timezone },
          ...requestMeta(request),
        });
        return created!;
      });
      return reply.status(201).send({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        country: organization.country,
        timezone: organization.timezone,
        status: organization.status,
      });
    },
  );

  app.get(
    '/organizations/:id',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      if ((request.params as { id: string }).id !== member.organizationId) {
        throw new ApiError(
          400,
          'VALIDATION_ERROR',
          'L’identifiant ne correspond pas à l’organisation active.',
        );
      }
      authorize(member, 'organization.read');
      const [organization] = await withTenant(services.db, member.organizationId, (tx) =>
        tx.select().from(schema.organizations),
      );
      return {
        id: organization!.id,
        name: organization!.name,
        slug: organization!.slug,
        country: organization!.country,
        timezone: organization!.timezone,
        status: organization!.status,
      };
    },
  );

  app.patch(
    '/organizations/:id',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object(
          { name: Type.Optional(Name), timezone: Type.Optional(TimezoneName) },
          { ...Strict, minProperties: 1 },
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      if ((request.params as { id: string }).id !== member.organizationId) {
        throw new ApiError(
          400,
          'VALIDATION_ERROR',
          'L’identifiant ne correspond pas à l’organisation active.',
        );
      }
      authorize(member, 'organization.manage');
      const body = request.body as { name?: string; timezone?: string };
      if (body.timezone) assertTimezone(body.timezone);
      const [updated] = await withTenant(services.db, member.organizationId, async (tx) => {
        const rows = await tx
          .update(schema.organizations)
          .set({
            ...(body.name ? { name: body.name.trim() } : {}),
            ...(body.timezone ? { timezone: body.timezone } : {}),
            updatedAt: services.now(),
          })
          .where(eq(schema.organizations.id, member.organizationId))
          .returning();
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'organization.updated',
          permission: 'organization.manage',
          targetType: 'organization',
          targetId: member.organizationId,
          result: 'success',
          metadata: { fields: Object.keys(body) },
          ...requestMeta(request),
        });
        return rows;
      });
      return { id: updated!.id, name: updated!.name, timezone: updated!.timezone };
    },
  );

  /** Permissions effectives de l’utilisateur dans l’organisation active (affichage UI). */
  app.get('/permissions', async (request) => {
    const member = await requireMember(request, services);
    return {
      organization_id: member.organizationId,
      permissions: effectivePermissions(member.grants),
      grants: member.grants.map((g) => ({
        role: g.role,
        scope:
          g.scope.type === 'organization'
            ? { type: 'organization' }
            : { type: 'sites', site_ids: g.scope.siteIds },
      })),
    };
  });

  // --- Sites -----------------------------------------------------------------

  app.get('/sites', async (request) => {
    const member = await requireMember(request, services);
    const visible = siteFilter(member.grants, 'organization.read');
    const rows = await withTenant(services.db, member.organizationId, (tx) =>
      tx
        .select()
        .from(schema.sites)
        .where(
          and(
            isNull(schema.sites.deletedAt),
            visible === 'all'
              ? undefined
              : inArray(
                  schema.sites.id,
                  visible.length ? visible : ['00000000-0000-0000-0000-000000000000'],
                ),
          ),
        )
        .orderBy(asc(schema.sites.name)),
    );
    return { items: rows.map(publicSite) };
  });

  app.post(
    '/sites',
    {
      schema: {
        body: Type.Object(
          { name: Name, timezone: Type.Optional(Type.Union([TimezoneName, Type.Null()])) },
          Strict,
        ),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      authorize(member, 'sites.manage');
      const body = request.body as { name: string; timezone?: string | null };
      if (body.timezone) assertTimezone(body.timezone);
      const site = await withTenant(services.db, member.organizationId, async (tx) => {
        const [created] = await tx
          .insert(schema.sites)
          .values({
            organizationId: member.organizationId,
            name: body.name.trim(),
            timezone: body.timezone ?? null,
          })
          .returning();
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'site.created',
          permission: 'sites.manage',
          targetType: 'site',
          targetId: created!.id,
          result: 'success',
          ...requestMeta(request),
        });
        return created!;
      });
      return reply.status(201).send(publicSite(site));
    },
  );

  app.patch(
    '/sites/:id',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object(
          {
            name: Type.Optional(Name),
            timezone: Type.Optional(Type.Union([TimezoneName, Type.Null()])),
          },
          { ...Strict, minProperties: 1 },
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      authorize(member, 'sites.manage');
      const { id } = request.params as { id: string };
      const body = request.body as { name?: string; timezone?: string | null };
      if (body.timezone) assertTimezone(body.timezone);
      const site = await withTenant(services.db, member.organizationId, async (tx) => {
        const [updated] = await tx
          .update(schema.sites)
          .set({
            ...(body.name ? { name: body.name.trim() } : {}),
            ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
            updatedAt: services.now(),
          })
          .where(and(eq(schema.sites.id, id), isNull(schema.sites.deletedAt)))
          .returning();
        if (!updated) return null;
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'site.updated',
          permission: 'sites.manage',
          targetType: 'site',
          targetId: id,
          result: 'success',
          metadata: { fields: Object.keys(body) },
          ...requestMeta(request),
        });
        return updated;
      });
      if (!site) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Site introuvable.');
      return publicSite(site);
    },
  );
}
