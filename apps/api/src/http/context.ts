import '@fastify/cookie';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { schema, withTenant } from '@pixlova/db';
import { can, type Grant, type Permission, type Role, type Target } from '@pixlova/permissions';
import { ApiError } from '../errors.js';
import { tokenHash } from '../lib/crypto.js';
import type { Services } from './services.js';

export interface AuthContext {
  user: { id: string; email: string; displayName: string | null; mfaEnabled: boolean };
  session: { id: string; authenticatedAt: Date; mfaVerifiedAt: Date | null };
  /** Mot de passe validé, second facteur attendu : seules les routes MFA sont ouvertes. */
  mfaPending: boolean;
}

export interface MemberContext {
  auth: AuthContext;
  organizationId: string;
  membershipId: string;
  grants: Grant[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function sessionCookieName(services: Services): string {
  // Le préfixe __Host- impose Secure, Path=/ et aucun Domain : cookie lié à l’hôte exact.
  return services.security.cookieSecure ? '__Host-pixlova_session' : 'pixlova_session';
}

export function setSessionCookie(
  reply: FastifyReply,
  services: Services,
  token: string,
  expires: Date,
): void {
  reply.setCookie(sessionCookieName(services), token, {
    httpOnly: true,
    secure: services.security.cookieSecure,
    sameSite: 'lax',
    path: '/',
    expires,
  });
}

export function clearSessionCookie(reply: FastifyReply, services: Services): void {
  reply.clearCookie(sessionCookieName(services), {
    path: '/',
    secure: services.security.cookieSecure,
    httpOnly: true,
    sameSite: 'lax',
  });
}

const authCache = new WeakMap<FastifyRequest, AuthContext | null>();

/** Résout la session du cookie (SEC-002) : révoquée, expirée ou compte désactivé → anonyme. */
export async function authenticate(
  request: FastifyRequest,
  services: Services,
): Promise<AuthContext | null> {
  if (authCache.has(request)) return authCache.get(request)!;
  const token = request.cookies[sessionCookieName(services)];
  let result: AuthContext | null = null;
  if (token && token.length <= 128) {
    const now = services.now();
    const [row] = await services.db
      .select({ session: schema.userSessions, user: schema.users })
      .from(schema.userSessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.userSessions.userId))
      .where(
        and(
          eq(schema.userSessions.tokenHash, tokenHash(token)),
          isNull(schema.userSessions.revokedAt),
          gt(schema.userSessions.expiresAt, now),
          gt(schema.userSessions.idleExpiresAt, now),
          eq(schema.users.status, 'active'),
        ),
      )
      .limit(1);
    if (row) {
      result = {
        user: {
          id: row.user.id,
          email: row.user.emailNormalized,
          displayName: row.user.displayName,
          mfaEnabled: row.user.mfaEnabled,
        },
        session: {
          id: row.session.id,
          authenticatedAt: row.session.authenticatedAt,
          mfaVerifiedAt: row.session.mfaVerifiedAt,
        },
        mfaPending: row.user.mfaEnabled && row.session.mfaVerifiedAt === null,
      };
      // Prolongation de l’inactivité au plus une fois par minute ; l’expiration absolue ne bouge pas.
      if (now.getTime() - row.session.lastSeenAt.getTime() > 60_000) {
        const idle = new Date(now.getTime() + services.security.sessionIdleHours * 3_600_000);
        await services.db
          .update(schema.userSessions)
          .set({
            lastSeenAt: now,
            idleExpiresAt: idle < row.session.expiresAt ? idle : row.session.expiresAt,
          })
          .where(eq(schema.userSessions.id, row.session.id));
      }
    }
  }
  authCache.set(request, result);
  return result;
}

export async function requireUser(
  request: FastifyRequest,
  services: Services,
  options: { allowMfaPending?: boolean } = {},
): Promise<AuthContext> {
  const auth = await authenticate(request, services);
  if (!auth) throw new ApiError(401, 'UNAUTHORIZED', 'Authentification requise.');
  if (auth.mfaPending && !options.allowMfaPending) {
    throw new ApiError(403, 'MFA_REQUIRED', 'Validez le second facteur pour continuer.');
  }
  return auth;
}

/** Actions sensibles : mot de passe saisi récemment (SEC-001, IAM-006). */
export function requireRecentAuth(auth: AuthContext, services: Services): void {
  const age = services.now().getTime() - auth.session.authenticatedAt.getTime();
  if (age > services.security.recentAuthMinutes * 60_000) {
    throw new ApiError(
      403,
      'REAUTHENTICATION_REQUIRED',
      'Confirmez votre mot de passe pour cette action.',
    );
  }
}

/**
 * Contexte tenant (API-002) : l’organisation désignée par `x-organization-id` est
 * confrontée aux appartenances actives de l’utilisateur. Une organisation dont il
 * n’est pas membre est traitée comme inexistante (aucune divulgation).
 */
export async function requireMember(
  request: FastifyRequest,
  services: Services,
): Promise<MemberContext> {
  const auth = await requireUser(request, services);
  const header = request.headers['x-organization-id'];
  const organizationId = typeof header === 'string' ? header : undefined;
  if (!organizationId || !UUID.test(organizationId)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'En-tête x-organization-id requis.');
  }
  const loaded = await withTenant(services.db, organizationId, async (tx) => {
    const [membership] = await tx
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.memberships.organizationId),
      )
      .where(
        and(
          eq(schema.memberships.userId, auth.user.id),
          eq(schema.memberships.status, 'active'),
          eq(schema.organizations.status, 'active'),
        ),
      )
      .limit(1);
    if (!membership) return null;
    return { membershipId: membership.id, grants: await loadGrants(tx, [membership.id]) };
  });
  if (!loaded) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Ressource introuvable.');
  return {
    auth,
    organizationId,
    membershipId: loaded.membershipId,
    grants: loaded.grants.get(loaded.membershipId) ?? [],
  };
}

type Tx = Parameters<Parameters<typeof withTenant>[2]>[0];

/** Grants de plusieurs appartenances, avec leurs sites. À appeler dans une transaction tenant. */
export async function loadGrants(tx: Tx, membershipIds: string[]): Promise<Map<string, Grant[]>> {
  const result = new Map<string, Grant[]>();
  if (membershipIds.length === 0) return result;
  const rows = await tx
    .select({
      id: schema.membershipGrants.id,
      membershipId: schema.membershipGrants.membershipId,
      role: schema.membershipGrants.roleKey,
      scopeType: schema.membershipGrants.scopeType,
      siteIds: sql<
        string[]
      >`coalesce(array_agg(${schema.membershipGrantSites.siteId}) filter (where ${schema.membershipGrantSites.siteId} is not null), '{}')`,
    })
    .from(schema.membershipGrants)
    .leftJoin(
      schema.membershipGrantSites,
      eq(schema.membershipGrantSites.grantId, schema.membershipGrants.id),
    )
    .where(inArray(schema.membershipGrants.membershipId, membershipIds))
    .groupBy(schema.membershipGrants.id);
  for (const row of rows) {
    const grant: Grant = {
      role: row.role as Role,
      scope:
        row.scopeType === 'organization'
          ? { type: 'organization' }
          : { type: 'sites', siteIds: [...row.siteIds].sort() },
    };
    result.set(row.membershipId, [...(result.get(row.membershipId) ?? []), grant]);
  }
  return result;
}

export function authorize(
  member: MemberContext,
  permission: Permission,
  target: Target = { siteId: null },
): void {
  if (!can(member.grants, permission, target)) {
    throw new ApiError(
      403,
      'FORBIDDEN',
      'Action non autorisée pour votre rôle ou votre périmètre.',
      false,
      {
        permission,
      },
    );
  }
}

/** IAM-007 : les rôles d’administration exigent la MFA pour leurs actions sensibles. */
export function requireAdminMfa(member: MemberContext, services: Services): void {
  if (!services.security.requireMfaForAdmins || member.auth.user.mfaEnabled) return;
  if (
    member.grants.some(
      (g) => g.role === 'Owner' || g.role === 'Admin' || g.role === 'BillingManager',
    )
  ) {
    throw new ApiError(
      403,
      'MFA_ENROLLMENT_REQUIRED',
      'Activez la double authentification pour cette action.',
    );
  }
}

export async function rateLimit(
  services: Services,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const result = await services.limiter.hit(key, limit, windowSeconds);
  if (!result.allowed) {
    throw new ApiError(
      429,
      'RATE_LIMITED',
      'Trop de tentatives. Réessayez plus tard.',
      true,
      undefined,
      {
        'retry-after': String(result.retryAfter),
      },
    );
  }
}

export function requestMeta(request: FastifyRequest): { requestId: string; ip: string | null } {
  return { requestId: request.id, ip: request.ip ?? null };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
