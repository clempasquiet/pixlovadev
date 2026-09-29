import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEDIA_LIMITS } from '@pixlova/contracts';
import { schema } from '@pixlova/db';
import { skipDatabaseTests } from '@pixlova/db/testing';
import { StorageUnavailableError } from '@pixlova/storage';
import {
  createMediaWorker,
  DEFAULT_VIDEO_TOOLS,
  expireUploadSessions,
  silentLogger,
  type Worker,
  type WorkerContext,
} from '@pixlova/workers';
import type { Client } from './support/harness.js';
import { createHarness, createOrganization, signUp, type Harness } from './support/harness.js';

function key(): Record<string, string> {
  return { 'idempotency-key': `test-${randomUUID()}` };
}

interface Session {
  upload_id: string;
  media: { id: string; status: string };
  upload: { method: string; url: string; headers: Record<string, string>; expires_at: string };
}

describe.skipIf(skipDatabaseTests)('bibliothèque média (L03)', () => {
  let h: Harness;
  let worker: Worker;
  let ctx: WorkerContext;
  let tmpRoot: string;
  let owner: Client;
  let org: { id: string; siteId: string };
  let rival: Client;
  let jpeg: Buffer;
  let png: Buffer;

  beforeAll(async () => {
    h = await createHarness();
    h.setMaxUsers(10);
    tmpRoot = await mkdtemp(join(tmpdir(), 'pixlova-api-worker-'));
    ctx = {
      appDb: h.database.app,
      systemDb: h.database.system,
      storage: h.storage,
      limits: DEFAULT_MEDIA_LIMITS,
      tools: DEFAULT_VIDEO_TOOLS,
      tmpRoot,
      trashRetentionDays: 30,
      // Horloge du test décalée : les tâches créées avec `now()` de la base sont dues.
      now: () => new Date(h.clock.now.getTime() + 60_000),
      logger: silentLogger,
    };
    worker = createMediaWorker(ctx, { workerId: 'api-test-worker' });
    owner = await signUp(h, 'owner@media.test');
    org = await createOrganization(owner, 'Médiathèque A');
    rival = await signUp(h, 'owner@rival-media.test');
    await createOrganization(rival, 'Médiathèque B');
    jpeg = await sharp({ create: { width: 640, height: 400, channels: 3, background: '#3366aa' } })
      .jpeg()
      .toBuffer();
    png = await sharp({ create: { width: 200, height: 100, channels: 4, background: '#00000080' } })
      .png()
      .toBuffer();
  });
  afterAll(async () => {
    await h?.close();
    if (tmpRoot) await rm(tmpRoot, { recursive: true, force: true });
  });

  async function startUpload(
    client: Client,
    file: Buffer,
    mime = 'image/jpeg',
    extra: Record<string, unknown> = {},
    headers = key(),
  ) {
    return client.request(
      'POST',
      '/media/upload-session',
      {
        filename: `photo-${randomUUID().slice(0, 6)}.jpg`,
        mime_type: mime,
        size_bytes: file.length,
        ...extra,
      },
      headers,
    );
  }

  async function put(session: Session, body: Buffer) {
    return h.app.inject({
      method: 'PUT',
      url: session.upload.url,
      headers: session.upload.headers,
      payload: body,
    });
  }

  async function upload(
    client: Client,
    file: Buffer,
    mime = 'image/jpeg',
    extra: Record<string, unknown> = {},
  ) {
    const started = await startUpload(client, file, mime, extra);
    expect(started.statusCode).toBe(201);
    const session = started.json() as Session;
    expect((await put(session, file)).statusCode).toBe(200);
    const completed = await client.post(`/media/upload-session/${session.upload_id}/complete`);
    expect(completed.statusCode).toBe(202);
    return session;
  }

  async function ready(
    client: Client,
    file: Buffer,
    mime = 'image/jpeg',
    extra: Record<string, unknown> = {},
  ) {
    const session = await upload(client, file, mime, extra);
    await worker.drain();
    return session.media.id;
  }

  describe('upload direct (MED-002, API-007)', () => {
    it('session, envoi signé, finalisation, préparation : média prêt avec variantes', async () => {
      const started = await startUpload(owner, jpeg);
      expect(started.statusCode).toBe(201);
      const session = started.json() as Session;
      expect(session.media).toMatchObject({ status: 'uploading' });
      expect(session.upload).toMatchObject({
        method: 'PUT',
        headers: { 'content-type': 'image/jpeg' },
      });
      expect(session.upload.url).toMatch(
        new RegExp(`^/storage/v1/objects/org/${org.id}/uploads/${session.upload_id}\\?`),
      );
      expect((await owner.get('/media/usage')).json()).toMatchObject({
        reserved_bytes: jpeg.length,
        used_bytes: 0,
      });

      expect((await put(session, jpeg)).statusCode).toBe(200);
      const completed = await owner.post(`/media/upload-session/${session.upload_id}/complete`);
      expect(completed.statusCode).toBe(202);
      expect(completed.json()).toMatchObject({ status: 'processing' });
      expect((await owner.get('/media/usage')).json()).toMatchObject({
        reserved_bytes: 0,
        used_bytes: jpeg.length,
      });
      // Finalisation rejouée : même résultat, pas de double consommation.
      expect(
        (await owner.post(`/media/upload-session/${session.upload_id}/complete`)).statusCode,
      ).toBe(202);
      expect((await owner.get('/media/usage')).json()).toMatchObject({ used_bytes: jpeg.length });

      await worker.drain();
      const media = (await owner.get(`/media/${session.media.id}`)).json();
      expect(media).toMatchObject({
        status: 'ready',
        width: 640,
        height: 400,
        mime_type: 'image/jpeg',
        usages: [],
      });
      expect(media.assets.map((a: { variant: string }) => a.variant).sort()).toEqual([
        'original',
        'playback',
        'thumbnail',
      ]);
      expect(media.thumbnail_url).toMatch(/^\/storage\/v1\/objects\/.*op=get/);
      const thumbnail = await h.app.inject({ method: 'GET', url: media.thumbnail_url });
      expect(thumbnail.statusCode).toBe(200);
      expect(thumbnail.headers['content-type']).toBe('image/webp');

      const url = (await owner.get(`/media/${session.media.id}/assets/original/url`)).json();
      expect(url).toMatchObject({
        mime_type: 'image/jpeg',
        size_bytes: jpeg.length,
        accepts_ranges: true,
      });
      const range = await h.app.inject({
        method: 'GET',
        url: url.url,
        headers: { range: 'bytes=0-1' },
      });
      expect(range.statusCode).toBe(206);
      expect(range.rawPayload).toEqual(jpeg.subarray(0, 2));
    });

    it('format non accepté (415), trop volumineux (413), clé d’idempotence requise', async () => {
      expect((await startUpload(owner, jpeg, 'image/gif')).statusCode).toBe(415);
      expect((await startUpload(owner, jpeg, 'image/svg+xml')).statusCode).toBe(415);
      const big = await owner.request(
        'POST',
        '/media/upload-session',
        {
          filename: 'x.jpg',
          mime_type: 'image/jpeg',
          size_bytes: DEFAULT_MEDIA_LIMITS.imageMaxBytes + 1,
        },
        key(),
      );
      expect(big.statusCode).toBe(413);
      expect(big.json().error).toMatchObject({
        code: 'FILE_TOO_LARGE',
        details: { max_bytes: DEFAULT_MEDIA_LIMITS.imageMaxBytes },
      });
      expect((await startUpload(owner, jpeg, 'image/jpeg', {}, {})).statusCode).toBe(400);
    });

    it('requête rejouée avec la même clé : même session, une seule réservation', async () => {
      const before = (await owner.get('/media/usage')).json().reserved_bytes;
      const headers = key();
      const first = await startUpload(owner, jpeg, 'image/jpeg', { filename: 'same.jpg' }, headers);
      const second = await startUpload(
        owner,
        jpeg,
        'image/jpeg',
        { filename: 'same.jpg' },
        headers,
      );
      expect(second.json().upload_id).toBe(first.json().upload_id);
      expect((await owner.get('/media/usage')).json().reserved_bytes).toBe(before + jpeg.length);
      await owner.post(`/media/upload-session/${first.json().upload_id}/abort`);
      expect((await owner.get('/media/usage')).json().reserved_bytes).toBe(before);
    });

    it('fichier non reçu ou de mauvaise taille : finalisation refusée, envoi signé borné', async () => {
      const session = (await startUpload(owner, jpeg)).json() as Session;
      const early = await owner.post(`/media/upload-session/${session.upload_id}/complete`);
      expect(early.statusCode).toBe(422);
      expect(early.json().error.code).toBe('UPLOAD_INCOMPLETE');
      expect((await put(session, jpeg.subarray(0, 100))).statusCode).toBe(400);
      expect((await put(session, Buffer.concat([jpeg, jpeg]))).statusCode).toBe(400);
      const wrongType = await h.app.inject({
        method: 'PUT',
        url: session.upload.url,
        headers: { 'content-type': 'image/png' },
        payload: jpeg,
      });
      expect(wrongType.statusCode).toBe(400);
      expect((await put(session, jpeg)).statusCode).toBe(200);
      expect(
        (await owner.post(`/media/upload-session/${session.upload_id}/complete`)).statusCode,
      ).toBe(202);
      await worker.drain();
    });

    it('stockage indisponible à la finalisation : 503 réessayable, rien de consommé', async () => {
      const session = (await startUpload(owner, jpeg)).json() as Session;
      await put(session, jpeg);
      const spy = vi
        .spyOn(h.storage, 'head')
        .mockRejectedValueOnce(new StorageUnavailableError('panne'));
      const failed = await owner.post(`/media/upload-session/${session.upload_id}/complete`);
      spy.mockRestore();
      expect(failed.statusCode).toBe(503);
      expect(failed.json().error).toMatchObject({ code: 'STORAGE_UNAVAILABLE', retryable: true });
      expect((await owner.get(`/media/${session.media.id}`)).json().status).toBe('uploading');
      expect(
        (await owner.post(`/media/upload-session/${session.upload_id}/complete`)).statusCode,
      ).toBe(202);
      await worker.drain();
    });

    it('session expirée : finalisation refusée, réservation libérée, média écarté', async () => {
      const session = (await startUpload(owner, jpeg)).json() as Session;
      const reserved = (await owner.get('/media/usage')).json().reserved_bytes;
      h.clock.advance(16 * 60_000);
      expect((await put(session, jpeg)).statusCode).toBe(403);
      expect(await expireUploadSessions(ctx)).toBeGreaterThanOrEqual(1);
      const late = await owner.post(`/media/upload-session/${session.upload_id}/complete`);
      expect(late.statusCode).toBe(409);
      expect(late.json().error.code).toBe('UPLOAD_SESSION_CLOSED');
      expect((await owner.get('/media/usage')).json().reserved_bytes).toBe(reserved - jpeg.length);
      const trash = (await owner.get('/media?trash=true'))
        .json()
        .items.map((m: { id: string }) => m.id);
      expect(trash).not.toContain(session.media.id);
    });
  });

  describe('quotas (DATA-008, BILL-005)', () => {
    it('derniers octets réservés sous concurrence : une seule session acceptée', async () => {
      const used = (await owner.get('/media/usage')).json();
      h.setStorageBytes(used.used_bytes + used.reserved_bytes + 1000);
      const results = await Promise.all([
        owner.request(
          'POST',
          '/media/upload-session',
          { filename: 'a.jpg', mime_type: 'image/jpeg', size_bytes: 600 },
          key(),
        ),
        owner.request(
          'POST',
          '/media/upload-session',
          { filename: 'b.jpg', mime_type: 'image/jpeg', size_bytes: 600 },
          key(),
        ),
        owner.request(
          'POST',
          '/media/upload-session',
          { filename: 'c.jpg', mime_type: 'image/jpeg', size_bytes: 600 },
          key(),
        ),
      ]);
      const statuses = results.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([201, 409, 409]);
      const refused = results.find((r) => r.statusCode === 409)!;
      expect(refused.json().error.code).toBe('STORAGE_QUOTA_EXCEEDED');
      const accepted = results.find((r) => r.statusCode === 201)!.json() as Session;
      await owner.post(`/media/upload-session/${accepted.upload_id}/abort`);
      expect((await startUpload(owner, Buffer.alloc(600), 'image/jpeg')).statusCode).toBe(201);
      h.setStorageBytes(2_000_000_000);
    });
  });

  describe('isolation entre organisations (SEC-003, TST-002)', () => {
    it('une autre organisation ne voit, ne finalise ni ne lit aucun média', async () => {
      const session = (await startUpload(owner, jpeg)).json() as Session;
      await put(session, jpeg);
      expect(
        (await rival.post(`/media/upload-session/${session.upload_id}/complete`)).statusCode,
      ).toBe(404);
      expect(
        (await rival.post(`/media/upload-session/${session.upload_id}/abort`)).statusCode,
      ).toBe(404);
      await owner.post(`/media/upload-session/${session.upload_id}/complete`);
      await worker.drain();
      const id = session.media.id;
      for (const path of [
        `/media/${id}`,
        `/media/${id}/usages`,
        `/media/${id}/assets/original/url`,
      ]) {
        expect((await rival.get(path)).statusCode).toBe(404);
      }
      expect((await rival.patch(`/media/${id}`, { name: 'volé' })).statusCode).toBe(404);
      expect((await rival.delete(`/media/${id}`)).statusCode).toBe(404);
      expect((await rival.post(`/media/${id}/retry`)).statusCode).toBe(404);
      expect((await rival.get('/media')).json().items).toEqual([]);
      // Désigner l’organisation voisine sans en être membre : refus sans divulgation.
      const forged = await rival.request('GET', `/media/${id}`, undefined, {
        'x-organization-id': org.id,
      });
      expect(forged.statusCode).toBe(404);
    });

    it('une URL signée ne s’applique qu’à sa clé et expire', async () => {
      const id = await ready(owner, jpeg);
      const url = (await owner.get(`/media/${id}/assets/original/url`)).json().url as string;
      const forged = url.replace(`/org/${org.id}/`, `/org/${randomUUID()}/`);
      expect((await h.app.inject({ method: 'GET', url: forged })).statusCode).toBe(403);
      const traversal = url.replace('/storage/v1/objects/', '/storage/v1/objects/../');
      expect(
        (await h.app.inject({ method: 'GET', url: traversal })).statusCode,
      ).toBeGreaterThanOrEqual(400);
      h.clock.advance(6 * 60_000);
      const expired = await h.app.inject({ method: 'GET', url });
      expect(expired.statusCode).toBe(403);
      expect(expired.json().error.code).toBe('URL_EXPIRED');
    });
  });

  describe('corbeille, restauration, purge (MED-008)', () => {
    it('suppression logique, restauration avec la même identité, purge définitive et quota libéré', async () => {
      const id = await ready(owner, png, 'image/png');
      const usage = (await owner.get('/media/usage')).json().used_bytes;
      expect((await owner.post(`/media/${id}/purge`)).statusCode).toBe(409);
      expect((await owner.delete(`/media/${id}`)).statusCode).toBe(204);
      expect(
        (await owner.get('/media')).json().items.map((m: { id: string }) => m.id),
      ).not.toContain(id);
      const trashed = (await owner.get('/media?trash=true'))
        .json()
        .items.find((m: { id: string }) => m.id === id);
      expect(trashed).toMatchObject({
        deleted_at: expect.any(String),
        purge_after: expect.any(String),
      });
      expect((await owner.patch(`/media/${id}`, { name: 'x' })).statusCode).toBe(409);
      // La corbeille compte dans le quota (ADR-009).
      expect((await owner.get('/media/usage')).json().used_bytes).toBe(usage);

      const restored = await owner.post(`/media/${id}/restore`);
      expect(restored.statusCode).toBe(200);
      expect(restored.json()).toMatchObject({ id, status: 'ready', deleted_at: null });

      await owner.delete(`/media/${id}`);
      const assets = await h.database.system
        .select()
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.mediaId, id));
      expect((await owner.post(`/media/${id}/purge`)).statusCode).toBe(202);
      await worker.drain();
      expect((await owner.get(`/media/${id}`)).statusCode).toBe(404);
      expect((await owner.post(`/media/${id}/restore`)).statusCode).toBe(404);
      for (const asset of assets) expect(await h.storage.head(asset.storageKey)).toBeNull();
      expect((await owner.get('/media/usage')).json().used_bytes).toBe(usage - png.length);

      const actions = (await owner.get('/audit?limit=200'))
        .json()
        .items.map((e: { action: string }) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          'media.upload_started',
          'media.uploaded',
          'media.deleted',
          'media.restored',
          'media.purge_requested',
          'media.purged',
        ]),
      );
    });

    it('purge engagée : restauration refusée', async () => {
      const id = await ready(owner, png, 'image/png');
      await owner.delete(`/media/${id}`);
      await h.database.system
        .update(schema.media)
        .set({ purgeStartedAt: new Date() })
        .where(eq(schema.media.id, id));
      const refused = await owner.post(`/media/${id}/restore`);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error.code).toBe('MEDIA_PURGING');
    });
  });

  describe('échec de préparation et nouvel essai (MED-003)', () => {
    it('fichier non conforme : erreur visible, nouvel essai contrôlé', async () => {
      const text = Buffer.from('pas une image '.repeat(50));
      const session = await upload(owner, text, 'image/jpeg');
      await worker.drain();
      const failed = (await owner.get(`/media/${session.media.id}`)).json();
      expect(failed).toMatchObject({
        status: 'error',
        error: { code: 'UNSUPPORTED_FORMAT' },
        assets: [],
      });
      expect((await owner.post(`/media/${session.media.id}/retry`)).statusCode).toBe(202);
      expect((await owner.get(`/media/${session.media.id}`)).json().status).toBe('processing');
      await worker.drain();
      expect((await owner.get(`/media/${session.media.id}`)).json().status).toBe('error');
      const readyId = await ready(owner, jpeg);
      expect((await owner.post(`/media/${readyId}/retry`)).statusCode).toBe(409);
    });
  });

  describe('dossiers, tags, recherche (MED-001)', () => {
    it('arborescence sans cycle, noms uniques, suppression d’un dossier vide seulement', async () => {
      const campagnes = (await owner.post('/media-folders', { name: 'Campagnes' })).json();
      const ete = (
        await owner.post('/media-folders', { name: 'Été', parent_id: campagnes.id })
      ).json();
      expect((await owner.post('/media-folders', { name: 'campagnes' })).statusCode).toBe(409);
      const cycle = await owner.patch(`/media-folders/${campagnes.id}`, { parent_id: ete.id });
      expect(cycle.statusCode).toBe(422);
      expect(cycle.json().error.code).toBe('FOLDER_CYCLE');
      const id = await ready(owner, jpeg, 'image/jpeg', { folder_id: ete.id, name: 'Affiche été' });
      expect(
        (await owner.get(`/media?folder_id=${ete.id}`))
          .json()
          .items.map((m: { id: string }) => m.id),
      ).toEqual([id]);
      expect((await owner.delete(`/media-folders/${ete.id}`)).statusCode).toBe(409);
      await owner.patch(`/media/${id}`, { folder_id: null, tags: ['Été', 'promo', 'PROMO'] });
      expect((await owner.delete(`/media-folders/${ete.id}`)).statusCode).toBe(204);
      expect(
        (await owner.get('/media?tag=promo')).json().items.map((m: { id: string }) => m.id),
      ).toEqual([id]);
      expect((await owner.get(`/media/${id}`)).json().tags.sort()).toEqual(['promo', 'Été'].sort());
      expect((await owner.get('/tags')).json().items).toEqual(
        expect.arrayContaining(['Été', 'promo']),
      );
      expect(
        (await owner.get('/media?q=affiche')).json().items.map((m: { id: string }) => m.id),
      ).toEqual([id]);
      expect((await owner.get('/media?q=%25')).json().items).toEqual([]);
      expect((await rival.get('/tags')).json().items).toEqual([]);
    });

    it('pagination par curseur stable', async () => {
      const first = (await owner.get('/media?limit=2')).json();
      expect(first.items).toHaveLength(2);
      expect(first.has_more).toBe(true);
      const second = (await owner.get(`/media?limit=2&cursor=${first.next_cursor}`)).json();
      const ids = [...first.items, ...second.items].map((m: { id: string }) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect((await owner.get('/media?cursor=invalide')).statusCode).toBe(400);
    });
  });

  describe('rôles et périmètre par site (ADR-007, ADR-009)', () => {
    it('gestionnaire limité à un site, lecteur sans écriture', async () => {
      const lyon = (await owner.post('/sites', { name: 'Lyon' })).json().id as string;
      const invite = async (email: string, role: string, scope: unknown) => {
        await owner.post('/invitations', { email, role, scope });
        await h.flushEmails();
        const token = new URL(h.mailer.linkFor(email, '/invitations/accept')!).searchParams.get(
          'token',
        );
        const client = await signUp(h, email);
        await client.post('/invitations/accept', { token });
        client.organizationId = org.id;
        return client;
      };
      const manager = await invite('contenus@media.test', 'ContentManager', {
        type: 'sites',
        site_ids: [lyon],
      });
      const viewer = await invite('lecteur@media.test', 'Viewer', { type: 'organization' });

      expect((await startUpload(manager, jpeg)).statusCode).toBe(403);
      const local = await ready(manager, jpeg, 'image/jpeg', { site_id: lyon });
      const listed = (await manager.get('/media'))
        .json()
        .items.map((m: { id: string; site_id: string }) => m.site_id);
      expect(new Set(listed)).toEqual(new Set([lyon]));
      const orgWide = (await owner.get('/media?limit=1'))
        .json()
        .items.find((m: { site_id: string | null }) => m.site_id === null);
      if (orgWide) expect((await manager.get(`/media/${orgWide.id}`)).statusCode).toBe(404);
      expect((await manager.post('/media-folders', { name: 'Siège' })).statusCode).toBe(403);
      expect(
        (await manager.post('/media-folders', { name: 'Vitrines Lyon', site_id: lyon })).statusCode,
      ).toBe(201);

      expect((await viewer.get(`/media/${local}`)).statusCode).toBe(200);
      expect((await startUpload(viewer, jpeg)).statusCode).toBe(403);
      expect((await viewer.delete(`/media/${local}`)).statusCode).toBe(403);
    });
  });
});
