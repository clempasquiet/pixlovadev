import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  encodeBase64url,
  verifyManifest,
  type CompositionDocument,
  type PlaylistDocument,
  type ProgramDocument,
} from '@pixlova/contracts';
import { schema, withTenant } from '@pixlova/db';
import { skipDatabaseTests } from '@pixlova/db/testing';
import {
  COMPILE_DISPLAY,
  compileDisplay,
  manifestSignerFromSeed,
} from '@pixlova/scheduling/compiler';
import type { Client } from './support/harness.js';
import { createHarness, createOrganization, signUp, type Harness } from './support/harness.js';
import { SimulatedPlayer } from './support/player.js';

function key(): Record<string, string> {
  return { 'idempotency-key': `test-${randomUUID()}` };
}

const signer = manifestSignerFromSeed(
  'manifest-key-test',
  encodeBase64url(ed25519.utils.randomSecretKey()),
);
const iso = (date: Date) => date.toISOString().replace(/\.[0-9]{3}Z$/, 'Z');
const ALL = { include: [{ type: 'organization' }], exclude: [] };

describe.skipIf(skipDatabaseTests)('playlists, programmation et manifests (L05)', () => {
  let h: Harness;
  let owner: Client;
  let org: { id: string; siteId: string };
  let rival: Client;
  let player: SimulatedPlayer;
  let displayId: string;
  let imageId: string;
  let assetId: string;
  let playlistId: string;
  let scheduleId: string;
  let ruleId: string;
  let otherSite: string;

  /** Média prêt inséré directement (la préparation est couverte par le worker). */
  async function readyImage(name: string): Promise<{ mediaId: string; assetId: string }> {
    const mediaId = randomUUID();
    const asset = randomUUID();
    await withTenant(h.database.app, org.id, async (tx) => {
      await tx.insert(schema.media).values({
        id: mediaId,
        organizationId: org.id,
        name,
        type: 'image',
        status: 'ready',
        declaredMimeType: 'image/png',
        mimeType: 'image/png',
        originalFilename: `${name}.png`,
        sizeBytes: 1000,
        checksumSha256: 'a'.repeat(64),
        quotaBytes: 1000,
      });
      await tx.insert(schema.mediaAssets).values({
        id: asset,
        organizationId: org.id,
        mediaId,
        variant: 'playback',
        profile: 'passthrough',
        storageKey: `org/${org.id}/media/${mediaId}/playback`,
        mimeType: 'image/png',
        sizeBytes: 1000,
        checksumSha256: 'a'.repeat(64),
      });
    });
    return { mediaId, assetId: asset };
  }

  const compile = () =>
    compileDisplay({
      db: h.database.app,
      organizationId: org.id,
      displayId,
      signer,
      now: h.clock.now,
    });

  const playerGet = (url: string, headers: Record<string, string> = {}) =>
    h.app.inject({
      method: 'GET',
      url: `/player/v1${url}`,
      headers: { authorization: `Bearer ${player.token}`, ...headers },
    });
  const playerPost = (url: string, payload: object) =>
    h.app.inject({
      method: 'POST',
      url: `/player/v1${url}`,
      payload,
      headers: { authorization: `Bearer ${player.token}` },
    });

  beforeAll(async () => {
    h = await createHarness();
    h.setMaxUsers(10);
    h.setDisplaySlots(10);
    owner = await signUp(h, 'owner@prog.test');
    org = await createOrganization(owner, 'Diffusion A');
    rival = await signUp(h, 'owner@rival-prog.test');
    await createOrganization(rival, 'Diffusion B');
    ({ mediaId: imageId, assetId } = await readyImage('Affiche'));
    player = new SimulatedPlayer(h);
    const code = await player.register();
    await owner.request(
      'POST',
      '/players/pair',
      { code, name: 'Player', site_id: org.siteId },
      key(),
    );
    await player.poll();
    await player.authenticate();
    displayId = (
      await owner.post('/displays', {
        site_id: org.siteId,
        name: 'Vitrine',
        width: 1920,
        height: 1080,
      })
    ).json().id;
    const outputs = (await owner.get('/players')).json().items[0].outputs as { id: string }[];
    const assigned = await owner.request(
      'PUT',
      `/displays/${displayId}/assignment`,
      { player_output_id: outputs[0]!.id },
      key(),
    );
    expect(assigned.statusCode).toBe(201);
    otherSite = (await owner.post('/sites', { name: 'Lyon' })).json().id;
  });
  afterAll(async () => {
    await h?.close();
  });

  describe('playlists (PLN-001, PLN-002)', () => {
    it('refuse les durées manquantes, publie, reste idempotente et détecte les conflits', async () => {
      const created = await owner.request('POST', '/playlists', { name: 'Accueil' }, key());
      expect(created.statusCode).toBe(201);
      playlistId = created.json().id;
      const item = {
        id: randomUUID(),
        content: { type: 'media', id: imageId },
        duration_ms: null,
        enabled: true,
        valid_from: null,
        valid_until: null,
      };
      const document: PlaylistDocument = {
        schema_version: 1,
        transition: 'fade',
        items: [item as PlaylistDocument['items'][number]],
      };
      const saved = await owner.put(`/playlists/${playlistId}/draft`, { revision: 1, document });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().issues.map((i: { code: string }) => i.code)).toContain(
        'DURATION_REQUIRED',
      );
      const refused = await owner.post(`/playlists/${playlistId}/publish`, { revision: 2 });
      expect(refused.statusCode).toBe(422);
      document.items[0]!.duration_ms = 8000;
      expect(
        (await owner.put(`/playlists/${playlistId}/draft`, { revision: 1, document })).statusCode,
      ).toBe(409);
      await owner.put(`/playlists/${playlistId}/draft`, { revision: 2, document });
      const published = await owner.post(`/playlists/${playlistId}/publish`, { revision: 3 });
      expect(published.statusCode).toBe(201);
      expect(published.json().version).toBe(1);
      const again = await owner.post(`/playlists/${playlistId}/publish`, { revision: 3 });
      expect(again.statusCode).toBe(200);
      expect(again.json().version).toBe(1);
      expect((await owner.get(`/playlists/${playlistId}/versions`)).json().items).toHaveLength(1);
      // Une publication demande une recompilation de chaque Display du tenant.
      const jobs = await h.database.system
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.kind, COMPILE_DISPLAY));
      expect(
        jobs.some((job) => (job.payload as { display_id?: string }).display_id === displayId),
      ).toBe(true);
    });

    it('refuse un cycle playlist → composition → playlist', async () => {
      const compo = (
        await owner.request(
          'POST',
          '/compositions',
          { name: 'Zone', width: 1920, height: 1080 },
          key(),
        )
      ).json();
      const doc: CompositionDocument = {
        schema_version: 1,
        canvas: { width: 1920, height: 1080, background: '#000000' },
        elements: [
          {
            id: 'zone',
            type: 'playlist_zone',
            x: 0,
            y: 0,
            width: 960,
            height: 540,
            rotation: 0,
            z_index: 1,
            opacity: 1,
            visible: true,
            locked: false,
            props: { playlist_id: playlistId },
          },
        ],
        settings: { duration_ms: 15000, audio_policy: 'muted' },
      };
      await owner.put(`/compositions/${compo.id}/draft`, { revision: 1, document: doc });
      expect(
        (await owner.post(`/compositions/${compo.id}/publish`, { revision: 2 })).statusCode,
      ).toBe(201);
      const current = (await owner.get(`/playlists/${playlistId}`)).json();
      const document = current.document as PlaylistDocument;
      document.items.push({
        id: randomUUID(),
        content: { type: 'composition', id: compo.id },
        duration_ms: null,
        enabled: true,
        valid_from: null,
        valid_until: null,
      });
      const saved = await owner.put(`/playlists/${playlistId}/draft`, {
        revision: current.draft_revision,
        document,
      });
      expect(saved.json().issues.map((i: { code: string }) => i.code)).toContain('CONTENT_CYCLE');
      const refused = await owner.post(`/playlists/${playlistId}/publish`, {
        revision: current.draft_revision + 1,
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error.details.issues[0].code).toBe('CONTENT_CYCLE');
      // Retour au brouillon publiable.
      document.items.pop();
      await owner.put(`/playlists/${playlistId}/draft`, {
        revision: current.draft_revision + 1,
        document,
      });
    });

    it('bloque la suppression et la purge d’un média utilisé par une playlist publiée', async () => {
      const usages = (await owner.get(`/media/${imageId}/usages`)).json().items;
      expect(usages).toContainEqual(
        expect.objectContaining({ type: 'playlist_version', id: playlistId, blocking: true }),
      );
      expect((await owner.delete(`/media/${imageId}`)).statusCode).toBe(409);
    });
  });

  describe('plannings, campagnes et overrides (PLN-003 à PLN-009)', () => {
    it('valide un planning, publie et annonce les Displays visés', async () => {
      const created = await owner.request('POST', '/schedules', { name: 'Semaine' }, key());
      scheduleId = created.json().id;
      ruleId = randomUUID();
      const document: ProgramDocument = {
        schema_version: 1,
        kind: 'schedule',
        timezone: null,
        targets: ALL as ProgramDocument['targets'],
        rules: [
          {
            id: ruleId,
            content: { type: 'playlist', id: playlistId },
            priority: 10,
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            start_time: '00:00',
            end_time: '24:00',
            start_date: '2026-10-10',
            end_date: '2026-10-01',
          },
        ],
        exceptions: [],
      };
      const saved = await owner.put(`/schedules/${scheduleId}/draft`, { revision: 1, document });
      expect(saved.json().issues.map((i: { code: string }) => i.code)).toContain(
        'DATE_RANGE_INVALID',
      );
      expect(saved.json().targets.count).toBe(1);
      const badPriority = await owner.put(`/schedules/${scheduleId}/draft`, {
        revision: 2,
        document: { ...document, rules: [{ ...document.rules[0], priority: 50 }] },
      });
      expect(badPriority.statusCode).toBe(400);
      const fixed = {
        ...document,
        rules: [
          { ...(document as { rules: object[] }).rules[0], start_date: null, end_date: null },
        ],
      };
      await owner.put(`/schedules/${scheduleId}/draft`, { revision: 2, document: fixed });
      const published = await owner.post(`/schedules/${scheduleId}/publish`, { revision: 3 });
      expect(published.statusCode).toBe(201);
      expect(published.json().targets.displays).toEqual([{ id: displayId, name: 'Vitrine' }]);
      expect(published.json().program.status).toBe('published');
    });

    it('borne les cibles au site du programme', async () => {
      const created = await owner.request(
        'POST',
        '/campaigns',
        { name: 'Lyon seulement', site_id: otherSite },
        key(),
      );
      const id = created.json().id;
      const saved = await owner.put(`/campaigns/${id}/draft`, {
        revision: 1,
        document: {
          schema_version: 1,
          kind: 'campaign',
          content: { type: 'playlist', id: playlistId },
          starts_at: iso(new Date(h.clock.now.getTime() + 3_600_000)),
          ends_at: iso(new Date(h.clock.now.getTime() + 7_200_000)),
          priority: 50,
          targets: { include: [{ type: 'display', id: displayId }], exclude: [] },
        },
      });
      expect(saved.json().issues.map((i: { code: string }) => i.code)).toContain(
        'TARGET_OUT_OF_SCOPE',
      );
      // « Organisation entière » n’étend pas le périmètre d’un programme de site.
      const preview = await owner.post('/targets/preview', { site_id: otherSite, targets: ALL });
      expect(preview.json().count).toBe(0);
    });

    it('un opérateur diffuse immédiatement mais pas en urgence (priorité 100)', async () => {
      await owner.post('/invitations', {
        email: 'operateur@prog.test',
        role: 'Operator',
        scope: { type: 'organization' },
      });
      await h.flushEmails();
      const token = new URL(
        h.mailer.linkFor('operateur@prog.test', '/invitations/accept')!,
      ).searchParams.get('token');
      const operator = await signUp(h, 'operateur@prog.test');
      await operator.post('/invitations/accept', { token });
      operator.organizationId = org.id;
      const body = {
        content: { type: 'media', id: imageId },
        ends_at: iso(new Date(h.clock.now.getTime() + 1_800_000)),
        targets: { include: [{ type: 'display', id: displayId }], exclude: [] },
      };
      expect(
        (await operator.request('POST', '/overrides', { ...body, priority: 100 }, key()))
          .statusCode,
      ).toBe(403);
      const headers = key();
      const created = await operator.request('POST', '/overrides', body, headers);
      expect(created.statusCode).toBe(201);
      expect(created.json().returns_at).toBe(body.ends_at);
      expect(created.json().override.status).toBe('active');
      // Rejeu avec la même clé : même résultat, aucun second override.
      const replay = await operator.request('POST', '/overrides', body, headers);
      expect(replay.json().override.id).toBe(created.json().override.id);
      expect((await owner.get('/overrides?active=true')).json().items).toHaveLength(1);
      // L’opérateur ne peut pas publier de planning.
      expect(
        (await operator.request('POST', '/schedules', { name: 'Interdit' }, key())).statusCode,
      ).toBe(403);
    });

    it('explique la diffusion : override gagnant, planning masqué, puis retour après annulation', async () => {
      const program = await owner.get(`/displays/${displayId}/effective-program`);
      expect(program.statusCode).toBe(200);
      const first = program.json().entries[0];
      expect(first.winner.kind).toBe('override');
      expect(first.masked).toContainEqual(
        expect.objectContaining({
          program_id: scheduleId,
          rule_id: ruleId,
          reason: 'lower_priority',
        }),
      );
      expect(program.json().timezone).toBe('Europe/Paris');
      const overrideId = first.winner.program_id;
      expect((await owner.post(`/overrides/${overrideId}/cancel`)).json().status).toBe('cancelled');
      const after = (await owner.get(`/displays/${displayId}/effective-program`)).json();
      expect(after.entries[0].winner).toMatchObject({ kind: 'schedule', program_id: scheduleId });
      expect(after.programs[scheduleId]).toEqual({ name: 'Semaine', kind: 'schedule' });
      // Simulation d’une date future (PLN-003).
      const future = await owner.get(
        `/displays/${displayId}/effective-program?from=2027-01-01T00:00:00Z&until=2027-01-08T00:00:00Z`,
      );
      expect(future.json().entries[0].winner.program_id).toBe(scheduleId);
      expect(
        (
          await owner.get(
            `/displays/${displayId}/effective-program?from=2027-01-01T00:00:00Z&until=2027-03-01T00:00:00Z`,
          )
        ).statusCode,
      ).toBe(422);
      expect((await rival.get(`/displays/${displayId}/effective-program`)).statusCode).toBe(404);
    });
  });

  describe('manifests, Player et états de livraison (FON-002, PROTO-004, PROTO-013)', () => {
    let manifestId: string;

    it('distribue le manifest signé de l’affectation active, avec ETag', async () => {
      const outcome = await compile();
      expect(outcome.status).toBe('published');
      const response = await playerGet(`/manifest?display_id=${displayId}`);
      expect(response.statusCode).toBe(200);
      const verified = verifyManifest(response.body, new Map([[signer.kid, signer.publicKey]]));
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      manifestId = verified.manifest.manifest_id;
      expect(verified.manifest.player_id).toBe(player.playerId);
      expect(verified.manifest.assets.map((a) => a.id)).toEqual([assetId]);
      const etag = response.headers.etag as string;
      expect(
        (await playerGet(`/manifest?display_id=${displayId}`, { 'if-none-match': etag }))
          .statusCode,
      ).toBe(304);
      expect((await playerGet(`/manifests/${manifestId}`)).statusCode).toBe(200);
      const config = (await player.config()).assignments.find((a) => a.display_id === displayId)!;
      expect(config.manifest_version).toBe(verified.manifest.version);
    });

    it('délivre une URL d’asset seulement pour un asset du manifest autorisé', async () => {
      const url = await playerGet(`/assets/${assetId}/url?manifest_id=${manifestId}`);
      expect(url.statusCode).toBe(200);
      expect(url.json()).toMatchObject({
        asset_id: assetId,
        size_bytes: 1000,
        range_supported: true,
      });
      const other = await readyImage('Hors manifest');
      expect(
        (await playerGet(`/assets/${other.assetId}/url?manifest_id=${manifestId}`)).statusCode,
      ).toBe(404);
    });

    it('suit reçu, préparé et appliqué, sans recul ni état inventé', async () => {
      const delivery = async () => (await owner.get(`/displays/${displayId}/delivery`)).json();
      let state = await delivery();
      expect(state.desired.state).toBe('received');
      expect(state.applied).toBeNull();
      const report = (value: string) =>
        playerPost(`/manifests/${manifestId}/status`, {
          state: value,
          observed_at: iso(h.clock.now),
          error_code: null,
          detail: null,
        });
      expect((await report('ready')).json().state).toBe('ready');
      state = await delivery();
      expect(state.prepared.manifest_id).toBe(manifestId);
      expect(state.applied).toBeNull();
      expect((await report('applied')).json().state).toBe('applied');
      expect((await report('downloading')).json().state).toBe('applied');
      state = await delivery();
      expect(state.applied.manifest_id).toBe(manifestId);
      expect(state.horizon.exhausted_soon).toBe(false);
      expect(state.compilations[0].status).toBe('published');
    });

    it('refuse un manifest à un autre Player, et à une affectation terminée', async () => {
      const intruder = new SimulatedPlayer(h);
      const code = await intruder.register();
      await rival.request(
        'POST',
        '/players/pair',
        { code, name: 'Intrus', site_id: (await rival.get('/sites')).json().items[0].id },
        key(),
      );
      await intruder.poll();
      await intruder.authenticate();
      const stolen = await h.app.inject({
        method: 'GET',
        url: `/player/v1/manifests/${manifestId}`,
        headers: { authorization: `Bearer ${intruder.token}` },
      });
      expect(stolen.statusCode).toBe(404);
      expect((await owner.delete(`/displays/${displayId}/assignment`)).statusCode).toBe(204);
      expect((await playerGet(`/manifest?display_id=${displayId}`)).statusCode).toBe(404);
      expect((await playerGet(`/assets/${assetId}/url?manifest_id=${manifestId}`)).statusCode).toBe(
        404,
      );
      // La purge d’un média encore épinglé par un manifest appliqué reste refusée.
      const [row] = await withTenant(h.database.app, org.id, (tx) =>
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(schema.manifestAssets)
          .where(eq(schema.manifestAssets.mediaAssetId, assetId)),
      );
      expect(row!.n).toBe(1);
    });
  });
});
