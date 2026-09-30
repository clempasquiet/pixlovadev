import { and, eq, gt, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import Type from 'typebox';
import { schema } from '@pixlova/db';
import { platformPermissions } from '@pixlova/permissions';
import { ApiError } from '../errors.js';
import { randomToken, tokenHash } from '../lib/crypto.js';
import {
  dummyHash,
  hashPassword,
  needsRehash,
  passwordProblem,
  verifyPassword,
} from '../lib/password.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../lib/totp.js';
import { Email, Password, Strict, Token, TotpCode } from '../modules/schemas.js';
import {
  authenticateOperator,
  clearAdminCookie,
  platformAudit,
  setAdminCookie,
  type OperatorContext,
} from './context.js';
import type { AdminServices } from './services.js';

/** Contexte de chiffrement propre aux opérateurs : un secret client ne s’y déchiffre pas. */
export const PLATFORM_TOTP_CONTEXT = 'platform_mfa_totp_secret';

const INVALID_CREDENTIALS = () =>
  new ApiError(401, 'INVALID_CREDENTIALS', 'Adresse email ou mot de passe incorrect.');

async function limit(
  services: AdminServices,
  key: string,
  max: number,
  windowSeconds: number,
): Promise<void> {
  const result = await services.limiter.hit(`admin:${key}`, max, windowSeconds);
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

async function createSession(
  services: AdminServices,
  request: FastifyRequest,
  operatorId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const now = services.now();
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + services.config.sessionAbsoluteHours * 3_600_000);
  const idle = new Date(now.getTime() + services.config.sessionIdleMinutes * 60_000);
  await services.platform.insert(schema.platformSessions).values({
    platformUserId: operatorId,
    tokenHash: tokenHash(token),
    idleExpiresAt: idle < expiresAt ? idle : expiresAt,
    expiresAt,
    authenticatedAt: now,
    ip: request.ip ?? null,
    userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
  });
  return { token, expiresAt };
}

/**
 * Vérifie un code TOTP de l’opérateur (anti-rejeu par dernier pas accepté). `confirm`
 * confirme un facteur en cours d’enrôlement.
 */
async function checkTotp(
  services: AdminServices,
  operatorId: string,
  code: string,
  confirm: boolean,
): Promise<boolean> {
  const [credential] = await services.platform
    .select()
    .from(schema.platformMfaCredentials)
    .where(
      and(
        eq(schema.platformMfaCredentials.platformUserId, operatorId),
        isNull(schema.platformMfaCredentials.revokedAt),
      ),
    )
    .limit(1);
  if (!credential) return false;
  if (!confirm && !credential.confirmedAt) return false;
  const secret = services.cipher.decrypt(credential.encryptedSecret, PLATFORM_TOTP_CONTEXT);
  const step = verifyTotp(secret, code, services.now().getTime(), credential.lastUsedStep);
  if (step === null) return false;
  // Mise à jour conditionnelle : deux requêtes simultanées ne consomment pas le même pas.
  const updated = await services.platform
    .update(schema.platformMfaCredentials)
    .set({
      lastUsedStep: step,
      ...(confirm && !credential.confirmedAt ? { confirmedAt: services.now() } : {}),
    })
    .where(
      and(
        eq(schema.platformMfaCredentials.id, credential.id),
        credential.lastUsedStep === null
          ? isNull(schema.platformMfaCredentials.lastUsedStep)
          : eq(schema.platformMfaCredentials.lastUsedStep, credential.lastUsedStep),
      ),
    )
    .returning({ id: schema.platformMfaCredentials.id });
  return updated.length === 1;
}

export function describeOperator(context: OperatorContext) {
  return {
    operator: {
      id: context.operator.id,
      email: context.operator.email,
      display_name: context.operator.displayName,
      status: context.operator.status,
    },
    roles: context.roles,
    permissions: context.mfaPending ? [] : platformPermissions(context.roles),
    session: {
      mfa_pending: context.mfaPending,
      enrolling: context.enrolling,
      expires_at: context.session.expiresAt.toISOString(),
      authenticated_at: context.session.authenticatedAt.toISOString(),
    },
  };
}

export function adminAuthRoutes(app: FastifyInstance, services: AdminServices): void {
  app.get('/auth/me', async (request) => {
    const context = await authenticateOperator(request, services);
    if (!context) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentification requise.');
    return describeOperator(context);
  });

  app.post(
    '/auth/login',
    { schema: { body: Type.Object({ email: Email, password: Password }, Strict) } },
    async (request, reply) => {
      const { email, password } = request.body as { email: string; password: string };
      const normalized = email.trim().toLowerCase();
      await limit(services, `login:ip:${request.ip}`, 30, 900);
      await limit(services, `login:account:${normalized}`, 5, 900);
      const [operator] = await services.platform
        .select()
        .from(schema.platformUsers)
        .where(eq(schema.platformUsers.emailNormalized, normalized))
        .limit(1);
      // Temps comparable que le compte existe ou non (empreinte factice).
      const valid =
        operator?.passwordHash && operator.status === 'active'
          ? await verifyPassword(operator.passwordHash, password)
          : (await verifyPassword(await dummyHash(), password), false);
      if (!operator || !valid) {
        await platformAudit(
          services.platform,
          request,
          operator
            ? {
                operator: {
                  id: operator.id,
                  email: operator.emailNormalized,
                  displayName: operator.displayName,
                  status: operator.status,
                },
              }
            : null,
          {
            action: 'platform.auth.login',
            targetType: 'platform_user',
            targetId: operator?.id ?? null,
            result: 'failed',
          },
        );
        throw INVALID_CREDENTIALS();
      }
      if (needsRehash(operator.passwordHash!)) {
        await services.platform
          .update(schema.platformUsers)
          .set({ passwordHash: await hashPassword(password), updatedAt: services.now() })
          .where(eq(schema.platformUsers.id, operator.id));
      }
      const session = await createSession(services, request, operator.id);
      setAdminCookie(reply, services, session.token, session.expiresAt);
      // Le second facteur est toujours exigé (ADM-002) : la session reste en attente.
      return { mfa_required: true };
    },
  );

  app.post(
    '/auth/mfa/verify',
    { schema: { body: Type.Object({ code: TotpCode }, Strict) } },
    async (request) => {
      const context = await authenticateOperator(request, services);
      if (!context || context.enrolling) {
        throw new ApiError(401, 'UNAUTHENTICATED', 'Authentification requise.');
      }
      await limit(services, `mfa:${context.session.id}`, 10, 900);
      const { code } = request.body as { code: string };
      const ok = await checkTotp(services, context.operator.id, code, false);
      await platformAudit(services.platform, request, context, {
        action: 'platform.auth.mfa_verify',
        targetType: 'platform_user',
        targetId: context.operator.id,
        result: ok ? 'success' : 'failed',
      });
      if (!ok) throw new ApiError(401, 'INVALID_MFA_CODE', 'Code invalide.');
      const now = services.now();
      await services.platform
        .update(schema.platformSessions)
        .set({ mfaVerifiedAt: now, authenticatedAt: now })
        .where(eq(schema.platformSessions.id, context.session.id));
      await services.platform
        .update(schema.platformUsers)
        .set({ lastLoginAt: now })
        .where(eq(schema.platformUsers.id, context.operator.id));
      return { ok: true };
    },
  );

  // Ressaisie du second facteur avant une action dangereuse (fenêtre courte).
  app.post(
    '/auth/reauthenticate',
    { schema: { body: Type.Object({ code: TotpCode }, Strict) } },
    async (request) => {
      const context = await authenticateOperator(request, services);
      if (!context || context.mfaPending) {
        throw new ApiError(401, 'UNAUTHENTICATED', 'Authentification requise.');
      }
      await limit(services, `mfa:${context.session.id}`, 10, 900);
      const { code } = request.body as { code: string };
      if (!(await checkTotp(services, context.operator.id, code, false))) {
        throw new ApiError(401, 'INVALID_MFA_CODE', 'Code invalide.');
      }
      await services.platform
        .update(schema.platformSessions)
        .set({ authenticatedAt: services.now() })
        .where(eq(schema.platformSessions.id, context.session.id));
      return { ok: true };
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    const context = await authenticateOperator(request, services);
    if (context) {
      await services.platform
        .update(schema.platformSessions)
        .set({ revokedAt: services.now(), revokeReason: 'logout' })
        .where(eq(schema.platformSessions.id, context.session.id));
      await platformAudit(services.platform, request, context, {
        action: 'platform.auth.logout',
        targetType: 'platform_user',
        targetId: context.operator.id,
        result: 'success',
      });
    }
    clearAdminCookie(reply, services);
    return { ok: true };
  });

  /**
   * Activation (premier accès ou facteurs réinitialisés) : code à usage unique remis hors
   * bande, nouveau mot de passe, puis enrôlement TOTP obligatoire avant tout droit.
   */
  app.post(
    '/auth/activate',
    {
      schema: {
        body: Type.Object({ email: Email, activation_code: Token, password: Password }, Strict),
      },
    },
    async (request, reply) => {
      const body = request.body as { email: string; activation_code: string; password: string };
      const normalized = body.email.trim().toLowerCase();
      await limit(services, `activate:ip:${request.ip}`, 20, 900);
      await limit(services, `activate:account:${normalized}`, 5, 900);
      const problem = passwordProblem(body.password, normalized);
      if (problem) {
        throw new ApiError(400, 'WEAK_PASSWORD', 'Mot de passe trop faible.', false, { problem });
      }
      const now = services.now();
      const passwordHash = await hashPassword(body.password);
      const secret = generateTotpSecret();
      const operatorId = await services.platform.transaction(async (tx) => {
        const [operator] = await tx
          .select()
          .from(schema.platformUsers)
          .where(eq(schema.platformUsers.emailNormalized, normalized))
          .for('update');
        if (!operator || operator.status !== 'pending') return null;
        const consumed = await tx
          .update(schema.platformActivationTokens)
          .set({ usedAt: now })
          .where(
            and(
              eq(schema.platformActivationTokens.platformUserId, operator.id),
              eq(schema.platformActivationTokens.tokenHash, tokenHash(body.activation_code)),
              isNull(schema.platformActivationTokens.usedAt),
              gt(schema.platformActivationTokens.expiresAt, now),
            ),
          )
          .returning({ id: schema.platformActivationTokens.id });
        if (consumed.length !== 1) return null;
        await tx
          .update(schema.platformUsers)
          .set({ passwordHash, updatedAt: now })
          .where(eq(schema.platformUsers.id, operator.id));
        await tx
          .update(schema.platformMfaCredentials)
          .set({ revokedAt: now })
          .where(
            and(
              eq(schema.platformMfaCredentials.platformUserId, operator.id),
              isNull(schema.platformMfaCredentials.revokedAt),
            ),
          );
        await tx.insert(schema.platformMfaCredentials).values({
          platformUserId: operator.id,
          encryptedSecret: services.cipher.encrypt(secret, PLATFORM_TOTP_CONTEXT),
        });
        return operator.id;
      });
      if (!operatorId) {
        await platformAudit(services.platform, request, null, {
          action: 'platform.auth.activate',
          result: 'failed',
        });
        throw new ApiError(400, 'INVALID_ACTIVATION', 'Code d’activation invalide ou expiré.');
      }
      const session = await createSession(services, request, operatorId);
      setAdminCookie(reply, services, session.token, session.expiresAt);
      return { secret, otpauth_uri: otpauthUri(secret, `admin:${normalized}`) };
    },
  );

  // Fin d’activation : le premier code TOTP valide active le compte et la session.
  app.post(
    '/auth/activate/confirm',
    { schema: { body: Type.Object({ code: TotpCode }, Strict) } },
    async (request) => {
      const context = await authenticateOperator(request, services);
      if (!context || !context.enrolling) {
        throw new ApiError(401, 'UNAUTHENTICATED', 'Authentification requise.');
      }
      await limit(services, `mfa:${context.session.id}`, 10, 900);
      const { code } = request.body as { code: string };
      if (!(await checkTotp(services, context.operator.id, code, true))) {
        throw new ApiError(401, 'INVALID_MFA_CODE', 'Code invalide.');
      }
      const now = services.now();
      await services.platform.transaction(async (tx) => {
        await tx
          .update(schema.platformUsers)
          .set({ status: 'active', lastLoginAt: now, updatedAt: now })
          .where(eq(schema.platformUsers.id, context.operator.id));
        await tx
          .update(schema.platformSessions)
          .set({ mfaVerifiedAt: now, authenticatedAt: now })
          .where(eq(schema.platformSessions.id, context.session.id));
        await platformAudit(tx, request, context, {
          action: 'platform.auth.activated',
          targetType: 'platform_user',
          targetId: context.operator.id,
          result: 'success',
        });
      });
      return { ok: true };
    },
  );
}
