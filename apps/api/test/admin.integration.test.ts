/**
 * Administration plateforme (L09-A, ADR-016) sur PostgreSQL réel : identités séparées,
 * TOTP obligatoire, contrôle serveur de chaque permission, motifs et audit, actions de
 * support bornées, gestion des opérateurs et séparation stricte des listeners.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@pixlova/db';
import { skipDatabaseTests } from '@pixlova/db/testing';
import type { PlatformRole } from '@pixlova/permissions';
import { buildAdminApp } from '../src/admin/app.js';
import { createOperator } from '../src/admin/operators.js';
import type { AdminServices } from '../src/admin/services.js';
import { buildPublicApp } from '../src/app.js';
import { DataCipher } from '../src/lib/crypto.js';
import { MemoryRateLimiter } from '../src/lib/rate-limit.js';
import {
  createHarness,
  createOrganization,
  PASSWORD,
  signUp,
  totpNow,
  type Client,
  type Harness,
} from './support/harness.js';
import { ADMIN_ORIGIN, Operator, OPERATOR_PASSWORD, REASON } from './support/operator.js';

describe.skipIf(skipDatabaseTests)('administration plateforme (L09-A)', () => {
  let h: Harness;
  let admin: FastifyInstance;
  let services: AdminServices;
  let consoleDir: string;
  let root: Operator;
  let customer: Client;
  let organizationId: string;

  async function newOperator(email: string, roles: PlatformRole[]): Promise<Operator> {
    const issued = await createOperator(
      h.database.platform,
      { email, displayName: email.split('@')[0]!, roles },
      null,
      h.clock.now,
      24,
    );
    const operator = new Operator(admin, h, email);
    await operator.activate(issued.activationCode);
    return operator;
  }

  async function platformAudit(action: string) {
    return h.database.system.execute(
      sql`SELECT organization_id, actor_type, actor_id, target_id, result, reason, metadata
          FROM audit_logs WHERE action = ${action} ORDER BY created_at`,
    );
  }

  beforeAll(async () => {
    h = await createHarness();
    consoleDir = await mkdtemp(join(tmpdir(), 'pixlova-admin-console-'));
    await writeFile(join(consoleDir, 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(join(consoleDir, 'app.js'), 'console.log(1)');
    services = {
      platform: h.database.platform,
      cipher: new DataCipher([{ kid: 'test', key: randomBytes(32) }]),
      limiter: new MemoryRateLimiter(() => h.clock.now.getTime()),
      entitlements: h.services.entitlements,
      config: {
        allowedOrigins: [ADMIN_ORIGIN],
        cookieSecure: true,
        sessionIdleMinutes: 30,
        sessionAbsoluteHours: 8,
        recentAuthMinutes: 5,
        activationHours: 24,
        presenceTimeoutSeconds: 90,
      },
      releaseTrust: new Map(),
      now: () => h.clock.now,
    };
    admin = buildAdminApp({ services, consoleDir });
    await admin.ready();
    root = await newOperator('root@pixlova.test', ['super_admin']);
    customer = await signUp(h, 'owner@client.test');
    organizationId = (await createOrganization(customer, 'Boulangerie Martin')).id;
  });

  afterAll(async () => {
    await admin?.close();
    await h?.close();
    await rm(consoleDir, { recursive: true, force: true });
  });

  describe('séparation des listeners (ADM-001)', () => {
    it('le listener public ne sert ni n’accepte aucune route d’administration', async () => {
      expect((await h.app.inject({ method: 'GET', url: '/admin-api/v1/auth/me' })).statusCode).toBe(
        404,
      );
      const pub = buildPublicApp();
      expect(() => pub.get('/admin-api/v1/x', async () => ({}))).toThrow(/interdite/);
      await pub.close();
    });

    it('l’administration ne sert ni le dashboard, ni les Players, ni le listener interne', async () => {
      for (const url of ['/api/v1/auth/me', '/player/v1/register', '/internal/v1/metrics']) {
        const response = await admin.inject({ method: 'GET', url });
        expect(response.headers['content-type']).toMatch(/text\/html/); // console, pas l’API
        expect(response.body).not.toMatch(/"status"|metrics/);
      }
      const fresh = buildAdminApp({ services });
      expect(() => fresh.get('/api/v1/x', async () => ({}))).toThrow(/interdite/);
      expect(() => fresh.get('/internal/v1/x', async () => ({}))).toThrow(/interdite/);
      await fresh.close();
    });

    it('sert la console sans sortir de son répertoire, avec une CSP stricte', async () => {
      const home = await admin.inject({ method: 'GET', url: '/organizations' });
      expect(home.body).toContain('<div id="root">');
      expect(home.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
      expect((await admin.inject({ method: 'GET', url: '/app.js' })).body).toBe('console.log(1)');
      const escape = await admin.inject({ method: 'GET', url: '/..%2F..%2F..%2Fetc%2Fpasswd' });
      expect(escape.body).not.toContain('root:');
      const unknown = await admin.inject({ method: 'GET', url: '/admin-api/v1/inconnu' });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().error.code).toBe('RESOURCE_NOT_FOUND');
    });
  });

  describe('identités et authentification (ADM-002)', () => {
    it('un compte client, même Owner, n’ouvre aucune session plateforme', async () => {
      const asCustomer = new Operator(admin, h, 'owner@client.test');
      const login = await asCustomer.post('/auth/login', {
        email: 'owner@client.test',
        password: PASSWORD,
      });
      expect(login.statusCode).toBe(401);
      // Le cookie client n’est pas reconnu par l’administration.
      const me = await admin.inject({
        method: 'GET',
        url: '/admin-api/v1/auth/me',
        headers: { cookie: customer.cookie! },
      });
      expect(me.statusCode).toBe(401);
    });

    it('activation à usage unique, mot de passe robuste, TOTP obligatoire avant tout droit', async () => {
      const issued = await createOperator(
        h.database.platform,
        { email: 'ops@pixlova.test', displayName: 'Ops', roles: ['operations'] },
        null,
        h.clock.now,
        24,
      );
      const ops = new Operator(admin, h, 'ops@pixlova.test');
      const weak = await ops.post('/auth/activate', {
        email: ops.email,
        activation_code: issued.activationCode,
        password: 'court',
      });
      expect(weak.json().error.code).toBe('WEAK_PASSWORD');
      const wrong = await ops.post('/auth/activate', {
        email: ops.email,
        activation_code: 'x'.repeat(43),
        password: OPERATOR_PASSWORD,
      });
      expect(wrong.json().error.code).toBe('INVALID_ACTIVATION');
      const activated = await ops.post('/auth/activate', {
        email: ops.email,
        activation_code: issued.activationCode,
        password: OPERATOR_PASSWORD,
      });
      ops.secret = activated.json().secret;
      expect(activated.json().otpauth_uri).toMatch(/^otpauth:\/\/totp\/pixlova%3Aadmin%3Aops/);
      // Avant confirmation du TOTP : aucun droit.
      const me = (await ops.get('/auth/me')).json();
      expect(me.session.enrolling).toBe(true);
      expect(me.permissions).toEqual([]);
      expect((await ops.get('/health')).json().error.code).toBe('MFA_REQUIRED');
      // Le code d’activation ne sert qu’une fois.
      const again = await new Operator(admin, h, ops.email).post('/auth/activate', {
        email: ops.email,
        activation_code: issued.activationCode,
        password: OPERATOR_PASSWORD,
      });
      expect(again.json().error.code).toBe('INVALID_ACTIVATION');
      expect((await ops.post('/auth/activate/confirm', { code: ops.code() })).statusCode).toBe(200);
      expect((await ops.get('/health')).statusCode).toBe(200);
      // Le secret TOTP est chiffré au repos.
      const [stored] = await h.database.platform
        .select()
        .from(schema.platformMfaCredentials)
        .where(eq(schema.platformMfaCredentials.platformUserId, issued.operatorId));
      expect(stored!.encryptedSecret).not.toContain(ops.secret);
    });

    it('connexion : mot de passe puis TOTP, code non rejouable, session courte', async () => {
      const ops = await newOperator('ops2@pixlova.test', ['operations']);
      h.clock.advance(31_000);
      const fresh = new Operator(admin, h, ops.email);
      fresh.secret = ops.secret;
      const bad = await fresh.post('/auth/login', {
        email: ops.email,
        password: 'mauvais mot de passe long',
      });
      expect(bad.json().error.code).toBe('INVALID_CREDENTIALS');
      expect(
        (await fresh.post('/auth/login', { email: ops.email, password: OPERATOR_PASSWORD })).json(),
      ).toEqual({
        mfa_required: true,
      });
      expect((await fresh.get('/health')).json().error.code).toBe('MFA_REQUIRED');
      expect((await fresh.post('/auth/mfa/verify', { code: '000000' })).json().error.code).toBe(
        'INVALID_MFA_CODE',
      );
      const code = fresh.code();
      expect((await fresh.post('/auth/mfa/verify', { code })).statusCode).toBe(200);
      expect((await fresh.get('/health')).statusCode).toBe(200);
      // Le même code ne ressert pas (anti-rejeu).
      expect((await fresh.post('/auth/reauthenticate', { code })).json().error.code).toBe(
        'INVALID_MFA_CODE',
      );
      // Inactivité de 31 min : session expirée.
      h.clock.advance(31 * 60_000);
      expect((await fresh.get('/health')).statusCode).toBe(401);
    });

    it('refuse une requête modifiante sans origine autorisée (CSRF)', async () => {
      const response = await admin.inject({
        method: 'POST',
        url: '/admin-api/v1/auth/login',
        payload: { email: 'root@pixlova.test', password: OPERATOR_PASSWORD },
        headers: { origin: 'https://evil.test' },
      });
      expect(response.json().error.code).toBe('CSRF_REJECTED');
    });
  });

  describe('vues et motifs (ADM-003, ADM-004)', () => {
    it('chaque vue exige sa permission ; un refus est audité', async () => {
      const content = await newOperator('content@pixlova.test', ['content_admin']);
      expect((await content.get('/templates')).json().items.length).toBeGreaterThan(0);
      expect((await content.get('/organizations')).statusCode).toBe(403);
      expect((await content.get('/health')).statusCode).toBe(403);
      const denied = await platformAudit('platform.permission.denied');
      expect(denied.rows.some((r) => r.result === 'denied')).toBe(true);
    });

    it('la fiche d’une organisation exige un motif, masque les adresses et s’audite hors tenant', async () => {
      await root.login();
      const list = (await root.get('/organizations?q=Boulangerie')).json();
      expect(list.items).toHaveLength(1);
      expect(list.items[0]).toMatchObject({ name: 'Boulangerie Martin', members: 1 });
      expect((await root.get(`/organizations/${organizationId}`)).json().error.code).toBe(
        'REASON_REQUIRED',
      );
      const detail = (await root.get(`/organizations/${organizationId}`, REASON)).json();
      expect(detail.members[0].email).toBe('ow•••@client.test');
      expect(detail.members[0].roles).toEqual(['Owner']);
      expect(detail.entitlements).toMatchObject({ max_users: 1, display_slots: 1 });
      // Sans abonnement Stripe : la projection est vide, rien n’est inventé (ADR-017).
      expect(detail.subscription).toMatchObject({
        available: true,
        environment: 'test',
        customer: null,
        subscriptions: [],
        changes: [],
      });
      const fleet = (await root.get(`/organizations/${organizationId}/fleet`, REASON)).json();
      expect(fleet).toEqual({ players: [], displays: [], incidents: [] });

      const viewed = await platformAudit('platform.organization.viewed');
      expect(viewed.rows.at(-1)).toMatchObject({
        organization_id: null,
        actor_type: 'platform_user',
        target_id: organizationId,
        reason: REASON,
      });
      // Journal plateforme invisible du tenant.
      const tenantAudit = (await customer.get('/audit')).json();
      expect(JSON.stringify(tenantAudit)).not.toContain('platform.organization');
    });

    it('santé de la plateforme : mesures réelles', async () => {
      const health = (await root.get('/health')).json();
      expect(health.organizations).toBeGreaterThanOrEqual(1);
      expect(health.schema.migrations_applied).toBeGreaterThanOrEqual(17);
      expect(health.players).toEqual({ paired: 0, online: 0 });
    });
  });

  describe('facturation (BillingAdmin, ADM-004, BILL-019)', () => {
    it('BillingAdmin consulte abonnements et codes sans accès aux diagnostics ; le support ne voit pas la facturation', async () => {
      const billing = await newOperator('billing@pixlova.test', ['billing_admin']);
      const overview = await billing.get('/billing');
      expect(overview.statusCode).toBe(200);
      expect(overview.json()).toMatchObject({
        environment: 'test',
        subscriptions: [],
        promotion_codes: [],
        events: { failed: 0, pending: 0 },
        failed_events: [],
      });
      expect((await platformAudit('platform.billing.viewed')).rows).toHaveLength(1);
      const detail = (await billing.get(`/organizations/${organizationId}`, REASON)).json();
      expect(detail.subscription.available).toBe(true);
      expect((await billing.get(`/organizations/${organizationId}/fleet`, REASON)).statusCode).toBe(
        403,
      );
      const support = await newOperator('support-billing@pixlova.test', ['support']);
      expect((await support.get('/billing')).statusCode).toBe(403);
      const seen = (await support.get(`/organizations/${organizationId}`, REASON)).json();
      expect(seen.subscription.available).toBe(false);
    });
  });

  describe('actions de support bornées', () => {
    it('recherche exacte, révocation des sessions avec second facteur récent et audit avant/après', async () => {
      const support = await newOperator('support@pixlova.test', ['support']);
      const found = (await support.get('/customers?email=OWNER@client.test', REASON)).json()
        .customer;
      expect(found).toMatchObject({
        email: 'owner@client.test',
        active_sessions: 1,
        mfa_enabled: false,
      });
      expect(found.memberships[0]).toMatchObject({
        organization_name: 'Boulangerie Martin',
        roles: ['Owner'],
      });
      expect((await support.get('/customers?email=inconnu@client.test', REASON)).json()).toEqual({
        customer: null,
      });

      h.clock.advance(6 * 60_000);
      const stale = await support.post(`/customers/${found.id}/sessions/revoke`, {
        reason: REASON,
      });
      expect(stale.json().error.code).toBe('RECENT_AUTH_REQUIRED');
      expect(
        (await support.post('/auth/reauthenticate', { code: support.code() })).statusCode,
      ).toBe(200);
      const revoked = await support.post(`/customers/${found.id}/sessions/revoke`, {
        reason: REASON,
      });
      expect(revoked.json()).toMatchObject({
        revoked_sessions: 1,
        customer: { active_sessions: 0 },
      });
      expect((await customer.get('/auth/me')).statusCode).toBe(401);

      const [entry] = (await platformAudit('platform.customer.sessions_revoked')).rows;
      expect(entry).toMatchObject({ reason: REASON, target_id: found.id });
      expect(entry!.metadata).toMatchObject({
        before: { active_sessions: 1 },
        after: { active_sessions: 0 },
      });

      // Le support ne réinitialise pas un second facteur et ne gère pas l’équipe.
      expect(
        (
          await support.post(`/customers/${found.id}/mfa/reset`, {
            reason: REASON,
            confirm_email: found.email,
          })
        ).statusCode,
      ).toBe(403);
      expect((await support.get('/team')).statusCode).toBe(403);
    });

    it('réinitialisation du second facteur : confirmation de l’adresse, sessions fermées', async () => {
      const client = await signUp(h, 'mfa@client.test');
      h.clock.advance(60_000);
      const { secret } = (await client.post('/auth/mfa/enroll')).json();
      expect(
        (await client.post('/auth/mfa/confirm', { code: totpNow(secret, h) })).statusCode,
      ).toBe(200);
      const id = (await root.get('/customers?email=mfa@client.test', REASON)).json().customer.id;

      h.clock.advance(31_000);
      expect((await root.post('/auth/reauthenticate', { code: root.code() })).statusCode).toBe(200);
      const mismatch = await root.post(`/customers/${id}/mfa/reset`, {
        reason: REASON,
        confirm_email: 'autre@client.test',
      });
      expect(mismatch.json().error.code).toBe('CONFIRMATION_MISMATCH');
      const reset = await root.post(`/customers/${id}/mfa/reset`, {
        reason: REASON,
        confirm_email: 'mfa@client.test',
      });
      expect(reset.json().customer).toMatchObject({ mfa_enabled: false, active_sessions: 0 });
      expect((await client.get('/auth/me')).statusCode).toBe(401);
      const [entry] = (await platformAudit('platform.customer.mfa_reset')).rows;
      expect(entry!.metadata).toMatchObject({
        before: { mfa_enabled: true },
        after: { mfa_enabled: false },
      });
    });

    it('désactivation d’un compte client : connexion refusée, réactivation possible', async () => {
      const client = await signUp(h, 'off@client.test');
      const id = (await root.get('/customers?email=off@client.test', REASON)).json().customer.id;
      const disabled = await root.post(`/customers/${id}/status`, {
        status: 'disabled',
        reason: REASON,
        confirm_email: 'off@client.test',
      });
      expect(disabled.json().customer.status).toBe('disabled');
      expect((await client.get('/auth/me')).statusCode).toBe(401);
      expect(
        (await client.post('/auth/login', { email: 'off@client.test', password: PASSWORD }))
          .statusCode,
      ).not.toBe(200);
      const enabled = await root.post(`/customers/${id}/status`, {
        status: 'active',
        reason: REASON,
        confirm_email: 'off@client.test',
      });
      expect(enabled.json().customer.status).toBe('active');
      expect(
        (await client.post('/auth/login', { email: 'off@client.test', password: PASSWORD }))
          .statusCode,
      ).toBe(200);
    });

    it('relance d’une tâche en échec uniquement', async () => {
      const ops = await newOperator('ops3@pixlova.test', ['operations']);
      const inserted = await h.database.system.execute(
        sql`INSERT INTO jobs (organization_id, kind, dedupe_key, state, attempts, last_error, finished_at)
            VALUES (${organizationId}, 'media.ingest', 'media:x', 'failed', 5, 'ffprobe: échec', now())
            RETURNING id`,
      );
      const jobId = String(inserted.rows[0]!.id);
      const failed = (await ops.get('/jobs')).json().items;
      expect(failed.find((j: { id: string }) => j.id === jobId)).toMatchObject({
        kind: 'media.ingest',
        attempts: 5,
      });
      expect((await ops.post(`/jobs/${jobId}/retry`, { reason: 'x' })).statusCode).toBe(400);
      expect((await ops.post(`/jobs/${jobId}/retry`, { reason: REASON })).json()).toEqual({
        id: jobId,
        state: 'queued',
      });
      expect((await ops.post(`/jobs/${jobId}/retry`, { reason: REASON })).json().error.code).toBe(
        'JOB_NOT_FAILED',
      );
    });
  });

  describe('gestion des opérateurs', () => {
    it('création par code d’activation, rôles audités, pas d’auto-modification, dernier SuperAdmin protégé', async () => {
      h.clock.advance(31_000);
      expect((await root.post('/auth/reauthenticate', { code: root.code() })).statusCode).toBe(200);
      const created = await root.post('/team', {
        email: 'second@pixlova.test',
        display_name: 'Second',
        roles: ['super_admin'],
        reason: REASON,
      });
      expect(created.statusCode).toBe(201);
      const second = new Operator(admin, h, 'second@pixlova.test');
      await second.activate(created.json().activation_code);

      expect(
        (
          await root.put(`/team/${created.json().id}/roles`, { roles: ['support'], reason: REASON })
        ).json(),
      ).toMatchObject({ roles: ['support'] });
      const [changed] = (await platformAudit('platform.operator.roles_changed')).rows;
      expect(changed!.metadata).toMatchObject({
        before: { roles: ['super_admin'] },
        after: { roles: ['support'] },
      });

      const self = (await root.get('/auth/me')).json().operator.id;
      expect(
        (await root.put(`/team/${self}/roles`, { roles: ['support'], reason: REASON })).json().error
          .code,
      ).toBe('SELF_MODIFICATION');

      // Désactivation : sessions de l’opérateur révoquées immédiatement.
      expect((await second.get('/organizations')).statusCode).toBe(200);
      const off = await root.post(`/team/${created.json().id}/status`, {
        status: 'disabled',
        reason: REASON,
      });
      expect(off.json()).toMatchObject({ status: 'disabled' });
      expect((await second.get('/organizations')).statusCode).toBe(401);

      // Réactivation puis nouveau code : les anciens facteurs ne servent plus.
      await root.post(`/team/${created.json().id}/status`, { status: 'active', reason: REASON });
      const reissued = await root.post(`/team/${created.json().id}/activation`, { reason: REASON });
      expect(reissued.json().activation_code).toBeTruthy();
      const oldLogin = await new Operator(admin, h, second.email).post('/auth/login', {
        email: second.email,
        password: OPERATOR_PASSWORD,
      });
      expect(oldLogin.statusCode).toBe(401);

      const team = (await root.get('/team')).json();
      expect(team.items.map((o: { email: string }) => o.email)).toContain('second@pixlova.test');
      const audit = (await root.get('/audit')).json().items;
      expect(audit).toContainEqual(
        expect.objectContaining({
          actor_email: 'root@pixlova.test',
          action: 'platform.operator.roles_changed',
          reason: REASON,
        }),
      );
    });

    it('deux SuperAdmin qui se rétrogradent simultanément laissent un SuperAdmin actif', async () => {
      h.clock.advance(31_000);
      await root.post('/auth/reauthenticate', { code: root.code() });
      const created = (
        await root.post('/team', {
          email: 'third@pixlova.test',
          display_name: 'Third',
          roles: ['super_admin'],
          reason: REASON,
        })
      ).json();
      const third = new Operator(admin, h, 'third@pixlova.test');
      await third.activate(created.activation_code);
      const rootId = (await root.get('/auth/me')).json().operator.id;
      const results = await Promise.all([
        root.put(`/team/${created.id}/roles`, { roles: ['support'], reason: REASON }),
        third.put(`/team/${rootId}/roles`, { roles: ['support'], reason: REASON }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 403]);
      const remaining = await h.database.platform.execute(
        sql`SELECT count(*) AS n FROM platform_user_roles r JOIN platform_users u ON u.id = r.platform_user_id
            WHERE r.role = 'super_admin' AND u.status = 'active'`,
      );
      expect(Number(remaining.rows[0]!.n)).toBe(1);
    });
  });
});
