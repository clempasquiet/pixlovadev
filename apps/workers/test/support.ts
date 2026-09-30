import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MEDIA_LIMITS } from '@pixlova/contracts';
import { adjustUsage, enqueueJob, schema, withTenant } from '@pixlova/db';
import { createTestDatabase, type TestDatabase } from '@pixlova/db/testing';
import {
  LocalObjectStorage,
  StorageUnavailableError,
  uploadObjectKey,
  type ObjectStorage,
} from '@pixlova/storage';
import { ed25519 } from '@noble/curves/ed25519.js';
import { encodeBase64url } from '@pixlova/contracts';
import { manifestSignerFromSeed } from '@pixlova/scheduling/compiler';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import {
  createMediaWorker,
  DEFAULT_VIDEO_TOOLS,
  MEDIA_INGEST,
  silentLogger,
  type Worker,
  type WorkerContext,
} from '../src/index.js';

/** Fichiers de test générés localement (TST-002) : aucun média client dans le dépôt. */
export interface Fixtures {
  dir: string;
  jpeg: string;
  jpegRotated: string;
  pngAlpha: string;
  webp: string;
  gif: string;
  tooWide: string;
  truncatedJpeg: string;
  text: string;
  mp4: string;
  mp4Rotated: string;
  webm: string;
  truncatedMp4: string;
}

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-y', ...args]);
}

export async function createFixtures(): Promise<Fixtures> {
  const dir = await mkdtemp(join(tmpdir(), 'pixlova-fixtures-'));
  const path = (name: string) => join(dir, name);
  const gradient = () =>
    sharp({
      create: { width: 1200, height: 800, channels: 3, background: { r: 30, g: 120, b: 200 } },
    });
  await gradient().jpeg({ quality: 90 }).toFile(path('photo.jpg'));
  await gradient().withMetadata({ orientation: 6 }).jpeg().toFile(path('rotated.jpg'));
  await sharp({
    create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } },
  })
    .png()
    .toFile(path('alpha.png'));
  await gradient().webp().toFile(path('image.webp'));
  await sharp({ create: { width: 20, height: 20, channels: 3, background: '#f00' } })
    .gif()
    .toFile(path('anim.gif'));
  await sharp({ create: { width: 20_000, height: 8, channels: 3, background: '#0f0' } })
    .png()
    .toFile(path('wide.png'));
  const jpeg = await readFile(path('photo.jpg'));
  await writeFile(path('truncated.jpg'), jpeg.subarray(0, Math.floor(jpeg.length / 2)));
  await writeFile(path('notes.txt'), 'ceci n’est pas une image\n'.repeat(20));

  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=30',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440',
    '-t',
    '2',
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    path('clip.mp4'),
  ]);
  ffmpeg(['-display_rotation', '90', '-i', path('clip.mp4'), '-c', 'copy', path('rotated.mp4')]);
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220',
    '-t',
    '2',
    '-c:v',
    'libvpx',
    '-deadline',
    'realtime',
    '-b:v',
    '300k',
    '-c:a',
    'libopus',
    path('clip.webm'),
  ]);
  const mp4 = await readFile(path('clip.mp4'));
  await writeFile(path('truncated.mp4'), mp4.subarray(0, Math.floor(mp4.length * 0.6)));

  return {
    dir,
    jpeg: path('photo.jpg'),
    jpegRotated: path('rotated.jpg'),
    pngAlpha: path('alpha.png'),
    webp: path('image.webp'),
    gif: path('anim.gif'),
    tooWide: path('wide.png'),
    truncatedJpeg: path('truncated.jpg'),
    text: path('notes.txt'),
    mp4: path('clip.mp4'),
    mp4Rotated: path('rotated.mp4'),
    webm: path('clip.webm'),
    truncatedMp4: path('truncated.mp4'),
  };
}

/** Stockage dont les lectures échouent tant que `failures` > 0 (panne simulée). */
export class FlakyStorage implements ObjectStorage {
  readonly driver = 'local' as const;
  failures = 0;
  constructor(private readonly inner: ObjectStorage) {}
  private check(): void {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new StorageUnavailableError('Panne simulée du stockage.');
    }
  }
  presignPut: ObjectStorage['presignPut'] = (key, options) => this.inner.presignPut(key, options);
  presignGet: ObjectStorage['presignGet'] = (key, options) => this.inner.presignGet(key, options);
  head: ObjectStorage['head'] = async (key) => {
    this.check();
    return this.inner.head(key);
  };
  read: ObjectStorage['read'] = async (key, range) => {
    this.check();
    return this.inner.read(key, range);
  };
  writeFile: ObjectStorage['writeFile'] = async (key, path, type) => {
    this.check();
    return this.inner.writeFile(key, path, type);
  };
  delete: ObjectStorage['delete'] = async (key) => {
    this.check();
    return this.inner.delete(key);
  };
}

export interface Harness {
  db: TestDatabase;
  storage: FlakyStorage;
  local: LocalObjectStorage;
  ctx: WorkerContext;
  worker: Worker;
  clock: { now: Date; advance(ms: number): void };
  organizationId: string;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const db = await createTestDatabase();
  const root = await mkdtemp(join(tmpdir(), 'pixlova-worker-'));
  const local = new LocalObjectStorage({
    root: join(root, 'storage'),
    secret: 'worker-test-secret-0123456789abcdef',
  });
  const storage = new FlakyStorage(local);
  // Horloge postérieure au `now()` de la base : les tâches créées sont immédiatement dues.
  const clock = {
    now: new Date(Date.now() + 60_000),
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const ctx: WorkerContext = {
    appDb: db.app,
    systemDb: db.system,
    storage,
    limits: DEFAULT_MEDIA_LIMITS,
    tools: DEFAULT_VIDEO_TOOLS,
    tmpRoot: root,
    trashRetentionDays: 30,
    manifestSigner: manifestSignerFromSeed(
      'manifest-key-test',
      encodeBase64url(ed25519.utils.randomSecretKey()),
    ),
    now: () => clock.now,
    logger: silentLogger,
  };
  const worker = createMediaWorker(ctx, { workerId: 'worker-test', leaseSeconds: 60 });
  const organizationId = randomUUID();
  await withTenant(db.app, organizationId, (tx) =>
    tx.insert(schema.organizations).values({
      id: organizationId,
      name: 'Org média',
      slug: `media-${organizationId.slice(0, 8)}`,
      country: 'FR',
      timezone: 'Europe/Paris',
    }),
  );
  return {
    db,
    storage,
    local,
    ctx,
    worker,
    clock,
    organizationId,
    async close() {
      await db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export interface UploadOptions {
  type?: 'image' | 'video';
  declaredMimeType?: string;
  clientChecksumSha256?: string;
  /** Taille déclarée différente du fichier réel. */
  declaredSize?: number;
}

/**
 * Reproduit l’état laissé par l’API après `upload-session` puis `complete` : objet en
 * quarantaine, quota consommé, média `processing` et tâche d’ingestion créée.
 */
export async function completedUpload(
  h: Harness,
  file: string,
  options: UploadOptions = {},
): Promise<string> {
  const mediaId = randomUUID();
  const uploadId = randomUUID();
  const size = options.declaredSize ?? (await stat(file)).size;
  const declaredMimeType = options.declaredMimeType ?? 'image/jpeg';
  const objectKey = uploadObjectKey(h.organizationId, uploadId);
  await h.local.writeFile(objectKey, file, declaredMimeType);
  await withTenant(h.db.app, h.organizationId, async (tx) => {
    await tx.insert(schema.media).values({
      id: mediaId,
      organizationId: h.organizationId,
      name: file.split('/').pop()!,
      type: options.type ?? 'image',
      status: 'processing',
      declaredMimeType,
      originalFilename: file.split('/').pop()!,
      quotaBytes: size,
    });
    await tx.insert(schema.uploadSessions).values({
      id: uploadId,
      organizationId: h.organizationId,
      mediaId,
      objectKey,
      declaredSize: size,
      declaredMimeType,
      clientChecksumSha256: options.clientChecksumSha256 ?? null,
      reservedBytes: size,
      state: 'completed',
      expiresAt: new Date(h.clock.now.getTime() + 15 * 60_000),
      completedAt: h.clock.now,
    });
    await adjustUsage(tx, h.organizationId, 'storage_bytes', { observed: size }, h.clock.now);
    await enqueueJob(tx, {
      organizationId: h.organizationId,
      kind: MEDIA_INGEST,
      dedupeKey: mediaId,
      payload: { mediaId },
    });
  });
  return mediaId;
}

export async function mediaState(h: Harness, mediaId: string) {
  return withTenant(h.db.app, h.organizationId, async (tx) => {
    const [media] = await tx.select().from(schema.media).where(eq(schema.media.id, mediaId));
    const assets = await tx
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.mediaId, mediaId));
    return { media, assets: Object.fromEntries(assets.map((a) => [a.variant, a])) };
  });
}
