import '@fastify/cookie';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { schema, type Database, type Transaction } from '@pixlova/db';
import { platformCan, type PlatformPermission } from '@pixlova/permissions';
import { ApiError } from '../errors.js';
import { sanitizeMetadata } from '../lib/audit.js';
import { tokenHash } from '../lib/crypto.js';
import type { AdminServices } from './services.js';

/** Opérateur authentifié ; rôles relus en base à chaque requête (révocation immédiate). */
export interface OperatorContext {
  operator: { id: string; email: string; displayName: string; status: string };
  roles: string[];
  session: { id: string; authenticatedAt: Date; mfaVerifiedAt: Date | null; expiresAt: Date };
  /** Mot de passe validé, second facteur attendu (ou à enrôler). */
  mfaPending: boolean;
  /** Compte en cours d’activation : TOTP à confirmer. */
  enrolling: boolean;
}

export function adminCookieName(services: AdminServices): string {
  return services.config.cookieSecure ? '__Host-pixlova_admin' : 'pixlova_admin';
}

export function setAdminCookie(
  reply: FastifyReply,
  services: AdminServices,
  token: string,
  expires: Date,
): void {
  reply.setCookie(adminCookieName(services), token, {
    httpOnly: true,
    secure: services.config.cookieSecure,
    // Console privée sur sa propre origine : aucune navigation intersite légitime.
    sameSite: 'strict',
    path: '/',
    expires,
  });
}

export function clearAdminCookie(reply: FastifyReply, services: AdminServices): void {
  reply.clearCookie(adminCookieName(services), {
    path: '/',
    secure: services.config.cookieSecure,
    httpOnly: true,
    sameSite: 'strict',
  });
}

const contextCache = new WeakMap<FastifyRequest, OperatorContext | null>();

/** Session d’opérateur valide (non révoquée, non expirée, compte non désactivé), ou null. */
export async function authenticateOperator(
  request: FastifyRequest,
  services: AdminServices,
): Promise<OperatorContext | null> {
  if (contextCache.has(request)) return contextCache.get(request)!;
  const token = request.cookies[adminCookieName(services)];
  let result: OperatorContext | null = null;
  if (token && token.length <= 128) {
    const now = services.now();
    const [row] = await services.platform
      .select({ session: schema.platformSessions, user: schema.platformUsers })
      .from(schema.platformSessions)
      .innerJoin(
        schema.platformUsers,
        eq(schema.platformUsers.id, schema.platformSessions.platformUserId),
      )
      .where(
        and(
          eq(schema.platformSessions.tokenHash, tokenHash(token)),
          isNull(schema.platformSessions.revokedAt),
          gt(schema.platformSessions.expiresAt, now),
          gt(schema.platformSessions.idleExpiresAt, now),
          sql`${schema.platformUsers.status} <> 'disabled'`,
        ),
      )
      .limit(1);
    if (row) {
      const roles = await services.platform
        .select({ role: schema.platformUserRoles.role })
        .from(schema.platformUserRoles)
        .where(eq(schema.platformUserRoles.platformUserId, row.user.id));
      // Inactivité repoussée au plus une fois par minute.
      if (now.getTime() - row.session.lastSeenAt.getTime() > 60_000) {
        const idle = new Date(now.getTime() + services.config.sessionIdleMinutes * 60_000);
        await services.platform
          .update(schema.platformSessions)
          .set({ lastSeenAt: now, idleExpiresAt: idle })
          .where(eq(schema.platformSessions.id, row.session.id));
      }
      result = {
        operator: {
          id: row.user.id,
          email: row.user.emailNormalized,
          displayName: row.user.displayName,
          status: row.user.status,
        },
        // Un compte en activation n’a aucun droit tant que son TOTP n’est pas confirmé.
        roles: row.user.status === 'active' ? roles.map((r) => r.role) : [],
        session: {
          id: row.session.id,
          authenticatedAt: row.session.authenticatedAt,
          mfaVerifiedAt: row.session.mfaVerifiedAt,
          expiresAt: row.session.expiresAt,
        },
        mfaPending: row.session.mfaVerifiedAt === null,
        enrolling: row.user.status === 'pending',
      };
    }
  }
  contextCache.set(request, result);
  return result;
}

/** Opérateur authentifié, second facteur validé. */
export async function requireOperator(
  request: FastifyRequest,
  services: AdminServices,
): Promise<OperatorContext> {
  const context = await authenticateOperator(request, services);
  if (!context) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentification requise.');
  if (context.mfaPending) {
    throw new ApiError(401, 'MFA_REQUIRED', 'Second facteur requis.');
  }
  return context;
}

/** Contrôle serveur de chaque action (PROD-005) ; un refus est audité. */
export async function requirePermission(
  request: FastifyRequest,
  services: AdminServices,
  permission: PlatformPermission,
): Promise<OperatorContext> {
  const context = await requireOperator(request, services);
  if (!platformCan(context.roles, permission)) {
    await platformAudit(services.platform, request, context, {
      action: 'platform.permission.denied',
      permission,
      result: 'denied',
    });
    throw new ApiError(403, 'FORBIDDEN', 'Action non autorisée pour vos rôles plateforme.');
  }
  return context;
}

/** Actions dangereuses : second facteur ressaisi récemment (`POST /auth/reauthenticate`). */
export function requireRecentMfa(context: OperatorContext, services: AdminServices): void {
  const limit = services.config.recentAuthMinutes * 60_000;
  if (services.now().getTime() - context.session.authenticatedAt.getTime() > limit) {
    throw new ApiError(
      403,
      'RECENT_AUTH_REQUIRED',
      'Confirmez votre second facteur avant cette action.',
    );
  }
}

/**
 * Motif obligatoire des consultations et actions de support (ADM-003), transmis par
 * l’en-tête `x-support-reason` (lecture) ou le champ `reason` (action).
 */
export function supportReason(request: FastifyRequest, bodyReason?: unknown): string {
  const raw = bodyReason ?? request.headers['x-support-reason'];
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length < 5 || reason.length > 500) {
    throw new ApiError(
      400,
      'REASON_REQUIRED',
      'Indiquez le motif de la consultation ou de l’action (5 à 500 caractères).',
    );
  }
  return reason;
}

export interface PlatformAuditEntry {
  action: string;
  permission?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  result: 'success' | 'denied' | 'failed';
  reason?: string | null;
  /** Organisation consultée, portée dans les métadonnées (jamais visible du tenant). */
  metadata?: Record<string, unknown>;
}

/**
 * Journal plateforme : `organization_id` NULL, donc invisible des organisations ; la
 * cible et l’état avant/après figurent dans l’entrée (ADM-003, SEC-016).
 */
export async function platformAudit(
  db: Database | Transaction,
  request: FastifyRequest,
  context: Pick<OperatorContext, 'operator'> | null,
  entry: PlatformAuditEntry,
): Promise<void> {
  const metadata = sanitizeMetadata(
    (entry.metadata ?? {}) as Parameters<typeof sanitizeMetadata>[0],
  );
  await db.insert(schema.auditLogs).values({
    organizationId: null,
    actorType: 'platform_user',
    actorId: context?.operator.id ?? null,
    action: entry.action,
    permission: entry.permission ?? null,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    result: entry.result,
    reason: entry.reason ?? null,
    requestId: request.id,
    ip: request.ip ?? null,
    metadata,
  });
}
