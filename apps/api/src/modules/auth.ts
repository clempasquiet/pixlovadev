import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Type from 'typebox';
import { schema, type Database, type Transaction } from '@pixlova/db';
import { ApiError } from '../errors.js';
import {
  authenticate,
  clearSessionCookie,
  normalizeEmail,
  rateLimit,
  requestMeta,
  requireRecentAuth,
  requireUser,
  setSessionCookie,
  type AuthContext,
} from '../http/context.js';
import type { Services } from '../http/services.js';
import { audit } from '../lib/audit.js';
import { randomToken, tokenHash } from '../lib/crypto.js';
import { queueEmail } from '../lib/email.js';
import {
  dummyHash,
  hashPassword,
  needsRehash,
  passwordProblem,
  verifyPassword,
} from '../lib/password.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../lib/totp.js';
import { Email, Password, RecoveryCode, Strict, Token, TotpCode, Uuid } from './schemas.js';

const TOTP_CONTEXT = 'mfa_totp_secret';

function link(services: Services, path: string, token: string): string {
  return `${services.security.appBaseUrl.replace(/\/$/, '')}${path}?token=${encodeURIComponent(token)}`;
}

function assertPassword(password: string, email: string): void {
  const problem = passwordProblem(password, email);
  if (problem) {
    throw new ApiError(
      422,
      'WEAK_PASSWORD',
      'Mot de passe refusé : 12 caractères minimum, sans reprendre l’adresse email.',
      false,
      {
        reason: problem,
      },
    );
  }
}

async function issueToken(
  tx: Transaction | Database,
  userId: string,
  purpose: 'email_verification' | 'password_reset',
  ttlMs: number,
  now: Date,
): Promise<string> {
  const token = randomToken();
  // Un nouveau jeton invalide les précédents du même usage.
  await tx
    .update(schema.authTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(schema.authTokens.userId, userId),
        eq(schema.authTokens.purpose, purpose),
        isNull(schema.authTokens.usedAt),
      ),
    );
  await tx.insert(schema.authTokens).values({
    userId,
    purpose,
    tokenHash: tokenHash(token),
    expiresAt: new Date(now.getTime() + ttlMs),
  });
  return token;
}

/** Consommation atomique : un jeton ne sert qu’une fois, même sous requêtes concurrentes. */
async function consumeToken(
  tx: Transaction,
  token: string,
  purpose: 'email_verification' | 'password_reset',
  now: Date,
): Promise<string | null> {
  const [row] = await tx
    .update(schema.authTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(schema.authTokens.tokenHash, tokenHash(token)),
        eq(schema.authTokens.purpose, purpose),
        isNull(schema.authTokens.usedAt),
        gt(schema.authTokens.expiresAt, now),
      ),
    )
    .returning({ userId: schema.authTokens.userId });
  return row?.userId ?? null;
}

async function createSession(
  services: Services,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  mfaVerified: boolean,
): Promise<void> {
  const now = services.now();
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + services.security.sessionAbsoluteDays * 86_400_000);
  await services.db.insert(schema.userSessions).values({
    userId,
    tokenHash: tokenHash(token),
    createdAt: now,
    lastSeenAt: now,
    idleExpiresAt: new Date(now.getTime() + services.security.sessionIdleHours * 3_600_000),
    expiresAt,
    authenticatedAt: now,
    mfaVerifiedAt: mfaVerified ? now : null,
    ip: request.ip ?? null,
    userAgent: request.headers['user-agent']?.slice(0, 300) ?? null,
  });
  setSessionCookie(reply, services, token, expiresAt);
}

async function revokeSessions(
  tx: Transaction | Database,
  userId: string,
  now: Date,
  reason: string,
  exceptSessionId?: string,
) {
  await tx
    .update(schema.userSessions)
    .set({ revokedAt: now, revokeReason: reason })
    .where(
      and(
        eq(schema.userSessions.userId, userId),
        isNull(schema.userSessions.revokedAt),
        exceptSessionId ? ne(schema.userSessions.id, exceptSessionId) : undefined,
      ),
    );
}

async function accountAudit(
  services: Services,
  request: FastifyRequest,
  userId: string | null,
  action: string,
  result: 'success' | 'denied' | 'failed',
  reason?: string,
) {
  await audit(services.system, {
    organizationId: null,
    actorType: 'user',
    actorId: userId,
    action,
    targetType: 'user',
    targetId: userId,
    result,
    reason: reason ?? null,
    ...requestMeta(request),
  });
}

function publicUser(auth: AuthContext) {
  return {
    id: auth.user.id,
    email: auth.user.email,
    display_name: auth.user.displayName,
    mfa_enabled: auth.user.mfaEnabled,
  };
}

/** Vérifie un code TOTP ou de secours pour l’utilisateur ; marque le code consommé. */
async function verifySecondFactor(
  services: Services,
  userId: string,
  input: { code?: string; recovery_code?: string },
): Promise<boolean> {
  return services.db.transaction(async (tx) => {
    if (input.recovery_code) {
      const [used] = await tx
        .update(schema.mfaRecoveryCodes)
        .set({ usedAt: services.now() })
        .where(
          and(
            eq(schema.mfaRecoveryCodes.userId, userId),
            eq(schema.mfaRecoveryCodes.codeHash, tokenHash(input.recovery_code)),
            isNull(schema.mfaRecoveryCodes.usedAt),
          ),
        )
        .returning({ id: schema.mfaRecoveryCodes.id });
      return Boolean(used);
    }
    const [credential] = await tx
      .select()
      .from(schema.mfaCredentials)
      .where(and(eq(schema.mfaCredentials.userId, userId), isNull(schema.mfaCredentials.revokedAt)))
      .for('update');
    if (!credential?.confirmedAt || !input.code) return false;
    const secret = services.cipher.decrypt(credential.encryptedSecret, TOTP_CONTEXT);
    const step = verifyTotp(secret, input.code, services.now().getTime(), credential.lastUsedStep);
    if (step === null) return false;
    await tx
      .update(schema.mfaCredentials)
      .set({ lastUsedStep: step })
      .where(eq(schema.mfaCredentials.id, credential.id));
    return true;
  });
}

const SecondFactor = Type.Object(
  { code: Type.Optional(TotpCode), recovery_code: Type.Optional(RecoveryCode) },
  Strict,
);

export function authRoutes(app: FastifyInstance, services: Services): void {
  app.post(
    '/auth/register',
    {
      schema: {
        body: Type.Object(
          {
            email: Email,
            password: Password,
            display_name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
          },
          Strict,
        ),
      },
    },
    async (request, reply) => {
      const body = request.body as { email: string; password: string; display_name?: string };
      await rateLimit(services, `register:ip:${request.ip}`, 10, 3600);
      const email = normalizeEmail(body.email);
      assertPassword(body.password, email);
      const now = services.now();
      const passwordHash = await hashPassword(body.password);
      await services.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(schema.users)
          .where(eq(schema.users.emailNormalized, email))
          .for('update');
        if (existing?.emailVerifiedAt) {
          // Anti-énumération : même réponse, le titulaire est prévenu par email.
          await queueEmail(tx, services.cipher, {
            template: 'account_exists',
            to: email,
            data: {
              loginLink: `${services.security.appBaseUrl}/login`,
              resetLink: `${services.security.appBaseUrl}/password-reset`,
            },
          });
          return;
        }
        let userId: string;
        if (existing) {
          // Compte jamais vérifié : la nouvelle inscription remplace le mot de passe non prouvé.
          await tx
            .update(schema.users)
            .set({
              passwordHash,
              displayName: body.display_name ?? existing.displayName,
              updatedAt: now,
            })
            .where(eq(schema.users.id, existing.id));
          userId = existing.id;
        } else {
          const [created] = await tx
            .insert(schema.users)
            .values({
              emailNormalized: email,
              passwordHash,
              displayName: body.display_name ?? null,
              passwordChangedAt: now,
            })
            .returning({ id: schema.users.id });
          userId = created!.id;
        }
        const token = await issueToken(
          tx,
          userId,
          'email_verification',
          services.security.emailVerificationHours * 3_600_000,
          now,
        );
        await queueEmail(tx, services.cipher, {
          template: 'email_verification',
          to: email,
          data: { link: link(services, '/verify-email', token) },
        });
      });
      return reply.status(202).send({ status: 'pending_verification' });
    },
  );

  app.post(
    '/auth/verify-email',
    { schema: { body: Type.Object({ token: Token }, Strict) } },
    async (request) => {
      const { token } = request.body as { token: string };
      await rateLimit(services, `verify:ip:${request.ip}`, 30, 3600);
      const now = services.now();
      const userId = await services.db.transaction(async (tx) => {
        const id = await consumeToken(tx, token, 'email_verification', now);
        if (id)
          await tx
            .update(schema.users)
            .set({ emailVerifiedAt: now, updatedAt: now })
            .where(eq(schema.users.id, id));
        return id;
      });
      if (!userId) throw new ApiError(400, 'TOKEN_INVALID', 'Lien invalide ou expiré.');
      await accountAudit(services, request, userId, 'auth.email_verified', 'success');
      return { status: 'verified' };
    },
  );

  app.post(
    '/auth/verify-email/resend',
    { schema: { body: Type.Object({ email: Email }, Strict) } },
    async (request, reply) => {
      const email = normalizeEmail((request.body as { email: string }).email);
      await rateLimit(services, `verify-resend:${email}`, 3, 3600);
      await rateLimit(services, `verify-resend:ip:${request.ip}`, 20, 3600);
      await services.db.transaction(async (tx) => {
        const [user] = await tx
          .select()
          .from(schema.users)
          .where(eq(schema.users.emailNormalized, email));
        if (!user || user.emailVerifiedAt) return;
        const token = await issueToken(
          tx,
          user.id,
          'email_verification',
          services.security.emailVerificationHours * 3_600_000,
          services.now(),
        );
        await queueEmail(tx, services.cipher, {
          template: 'email_verification',
          to: email,
          data: { link: link(services, '/verify-email', token) },
        });
      });
      return reply.status(202).send({ status: 'accepted' });
    },
  );

  app.post(
    '/auth/login',
    { schema: { body: Type.Object({ email: Email, password: Password }, Strict) } },
    async (request, reply) => {
      const body = request.body as { email: string; password: string };
      const email = normalizeEmail(body.email);
      await rateLimit(services, `login:ip:${request.ip}`, 50, 900);
      await rateLimit(services, `login:account:${email}`, 10, 900);
      const [user] = await services.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.emailNormalized, email));
      // Temps comparable que le compte existe ou non (SEC-002).
      const valid = await verifyPassword(user?.passwordHash ?? (await dummyHash()), body.password);
      if (!user || !valid || user.status !== 'active') {
        await accountAudit(
          services,
          request,
          user?.id ?? null,
          'auth.login',
          'denied',
          'INVALID_CREDENTIALS',
        );
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Adresse email ou mot de passe incorrect.');
      }
      if (!user.emailVerifiedAt) {
        throw new ApiError(
          403,
          'EMAIL_NOT_VERIFIED',
          'Confirmez votre adresse email avant de vous connecter.',
        );
      }
      if (needsRehash(user.passwordHash!)) {
        await services.db
          .update(schema.users)
          .set({ passwordHash: await hashPassword(body.password) })
          .where(eq(schema.users.id, user.id));
      }
      await createSession(services, request, reply, user.id, !user.mfaEnabled);
      await accountAudit(services, request, user.id, 'auth.login', 'success');
      return {
        user: {
          id: user.id,
          email: user.emailNormalized,
          display_name: user.displayName,
          mfa_enabled: user.mfaEnabled,
        },
        mfa_required: user.mfaEnabled,
      };
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    const auth = await authenticate(request, services);
    if (auth) {
      await services.db
        .update(schema.userSessions)
        .set({ revokedAt: services.now(), revokeReason: 'logout' })
        .where(eq(schema.userSessions.id, auth.session.id));
    }
    clearSessionCookie(reply, services);
    return reply.status(204).send();
  });

  app.get('/auth/me', async (request) => {
    const auth = await requireUser(request, services, { allowMfaPending: true });
    if (auth.mfaPending) return { user: publicUser(auth), mfa_pending: true, organizations: [] };
    // Liste inter-tenants de ses propres appartenances : opération système nommée.
    const organizations = await services.system
      .select({
        id: schema.organizations.id,
        name: schema.organizations.name,
        slug: schema.organizations.slug,
        roles: sql<
          string[]
        >`array_agg(distinct ${schema.membershipGrants.roleKey}) filter (where ${schema.membershipGrants.roleKey} is not null)`,
      })
      .from(schema.memberships)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.memberships.organizationId),
      )
      .leftJoin(
        schema.membershipGrants,
        eq(schema.membershipGrants.membershipId, schema.memberships.id),
      )
      .where(
        and(
          eq(schema.memberships.userId, auth.user.id),
          eq(schema.memberships.status, 'active'),
          eq(schema.organizations.status, 'active'),
        ),
      )
      .groupBy(schema.organizations.id)
      .orderBy(schema.organizations.name);
    return {
      user: publicUser(auth),
      mfa_pending: false,
      organizations: organizations.map((o) => ({ ...o, roles: o.roles ?? [] })),
    };
  });

  app.get('/auth/sessions', async (request) => {
    const auth = await requireUser(request, services);
    const rows = await services.db
      .select()
      .from(schema.userSessions)
      .where(
        and(
          eq(schema.userSessions.userId, auth.user.id),
          isNull(schema.userSessions.revokedAt),
          gt(schema.userSessions.expiresAt, services.now()),
        ),
      )
      .orderBy(desc(schema.userSessions.lastSeenAt));
    return {
      items: rows.map((s) => ({
        id: s.id,
        created_at: s.createdAt.toISOString(),
        last_seen_at: s.lastSeenAt.toISOString(),
        ip: s.ip,
        user_agent: s.userAgent,
        current: s.id === auth.session.id,
      })),
    };
  });

  app.delete(
    '/auth/sessions/:id',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request, reply) => {
      const auth = await requireUser(request, services);
      const { id } = request.params as { id: string };
      const revoked = await services.db
        .update(schema.userSessions)
        .set({ revokedAt: services.now(), revokeReason: 'user_revoked' })
        .where(
          and(
            eq(schema.userSessions.id, id),
            eq(schema.userSessions.userId, auth.user.id),
            isNull(schema.userSessions.revokedAt),
          ),
        )
        .returning({ id: schema.userSessions.id });
      if (revoked.length === 0)
        throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Session introuvable.');
      await accountAudit(services, request, auth.user.id, 'auth.session_revoked', 'success');
      return reply.status(204).send();
    },
  );

  app.post('/auth/sessions/revoke-all', async (request, reply) => {
    const auth = await requireUser(request, services);
    await revokeSessions(
      services.db,
      auth.user.id,
      services.now(),
      'user_revoked_all',
      auth.session.id,
    );
    await accountAudit(services, request, auth.user.id, 'auth.sessions_revoked_all', 'success');
    return reply.status(204).send();
  });

  app.post(
    '/auth/password-reset/request',
    { schema: { body: Type.Object({ email: Email }, Strict) } },
    async (request, reply) => {
      const email = normalizeEmail((request.body as { email: string }).email);
      await rateLimit(services, `reset:ip:${request.ip}`, 20, 3600);
      await rateLimit(services, `reset:account:${email}`, 5, 3600);
      await services.db.transaction(async (tx) => {
        const [user] = await tx
          .select()
          .from(schema.users)
          .where(eq(schema.users.emailNormalized, email));
        if (!user || user.status !== 'active') return;
        const token = await issueToken(
          tx,
          user.id,
          'password_reset',
          services.security.passwordResetMinutes * 60_000,
          services.now(),
        );
        await queueEmail(tx, services.cipher, {
          template: 'password_reset',
          to: email,
          data: { link: link(services, '/password-reset/confirm', token) },
        });
      });
      // Réponse identique que le compte existe ou non.
      return reply.status(202).send({ status: 'accepted' });
    },
  );

  app.post(
    '/auth/password-reset/confirm',
    { schema: { body: Type.Object({ token: Token, password: Password }, Strict) } },
    async (request) => {
      const body = request.body as { token: string; password: string };
      await rateLimit(services, `reset-confirm:ip:${request.ip}`, 20, 3600);
      const now = services.now();
      const passwordHash = await hashPassword(body.password);
      const userId = await services.db.transaction(async (tx) => {
        const id = await consumeToken(tx, body.token, 'password_reset', now);
        if (!id) return null;
        const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, id));
        assertPassword(body.password, user!.emailNormalized);
        // Le lien email prouve aussi la possession de l’adresse.
        await tx
          .update(schema.users)
          .set({
            passwordHash,
            passwordChangedAt: now,
            emailVerifiedAt: user!.emailVerifiedAt ?? now,
            updatedAt: now,
          })
          .where(eq(schema.users.id, id));
        // La réinitialisation ferme toutes les sessions ; la MFA reste exigée à la connexion suivante.
        await revokeSessions(tx, id, now, 'password_reset');
        await queueEmail(tx, services.cipher, {
          template: 'password_changed',
          to: user!.emailNormalized,
          data: {},
        });
        return id;
      });
      if (!userId) throw new ApiError(400, 'TOKEN_INVALID', 'Lien invalide ou expiré.');
      await accountAudit(services, request, userId, 'auth.password_reset', 'success');
      return { status: 'password_changed' };
    },
  );

  app.post(
    '/auth/password/change',
    {
      schema: { body: Type.Object({ current_password: Password, new_password: Password }, Strict) },
    },
    async (request) => {
      const auth = await requireUser(request, services);
      const body = request.body as { current_password: string; new_password: string };
      await rateLimit(services, `password-change:${auth.user.id}`, 10, 900);
      const [user] = await services.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, auth.user.id));
      if (!(await verifyPassword(user!.passwordHash ?? '', body.current_password))) {
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Mot de passe actuel incorrect.');
      }
      assertPassword(body.new_password, auth.user.email);
      const now = services.now();
      const passwordHash = await hashPassword(body.new_password);
      await services.db.transaction(async (tx) => {
        await tx
          .update(schema.users)
          .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
          .where(eq(schema.users.id, auth.user.id));
        await revokeSessions(tx, auth.user.id, now, 'password_changed', auth.session.id);
        await tx
          .update(schema.userSessions)
          .set({ authenticatedAt: now })
          .where(eq(schema.userSessions.id, auth.session.id));
        await queueEmail(tx, services.cipher, {
          template: 'password_changed',
          to: auth.user.email,
          data: {},
        });
      });
      await accountAudit(services, request, auth.user.id, 'auth.password_changed', 'success');
      return { status: 'password_changed' };
    },
  );

  app.post(
    '/auth/reauthenticate',
    { schema: { body: Type.Object({ password: Password }, Strict) } },
    async (request) => {
      const auth = await requireUser(request, services);
      await rateLimit(services, `reauth:${auth.user.id}`, 10, 900);
      const [user] = await services.db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, auth.user.id));
      if (
        !(await verifyPassword(
          user!.passwordHash ?? '',
          (request.body as { password: string }).password,
        ))
      ) {
        await accountAudit(services, request, auth.user.id, 'auth.reauthenticate', 'denied');
        throw new ApiError(401, 'INVALID_CREDENTIALS', 'Mot de passe incorrect.');
      }
      await services.db
        .update(schema.userSessions)
        .set({ authenticatedAt: services.now() })
        .where(eq(schema.userSessions.id, auth.session.id));
      return { status: 'reauthenticated' };
    },
  );

  // --- MFA TOTP (IAM-007) ---------------------------------------------------

  app.post('/auth/mfa/enroll', async (request) => {
    const auth = await requireUser(request, services);
    requireRecentAuth(auth, services);
    if (auth.user.mfaEnabled)
      throw new ApiError(409, 'MFA_ALREADY_ENABLED', 'La double authentification est déjà active.');
    const secret = generateTotpSecret();
    await services.db.transaction(async (tx) => {
      await tx
        .update(schema.mfaCredentials)
        .set({ revokedAt: services.now() })
        .where(
          and(
            eq(schema.mfaCredentials.userId, auth.user.id),
            isNull(schema.mfaCredentials.revokedAt),
          ),
        );
      await tx.insert(schema.mfaCredentials).values({
        userId: auth.user.id,
        type: 'totp',
        encryptedSecret: services.cipher.encrypt(secret, TOTP_CONTEXT),
      });
    });
    return { secret, otpauth_uri: otpauthUri(secret, auth.user.email) };
  });

  app.post(
    '/auth/mfa/confirm',
    { schema: { body: Type.Object({ code: TotpCode }, Strict) } },
    async (request) => {
      const auth = await requireUser(request, services);
      await rateLimit(services, `mfa:${auth.session.id}`, 10, 900);
      const now = services.now();
      const recoveryCodes = Array.from({ length: 10 }, () => {
        const raw = randomToken(8)
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '')
          .padEnd(10, '0')
          .slice(0, 10);
        return `${raw.slice(0, 5)}-${raw.slice(5)}`;
      });
      const confirmed = await services.db.transaction(async (tx) => {
        const [credential] = await tx
          .select()
          .from(schema.mfaCredentials)
          .where(
            and(
              eq(schema.mfaCredentials.userId, auth.user.id),
              isNull(schema.mfaCredentials.revokedAt),
              isNull(schema.mfaCredentials.confirmedAt),
            ),
          )
          .for('update');
        if (!credential) return false;
        const secret = services.cipher.decrypt(credential.encryptedSecret, TOTP_CONTEXT);
        const step = verifyTotp(
          secret,
          (request.body as { code: string }).code,
          now.getTime(),
          null,
        );
        if (step === null) return false;
        await tx
          .update(schema.mfaCredentials)
          .set({ confirmedAt: now, lastUsedStep: step })
          .where(eq(schema.mfaCredentials.id, credential.id));
        await tx
          .update(schema.users)
          .set({ mfaEnabled: true, updatedAt: now })
          .where(eq(schema.users.id, auth.user.id));
        await tx
          .update(schema.mfaRecoveryCodes)
          .set({ usedAt: now })
          .where(
            and(
              eq(schema.mfaRecoveryCodes.userId, auth.user.id),
              isNull(schema.mfaRecoveryCodes.usedAt),
            ),
          );
        await tx
          .insert(schema.mfaRecoveryCodes)
          .values(
            recoveryCodes.map((code) => ({ userId: auth.user.id, codeHash: tokenHash(code) })),
          );
        await tx
          .update(schema.userSessions)
          .set({ mfaVerifiedAt: now })
          .where(eq(schema.userSessions.id, auth.session.id));
        await queueEmail(tx, services.cipher, {
          template: 'mfa_changed',
          to: auth.user.email,
          data: { enabled: true },
        });
        return true;
      });
      if (!confirmed) throw new ApiError(400, 'MFA_INVALID', 'Code invalide.');
      await accountAudit(services, request, auth.user.id, 'auth.mfa_enabled', 'success');
      // Codes de secours affichés une seule fois ; seules leurs empreintes sont conservées.
      return { status: 'enabled', recovery_codes: recoveryCodes };
    },
  );

  app.post('/auth/mfa/verify', { schema: { body: SecondFactor } }, async (request) => {
    const auth = await requireUser(request, services, { allowMfaPending: true });
    await rateLimit(services, `mfa:${auth.session.id}`, 10, 900);
    const body = request.body as { code?: string; recovery_code?: string };
    if (!(await verifySecondFactor(services, auth.user.id, body))) {
      await accountAudit(services, request, auth.user.id, 'auth.mfa_verify', 'denied');
      throw new ApiError(400, 'MFA_INVALID', 'Code invalide.');
    }
    await services.db
      .update(schema.userSessions)
      .set({ mfaVerifiedAt: services.now() })
      .where(eq(schema.userSessions.id, auth.session.id));
    await accountAudit(
      services,
      request,
      auth.user.id,
      body.recovery_code ? 'auth.mfa_recovery_code_used' : 'auth.mfa_verify',
      'success',
    );
    return { status: 'verified' };
  });

  app.post('/auth/mfa/disable', { schema: { body: SecondFactor } }, async (request) => {
    const auth = await requireUser(request, services);
    requireRecentAuth(auth, services);
    await rateLimit(services, `mfa:${auth.session.id}`, 10, 900);
    if (
      !(await verifySecondFactor(
        services,
        auth.user.id,
        request.body as { code?: string; recovery_code?: string },
      ))
    ) {
      throw new ApiError(400, 'MFA_INVALID', 'Code invalide.');
    }
    const now = services.now();
    await services.db.transaction(async (tx) => {
      await tx
        .update(schema.mfaCredentials)
        .set({ revokedAt: now })
        .where(
          and(
            eq(schema.mfaCredentials.userId, auth.user.id),
            isNull(schema.mfaCredentials.revokedAt),
          ),
        );
      await tx
        .update(schema.mfaRecoveryCodes)
        .set({ usedAt: now })
        .where(
          and(
            eq(schema.mfaRecoveryCodes.userId, auth.user.id),
            isNull(schema.mfaRecoveryCodes.usedAt),
          ),
        );
      await tx
        .update(schema.users)
        .set({ mfaEnabled: false, updatedAt: now })
        .where(eq(schema.users.id, auth.user.id));
      await queueEmail(tx, services.cipher, {
        template: 'mfa_changed',
        to: auth.user.email,
        data: { enabled: false },
      });
    });
    await accountAudit(services, request, auth.user.id, 'auth.mfa_disabled', 'success');
    return { status: 'disabled' };
  });
}
