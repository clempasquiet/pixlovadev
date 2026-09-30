import { and, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import Type from 'typebox';
import { schema, withTenant, type Transaction } from '@pixlova/db';
import { canDelegate, ROLES, validateGrant, type Grant } from '@pixlova/permissions';
import { ApiError } from '../errors.js';
import {
  authorize,
  loadGrants,
  normalizeEmail,
  rateLimit,
  requestMeta,
  requireAdminMfa,
  requireMember,
  requireRecentAuth,
  requireUser,
  type MemberContext,
} from '../http/context.js';
import type { Services } from '../http/services.js';
import { audit } from '../lib/audit.js';
import { randomToken, tokenHash } from '../lib/crypto.js';
import { queueEmail } from '../lib/email.js';
import { Email, GrantInput, Strict, Token, Uuid } from './schemas.js';

function toGrant(input: GrantInput): Grant {
  return {
    role: input.role as Grant['role'],
    scope:
      input.scope.type === 'organization'
        ? { type: 'organization' }
        : { type: 'sites', siteIds: [...input.scope.site_ids].sort() },
  };
}

function describeGrant(grant: Grant) {
  return {
    role: grant.role,
    scope:
      grant.scope.type === 'organization'
        ? { type: 'organization' }
        : { type: 'sites', site_ids: grant.scope.siteIds },
  };
}

function grantLabel(grant: Grant): string {
  return grant.scope.type === 'organization'
    ? grant.role
    : `${grant.role}@sites:${grant.scope.siteIds.join('+')}`;
}

/** Verrou de l’organisation : sérialise les changements de propriétaires (DATA-004). */
async function lockOrganization(tx: Transaction, organizationId: string): Promise<void> {
  await tx
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .for('update');
}

async function assertSitesExist(tx: Transaction, grants: Grant[]): Promise<void> {
  const siteIds = [
    ...new Set(grants.flatMap((g) => (g.scope.type === 'sites' ? g.scope.siteIds : []))),
  ];
  if (siteIds.length === 0) return;
  const rows = await tx
    .select({ id: schema.sites.id })
    .from(schema.sites)
    .where(and(inArray(schema.sites.id, siteIds), isNull(schema.sites.deletedAt)));
  if (rows.length !== siteIds.length)
    throw new ApiError(422, 'VALIDATION_ERROR', 'Site inconnu dans le périmètre.', false, {
      field: 'site_ids',
    });
}

function assertDelegable(member: MemberContext, grants: Grant[]): void {
  for (const grant of grants) {
    const validity = validateGrant(grant);
    if (validity !== 'ok')
      throw new ApiError(422, 'VALIDATION_ERROR', 'Combinaison rôle/périmètre invalide.', false, {
        reason: validity,
      });
    if (!canDelegate(member.grants, grant)) {
      throw new ApiError(
        403,
        'DELEGATION_FORBIDDEN',
        'Vous ne pouvez pas attribuer ou retirer ce rôle sur ce périmètre.',
        false,
        {
          role: grant.role,
        },
      );
    }
  }
}

async function countOwners(tx: Transaction, excludeMembershipId?: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(distinct ${schema.memberships.id})::int` })
    .from(schema.membershipGrants)
    .innerJoin(schema.memberships, eq(schema.memberships.id, schema.membershipGrants.membershipId))
    .where(
      and(
        eq(schema.membershipGrants.roleKey, 'Owner'),
        eq(schema.memberships.status, 'active'),
        excludeMembershipId ? ne(schema.memberships.id, excludeMembershipId) : undefined,
      ),
    );
  return row?.count ?? 0;
}

async function insertGrants(
  tx: Transaction,
  organizationId: string,
  membershipId: string,
  grants: Grant[],
  createdBy: string,
) {
  for (const grant of grants) {
    const [row] = await tx
      .insert(schema.membershipGrants)
      .values({
        organizationId,
        membershipId,
        roleKey: grant.role,
        scopeType: grant.scope.type,
        createdBy,
      })
      .returning({ id: schema.membershipGrants.id });
    if (grant.scope.type === 'sites') {
      await tx
        .insert(schema.membershipGrantSites)
        .values(
          grant.scope.siteIds.map((siteId) => ({ organizationId, grantId: row!.id, siteId })),
        );
    }
  }
}

/** Places consommées : membres actifs et invitations en attente non expirées (BILL-003). */
async function usedSeats(tx: Transaction, now: Date): Promise<number> {
  const [members] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.memberships)
    .where(eq(schema.memberships.status, 'active'));
  const [pending] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.invitations)
    .where(
      and(
        isNull(schema.invitations.acceptedAt),
        isNull(schema.invitations.revokedAt),
        gt(schema.invitations.expiresAt, now),
      ),
    );
  return (members?.n ?? 0) + (pending?.n ?? 0);
}

function mutationGuards(request: FastifyRequest, member: MemberContext, services: Services): void {
  authorize(member, 'members.manage');
  requireAdminMfa(member, services);
  void request;
}

export function memberRoutes(app: FastifyInstance, services: Services): void {
  app.get('/members', async (request) => {
    const member = await requireMember(request, services);
    authorize(member, 'members.read');
    return withTenant(services.db, member.organizationId, async (tx) => {
      const rows = await tx
        .select({
          membership: schema.memberships,
          user: {
            email: schema.users.emailNormalized,
            displayName: schema.users.displayName,
            mfaEnabled: schema.users.mfaEnabled,
          },
        })
        .from(schema.memberships)
        .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
        .where(eq(schema.memberships.status, 'active'))
        .orderBy(schema.users.emailNormalized);
      const grants = await loadGrants(
        tx,
        rows.map((r) => r.membership.id),
      );
      return {
        items: rows.map(({ membership, user }) => ({
          id: membership.id,
          user_id: membership.userId,
          email: user.email,
          display_name: user.displayName,
          mfa_enabled: user.mfaEnabled,
          joined_at: membership.createdAt.toISOString(),
          grants: (grants.get(membership.id) ?? []).map(describeGrant),
        })),
      };
    });
  });

  app.put(
    '/members/:id/grants',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object(
          { grants: Type.Array(GrantInput, { minItems: 1, maxItems: 10 }) },
          Strict,
        ),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      mutationGuards(request, member, services);
      const { id } = request.params as { id: string };
      const next = (request.body as { grants: GrantInput[] }).grants.map(toGrant);
      if (next.some((g) => g.role === 'Owner')) requireRecentAuth(member.auth, services);
      return withTenant(services.db, member.organizationId, async (tx) => {
        await lockOrganization(tx, member.organizationId);
        const [target] = await tx
          .select()
          .from(schema.memberships)
          .where(and(eq(schema.memberships.id, id), eq(schema.memberships.status, 'active')));
        if (!target) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Membre introuvable.');
        const current = (await loadGrants(tx, [id])).get(id) ?? [];
        if (current.some((g) => g.role === 'Owner')) requireRecentAuth(member.auth, services);
        // On ne retire pas plus que ce qu’on pourrait attribuer, et on n’attribue que ce qu’on détient (IAM-006).
        assertDelegable(member, [...current, ...next]);
        await assertSitesExist(tx, next);
        await tx
          .delete(schema.membershipGrants)
          .where(eq(schema.membershipGrants.membershipId, id));
        await insertGrants(tx, member.organizationId, id, next, member.auth.user.id);
        if ((await countOwners(tx)) === 0) {
          throw new ApiError(
            409,
            'LAST_OWNER',
            'L’organisation doit conserver au moins un propriétaire actif.',
          );
        }
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'member.grants_changed',
          permission: 'members.manage',
          targetType: 'membership',
          targetId: id,
          result: 'success',
          metadata: { before: current.map(grantLabel), after: next.map(grantLabel) },
          ...requestMeta(request),
        });
        return { id, grants: next.map(describeGrant) };
      });
    },
  );

  app.delete(
    '/members/:id',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request, reply) => {
      const member = await requireMember(request, services);
      const { id } = request.params as { id: string };
      const leaving = id === member.membershipId;
      if (!leaving) mutationGuards(request, member, services);
      await withTenant(services.db, member.organizationId, async (tx) => {
        await lockOrganization(tx, member.organizationId);
        const [target] = await tx
          .select()
          .from(schema.memberships)
          .where(and(eq(schema.memberships.id, id), eq(schema.memberships.status, 'active')));
        if (!target) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Membre introuvable.');
        const current = (await loadGrants(tx, [id])).get(id) ?? [];
        if (!leaving) assertDelegable(member, current);
        if (current.some((g) => g.role === 'Owner')) requireRecentAuth(member.auth, services);
        await tx
          .delete(schema.membershipGrants)
          .where(eq(schema.membershipGrants.membershipId, id));
        await tx
          .update(schema.memberships)
          .set({ status: 'revoked', updatedAt: services.now() })
          .where(eq(schema.memberships.id, id));
        if ((await countOwners(tx)) === 0) {
          throw new ApiError(
            409,
            'LAST_OWNER',
            'L’organisation doit conserver au moins un propriétaire actif.',
          );
        }
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: leaving ? 'member.left' : 'member.removed',
          permission: leaving ? null : 'members.manage',
          targetType: 'membership',
          targetId: id,
          result: 'success',
          metadata: { before: current.map(grantLabel) },
          ...requestMeta(request),
        });
      });
      return reply.status(204).send();
    },
  );

  // --- Invitations (IAM-002) --------------------------------------------------

  app.get('/invitations', async (request) => {
    const member = await requireMember(request, services);
    authorize(member, 'members.read');
    const rows = await withTenant(services.db, member.organizationId, (tx) =>
      tx
        .select()
        .from(schema.invitations)
        .where(and(isNull(schema.invitations.acceptedAt), isNull(schema.invitations.revokedAt)))
        .orderBy(schema.invitations.createdAt),
    );
    return {
      items: rows.map((inv) => ({
        id: inv.id,
        email: inv.emailNormalized,
        role: inv.roleKey,
        scope_type: inv.scopeType,
        expires_at: inv.expiresAt.toISOString(),
        expired: inv.expiresAt <= services.now(),
        created_at: inv.createdAt.toISOString(),
      })),
    };
  });

  app.post(
    '/invitations',
    {
      schema: {
        body: Type.Object(
          { email: Email, role: GrantInput.properties.role, scope: GrantInput.properties.scope },
          Strict,
        ),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      mutationGuards(request, member, services);
      await rateLimit(services, `invite:${member.organizationId}`, 50, 3600);
      const body = request.body as {
        email: string;
        role: GrantInput['role'];
        scope: GrantInput['scope'];
      };
      const email = normalizeEmail(body.email);
      const grant = toGrant({ role: body.role, scope: body.scope });
      assertDelegable(member, [grant]);
      if (grant.role === 'Owner') requireRecentAuth(member.auth, services);
      const now = services.now();
      const maxUsers = await services.entitlements.maxUsers(member.organizationId);
      const token = randomToken();
      const created = await withTenant(services.db, member.organizationId, async (tx) => {
        await lockOrganization(tx, member.organizationId);
        await assertSitesExist(tx, [grant]);
        const [existingMember] = await tx
          .select({ id: schema.memberships.id })
          .from(schema.memberships)
          .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
          .where(
            and(eq(schema.users.emailNormalized, email), eq(schema.memberships.status, 'active')),
          );
        if (existingMember)
          throw new ApiError(
            409,
            'ALREADY_MEMBER',
            'Cette personne est déjà membre de l’organisation.',
          );
        // Une invitation expirée non acceptée libère sa place : elle est close avant d’en créer une autre.
        await tx
          .update(schema.invitations)
          .set({ revokedAt: now })
          .where(
            and(
              eq(schema.invitations.emailNormalized, email),
              isNull(schema.invitations.acceptedAt),
              isNull(schema.invitations.revokedAt),
              sql`${schema.invitations.expiresAt} <= ${now}`,
            ),
          );
        const [pending] = await tx
          .select({ id: schema.invitations.id })
          .from(schema.invitations)
          .where(
            and(
              eq(schema.invitations.emailNormalized, email),
              isNull(schema.invitations.acceptedAt),
              isNull(schema.invitations.revokedAt),
            ),
          );
        if (pending)
          throw new ApiError(
            409,
            'INVITATION_PENDING',
            'Une invitation est déjà en attente ; renvoyez-la.',
            false,
            { invitation_id: pending.id },
          );
        if ((await usedSeats(tx, now)) >= maxUsers) {
          throw new ApiError(
            409,
            'USER_LIMIT_REACHED',
            'Nombre maximal d’utilisateurs atteint pour l’offre.',
            false,
            { allowed: maxUsers },
          );
        }
        const [invitation] = await tx
          .insert(schema.invitations)
          .values({
            organizationId: member.organizationId,
            emailNormalized: email,
            roleKey: grant.role,
            scopeType: grant.scope.type,
            tokenHash: tokenHash(token),
            expiresAt: new Date(now.getTime() + services.security.invitationDays * 86_400_000),
            invitedBy: member.auth.user.id,
          })
          .returning();
        if (grant.scope.type === 'sites') {
          await tx.insert(schema.invitationSites).values(
            grant.scope.siteIds.map((siteId) => ({
              organizationId: member.organizationId,
              invitationId: invitation!.id,
              siteId,
            })),
          );
        }
        const [organization] = await tx
          .select({ name: schema.organizations.name })
          .from(schema.organizations);
        await queueEmail(tx, services.cipher, {
          template: 'invitation',
          to: email,
          data: {
            link: `${services.security.appBaseUrl}/invitations/accept?token=${token}`,
            organizationName: organization!.name,
            role: ROLES[grant.role].label,
          },
        });
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'invitation.created',
          permission: 'members.manage',
          targetType: 'invitation',
          targetId: invitation!.id,
          result: 'success',
          metadata: { grant: grantLabel(grant) },
          ...requestMeta(request),
        });
        return invitation!;
      });
      return reply.status(201).send({
        id: created.id,
        email,
        role: grant.role,
        expires_at: created.expiresAt.toISOString(),
      });
    },
  );

  app.post(
    '/invitations/:id/revoke',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request, reply) => {
      const member = await requireMember(request, services);
      mutationGuards(request, member, services);
      const { id } = request.params as { id: string };
      await withTenant(services.db, member.organizationId, async (tx) => {
        const [revoked] = await tx
          .update(schema.invitations)
          .set({ revokedAt: services.now() })
          .where(
            and(
              eq(schema.invitations.id, id),
              isNull(schema.invitations.acceptedAt),
              isNull(schema.invitations.revokedAt),
            ),
          )
          .returning({ id: schema.invitations.id });
        if (!revoked)
          throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Invitation introuvable ou déjà close.');
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'invitation.revoked',
          permission: 'members.manage',
          targetType: 'invitation',
          targetId: id,
          result: 'success',
          ...requestMeta(request),
        });
      });
      return reply.status(204).send();
    },
  );

  /** Renvoi : nouveau jeton et nouvelle échéance sur la même invitation (aucune appartenance en double). */
  app.post(
    '/invitations/:id/resend',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      mutationGuards(request, member, services);
      const { id } = request.params as { id: string };
      await rateLimit(services, `invite-resend:${id}`, 5, 3600);
      const token = randomToken();
      const now = services.now();
      const expiresAt = new Date(now.getTime() + services.security.invitationDays * 86_400_000);
      await withTenant(services.db, member.organizationId, async (tx) => {
        const [invitation] = await tx
          .update(schema.invitations)
          .set({ tokenHash: tokenHash(token), expiresAt })
          .where(
            and(
              eq(schema.invitations.id, id),
              isNull(schema.invitations.acceptedAt),
              isNull(schema.invitations.revokedAt),
            ),
          )
          .returning();
        if (!invitation)
          throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Invitation introuvable ou déjà close.');
        const [organization] = await tx
          .select({ name: schema.organizations.name })
          .from(schema.organizations);
        await queueEmail(tx, services.cipher, {
          template: 'invitation',
          to: invitation.emailNormalized,
          data: {
            link: `${services.security.appBaseUrl}/invitations/accept?token=${token}`,
            organizationName: organization!.name,
            role: ROLES[invitation.roleKey as Grant['role']].label,
          },
        });
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'invitation.resent',
          permission: 'members.manage',
          targetType: 'invitation',
          targetId: id,
          result: 'success',
          ...requestMeta(request),
        });
      });
      return { id, expires_at: expiresAt.toISOString() };
    },
  );

  /**
   * Acceptation par le compte destinataire, adresse vérifiée identique (IAM-002).
   * Le compte n’étant pas encore membre, l’opération passe par le rôle système,
   * sous verrou de l’invitation : deux acceptations concurrentes n’en font qu’une.
   */
  app.post(
    '/invitations/accept',
    { schema: { body: Type.Object({ token: Token }, Strict) } },
    async (request) => {
      const auth = await requireUser(request, services);
      await rateLimit(services, `invite-accept:${auth.user.id}`, 20, 3600);
      const { token } = request.body as { token: string };
      const now = services.now();
      const invalid = () =>
        new ApiError(
          404,
          'INVITATION_INVALID',
          'Invitation invalide, expirée ou destinée à une autre adresse.',
        );
      const result = await services.system.transaction(async (tx) => {
        const [invitation] = await tx
          .select()
          .from(schema.invitations)
          .where(eq(schema.invitations.tokenHash, tokenHash(token)))
          .for('update');
        if (
          !invitation ||
          invitation.acceptedAt ||
          invitation.revokedAt ||
          invitation.expiresAt <= now
        )
          throw invalid();
        if (invitation.emailNormalized !== auth.user.email) throw invalid();
        const organizationId = invitation.organizationId;
        const [organization] = await tx
          .select()
          .from(schema.organizations)
          .where(eq(schema.organizations.id, organizationId))
          .for('update');
        if (!organization || organization.status !== 'active') throw invalid();
        const siteRows = await tx
          .select({ siteId: schema.invitationSites.siteId })
          .from(schema.invitationSites)
          .where(eq(schema.invitationSites.invitationId, invitation.id));
        const grant: Grant = {
          role: invitation.roleKey as Grant['role'],
          scope:
            invitation.scopeType === 'organization'
              ? { type: 'organization' }
              : { type: 'sites', siteIds: siteRows.map((r) => r.siteId).sort() },
        };
        const [existing] = await tx
          .select()
          .from(schema.memberships)
          .where(
            and(
              eq(schema.memberships.organizationId, organizationId),
              eq(schema.memberships.userId, auth.user.id),
            ),
          );
        if (existing?.status !== 'active') {
          // Quota revérifié à l’acceptation (l’invitation acceptée libère sa propre place).
          const [members] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(schema.memberships)
            .where(
              and(
                eq(schema.memberships.organizationId, organizationId),
                eq(schema.memberships.status, 'active'),
              ),
            );
          if ((members?.n ?? 0) >= (await services.entitlements.maxUsers(organizationId))) {
            throw new ApiError(
              409,
              'USER_LIMIT_REACHED',
              'Nombre maximal d’utilisateurs atteint pour l’offre.',
            );
          }
        }
        let membershipId: string;
        if (existing) {
          membershipId = existing.id;
          if (existing.status !== 'active') {
            await tx
              .update(schema.memberships)
              .set({ status: 'active', updatedAt: now })
              .where(eq(schema.memberships.id, existing.id));
            await tx
              .delete(schema.membershipGrants)
              .where(eq(schema.membershipGrants.membershipId, existing.id));
            await insertGrants(tx, organizationId, existing.id, [grant], invitation.invitedBy);
          }
          // Déjà membre actif : l’invitation n’étend pas implicitement le rôle.
        } else {
          const [created] = await tx
            .insert(schema.memberships)
            .values({ organizationId, userId: auth.user.id })
            .returning({ id: schema.memberships.id });
          membershipId = created!.id;
          await insertGrants(tx, organizationId, membershipId, [grant], invitation.invitedBy);
        }
        await tx
          .update(schema.invitations)
          .set({ acceptedAt: now, acceptedBy: auth.user.id })
          .where(eq(schema.invitations.id, invitation.id));
        await audit(tx, {
          organizationId,
          actorType: 'user',
          actorId: auth.user.id,
          action: 'invitation.accepted',
          targetType: 'membership',
          targetId: membershipId,
          result: 'success',
          metadata: { invitation_id: invitation.id, grant: grantLabel(grant) },
          ...requestMeta(request),
        });
        return {
          organization_id: organizationId,
          organization_name: organization.name,
          membership_id: membershipId,
        };
      });
      return result;
    },
  );
}
