import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@pixlova/db';
import { skipDatabaseTests } from '@pixlova/db/testing';
import {
  Client,
  createHarness,
  createOrganization,
  lastLinkToken,
  PASSWORD,
  signUp,
  totpNow,
  type Harness,
} from './support/harness.js';

describe.skipIf(skipDatabaseTests)(
  'comptes, sessions et MFA (PAR-001, IAM-007, SEC-001, SEC-002)',
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await createHarness();
    });
    afterAll(async () => {
      await h?.close();
    });

    it('parcours complet : inscription, vérification, connexion, organisation Free avec Owner et site principal', async () => {
      const client = await signUp(h, 'alice@example.test');
      const organization = await createOrganization(client, 'Crêperie « Chez Zoé »');
      const me = (await client.get('/auth/me')).json();
      expect(me.organizations).toEqual([
        expect.objectContaining({ id: organization.id, roles: ['Owner'] }),
      ]);
      const sites = (await client.get('/sites')).json();
      expect(sites.items).toEqual([
        expect.objectContaining({ name: 'Site principal', timezone: null }),
      ]);
      const permissions = (await client.get('/permissions')).json();
      expect(permissions.permissions).toContain('billing.manage');
      const auditLog = (await client.get('/audit')).json();
      expect(auditLog.items.map((e: { action: string }) => e.action)).toContain(
        'organization.created',
      );
    });

    it('le cookie de session est HttpOnly, Secure, SameSite=Lax, lié à l’hôte ; la base ne stocke que son empreinte', async () => {
      const client = new Client(h, 'alice@example.test');
      const response = await client.post('/auth/login', {
        email: 'Alice@Example.TEST',
        password: PASSWORD,
      });
      expect(response.statusCode).toBe(200);
      const cookie = String(response.headers['set-cookie']);
      expect(cookie).toMatch(/^__Host-pixlova_session=/);
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=Lax/);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).not.toMatch(/Domain=/);
      const raw = client.cookie!.split('=')[1]!;
      const stored = await h.database.system
        .select({ hash: schema.userSessions.tokenHash })
        .from(schema.userSessions);
      expect(stored.map((s) => s.hash)).not.toContain(raw);
      expect(stored.every((s) => /^[0-9a-f]{64}$/.test(s.hash))).toBe(true);
    });

    it('anti-énumération : inscription d’une adresse existante et reset d’une adresse inconnue répondent à l’identique', async () => {
      const anonymous = new Client(h, 'x');
      const existing = await anonymous.post('/auth/register', {
        email: 'alice@example.test',
        password: 'another long password',
      });
      const unknownReset = await anonymous.post('/auth/password-reset/request', {
        email: 'nobody@example.test',
      });
      const knownReset = await anonymous.post('/auth/password-reset/request', {
        email: 'alice@example.test',
      });
      expect(existing.statusCode).toBe(202);
      expect([unknownReset.statusCode, unknownReset.json()]).toEqual([
        knownReset.statusCode,
        knownReset.json(),
      ]);
      await h.flushEmails();
      expect(
        h.mailer.sent.some((m) => m.to === 'alice@example.test' && /existe déjà/.test(m.subject)),
      ).toBe(true);
      expect(h.mailer.sent.some((m) => m.to === 'nobody@example.test')).toBe(false);
      // Le mot de passe du compte vérifié n’a pas été remplacé.
      expect(
        (await anonymous.post('/auth/login', { email: 'alice@example.test', password: PASSWORD }))
          .statusCode,
      ).toBe(200);
    });

    it('refuse un mot de passe faible, une connexion non vérifiée et des identifiants invalides', async () => {
      const client = new Client(h, 'bob@example.test');
      const weak = await client.post('/auth/register', {
        email: 'bob@example.test',
        password: 'court',
      });
      expect(weak.json().error.code).toBe('WEAK_PASSWORD');
      await client.post('/auth/register', { email: 'bob@example.test', password: PASSWORD });
      expect(
        (await client.post('/auth/login', { email: 'bob@example.test', password: PASSWORD })).json()
          .error.code,
      ).toBe('EMAIL_NOT_VERIFIED');
      const wrong = await client.post('/auth/login', {
        email: 'bob@example.test',
        password: 'mauvais mot de passe',
      });
      const unknown = await client.post('/auth/login', {
        email: 'ghost@example.test',
        password: 'mauvais mot de passe',
      });
      expect([wrong.statusCode, wrong.json().error.code]).toEqual([401, 'INVALID_CREDENTIALS']);
      expect([unknown.statusCode, unknown.json().error.code]).toEqual([401, 'INVALID_CREDENTIALS']);
      expect(wrong.json().error.message).toBe(unknown.json().error.message);
    });

    it('limite les tentatives de connexion par compte', async () => {
      const client = new Client(h, 'carol@example.test');
      let last = await client.post('/auth/login', {
        email: 'carol@example.test',
        password: 'wrong password 000',
      });
      for (let i = 0; i < 10; i++)
        last = await client.post('/auth/login', {
          email: 'carol@example.test',
          password: 'wrong password 000',
        });
      expect(last.statusCode).toBe(429);
      expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
      h.clock.advance(16 * 60_000);
      expect(
        (
          await client.post('/auth/login', {
            email: 'carol@example.test',
            password: 'wrong password 000',
          })
        ).statusCode,
      ).toBe(401);
    });

    it('un lien de vérification ne sert qu’une fois', async () => {
      const client = new Client(h, 'dave@example.test');
      await client.post('/auth/register', { email: 'dave@example.test', password: PASSWORD });
      const token = await lastLinkToken(h, 'dave@example.test', '/verify-email');
      const [first, second] = await Promise.all([
        client.post('/auth/verify-email', { token }),
        client.post('/auth/verify-email', { token }),
      ]);
      expect([first.statusCode, second.statusCode].sort()).toEqual([200, 400]);
    });

    it('refuse les requêtes modifiantes sans origine autorisée (CSRF)', async () => {
      const client = await signUp(h, 'erin@example.test');
      const response = await client.request(
        'POST',
        '/organizations',
        { name: 'X', country: 'FR', timezone: 'UTC' },
        { origin: 'https://evil.test' },
      );
      expect([response.statusCode, response.json().error.code]).toEqual([403, 'CSRF_REJECTED']);
    });

    it('déconnexion, révocation de toutes les sessions et expiration d’inactivité', async () => {
      const first = await signUp(h, 'frank@example.test');
      const second = new Client(h, 'frank@example.test');
      await second.post('/auth/login', { email: 'frank@example.test', password: PASSWORD });
      expect((await first.get('/auth/sessions')).json().items).toHaveLength(2);
      expect((await first.post('/auth/sessions/revoke-all')).statusCode).toBe(204);
      expect((await second.get('/auth/me')).statusCode).toBe(401);
      expect((await first.get('/auth/me')).statusCode).toBe(200);
      h.clock.advance((h.services.security.sessionIdleHours + 1) * 3_600_000);
      expect((await first.get('/auth/me')).statusCode).toBe(401);
      const third = new Client(h, 'frank@example.test');
      await third.post('/auth/login', { email: 'frank@example.test', password: PASSWORD });
      expect((await third.post('/auth/logout')).statusCode).toBe(204);
      expect(third.cookie).toBeNull();
    });

    it('la réinitialisation du mot de passe consomme le jeton et ferme toutes les sessions', async () => {
      const session = await signUp(h, 'gina@example.test');
      const anonymous = new Client(h, 'gina@example.test');
      await anonymous.post('/auth/password-reset/request', { email: 'gina@example.test' });
      const token = await lastLinkToken(h, 'gina@example.test', '/password-reset/confirm');
      const confirm = await anonymous.post('/auth/password-reset/confirm', {
        token,
        password: 'nouveau mot de passe très long',
      });
      expect(confirm.statusCode).toBe(200);
      expect((await session.get('/auth/me')).statusCode).toBe(401);
      expect(
        (
          await anonymous.post('/auth/password-reset/confirm', {
            token,
            password: 'encore un autre mot de passe',
          })
        ).json().error.code,
      ).toBe('TOKEN_INVALID');
      expect(
        (await anonymous.post('/auth/login', { email: 'gina@example.test', password: PASSWORD }))
          .statusCode,
      ).toBe(401);
      expect(
        (
          await anonymous.post('/auth/login', {
            email: 'gina@example.test',
            password: 'nouveau mot de passe très long',
          })
        ).statusCode,
      ).toBe(200);
    });

    it('MFA TOTP : activation après réauthentification, second facteur exigé, code non rejouable, code de secours unique', async () => {
      const client = await signUp(h, 'hugo@example.test');
      await createOrganization(client, 'Hugo SARL');
      h.clock.advance(16 * 60_000);
      expect((await client.post('/auth/mfa/enroll')).json().error.code).toBe(
        'REAUTHENTICATION_REQUIRED',
      );
      expect((await client.post('/auth/reauthenticate', { password: PASSWORD })).statusCode).toBe(
        200,
      );
      const { secret, otpauth_uri } = (await client.post('/auth/mfa/enroll')).json();
      expect(otpauth_uri).toMatch(/^otpauth:\/\/totp\/pixlova%3Ahugo%40example.test\?secret=/);
      const confirm = await client.post('/auth/mfa/confirm', { code: totpNow(secret, h) });
      expect(confirm.statusCode).toBe(200);
      const recovery: string[] = confirm.json().recovery_codes;
      expect(recovery).toHaveLength(10);

      // Le secret est chiffré au repos.
      const [stored] = await h.database.system.select().from(schema.mfaCredentials);
      expect(stored!.encryptedSecret).not.toContain(secret);

      const login = new Client(h, 'hugo@example.test');
      login.organizationId = client.organizationId;
      expect(
        (await login.post('/auth/login', { email: 'hugo@example.test', password: PASSWORD })).json()
          .mfa_required,
      ).toBe(true);
      expect((await login.get('/sites')).json().error.code).toBe('MFA_REQUIRED');
      expect((await login.get('/auth/me')).json().mfa_pending).toBe(true);
      // Le code utilisé à l’activation ne peut pas être rejoué.
      expect((await login.post('/auth/mfa/verify', { code: totpNow(secret, h) })).statusCode).toBe(
        400,
      );
      h.clock.advance(30_000);
      expect((await login.post('/auth/mfa/verify', { code: totpNow(secret, h) })).statusCode).toBe(
        200,
      );
      expect((await login.get('/sites')).statusCode).toBe(200);

      const other = new Client(h, 'hugo@example.test');
      await other.post('/auth/login', { email: 'hugo@example.test', password: PASSWORD });
      expect(
        (await other.post('/auth/mfa/verify', { recovery_code: recovery[0] })).statusCode,
      ).toBe(200);
      const again = new Client(h, 'hugo@example.test');
      await again.post('/auth/login', { email: 'hugo@example.test', password: PASSWORD });
      expect(
        (await again.post('/auth/mfa/verify', { recovery_code: recovery[0] })).statusCode,
      ).toBe(400);

      const [user] = await h.database.system
        .select()
        .from(schema.users)
        .where(eq(schema.users.emailNormalized, 'hugo@example.test'));
      expect(user!.mfaEnabled).toBe(true);
    });

    it('l’audit de compte ne contient ni mot de passe, ni jeton, ni code', async () => {
      const rows = await h.database.system.select().from(schema.auditLogs);
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(PASSWORD);
      // Aucun jeton (base64url de 43 caractères) ni code à 6 chiffres dans les métadonnées.
      expect(serialized).not.toMatch(/[A-Za-z0-9_-]{43}/);
      for (const row of rows) {
        expect(Object.keys(row.metadata as object).join(',')).not.toMatch(
          /pass|token|secret|code|cookie|otp/i,
        );
        expect(JSON.stringify(row.metadata)).not.toMatch(/\b[0-9]{6}\b/);
      }
    });
  },
);
