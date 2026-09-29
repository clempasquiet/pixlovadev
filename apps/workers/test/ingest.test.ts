import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { text } from 'node:stream/consumers';
import { claimJob, enqueueJob, lockUsage, schema, withTenant } from '@pixlova/db';
import { skipDatabaseTests } from '@pixlova/db/testing';
import { uploadObjectKey } from '@pixlova/storage';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MEDIA_INGEST,
  MEDIA_PURGE,
  cleanQuarantine,
  expireUploadSessions,
  schedulePurges,
} from '../src/index.js';
import {
  completedUpload,
  createFixtures,
  createHarness,
  mediaState,
  type Fixtures,
  type Harness,
} from './support.js';

const sha256 = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

describe.skipIf(skipDatabaseTests)('worker média : préparation (MED-003, MED-004, SEC-014)', () => {
  let fx: Fixtures;
  let h: Harness;

  beforeAll(async () => {
    fx = await createFixtures();
    h = await createHarness();
  }, 120_000);
  afterAll(async () => {
    await h?.close();
    if (fx) await rm(fx.dir, { recursive: true, force: true });
  });

  async function process(file: string, options: Parameters<typeof completedUpload>[2] = {}) {
    const mediaId = await completedUpload(h, file, options);
    await h.worker.drain();
    return { mediaId, ...(await mediaState(h, mediaId)) };
  }

  it('image JPEG compatible : original copié hors quarantaine, lecture sans ré-encodage, vignette', async () => {
    const { media, assets } = await process(fx.jpeg);
    expect(media).toMatchObject({
      status: 'ready',
      mimeType: 'image/jpeg',
      width: 1200,
      height: 800,
      checksumSha256: await sha256(fx.jpeg),
    });
    expect(assets.original!.storageKey).toMatch(/\/media\/.+\/original-[0-9a-f]{16}\.jpg$/);
    expect(assets.playback).toMatchObject({
      profile: 'passthrough',
      storageKey: assets.original!.storageKey,
    });
    expect(assets.thumbnail).toMatchObject({
      profile: 'webp-thumb-480-v1',
      mimeType: 'image/webp',
      width: 480,
      height: 320,
    });
    // Chaque variante stockée correspond à son checksum enregistré.
    const stored = await h.local.read(assets.thumbnail!.storageKey);
    const bytes = Buffer.from(await text(stored), 'latin1');
    expect(bytes.length).toBeGreaterThan(0);
    expect((await h.local.head(assets.thumbnail!.storageKey))?.size).toBe(
      assets.thumbnail!.sizeBytes,
    );
  });

  it('orientation EXIF : dimensions affichées et variante normalisée', async () => {
    const { media, assets } = await process(fx.jpegRotated);
    expect(media).toMatchObject({ status: 'ready', width: 800, height: 1200 });
    expect(assets.playback).toMatchObject({
      profile: 'image-normalized-v1',
      width: 800,
      height: 1200,
    });
    expect(assets.playback!.storageKey).not.toBe(assets.original!.storageKey);
    const meta = await sharp(fx.jpegRotated).metadata();
    expect(meta.orientation).toBe(6);
  });

  it('PNG avec transparence et WebP acceptés', async () => {
    expect((await process(fx.pngAlpha, { declaredMimeType: 'image/png' })).media).toMatchObject({
      status: 'ready',
      mimeType: 'image/png',
    });
    expect((await process(fx.webp, { declaredMimeType: 'image/webp' })).media).toMatchObject({
      status: 'ready',
      mimeType: 'image/webp',
    });
  });

  it.each([
    ['GIF', 'gif', 'UNSUPPORTED_FORMAT'],
    ['texte déclaré JPEG', 'text', 'UNSUPPORTED_FORMAT'],
    ['JPEG tronqué', 'truncatedJpeg', 'CORRUPTED_FILE'],
    ['image trop large', 'tooWide', 'LIMIT_EXCEEDED'],
  ] as const)('%s : erreur définitive, aucune variante', async (_label, key, code) => {
    const { media, assets } = await process(fx[key]);
    expect(media).toMatchObject({ status: 'error', errorCode: code });
    expect(assets).toEqual({});
    const [job] = await h.db.system
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.kind, MEDIA_INGEST), eq(schema.jobs.dedupeKey, media!.id)));
    expect(job).toMatchObject({ state: 'failed', attempts: 1 });
  });

  it('une image déclarée vidéo est refusée (type réel)', async () => {
    const { media } = await process(fx.pngAlpha, { type: 'video', declaredMimeType: 'video/mp4' });
    expect(media).toMatchObject({ status: 'error', errorCode: 'TYPE_MISMATCH' });
  });

  it('SHA-256 client différent : refus', async () => {
    const { media } = await process(fx.jpeg, { clientChecksumSha256: 'a'.repeat(64) });
    expect(media).toMatchObject({ status: 'error', errorCode: 'CHECKSUM_MISMATCH' });
  });

  it('fichier reçu plus court que déclaré : refus', async () => {
    const { media } = await process(fx.jpeg, { declaredSize: 10_000_000 });
    expect(media).toMatchObject({ status: 'error', errorCode: 'UPLOAD_SIZE_MISMATCH' });
  });

  it('vidéo MP4 H.264/AAC : diffusée telle quelle après décodage complet', async () => {
    const { media, assets } = await process(fx.mp4, {
      type: 'video',
      declaredMimeType: 'video/mp4',
    });
    expect(media).toMatchObject({
      status: 'ready',
      mimeType: 'video/mp4',
      width: 640,
      height: 360,
    });
    expect(media!.durationMs).toBeGreaterThan(1900);
    expect(media!.metadata).toMatchObject({ video_codec: 'h264', playback_incompatibilities: [] });
    expect(assets.playback).toMatchObject({
      profile: 'passthrough',
      storageKey: assets.original!.storageKey,
    });
    expect(assets.thumbnail).toMatchObject({ mimeType: 'image/webp', width: 480, height: 270 });
  });

  it('vidéo WebM VP8/Opus : transcodée en H.264/AAC', async () => {
    const { media, assets } = await process(fx.webm, {
      type: 'video',
      declaredMimeType: 'video/webm',
    });
    expect(media).toMatchObject({
      status: 'ready',
      mimeType: 'video/webm',
      width: 320,
      height: 240,
    });
    expect(assets.playback).toMatchObject({
      profile: 'h264-aac-mp4-v1',
      mimeType: 'video/mp4',
      width: 320,
      height: 240,
    });
    expect(assets.playback!.codecMetadata).toMatchObject({
      video_codec: 'h264',
      audio: ['aac'],
      reasons: expect.arrayContaining(['container', 'video_codec', 'audio_codec']),
    });
  });

  it('vidéo avec rotation : transcodée, dimensions affichées 360×640', async () => {
    const { media, assets } = await process(fx.mp4Rotated, {
      type: 'video',
      declaredMimeType: 'video/mp4',
    });
    expect(media).toMatchObject({ status: 'ready', width: 360, height: 640 });
    expect(assets.playback).toMatchObject({ profile: 'h264-aac-mp4-v1', width: 360, height: 640 });
  });

  it('MP4 tronqué : erreur définitive', async () => {
    const { media } = await process(fx.truncatedMp4, {
      type: 'video',
      declaredMimeType: 'video/mp4',
    });
    expect(media).toMatchObject({ status: 'error', errorCode: 'CORRUPTED_FILE' });
  });

  it('stockage indisponible : reprise différée, puis succès sans doublon', async () => {
    const mediaId = await completedUpload(h, fx.jpeg);
    h.storage.failures = 1;
    await h.worker.drain();
    let state = await mediaState(h, mediaId);
    expect(state.media).toMatchObject({ status: 'processing' });
    const [job] = await h.db.system
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.kind, MEDIA_INGEST), eq(schema.jobs.dedupeKey, mediaId)));
    expect(job).toMatchObject({ state: 'queued', attempts: 1 });
    expect(job!.lastError).toMatch(/StorageUnavailableError/);
    expect(await h.worker.drain()).toBe(0);
    h.clock.advance(16_000);
    expect(await h.worker.drain()).toBe(1);
    state = await mediaState(h, mediaId);
    expect(state.media).toMatchObject({ status: 'ready' });
  });

  it('worker arrêté en cours de tâche : reprise par un autre après expiration du bail', async () => {
    const mediaId = await completedUpload(h, fx.jpeg);
    const lost = await claimJob(h.db.system, {
      workerId: 'worker-mort',
      kinds: [MEDIA_INGEST],
      leaseSeconds: 60,
      now: h.clock.now,
    });
    expect(lost).not.toBeNull();
    expect(await h.worker.drain()).toBe(0);
    h.clock.advance(61_000);
    expect(await h.worker.drain()).toBe(1);
    expect((await mediaState(h, mediaId)).media).toMatchObject({ status: 'ready' });
  });

  it('fichier qui fait tomber le worker à chaque essai : clos en erreur', async () => {
    const mediaId = await completedUpload(h, fx.jpeg);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        await claimJob(h.db.system, {
          workerId: `crash-${attempt}`,
          kinds: [MEDIA_INGEST],
          leaseSeconds: 60,
          now: h.clock.now,
        }),
      ).not.toBeNull();
      h.clock.advance(61_000);
    }
    await h.worker.drain();
    expect((await mediaState(h, mediaId)).media).toMatchObject({
      status: 'error',
      errorCode: 'PROCESSING_FAILED',
    });
  });

  it('préparation rejouée : variantes inchangées, aucun doublon', async () => {
    const { mediaId, assets } = await process(fx.mp4, {
      type: 'video',
      declaredMimeType: 'video/mp4',
    });
    await withTenant(h.db.app, h.organizationId, async (tx) => {
      await tx
        .update(schema.media)
        .set({ status: 'processing' })
        .where(eq(schema.media.id, mediaId));
      await enqueueJob(tx, {
        organizationId: h.organizationId,
        kind: MEDIA_INGEST,
        dedupeKey: mediaId,
        payload: { mediaId },
      });
    });
    await h.worker.drain();
    const again = await mediaState(h, mediaId);
    expect(again.media).toMatchObject({ status: 'ready' });
    expect(
      Object.values(again.assets)
        .map((a) => a.id)
        .sort(),
    ).toEqual(
      Object.values(assets)
        .map((a) => a.id)
        .sort(),
    );
  });

  it('binaire définitif altéré dans le stockage : détecté à la reprise', async () => {
    const { mediaId, assets } = await process(fx.jpeg);
    await h.local.writeFile(assets.original!.storageKey, fx.webp, 'image/jpeg');
    await withTenant(h.db.app, h.organizationId, async (tx) => {
      await tx
        .delete(schema.mediaAssets)
        .where(
          and(eq(schema.mediaAssets.mediaId, mediaId), eq(schema.mediaAssets.variant, 'thumbnail')),
        );
      await tx
        .update(schema.media)
        .set({ status: 'processing' })
        .where(eq(schema.media.id, mediaId));
      await enqueueJob(tx, {
        organizationId: h.organizationId,
        kind: MEDIA_INGEST,
        dedupeKey: mediaId,
        payload: { mediaId },
      });
    });
    await h.worker.drain();
    expect((await mediaState(h, mediaId)).media).toMatchObject({
      status: 'error',
      errorCode: expect.stringMatching(/CORRUPTED_FILE|UPLOAD_SIZE_MISMATCH/),
    });
  });
});

describe.skipIf(skipDatabaseTests)(
  'worker média : quarantaine, expiration et purge (MED-008)',
  () => {
    let fx: Fixtures;
    let h: Harness;

    beforeAll(async () => {
      fx = await createFixtures();
      h = await createHarness();
    }, 120_000);
    afterAll(async () => {
      await h?.close();
      if (fx) await rm(fx.dir, { recursive: true, force: true });
    });

    it('quarantaine supprimée après copie et expiration de l’URL d’envoi', async () => {
      const mediaId = await completedUpload(h, fx.jpeg);
      await h.worker.drain();
      const [session] = await h.db.system
        .select()
        .from(schema.uploadSessions)
        .where(eq(schema.uploadSessions.mediaId, mediaId));
      expect(await h.local.head(session!.objectKey)).not.toBeNull();
      expect(await cleanQuarantine(h.ctx)).toBe(0);
      h.clock.advance(16 * 60_000);
      expect(await cleanQuarantine(h.ctx)).toBeGreaterThanOrEqual(1);
      expect(await h.local.head(session!.objectKey)).toBeNull();
      expect((await mediaState(h, mediaId)).media).toMatchObject({ status: 'ready' });
    });

    it('session non finalisée : réservation libérée, média purgé', async () => {
      const mediaId = crypto.randomUUID();
      const uploadId = crypto.randomUUID();
      await withTenant(h.db.app, h.organizationId, async (tx) => {
        await tx.insert(schema.media).values({
          id: mediaId,
          organizationId: h.organizationId,
          name: 'abandon',
          type: 'image',
          declaredMimeType: 'image/png',
          originalFilename: 'abandon.png',
        });
        await tx.insert(schema.uploadSessions).values({
          id: uploadId,
          organizationId: h.organizationId,
          mediaId,
          objectKey: uploadObjectKey(h.organizationId, uploadId),
          declaredSize: 5000,
          declaredMimeType: 'image/png',
          reservedBytes: 5000,
          expiresAt: new Date(h.clock.now.getTime() + 60_000),
        });
        const { adjustUsage } = await import('@pixlova/db');
        await adjustUsage(tx, h.organizationId, 'storage_bytes', { reserved: 5000 }, h.clock.now);
      });
      const before = await withTenant(h.db.app, h.organizationId, (tx) =>
        lockUsage(tx, h.organizationId, 'storage_bytes'),
      );
      h.clock.advance(2 * 60_000);
      expect(await expireUploadSessions(h.ctx)).toBe(1);
      const after = await withTenant(h.db.app, h.organizationId, (tx) =>
        lockUsage(tx, h.organizationId, 'storage_bytes'),
      );
      expect(after.reserved).toBe(before.reserved - 5000);
      expect((await mediaState(h, mediaId)).media).toMatchObject({
        status: 'error',
        errorCode: 'UPLOAD_EXPIRED',
      });
      expect(await schedulePurges(h.ctx)).toBe(1);
      await h.worker.drain();
      expect((await mediaState(h, mediaId)).media).toBeUndefined();
    });

    it('corbeille à échéance : objets, lignes et quota supprimés ; audit système', async () => {
      const mediaId = await completedUpload(h, fx.mp4, {
        type: 'video',
        declaredMimeType: 'video/mp4',
      });
      await h.worker.drain();
      const { media, assets } = await mediaState(h, mediaId);
      const keys = Object.values(assets).map((a) => a.storageKey);
      const usageBefore = await withTenant(h.db.app, h.organizationId, (tx) =>
        lockUsage(tx, h.organizationId, 'storage_bytes'),
      );
      await withTenant(h.db.app, h.organizationId, (tx) =>
        tx
          .update(schema.media)
          .set({ deletedAt: h.clock.now, purgeAfter: new Date(h.clock.now.getTime() + 86_400_000) })
          .where(eq(schema.media.id, mediaId)),
      );
      expect(await schedulePurges(h.ctx)).toBe(0);
      h.clock.advance(86_400_000 + 1000);
      expect(await schedulePurges(h.ctx)).toBe(1);
      expect(await schedulePurges(h.ctx)).toBe(0);
      await h.worker.drain();
      expect((await mediaState(h, mediaId)).media).toBeUndefined();
      for (const key of keys) expect(await h.local.head(key)).toBeNull();
      const usageAfter = await withTenant(h.db.app, h.organizationId, (tx) =>
        lockUsage(tx, h.organizationId, 'storage_bytes'),
      );
      expect(usageAfter.observed).toBe(usageBefore.observed - media!.quotaBytes);
      const audit = await withTenant(h.db.app, h.organizationId, (tx) =>
        tx
          .select()
          .from(schema.auditLogs)
          .where(
            and(
              eq(schema.auditLogs.action, 'media.purged'),
              eq(schema.auditLogs.targetId, mediaId),
            ),
          ),
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorType: 'system', result: 'success' });
    });

    it('média restauré avant la purge : conservé', async () => {
      const mediaId = await completedUpload(h, fx.jpeg);
      await h.worker.drain();
      await withTenant(h.db.app, h.organizationId, async (tx) => {
        await tx
          .update(schema.media)
          .set({ deletedAt: h.clock.now, purgeAfter: h.clock.now })
          .where(eq(schema.media.id, mediaId));
        await enqueueJob(tx, {
          organizationId: h.organizationId,
          kind: MEDIA_PURGE,
          dedupeKey: mediaId,
          payload: { mediaId },
        });
        await tx
          .update(schema.media)
          .set({ deletedAt: null, purgeAfter: null })
          .where(eq(schema.media.id, mediaId));
      });
      await h.worker.drain();
      expect((await mediaState(h, mediaId)).media).toMatchObject({
        status: 'ready',
        purgeStartedAt: null,
      });
    });

    it('stockage indisponible pendant la purge : reprise, rien de perdu entre-temps', async () => {
      const mediaId = await completedUpload(h, fx.jpeg);
      await h.worker.drain();
      await withTenant(h.db.app, h.organizationId, async (tx) => {
        await tx
          .update(schema.media)
          .set({ deletedAt: h.clock.now, purgeAfter: h.clock.now })
          .where(eq(schema.media.id, mediaId));
        await enqueueJob(tx, {
          organizationId: h.organizationId,
          kind: MEDIA_PURGE,
          dedupeKey: mediaId,
          payload: { mediaId },
        });
      });
      h.storage.failures = 1;
      await h.worker.drain();
      const pending = (await mediaState(h, mediaId)).media;
      expect(pending).toMatchObject({ purgeStartedAt: expect.any(Date) });
      h.clock.advance(16_000);
      await h.worker.drain();
      expect((await mediaState(h, mediaId)).media).toBeUndefined();
    });
  },
);

describe('durcissement du décodage d’images', () => {
  it('seuls les décodeurs JPEG, PNG et WebP depuis un fichier restent actifs', async () => {
    const { hardenImageDecoder } = await import('../src/index.js');
    hardenImageDecoder();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    await expect(sharp(svg).metadata()).rejects.toThrow();
  });
});
