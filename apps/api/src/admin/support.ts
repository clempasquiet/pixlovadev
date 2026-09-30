import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Type from 'typebox';
import { schema } from '@pixlova/db';
import { ApiError } from '../errors.js';
import { Email, Strict, Uuid } from '../modules/schemas.js';
import { platformAudit, requirePermission, requireRecentMfa, supportReason } from './context.js';
import type { AdminServices } from './services.js';
import { describeCustomer } from './views.js';

const Reason = Type.String({ minLength: 5, maxLength: 500 });

/**
 * Actions de support (ADM-003) : explicites, bornées à un compte ou une tâche, avec
 * motif, second facteur récent pour les plus sensibles, et état avant/après audité.
 * Aucune impersonation : le support n’agit jamais « en tant que » client.
 */
export function adminSupportRoutes(app: FastifyInstance, services: AdminServices): void {
  /** Relit l’adresse exacte : une action dangereuse désigne son compte sans ambiguïté. */
  async function confirmTarget(userId: string, confirmEmail: string) {
    const customer = await describeCustomer(services, userId);
    if (customer.email !== confirmEmail.trim().toLowerCase()) {
      throw new ApiError(
        409,
        'CONFIRMATION_MISMATCH',
        'L’adresse de confirmation ne correspond pas au compte.',
      );
    }
    return customer;
  }

  app.post(
    '/customers/:id/sessions/revoke',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object({ reason: Reason }, Strict),
      },
    },
    async (request) => {
      const context = await requirePermission(
        request,
        services,
        'platform.customers.revoke_sessions',
      );
      requireRecentMfa(context, services);
      const { id } = request.params as { id: string };
      const reason = supportReason(request, (request.body as { reason: string }).reason);
      const before = await describeCustomer(services, id);
      const now = services.now();
      const revoked = await services.platform.transaction(async (tx) => {
        const rows = await tx
          .update(schema.userSessions)
          .set({ revokedAt: now, revokeReason: 'platform_support' })
          .where(
            and(
              eq(schema.userSessions.userId, id),
              isNull(schema.userSessions.revokedAt),
              gt(schema.userSessions.expiresAt, now),
            ),
          )
          .returning({ id: schema.userSessions.id });
        await platformAudit(tx, request, context, {
          action: 'platform.customer.sessions_revoked',
          permission: 'platform.customers.revoke_sessions',
          targetType: 'user',
          targetId: id,
          result: 'success',
          reason,
          metadata: {
            before: { active_sessions: before.active_sessions },
            after: { active_sessions: 0 },
            revoked: rows.length,
          },
        });
        return rows.length;
      });
      return { revoked_sessions: revoked, customer: await describeCustomer(services, id) };
    },
  );

  // Récupération d’un compte sans code de secours (ADR-006, procédure support).
  app.post(
    '/customers/:id/mfa/reset',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object({ reason: Reason, confirm_email: Email }, Strict),
      },
    },
    async (request) => {
      const context = await requirePermission(request, services, 'platform.customers.reset_mfa');
      requireRecentMfa(context, services);
      const { id } = request.params as { id: string };
      const body = request.body as { reason: string; confirm_email: string };
      const reason = supportReason(request, body.reason);
      const before = await confirmTarget(id, body.confirm_email);
      if (!before.mfa_enabled) {
        throw new ApiError(409, 'MFA_NOT_ENABLED', 'Ce compte n’a pas de second facteur actif.');
      }
      const now = services.now();
      await services.platform.transaction(async (tx) => {
        await tx
          .update(schema.mfaCredentials)
          .set({ revokedAt: now })
          .where(
            and(eq(schema.mfaCredentials.userId, id), isNull(schema.mfaCredentials.revokedAt)),
          );
        await tx
          .update(schema.mfaRecoveryCodes)
          .set({ usedAt: now })
          .where(
            and(eq(schema.mfaRecoveryCodes.userId, id), isNull(schema.mfaRecoveryCodes.usedAt)),
          );
        await tx
          .update(schema.users)
          .set({ mfaEnabled: false, updatedAt: now })
          .where(eq(schema.users.id, id));
        // Toute session ouverte avec l’ancien facteur est fermée.
        await tx
          .update(schema.userSessions)
          .set({ revokedAt: now, revokeReason: 'platform_mfa_reset' })
          .where(and(eq(schema.userSessions.userId, id), isNull(schema.userSessions.revokedAt)));
        await platformAudit(tx, request, context, {
          action: 'platform.customer.mfa_reset',
          permission: 'platform.customers.reset_mfa',
          targetType: 'user',
          targetId: id,
          result: 'success',
          reason,
          metadata: {
            before: { mfa_enabled: true, active_sessions: before.active_sessions },
            after: { mfa_enabled: false, active_sessions: 0 },
          },
        });
      });
      return { customer: await describeCustomer(services, id) };
    },
  );

  app.post(
    '/customers/:id/status',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object(
          {
            status: Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
            reason: Reason,
            confirm_email: Email,
          },
          Strict,
        ),
      },
    },
    async (request) => {
      const context = await requirePermission(request, services, 'platform.customers.set_status');
      requireRecentMfa(context, services);
      const { id } = request.params as { id: string };
      const body = request.body as {
        status: 'active' | 'disabled';
        reason: string;
        confirm_email: string;
      };
      const reason = supportReason(request, body.reason);
      const before = await confirmTarget(id, body.confirm_email);
      if (before.status === body.status) {
        throw new ApiError(409, 'NO_CHANGE', 'Le compte est déjà dans cet état.');
      }
      const now = services.now();
      await services.platform.transaction(async (tx) => {
        await tx
          .update(schema.users)
          .set({ status: body.status, updatedAt: now })
          .where(eq(schema.users.id, id));
        if (body.status === 'disabled') {
          await tx
            .update(schema.userSessions)
            .set({ revokedAt: now, revokeReason: 'platform_account_disabled' })
            .where(and(eq(schema.userSessions.userId, id), isNull(schema.userSessions.revokedAt)));
        }
        await platformAudit(tx, request, context, {
          action:
            body.status === 'disabled' ? 'platform.customer.disabled' : 'platform.customer.enabled',
          permission: 'platform.customers.set_status',
          targetType: 'user',
          targetId: id,
          result: 'success',
          reason,
          metadata: { before: { status: before.status }, after: { status: body.status } },
        });
      });
      return { customer: await describeCustomer(services, id) };
    },
  );

  // Relance d’une tâche en échec : seule transition autorisée failed → queued.
  app.post(
    '/jobs/:id/retry',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object({ reason: Reason }, Strict),
      },
    },
    async (request) => {
      const context = await requirePermission(request, services, 'platform.jobs.retry');
      const { id } = request.params as { id: string };
      const reason = supportReason(request, (request.body as { reason: string }).reason);
      const now = services.now();
      try {
        return await services.platform.transaction(async (tx) => {
          const updated = await tx
            .update(schema.jobs)
            .set({
              state: 'queued',
              attempts: 0,
              runAfter: now,
              lastError: null,
              finishedAt: null,
              updatedAt: now,
            })
            .where(and(eq(schema.jobs.id, id), eq(schema.jobs.state, 'failed')))
            .returning({ id: schema.jobs.id, kind: schema.jobs.kind });
          if (updated.length !== 1) {
            throw new ApiError(
              409,
              'JOB_NOT_FAILED',
              'Seule une tâche en échec peut être relancée.',
            );
          }
          await platformAudit(tx, request, context, {
            action: 'platform.job.retried',
            permission: 'platform.jobs.retry',
            targetType: 'job',
            targetId: id,
            result: 'success',
            reason,
            metadata: {
              kind: updated[0]!.kind,
              before: { state: 'failed' },
              after: { state: 'queued' },
            },
          });
          return { id, state: 'queued' };
        });
      } catch (error) {
        // Une tâche active de même clé existe déjà : elle fera le travail.
        const code =
          (error as { code?: string; cause?: { code?: string } }).code ??
          (error as { cause?: { code?: string } }).cause?.code;
        if (code === '23505') {
          throw new ApiError(409, 'JOB_ALREADY_ACTIVE', 'Une tâche équivalente est déjà en file.');
        }
        throw error;
      }
    },
  );
}
