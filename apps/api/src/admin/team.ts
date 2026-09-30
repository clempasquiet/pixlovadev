import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import Type from 'typebox';
import { schema, type Transaction } from '@pixlova/db';
import {
  PLATFORM_ROLE_KEYS,
  PLATFORM_ROLES,
  platformCan,
  type PlatformRole,
} from '@pixlova/permissions';
import { ApiError } from '../errors.js';
import { Email, Strict, Uuid } from '../modules/schemas.js';
import {
  platformAudit,
  requirePermission,
  requireRecentMfa,
  supportReason,
  type OperatorContext,
} from './context.js';
import { createOperator, issueActivation } from './operators.js';
import type { AdminServices } from './services.js';

const Reason = Type.String({ minLength: 5, maxLength: 500 });
const Roles = Type.Array(Type.Union(PLATFORM_ROLE_KEYS.map((role) => Type.Literal(role))), {
  minItems: 1,
  maxItems: PLATFORM_ROLE_KEYS.length,
  uniqueItems: true,
});

/**
 * Gestion des opérateurs (SuperAdmin, ADM-002) : création par code d’activation remis
 * hors bande, rôles, désactivation et réinitialisation des facteurs. Il reste toujours
 * au moins un SuperAdmin actif ; un opérateur ne modifie pas ses propres accès.
 */
export function adminTeamRoutes(app: FastifyInstance, services: AdminServices): void {
  async function guard(request: FastifyRequest): Promise<OperatorContext> {
    const context = await requirePermission(request, services, 'platform.team.manage');
    requireRecentMfa(context, services);
    return context;
  }

  async function snapshot(tx: Transaction, id: string) {
    const [operator] = await tx
      .select({
        id: schema.platformUsers.id,
        email: schema.platformUsers.emailNormalized,
        status: schema.platformUsers.status,
      })
      .from(schema.platformUsers)
      .where(eq(schema.platformUsers.id, id))
      .for('update');
    if (!operator) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Opérateur introuvable.');
    const roles = await tx
      .select({ role: schema.platformUserRoles.role })
      .from(schema.platformUserRoles)
      .where(eq(schema.platformUserRoles.platformUserId, id));
    return { ...operator, roles: roles.map((r) => r.role).sort() };
  }

  /**
   * Sérialise les modifications d’équipe et revérifie, sous le verrou, que l’auteur
   * détient toujours le droit : deux SuperAdmin qui se rétrogradent simultanément ne
   * peuvent pas vider le rôle.
   */
  async function lockTeam(tx: Transaction, context: OperatorContext): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(727602)`);
    const roles = await tx
      .select({ role: schema.platformUserRoles.role })
      .from(schema.platformUserRoles)
      .innerJoin(
        schema.platformUsers,
        eq(schema.platformUsers.id, schema.platformUserRoles.platformUserId),
      )
      .where(
        and(
          eq(schema.platformUserRoles.platformUserId, context.operator.id),
          eq(schema.platformUsers.status, 'active'),
        ),
      );
    if (
      !platformCan(
        roles.map((r) => r.role),
        'platform.team.manage',
      )
    ) {
      throw new ApiError(403, 'FORBIDDEN', 'Action non autorisée pour vos rôles plateforme.');
    }
  }

  async function assertAnotherSuperAdmin(tx: Transaction, excluding: string): Promise<void> {
    const result = await tx.execute(
      sql`SELECT u.id FROM platform_users u JOIN platform_user_roles r ON r.platform_user_id = u.id
          WHERE r.role = 'super_admin' AND u.status = 'active' AND u.id <> ${excluding}`,
    );
    if (result.rows.length === 0) {
      throw new ApiError(409, 'LAST_SUPER_ADMIN', 'Il doit rester au moins un SuperAdmin actif.');
    }
  }

  function notSelf(context: OperatorContext, id: string): void {
    if (context.operator.id === id) {
      throw new ApiError(409, 'SELF_MODIFICATION', 'Un autre SuperAdmin doit modifier vos accès.');
    }
  }

  app.get('/team', async (request) => {
    await requirePermission(request, services, 'platform.team.manage');
    const operators = await services.platform.execute(
      sql`SELECT u.id, u.email_normalized, u.display_name, u.status, u.last_login_at, u.created_at,
            coalesce(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles,
            (SELECT count(*) FROM platform_sessions s WHERE s.platform_user_id = u.id
               AND s.revoked_at IS NULL AND s.expires_at > now() AND s.idle_expires_at > now()) AS sessions
          FROM platform_users u LEFT JOIN platform_user_roles r ON r.platform_user_id = u.id
          GROUP BY u.id ORDER BY u.created_at`,
    );
    return {
      roles: PLATFORM_ROLE_KEYS.map((key) => ({ key, label: PLATFORM_ROLES[key].label })),
      items: operators.rows.map((o) => ({
        id: o.id,
        email: o.email_normalized,
        display_name: o.display_name,
        status: o.status,
        roles: o.roles,
        active_sessions: Number(o.sessions),
        last_login_at: o.last_login_at ? new Date(String(o.last_login_at)).toISOString() : null,
        created_at: new Date(String(o.created_at)).toISOString(),
      })),
    };
  });

  app.post(
    '/team',
    {
      schema: {
        body: Type.Object(
          {
            email: Email,
            display_name: Type.String({ minLength: 1, maxLength: 120 }),
            roles: Roles,
            reason: Reason,
          },
          Strict,
        ),
      },
    },
    async (request, reply) => {
      const context = await guard(request);
      const body = request.body as {
        email: string;
        display_name: string;
        roles: PlatformRole[];
        reason: string;
      };
      const reason = supportReason(request, body.reason);
      try {
        const issued = await services.platform.transaction(async (tx) => {
          await lockTeam(tx, context);
          const result = await createOperator(
            tx,
            { email: body.email, displayName: body.display_name.trim(), roles: body.roles },
            context.operator.id,
            services.now(),
            services.config.activationHours,
          );
          await platformAudit(tx, request, context, {
            action: 'platform.operator.created',
            permission: 'platform.team.manage',
            targetType: 'platform_user',
            targetId: result.operatorId,
            result: 'success',
            reason,
            metadata: { after: { status: 'pending', roles: [...body.roles].sort() } },
          });
          return result;
        });
        reply.code(201);
        return {
          id: issued.operatorId,
          activation_code: issued.activationCode,
          activation_expires_at: issued.expiresAt.toISOString(),
        };
      } catch (error) {
        const code =
          (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
        if (code === '23505')
          throw new ApiError(409, 'OPERATOR_EXISTS', 'Cette adresse est déjà un opérateur.');
        throw error;
      }
    },
  );

  app.put(
    '/team/:id/roles',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object({ roles: Roles, reason: Reason }, Strict),
      },
    },
    async (request) => {
      const context = await guard(request);
      const { id } = request.params as { id: string };
      notSelf(context, id);
      const body = request.body as { roles: PlatformRole[]; reason: string };
      const reason = supportReason(request, body.reason);
      return services.platform.transaction(async (tx) => {
        await lockTeam(tx, context);
        const before = await snapshot(tx, id);
        if (before.roles.includes('super_admin') && !body.roles.includes('super_admin')) {
          await assertAnotherSuperAdmin(tx, id);
        }
        await tx
          .delete(schema.platformUserRoles)
          .where(eq(schema.platformUserRoles.platformUserId, id));
        await tx.insert(schema.platformUserRoles).values(
          body.roles.map((role) => ({
            platformUserId: id,
            role,
            grantedBy: context.operator.id,
          })),
        );
        const after = [...body.roles].sort();
        await platformAudit(tx, request, context, {
          action: 'platform.operator.roles_changed',
          permission: 'platform.team.manage',
          targetType: 'platform_user',
          targetId: id,
          result: 'success',
          reason,
          metadata: { before: { roles: before.roles }, after: { roles: after } },
        });
        return { id, roles: after };
      });
    },
  );

  app.post(
    '/team/:id/status',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object(
          {
            status: Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
            reason: Reason,
          },
          Strict,
        ),
      },
    },
    async (request) => {
      const context = await guard(request);
      const { id } = request.params as { id: string };
      notSelf(context, id);
      const body = request.body as { status: 'active' | 'disabled'; reason: string };
      const reason = supportReason(request, body.reason);
      const now = services.now();
      return services.platform.transaction(async (tx) => {
        await lockTeam(tx, context);
        const before = await snapshot(tx, id);
        if (body.status === 'active' && before.status !== 'disabled') {
          throw new ApiError(409, 'NO_CHANGE', 'Seul un opérateur désactivé peut être réactivé.');
        }
        if (body.status === 'disabled' && before.status === 'disabled') {
          throw new ApiError(409, 'NO_CHANGE', 'L’opérateur est déjà désactivé.');
        }
        if (body.status === 'disabled' && before.roles.includes('super_admin')) {
          await assertAnotherSuperAdmin(tx, id);
        }
        // Réactivation : sans mot de passe (compte jamais activé), il reste en attente.
        const [row] = await tx
          .select({ hasPassword: sql<boolean>`${schema.platformUsers.passwordHash} IS NOT NULL` })
          .from(schema.platformUsers)
          .where(eq(schema.platformUsers.id, id));
        const status =
          body.status === 'disabled' ? 'disabled' : row!.hasPassword ? 'active' : 'pending';
        await tx
          .update(schema.platformUsers)
          .set({ status, updatedAt: now })
          .where(eq(schema.platformUsers.id, id));
        if (status === 'disabled') {
          await tx
            .update(schema.platformSessions)
            .set({ revokedAt: now, revokeReason: 'operator_disabled' })
            .where(
              and(
                eq(schema.platformSessions.platformUserId, id),
                isNull(schema.platformSessions.revokedAt),
              ),
            );
        }
        await platformAudit(tx, request, context, {
          action:
            status === 'disabled' ? 'platform.operator.disabled' : 'platform.operator.enabled',
          permission: 'platform.team.manage',
          targetType: 'platform_user',
          targetId: id,
          result: 'success',
          reason,
          metadata: { before: { status: before.status }, after: { status } },
        });
        return { id, status };
      });
    },
  );

  // Réinitialisation des facteurs (perte du TOTP) : nouveau code d’activation.
  app.post(
    '/team/:id/activation',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object({ reason: Reason }, Strict),
      },
    },
    async (request) => {
      const context = await guard(request);
      const { id } = request.params as { id: string };
      notSelf(context, id);
      const reason = supportReason(request, (request.body as { reason: string }).reason);
      const issued = await services.platform.transaction(async (tx) => {
        await lockTeam(tx, context);
        const before = await snapshot(tx, id);
        if (before.status === 'disabled') {
          throw new ApiError(409, 'OPERATOR_DISABLED', 'Réactivez d’abord cet opérateur.');
        }
        if (before.roles.includes('super_admin') && before.status === 'active') {
          await assertAnotherSuperAdmin(tx, id);
        }
        const result = await issueActivation(
          tx,
          id,
          context.operator.id,
          services.now(),
          services.config.activationHours,
        );
        await platformAudit(tx, request, context, {
          action: 'platform.operator.activation_issued',
          permission: 'platform.team.manage',
          targetType: 'platform_user',
          targetId: id,
          result: 'success',
          reason,
          metadata: { before: { status: before.status }, after: { status: 'pending' } },
        });
        return result;
      });
      return {
        id,
        activation_code: issued.activationCode,
        activation_expires_at: issued.expiresAt.toISOString(),
      };
    },
  );
}
