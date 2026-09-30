import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signPlayerChallenge } from '@pixlova/contracts';
import { schema } from '@pixlova/db';
import { skipDatabaseTests } from '@pixlova/db/testing';
import type { Client } from './support/harness.js';
import { createHarness, createOrganization, signUp, type Harness } from './support/harness.js';
import { SimulatedPlayer } from './support/player.js';

function key(): Record<string, string> {
  return { 'idempotency-key': `test-${randomUUID()}` };
}

async function pair(
  client: Client,
  code: string,
  siteId: string,
  name = 'Player',
  headers = key(),
) {
  return client.request('POST', '/players/pair', { code, name, site_id: siteId }, headers);
}

describe.skipIf(skipDatabaseTests)('Players, appairage, Displays et remplacement (L02)', () => {
  let h: Harness;
  let owner: Client;
  let org: { id: string; siteId: string };
  let rival: Client;
  let rivalOrg: { id: string; siteId: string };

  beforeAll(async () => {
    h = await createHarness();
    h.setMaxUsers(10);
    owner = await signUp(h, 'owner@fleet.test');
    org = await createOrganization(owner, 'Parc A');
    rival = await signUp(h, 'owner@rival.test');
    rivalOrg = await createOrganization(rival, 'Parc B');
  });
  afterAll(async () => {
    await h?.close();
  });

  describe('appairage à usage unique (PLY-002, PROTO-001, PROTO-002)', () => {
    it('code réclamé par un utilisateur autorisé, association récupérée par le seul Player détenteur du secret', async () => {
      const player = new SimulatedPlayer(h);
      const code = await player.register();
      expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
      expect((await player.poll()).json().status).toBe('pending');
      const headers = key();
      const claimed = await pair(
        owner,
        code.toLowerCase().replace('-', ' '),
        org.siteId,
        'Vitrine',
        headers,
      );
      expect(claimed.statusCode).toBe(201);
      // Même clé, même requête : même réponse, aucun second Player.
      const replay = await pair(
        owner,
        code.toLowerCase().replace('-', ' '),
        org.siteId,
        'Vitrine',
        headers,
      );
      expect(replay.json()).toEqual(claimed.json());
      const conflict = await pair(owner, code, org.siteId, 'Autre nom', headers);
      expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
      // Un code consommé est refusé, même avec une nouvelle clé.
      expect((await pair(owner, code, org.siteId)).json().error.code).toBe('PAIRING_CODE_INVALID');

      const stranger = new SimulatedPlayer(h);
      stranger.registration = { ...player.registration!, poll_secret: 'A'.repeat(43) };
      expect((await stranger.poll()).statusCode).toBe(404);
      const polled = await player.poll();
      expect(polled.json()).toEqual({
        status: 'paired',
        player_id: claimed.json().player.id,
        organization_id: org.id,
      });
      await player.authenticate();
      expect((await player.config()).assignments).toEqual([]);
      const players = (await owner.get('/players')).json().items;
      expect(players).toHaveLength(1);
      expect(players[0].outputs.map((o: { output_key: string }) => o.output_key)).toEqual([
        'HDMI-A-1',
        'HDMI-A-2',
      ]);
    });

    it('exige une clé d’idempotence', async () => {
      const player = new SimulatedPlayer(h);
      const code = await player.register();
      expect((await pair(owner, code, org.siteId, 'X', {})).statusCode).toBe(400);
    });

    it('deux réclamations simultanées du même code par deux organisations : une seule réussit', async () => {
      const player = new SimulatedPlayer(h);
      const code = await player.register();
      const results = await Promise.all([
        pair(owner, code, org.siteId, 'A'),
        pair(rival, code, rivalOrg.siteId, 'B'),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 404]);
      const winner = results.find((r) => r.statusCode === 201)!;
      await player.poll();
      expect(player.organizationId).toBe(winner === results[0] ? org.id : rivalOrg.id);
      // Nettoyage : ce Player sert aux tests de rejeu.
      const client = winner === results[0] ? owner : rival;
      await client.post(`/players/${player.playerId}/revoke`);
    });

    it('refuse un code expiré, côté utilisateur comme côté Player', async () => {
      const player = new SimulatedPlayer(h);
      const code = await player.register();
      h.clock.advance((h.services.security.pairingCodeMinutes + 1) * 60_000);
      await owner.post('/auth/login', {
        email: 'owner@fleet.test',
        password: 'correct horse battery staple',
      });
      expect((await pair(owner, code, org.siteId)).json().error.code).toBe('PAIRING_EXPIRED');
      expect((await player.poll()).json().error.code).toBe('PAIRING_EXPIRED');
      await rival.post('/auth/login', {
        email: 'owner@rival.test',
        password: 'correct horse battery staple',
      });
    });

    it('un challenge ne sert qu’une fois, expire, et exige la clé de l’appareil appairé', async () => {
      const player = new SimulatedPlayer(h);
      await pair(owner, await player.register(), org.siteId, 'Rejeu');
      await player.poll();
      const doc = (await player.challenge()).json().challenge;
      const signature = signPlayerChallenge(doc, player.secretKey);
      expect(
        (await player.call('POST', '/token/refresh', { challenge_id: doc.challenge_id, signature }))
          .statusCode,
      ).toBe(200);
      expect(
        (await player.call('POST', '/token/refresh', { challenge_id: doc.challenge_id, signature }))
          .statusCode,
      ).toBe(401);
      const other = (await player.challenge()).json().challenge;
      const forged = signPlayerChallenge(other, ed25519.utils.randomSecretKey());
      expect(
        (
          await player.call('POST', '/token/refresh', {
            challenge_id: other.challenge_id,
            signature: forged,
          })
        ).statusCode,
      ).toBe(401);
      const late = (await player.challenge()).json().challenge;
      h.clock.advance((h.services.security.playerChallengeSeconds + 1) * 1000);
      const lateSignature = signPlayerChallenge(late, player.secretKey);
      expect(
        (
          await player.call('POST', '/token/refresh', {
            challenge_id: late.challenge_id,
            signature: lateSignature,
          })
        ).statusCode,
      ).toBe(401);
      // Le cloud ne stocke que la clé publique.
      const [credential] = await h.database.system
        .select()
        .from(schema.playerCredentials)
        .where(eq(schema.playerCredentials.playerId, player.playerId!));
      expect(credential!.publicKey).toHaveLength(43);
    });

    it('un jeton Player expire', async () => {
      const player = new SimulatedPlayer(h);
      await pair(owner, await player.register(), org.siteId, 'Expiration');
      await player.poll();
      await player.authenticate();
      h.clock.advance((h.services.security.playerTokenMinutes + 1) * 60_000);
      expect((await player.call('GET', '/config')).statusCode).toBe(401);
      await owner.post('/auth/login', {
        email: 'owner@fleet.test',
        password: 'correct horse battery staple',
      });
      await rival.post('/auth/login', {
        email: 'owner@rival.test',
        password: 'correct horse battery staple',
      });
    });
  });

  describe('Displays et slots (DSP-004, DSP-006, BILL-002 à BILL-004)', () => {
    it('accepte les résolutions libres et refuse les valeurs invalides', async () => {
      h.setDisplaySlots(10);
      const led = await owner.post('/displays', {
        site_id: org.siteId,
        name: 'Bandeau',
        width: 2688,
        height: 672,
      });
      expect([led.statusCode, led.json().width, led.json().height]).toEqual([201, 2688, 672]);
      expect(
        (await owner.post('/displays', { site_id: org.siteId, name: 'Nul', width: 0, height: 10 }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await owner.post('/displays', {
            site_id: org.siteId,
            name: 'Penché',
            width: 10,
            height: 10,
            orientation: 45,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await owner.post('/displays', {
            site_id: org.siteId,
            name: 'Fuseau',
            width: 10,
            height: 10,
            timezone: 'Mars/Olympus',
          })
        ).statusCode,
      ).toBe(422);
      // Un site d’une autre organisation est inconnu dans ce tenant.
      expect(
        (
          await owner.post('/displays', {
            site_id: rivalOrg.siteId,
            name: 'Croisé',
            width: 10,
            height: 10,
          })
        ).statusCode,
      ).toBe(422);
      await owner.patch(`/displays/${led.json().id}`, { lifecycle_status: 'inactive' });
    });

    it('aucune création au-delà des slots, même sous concurrence ; la désactivation libère le slot sans supprimer', async () => {
      h.setDisplaySlots(1);
      const active = (await owner.get('/displays')).json();
      expect(active.slots).toEqual({ allowed: 1, active: 0 });
      const results = await Promise.all(
        [1, 2, 3].map((i) =>
          owner.post('/displays', {
            site_id: org.siteId,
            name: `Concurrent ${i}`,
            width: 1920,
            height: 1080,
          }),
        ),
      );
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409, 409]);
      const refused = results.find((r) => r.statusCode === 409)!.json().error;
      expect([refused.code, refused.details]).toEqual([
        'DISPLAY_LIMIT_REACHED',
        { allowed: 1, active: 1 },
      ]);
      const created = results.find((r) => r.statusCode === 201)!.json();
      expect(
        (await owner.patch(`/displays/${created.id}`, { lifecycle_status: 'inactive' })).statusCode,
      ).toBe(200);
      const list = (await owner.get('/displays')).json();
      expect(list.slots.active).toBe(0);
      expect(list.items.some((d: { id: string }) => d.id === created.id)).toBe(true);
    });
  });

  describe('affectation et remplacement sans perte (DSP-002, DSP-003, DATA-006, TST-018)', () => {
    let playerA: SimulatedPlayer;
    let playerB: SimulatedPlayer;
    let display1: string;
    let display2: string;
    const outputs = async (playerId: string) =>
      (await owner.get('/players')).json().items.find((p: { id: string }) => p.id === playerId)
        .outputs as { id: string; output_key: string }[];
    const assign = (displayId: string, outputId: string, headers = key()) =>
      owner.request(
        'PUT',
        `/displays/${displayId}/assignment`,
        { player_output_id: outputId },
        headers,
      );

    beforeAll(async () => {
      h.setDisplaySlots(10);
      playerA = new SimulatedPlayer(h);
      await pair(owner, await playerA.register(), org.siteId, 'Player A');
      await playerA.poll();
      await playerA.authenticate();
      playerB = new SimulatedPlayer(h);
      await pair(owner, await playerB.register(), org.siteId, 'Player B');
      await playerB.poll();
      await playerB.authenticate();
      display1 = (
        await owner.post('/displays', {
          site_id: org.siteId,
          name: 'Vitrine',
          width: 1080,
          height: 1920,
          orientation: 90,
          timezone: 'Europe/Paris',
        })
      ).json().id;
      display2 = (
        await owner.post('/displays', {
          site_id: org.siteId,
          name: 'Comptoir',
          width: 1920,
          height: 1080,
        })
      ).json().id;
    });

    it('affecte deux Displays aux deux sorties du Player A', async () => {
      const [a1, a2] = await outputs(playerA.playerId!);
      expect((await assign(display1, a1!.id)).json().generation).toBe('1');
      expect((await assign(display2, a2!.id)).json().generation).toBe('1');
      const config = await playerA.config();
      expect(
        config.assignments.map((a) => [a.display_id, a.assignment_generation, a.output_key]).sort(),
      ).toEqual(
        [
          [display1, '1', a1!.output_key],
          [display2, '1', a2!.output_key],
        ].sort(),
      );
      expect(config.assignments.find((a) => a.display_id === display1)!.display).toEqual({
        name: 'Vitrine',
        width: 1080,
        height: 1920,
        orientation: 90,
        timezone: 'Europe/Paris',
      });
      expect(
        (await playerA.heartbeat([{ display_id: display1, assignment_generation: '1' }])).json()
          .stale_displays,
      ).toEqual([]);
    });

    it('refuse une sortie déjà occupée, y compris sous concurrence', async () => {
      const [b1] = await outputs(playerB.playerId!);
      // Deux Displays dédiés : l’issue de la course ne modifie pas l’état des autres tests.
      const [extraA, extraB] = await Promise.all(
        ['Extra A', 'Extra B'].map(
          async (name) =>
            (
              await owner.post('/displays', {
                site_id: org.siteId,
                name,
                width: 800,
                height: 600,
              })
            ).json().id as string,
        ),
      );
      const results = await Promise.all([assign(extraA!, b1!.id), assign(extraB!, b1!.id)]);
      // L’une affecte b1 ; l’autre est refusée explicitement, sans voler l’affectation.
      expect(results.filter((r) => r.statusCode < 300)).toHaveLength(1);
      expect(results.filter((r) => r.json().error?.code === 'ASSIGNMENT_CONFLICT')).toHaveLength(1);
      // Une sortie occupée n’est pas prise par un Display déjà affecté ailleurs.
      const moved = await assign(display2, b1!.id);
      expect(moved.json().error?.code).toBe('ASSIGNMENT_CONFLICT');
      const winner = results.findIndex((r) => r.statusCode < 300) === 0 ? extraA! : extraB!;
      await owner.delete(`/displays/${winner}/assignment`);
      for (const extra of [extraA!, extraB!]) {
        await owner.patch(`/displays/${extra}`, { lifecycle_status: 'inactive' });
      }
    });

    it('remplace le Player du Display 1 : même display_id, génération incrémentée, historique conservé, autre sortie intacte', async () => {
      const [b1] = await outputs(playerB.playerId!);
      const before = (await owner.get(`/displays/${display1}`)).json();
      const replaced = await assign(display1, b1!.id);
      expect([
        replaced.statusCode,
        replaced.json().generation,
        replaced.json().previous.generation,
      ]).toEqual([
        200,
        String(Number(before.assignment_generation) + 1),
        before.assignment_generation,
      ]);
      const detail = (await owner.get(`/displays/${display1}`)).json();
      expect(detail.id).toBe(display1);
      expect(detail.assignment.player.id).toBe(playerB.playerId);
      expect(detail.history).toHaveLength(2);
      expect(detail.history[1].ended_at).not.toBeNull();
      expect(detail.compatibility).toBe('ok');
      // Le Display 2 reste affecté au Player A.
      expect((await playerA.config()).assignments.map((a) => a.display_id)).toEqual([display2]);
      expect(
        (await playerB.config()).assignments.map((a) => [a.display_id, a.assignment_generation]),
      ).toEqual([[display1, detail.assignment_generation]]);
      // Aucune période avec deux affectations actives.
      const active = await h.database.system
        .select()
        .from(schema.displayAssignments)
        .where(eq(schema.displayAssignments.displayId, display1));
      expect(active.filter((a) => a.endedAt === null)).toHaveLength(1);
    });

    it('l’ancien Player qui se reconnecte ne reprend pas l’affectation', async () => {
      const heartbeat = await playerA.heartbeat([
        { display_id: display1, assignment_generation: '1' },
        { display_id: display2, assignment_generation: '1' },
      ]);
      expect(heartbeat.json().stale_displays).toEqual([display1]);
      const detail = (await owner.get(`/displays/${display1}`)).json();
      expect(detail.assignment.player.id).toBe(playerB.playerId);
      expect((await playerA.config()).assignments.map((a) => a.display_id)).toEqual([display2]);
    });

    it('présence honnête : en ligne après heartbeat, hors ligne après 90 s sans contact, avec horodatage', async () => {
      await playerB.heartbeat([]);
      let list = (await owner.get('/displays')).json().items;
      expect(list.find((d: { id: string }) => d.id === display1).assignment.presence).toBe(
        'online',
      );
      h.clock.advance(91_000);
      list = (await owner.get('/displays')).json().items;
      const entry = list.find((d: { id: string }) => d.id === display1).assignment;
      expect(entry.presence).toBe('offline');
      expect(entry.last_seen_at).not.toBeNull();
    });

    it('la révocation invalide jeton et challenge, clôt les affectations et conserve les Displays', async () => {
      await playerA.authenticate().catch(() => undefined);
      const revoked = await owner.post(`/players/${playerA.playerId}/revoke`);
      expect([revoked.statusCode, revoked.json().ended_assignments]).toEqual([200, 1]);
      const config = await playerA.call('GET', '/config');
      expect([config.statusCode, config.json().error.code]).toEqual([403, 'PLAYER_REVOKED']);
      expect((await playerA.challenge()).json().error.code).toBe('PLAYER_REVOKED');
      const detail = (await owner.get(`/displays/${display2}`)).json();
      expect([detail.id, detail.assignment]).toEqual([display2, null]);
      expect(detail.history).toHaveLength(1);
      const [b2] = (await outputs(playerB.playerId!)).slice(1);
      expect((await assign(display2, b2!.id)).json().generation).toBe('2');
    });
  });

  describe('isolation et périmètres', () => {
    it('une organisation ne voit ni n’utilise les Players, sorties et Displays d’une autre', async () => {
      expect(
        (await rival.get('/players'))
          .json()
          .items.every((p: { name: string }) => !p.name.startsWith('Player')),
      ).toBe(true);
      const ownDisplay = await rival.post('/displays', {
        site_id: rivalOrg.siteId,
        name: 'B1',
        width: 1920,
        height: 1080,
      });
      const foreignOutput = (await owner.get('/players')).json().items[0].outputs[0].id;
      const attempt = await rival.request(
        'PUT',
        `/displays/${ownDisplay.json().id}/assignment`,
        { player_output_id: foreignOutput },
        key(),
      );
      expect(attempt.statusCode).toBe(404);
      const foreignDisplay = (await owner.get('/displays')).json().items[0].id;
      expect((await rival.get(`/displays/${foreignDisplay}`)).statusCode).toBe(404);
    });

    it('un technicien limité à un site n’appaire que sur ce site', async () => {
      const lyon = (await owner.post('/sites', { name: 'Lyon' })).json().id;
      await owner.post('/invitations', {
        email: 'tech@fleet.test',
        role: 'Technician',
        scope: { type: 'sites', site_ids: [lyon] },
      });
      await h.flushEmails();
      const token = new URL(
        h.mailer.linkFor('tech@fleet.test', '/invitations/accept')!,
      ).searchParams.get('token');
      const tech = await signUp(h, 'tech@fleet.test');
      await tech.post('/invitations/accept', { token });
      tech.organizationId = org.id;
      const player = new SimulatedPlayer(h);
      const code = await player.register();
      expect((await pair(tech, code, org.siteId)).statusCode).toBe(403);
      expect((await pair(tech, code, lyon)).statusCode).toBe(201);
      expect(
        (await tech.get('/players')).json().items.map((p: { site_id: string }) => p.site_id),
      ).toEqual([lyon]);
    });
  });

  describe('groupes de Displays', () => {
    it('crée un groupe et remplace ses membres de manière atomique', async () => {
      const group = (await owner.post('/display-groups', { name: 'Vitrines' })).json();
      const displays = (await owner.get('/displays')).json().items.map((d: { id: string }) => d.id);
      expect(
        (
          await owner.put(`/display-groups/${group.id}/members`, {
            display_ids: displays.slice(0, 2),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await owner.put(`/display-groups/${group.id}/members`, {
            display_ids: [displays[0], randomUUID()],
          })
        ).statusCode,
      ).toBe(422);
      const listed = (await owner.get('/display-groups'))
        .json()
        .items.find((g: { id: string }) => g.id === group.id);
      expect(listed.display_ids.sort()).toEqual(displays.slice(0, 2).sort());
    });
  });
});
