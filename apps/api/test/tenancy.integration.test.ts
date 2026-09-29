import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  'organisations, isolation, invitations et RBAC (TST-002, TST-021, IAM-002 à IAM-006)',
  () => {
    let h: Harness;
    let owner: Client;
    let rival: Client;
    let orgA: { id: string; siteId: string };
    let orgB: { id: string; siteId: string };
    let secondSite: string;

    beforeAll(async () => {
      h = await createHarness();
      owner = await signUp(h, 'owner@a.test');
      rival = await signUp(h, 'owner@b.test');
      orgA = await createOrganization(owner, 'Organisation A');
      orgB = await createOrganization(rival, 'Organisation B');
      secondSite = (
        await owner.post('/sites', { name: 'Boutique Lyon', timezone: 'Europe/Paris' })
      ).json().id;
    });
    afterAll(async () => {
      await h?.close();
    });

    describe('isolation entre deux organisations aux identifiants connus', () => {
      it('un utilisateur ne peut pas utiliser le contexte d’une organisation dont il n’est pas membre', async () => {
        const intruder = new Client(h, 'owner@b.test');
        intruder.cookie = rival.cookie;
        intruder.organizationId = orgA.id;
        for (const url of [
          '/sites',
          '/members',
          '/invitations',
          '/audit',
          '/permissions',
          `/organizations/${orgA.id}`,
        ]) {
          const response = await intruder.get(url);
          expect([url, response.statusCode, response.json().error.code]).toEqual([
            url,
            404,
            'RESOURCE_NOT_FOUND',
          ]);
        }
        const write = await intruder.patch(`/sites/${orgA.siteId}`, { name: 'piraté' });
        expect(write.statusCode).toBe(404);
      });

      it('un identifiant d’une autre organisation est introuvable dans son propre contexte', async () => {
        const response = await rival.patch(`/sites/${orgA.siteId}`, { name: 'piraté' });
        expect([response.statusCode, response.json().error.code]).toEqual([
          404,
          'RESOURCE_NOT_FOUND',
        ]);
        const sites = (await rival.get('/sites')).json().items.map((s: { id: string }) => s.id);
        expect(sites).toEqual([orgB.siteId]);
        expect((await rival.get(`/organizations/${orgA.id}`)).statusCode).toBe(400);
      });

      it('la liste des organisations de /auth/me ne montre que les siennes', async () => {
        const me = (await rival.get('/auth/me')).json();
        expect(me.organizations.map((o: { id: string }) => o.id)).toEqual([orgB.id]);
      });
    });

    describe('invitations', () => {
      it('l’offre Free limite l’organisation à un utilisateur (BILL-003)', async () => {
        h.setMaxUsers(1);
        const response = await owner.post('/invitations', {
          email: 'c@a.test',
          role: 'ContentManager',
          scope: { type: 'organization' },
        });
        expect([response.statusCode, response.json().error.code]).toEqual([
          409,
          'USER_LIMIT_REACHED',
        ]);
      });

      it('une invitation rejoint l’organisation choisie, avec le rôle et le périmètre prévus, une seule fois', async () => {
        h.setMaxUsers(10);
        const invited = await owner.post('/invitations', {
          email: 'Carla@A.test',
          role: 'ContentManager',
          scope: { type: 'sites', site_ids: [secondSite] },
        });
        expect(invited.statusCode).toBe(201);
        const token = await lastLinkToken(h, 'carla@a.test', '/invitations/accept');
        const carla = await signUp(h, 'carla@a.test');
        // Aucune organisation créée implicitement par l’inscription (PAR-001).
        expect((await carla.get('/auth/me')).json().organizations).toEqual([]);
        const [first, second] = await Promise.all([
          carla.post('/invitations/accept', { token }),
          carla.post('/invitations/accept', { token }),
        ]);
        expect([first.statusCode, second.statusCode].sort()).toEqual([200, 404]);
        carla.organizationId = orgA.id;
        const permissions = (await carla.get('/permissions')).json();
        expect(permissions.grants).toEqual([
          { role: 'ContentManager', scope: { type: 'sites', site_ids: [secondSite] } },
        ]);
        // Scope site : seul son site est visible ; aucune gestion des membres.
        expect((await carla.get('/sites')).json().items.map((s: { id: string }) => s.id)).toEqual([
          secondSite,
        ]);
        expect((await carla.get('/members')).json().error.code).toBe('FORBIDDEN');
        expect((await carla.post('/sites', { name: 'Non' })).statusCode).toBe(403);
        const members = (await owner.get('/members')).json().items;
        expect(members.filter((m: { email: string }) => m.email === 'carla@a.test')).toHaveLength(
          1,
        );
      });

      it('une invitation est refusée pour une autre adresse, après révocation ou après expiration', async () => {
        await owner.post('/invitations', {
          email: 'dan@a.test',
          role: 'Viewer',
          scope: { type: 'organization' },
        });
        const token = await lastLinkToken(h, 'dan@a.test', '/invitations/accept');
        const eve = await signUp(h, 'eve@a.test');
        expect((await eve.post('/invitations/accept', { token })).json().error.code).toBe(
          'INVITATION_INVALID',
        );
        const list = (await owner.get('/invitations')).json().items;
        const pending = list.find((i: { email: string }) => i.email === 'dan@a.test');
        // Le renvoi remplace le jeton sans créer une seconde invitation.
        expect(
          (
            await owner.post('/invitations', {
              email: 'dan@a.test',
              role: 'Viewer',
              scope: { type: 'organization' },
            })
          ).json().error.code,
        ).toBe('INVITATION_PENDING');
        expect((await owner.post(`/invitations/${pending.id}/resend`)).statusCode).toBe(200);
        const renewed = await lastLinkToken(h, 'dan@a.test', '/invitations/accept');
        expect(renewed).not.toBe(token);
        const dan = await signUp(h, 'dan@a.test');
        expect((await dan.post('/invitations/accept', { token })).json().error.code).toBe(
          'INVITATION_INVALID',
        );
        expect((await owner.post(`/invitations/${pending.id}/revoke`)).statusCode).toBe(204);
        expect((await dan.post('/invitations/accept', { token: renewed })).json().error.code).toBe(
          'INVITATION_INVALID',
        );

        await owner.post('/invitations', {
          email: 'fay@a.test',
          role: 'Viewer',
          scope: { type: 'organization' },
        });
        const expiring = await lastLinkToken(h, 'fay@a.test', '/invitations/accept');
        const fay = await signUp(h, 'fay@a.test');
        h.clock.advance((h.services.security.invitationDays * 24 + 1) * 3_600_000);
        // Les sessions ont expiré par inactivité pendant ce délai : reconnexion.
        for (const client of [fay, owner, rival])
          await client.post('/auth/login', { email: client.email, password: PASSWORD });
        expect((await fay.post('/invitations/accept', { token: expiring })).json().error.code).toBe(
          'INVITATION_INVALID',
        );
      });
    });

    describe('rôles, délégation et propriétaire', () => {
      let admin: Client;
      let adminMembership: string;
      let ownerMembership: string;

      beforeAll(async () => {
        await owner.post('/invitations', {
          email: 'admin@a.test',
          role: 'Admin',
          scope: { type: 'organization' },
        });
        const token = await lastLinkToken(h, 'admin@a.test', '/invitations/accept');
        admin = await signUp(h, 'admin@a.test');
        adminMembership = (await admin.post('/invitations/accept', { token })).json().membership_id;
        admin.organizationId = orgA.id;
        const members = (await owner.get('/members')).json().items;
        ownerMembership = members.find((m: { email: string }) => m.email === 'owner@a.test').id;
      });

      it('un Admin ne peut ni nommer un Owner, ni rétrograder un Owner, ni s’octroyer la facturation', async () => {
        const promote = await admin.put(`/members/${adminMembership}/grants`, {
          grants: [{ role: 'Owner', scope: { type: 'organization' } }],
        });
        expect(promote.json().error.code).toBe('DELEGATION_FORBIDDEN');
        const demote = await admin.put(`/members/${ownerMembership}/grants`, {
          grants: [{ role: 'Viewer', scope: { type: 'organization' } }],
        });
        expect(demote.json().error.code).toBe('DELEGATION_FORBIDDEN');
        const billing = await admin.put(`/members/${adminMembership}/grants`, {
          grants: [
            { role: 'Admin', scope: { type: 'organization' } },
            { role: 'BillingManager', scope: { type: 'organization' } },
          ],
        });
        expect(billing.json().error.code).toBe('DELEGATION_FORBIDDEN');
        expect((await admin.delete(`/members/${ownerMembership}`)).json().error.code).toBe(
          'DELEGATION_FORBIDDEN',
        );
      });

      it('un rôle d’organisation ne peut pas être limité à des sites', async () => {
        const response = await owner.put(`/members/${adminMembership}/grants`, {
          grants: [{ role: 'Admin', scope: { type: 'sites', site_ids: [secondSite] } }],
        });
        expect([response.statusCode, response.json().error.details.reason]).toEqual([
          422,
          'ROLE_REQUIRES_ORGANIZATION_SCOPE',
        ]);
      });

      it('un site d’une autre organisation est refusé dans un périmètre', async () => {
        const response = await owner.put(`/members/${adminMembership}/grants`, {
          grants: [{ role: 'Technician', scope: { type: 'sites', site_ids: [orgB.siteId] } }],
        });
        expect(response.statusCode).toBe(422);
      });

      it('le dernier Owner ne peut pas se rétrograder ni partir (DATA-004)', async () => {
        const demote = await owner.put(`/members/${ownerMembership}/grants`, {
          grants: [{ role: 'Admin', scope: { type: 'organization' } }],
        });
        expect(demote.json().error.code).toBe('LAST_OWNER');
        expect((await owner.delete(`/members/${ownerMembership}`)).json().error.code).toBe(
          'LAST_OWNER',
        );
      });

      it('deux Owners qui se rétrogradent simultanément : au moins un reste Owner', async () => {
        await owner.post('/auth/reauthenticate', { password: PASSWORD });
        const promote = await owner.put(`/members/${adminMembership}/grants`, {
          grants: [{ role: 'Owner', scope: { type: 'organization' } }],
        });
        expect(promote.statusCode).toBe(200);
        await admin.post('/auth/reauthenticate', { password: PASSWORD });
        const results = await Promise.all([
          owner.put(`/members/${ownerMembership}/grants`, {
            grants: [{ role: 'Admin', scope: { type: 'organization' } }],
          }),
          admin.put(`/members/${adminMembership}/grants`, {
            grants: [{ role: 'Admin', scope: { type: 'organization' } }],
          }),
        ]);
        expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        const members = (await owner.get('/members')).json().items;
        const owners = members.filter((m: { grants: { role: string }[] }) =>
          m.grants.some((g) => g.role === 'Owner'),
        );
        expect(owners).toHaveLength(1);
      });

      it('un changement de droits s’applique immédiatement aux sessions existantes', async () => {
        const current = (await owner.get('/members')).json().items;
        const target = current.find((m: { email: string }) => m.email === 'carla@a.test');
        const actor = current.some(
          (m: { email: string; grants: { role: string }[] }) =>
            m.email === 'owner@a.test' && m.grants.some((g) => g.role === 'Owner'),
        )
          ? owner
          : admin;
        await actor.put(`/members/${target.id}/grants`, {
          grants: [{ role: 'Viewer', scope: { type: 'sites', site_ids: [secondSite] } }],
        });
        const carla = new Client(h, 'carla@a.test');
        await carla.post('/auth/login', { email: 'carla@a.test', password: PASSWORD });
        carla.organizationId = orgA.id;
        expect((await carla.get('/permissions')).json().permissions).toEqual(['organization.read']);
        await actor.delete(`/members/${target.id}`);
        expect((await carla.get('/sites')).statusCode).toBe(404);
      });
    });

    describe('audit (IAM-008)', () => {
      it('trace les actions sensibles et reste réservé à audit.read, paginé par curseur', async () => {
        const page = (await owner.get('/audit?limit=5')).json();
        expect(page.items).toHaveLength(5);
        expect(page.has_more).toBe(true);
        const next = (await owner.get(`/audit?limit=5&cursor=${page.next_cursor}`)).json();
        const ids = new Set([...page.items, ...next.items].map((e: { id: string }) => e.id));
        expect(ids.size).toBe(10);
        const all: { action: string }[] = [];
        let cursor: string | null = null;
        do {
          const response: { items: { action: string }[]; next_cursor: string | null } = (
            await owner.get(`/audit?limit=200${cursor ? `&cursor=${cursor}` : ''}`)
          ).json();
          all.push(...response.items);
          cursor = response.next_cursor;
        } while (cursor);
        const actions = all.map((e: { action: string }) => e.action);
        for (const expected of [
          'organization.created',
          'site.created',
          'invitation.created',
          'invitation.accepted',
          'invitation.revoked',
          'member.grants_changed',
          'member.removed',
        ]) {
          expect(actions).toContain(expected);
        }
        // Aucune entrée de l’organisation B.
        const rivalActions = (await rival.get('/audit?limit=200')).json().items;
        expect(
          rivalActions.every((e: { target_id: string | null }) => e.target_id !== orgA.id),
        ).toBe(true);
        expect(JSON.stringify(all)).not.toContain(PASSWORD);
      });
    });
  },
);

describe.skipIf(skipDatabaseTests)(
  'MFA exigée pour les administrateurs (IAM-007, politique activée)',
  () => {
    let h: Harness;
    beforeAll(async () => {
      h = await createHarness({ requireMfaForAdmins: true });
      h.setMaxUsers(5);
    });
    afterAll(async () => {
      await h?.close();
    });

    it('un Owner sans MFA ne peut pas inviter ; après activation, il le peut', async () => {
      const owner = await signUp(h, 'secure@a.test');
      await createOrganization(owner, 'Sécurisée');
      const refused = await owner.post('/invitations', {
        email: 'x@a.test',
        role: 'Viewer',
        scope: { type: 'organization' },
      });
      expect(refused.json().error.code).toBe('MFA_ENROLLMENT_REQUIRED');
      const { secret } = (await owner.post('/auth/mfa/enroll')).json();
      await owner.post('/auth/mfa/confirm', { code: totpNow(secret, h) });
      const accepted = await owner.post('/invitations', {
        email: 'x@a.test',
        role: 'Viewer',
        scope: { type: 'organization' },
      });
      expect(accepted.statusCode).toBe(201);
    });
  },
);
