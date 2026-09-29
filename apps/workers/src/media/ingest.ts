import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { maxBytesFor, type MediaErrorCode } from '@pixlova/contracts';
import { schema, withTenant, type ClaimedJob } from '@pixlova/db';
import { mediaObjectKey } from '@pixlova/storage';
import { and, eq } from 'drizzle-orm';
import type { WorkerContext } from '../context.js';
import { JobAbortedError, PermanentMediaError } from '../errors.js';
import type { JobHandler } from '../runner.js';
import { downloadObject, hashFile } from './files.js';
import {
  analyzeImage,
  imageLibraryVersion,
  isImagePlaybackReady,
  makeThumbnail,
  normalizeImage,
  type ImageInfo,
} from './image.js';
import { sniffFile, type DetectedFormat } from './sniff.js';
import {
  extractFrame,
  ffmpegVersion,
  playbackIncompatibilities,
  probeVideo,
  transcodeVideo,
  verifyVideoDecode,
  type VideoInfo,
} from './video.js';

export const MEDIA_INGEST = 'media.ingest';

type Variant = (typeof schema.MEDIA_VARIANTS)[number];
type AssetRow = typeof schema.mediaAssets.$inferSelect;

interface NewAsset {
  variant: Variant;
  profile: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  codecMetadata: Record<string, unknown>;
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
};

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new JobAbortedError('Tâche interrompue.');
}

/**
 * Enregistre une variante. L’unicité (média, variante) garantit qu’une reprise ou un
 * worker concurrent ne crée pas de doublon ; l’objet du perdant est supprimé.
 */
async function recordAsset(
  ctx: WorkerContext,
  organizationId: string,
  mediaId: string,
  asset: NewAsset,
  ownsObject: boolean,
): Promise<AssetRow> {
  const result = await withTenant(ctx.appDb, organizationId, async (tx) => {
    const [media] = await tx
      .select({ id: schema.media.id, purgeStartedAt: schema.media.purgeStartedAt })
      .from(schema.media)
      .where(eq(schema.media.id, mediaId))
      .for('update');
    if (!media || media.purgeStartedAt) return { row: null, inserted: false };
    const [inserted] = await tx
      .insert(schema.mediaAssets)
      .values({ organizationId, mediaId, ...asset })
      .onConflictDoNothing({ target: [schema.mediaAssets.mediaId, schema.mediaAssets.variant] })
      .returning();
    if (inserted) return { row: inserted, inserted: true };
    const [existing] = await tx
      .select()
      .from(schema.mediaAssets)
      .where(
        and(eq(schema.mediaAssets.mediaId, mediaId), eq(schema.mediaAssets.variant, asset.variant)),
      );
    return { row: existing ?? null, inserted: false };
  });
  if (!result.inserted && ownsObject) await ctx.storage.delete(asset.storageKey);
  if (!result.row) throw new JobAbortedError('Média purgé pendant la préparation.');
  return result.row;
}

async function storeFile(
  ctx: WorkerContext,
  organizationId: string,
  mediaId: string,
  variant: Variant,
  path: string,
  mimeType: string,
): Promise<{ storageKey: string; sha256: string; size: number }> {
  const { sha256, size } = await hashFile(path);
  const storageKey = mediaObjectKey(
    organizationId,
    mediaId,
    variant,
    EXTENSIONS[mimeType] ?? 'bin',
  );
  await ctx.storage.writeFile(storageKey, path, mimeType);
  // Relecture de la taille écrite : un envoi tronqué n’est jamais enregistré.
  const head = await ctx.storage.head(storageKey);
  if (head?.size !== size) throw new Error('Écriture incomplète dans le stockage.');
  return { storageKey, sha256, size };
}

/**
 * Préparation d’un média (MED-003, MED-004, SEC-014) : octets vérifiés, format réel,
 * analyse, variantes immuables, puis passage à `ready`. Chaque étape déjà enregistrée
 * est conservée lors d’une reprise.
 */
async function ingest(ctx: WorkerContext, job: ClaimedJob, signal: AbortSignal): Promise<void> {
  const organizationId = job.organizationId;
  const mediaId = job.payload.mediaId;
  if (!organizationId || typeof mediaId !== 'string')
    throw new Error('Tâche d’ingestion invalide.');

  const state = await withTenant(ctx.appDb, organizationId, async (tx) => {
    const [media] = await tx.select().from(schema.media).where(eq(schema.media.id, mediaId));
    const [session] = await tx
      .select()
      .from(schema.uploadSessions)
      .where(eq(schema.uploadSessions.mediaId, mediaId));
    const assets = await tx
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.mediaId, mediaId));
    return { media, session, assets };
  });
  const { media, session } = state;
  if (!media || media.purgeStartedAt || media.status !== 'processing') return;
  const assets = new Map(state.assets.map((asset) => [asset.variant, asset]));

  const dir = await mkdtemp(join(ctx.tmpRoot, 'ingest-'));
  try {
    const originalPath = join(dir, 'original');
    const original = assets.get('original');
    let digest: { sha256: string; size: number };
    if (original) {
      digest = await downloadObject(
        ctx.storage,
        original.storageKey,
        originalPath,
        original.sizeBytes,
        signal,
      );
      if (digest.sha256 !== original.checksumSha256) {
        throw new PermanentMediaError('CORRUPTED_FILE', 'Binaire stocké altéré.');
      }
    } else {
      if (!session)
        throw new PermanentMediaError('UPLOAD_MISSING', 'Session d’upload introuvable.');
      digest = await downloadObject(
        ctx.storage,
        session.objectKey,
        originalPath,
        session.declaredSize,
        signal,
      );
      if (session.clientChecksumSha256 && session.clientChecksumSha256 !== digest.sha256) {
        throw new PermanentMediaError('CHECKSUM_MISMATCH', 'SHA-256 différent de celui annoncé.');
      }
    }
    checkAbort(signal);

    const detected = await sniffFile(originalPath);
    if (!detected.category) {
      throw new PermanentMediaError(
        'UNSUPPORTED_FORMAT',
        `Format non accepté (${detected.format}).`,
      );
    }
    if (detected.category !== media.type) {
      throw new PermanentMediaError(
        'TYPE_MISMATCH',
        'Le contenu ne correspond pas au type annoncé.',
      );
    }
    if (digest.size > maxBytesFor(detected.category, ctx.limits)) {
      throw new PermanentMediaError('LIMIT_EXCEEDED', 'Fichier trop volumineux.');
    }

    if (detected.category === 'image') {
      await prepareImage(
        ctx,
        organizationId,
        mediaId,
        detected,
        originalPath,
        digest,
        dir,
        assets,
        original,
        signal,
      );
    } else {
      await prepareVideo(
        ctx,
        organizationId,
        mediaId,
        detected,
        originalPath,
        digest,
        dir,
        assets,
        original,
        signal,
      );
    }
    checkAbort(signal);

    await withTenant(ctx.appDb, organizationId, async (tx) => {
      await tx
        .update(schema.media)
        .set({ status: 'ready', errorCode: null, errorDetail: null, updatedAt: ctx.now() })
        .where(and(eq(schema.media.id, mediaId), eq(schema.media.status, 'processing')));
    });
    ctx.logger.info({ mediaId, organizationId, jobId: job.id }, 'média prêt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function recordOriginal(
  ctx: WorkerContext,
  organizationId: string,
  mediaId: string,
  detected: Extract<DetectedFormat, { category: 'image' | 'video' }>,
  originalPath: string,
  digest: { sha256: string; size: number },
  dimensions: { width: number; height: number; durationMs: number | null },
  metadata: Record<string, unknown>,
): Promise<AssetRow> {
  const stored = await storeFile(
    ctx,
    organizationId,
    mediaId,
    'original',
    originalPath,
    detected.mimeType,
  );
  if (stored.sha256 !== digest.sha256) throw new Error('Copie locale modifiée.');
  const row = await recordAsset(
    ctx,
    organizationId,
    mediaId,
    {
      variant: 'original',
      profile: 'original',
      storageKey: stored.storageKey,
      mimeType: detected.mimeType,
      sizeBytes: stored.size,
      checksumSha256: stored.sha256,
      width: dimensions.width,
      height: dimensions.height,
      durationMs: dimensions.durationMs,
      codecMetadata: metadata,
    },
    true,
  );
  await withTenant(ctx.appDb, organizationId, (tx) =>
    tx
      .update(schema.media)
      .set({
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        checksumSha256: row.checksumSha256,
        width: dimensions.width,
        height: dimensions.height,
        durationMs: dimensions.durationMs,
        metadata,
        updatedAt: ctx.now(),
      })
      .where(eq(schema.media.id, mediaId)),
  );
  return row;
}

async function prepareImage(
  ctx: WorkerContext,
  organizationId: string,
  mediaId: string,
  detected: Extract<DetectedFormat, { category: 'image' }>,
  originalPath: string,
  digest: { sha256: string; size: number },
  dir: string,
  assets: Map<string, AssetRow>,
  existingOriginal: AssetRow | undefined,
  signal: AbortSignal,
): Promise<void> {
  const info: ImageInfo = await analyzeImage(originalPath, detected.format, ctx.limits);
  checkAbort(signal);
  const metadata = {
    format: info.format,
    orientation: info.orientation,
    has_alpha: info.hasAlpha,
    tool: imageLibraryVersion(),
  };
  const original =
    existingOriginal ??
    (await recordOriginal(
      ctx,
      organizationId,
      mediaId,
      detected,
      originalPath,
      digest,
      {
        width: info.width,
        height: info.height,
        durationMs: null,
      },
      metadata,
    ));
  assets.set('original', original);

  if (!assets.has('playback')) {
    if (isImagePlaybackReady(info)) {
      assets.set(
        'playback',
        await recordAsset(
          ctx,
          organizationId,
          mediaId,
          {
            variant: 'playback',
            profile: 'passthrough',
            storageKey: original.storageKey,
            mimeType: original.mimeType,
            sizeBytes: original.sizeBytes,
            checksumSha256: original.checksumSha256,
            width: info.width,
            height: info.height,
            durationMs: null,
            codecMetadata: {},
          },
          false,
        ),
      );
    } else {
      const path = join(dir, `playback.${EXTENSIONS[detected.mimeType]}`);
      const size = await normalizeImage(originalPath, path, info, ctx.limits);
      const stored = await storeFile(
        ctx,
        organizationId,
        mediaId,
        'playback',
        path,
        detected.mimeType,
      );
      assets.set(
        'playback',
        await recordAsset(
          ctx,
          organizationId,
          mediaId,
          {
            variant: 'playback',
            profile: 'image-normalized-v1',
            storageKey: stored.storageKey,
            mimeType: detected.mimeType,
            sizeBytes: stored.size,
            checksumSha256: stored.sha256,
            width: size.width,
            height: size.height,
            durationMs: null,
            codecMetadata: { tool: imageLibraryVersion(), reasons: ['orientation'] },
          },
          true,
        ),
      );
    }
  }
  checkAbort(signal);
  if (!assets.has('thumbnail')) {
    await recordThumbnail(ctx, organizationId, mediaId, originalPath, dir, assets);
  }
}

async function recordThumbnail(
  ctx: WorkerContext,
  organizationId: string,
  mediaId: string,
  sourcePath: string,
  dir: string,
  assets: Map<string, AssetRow>,
): Promise<void> {
  const path = join(dir, 'thumbnail.webp');
  const size = await makeThumbnail(sourcePath, path, ctx.limits);
  const stored = await storeFile(ctx, organizationId, mediaId, 'thumbnail', path, 'image/webp');
  assets.set(
    'thumbnail',
    await recordAsset(
      ctx,
      organizationId,
      mediaId,
      {
        variant: 'thumbnail',
        profile: 'webp-thumb-480-v1',
        storageKey: stored.storageKey,
        mimeType: 'image/webp',
        sizeBytes: stored.size,
        checksumSha256: stored.sha256,
        width: size.width,
        height: size.height,
        durationMs: null,
        codecMetadata: { tool: imageLibraryVersion() },
      },
      true,
    ),
  );
}

async function prepareVideo(
  ctx: WorkerContext,
  organizationId: string,
  mediaId: string,
  detected: Extract<DetectedFormat, { category: 'video' }>,
  originalPath: string,
  digest: { sha256: string; size: number },
  dir: string,
  assets: Map<string, AssetRow>,
  existingOriginal: AssetRow | undefined,
  signal: AbortSignal,
): Promise<void> {
  const info: VideoInfo = await probeVideo(
    originalPath,
    detected.demuxer,
    ctx.limits,
    ctx.tools,
    signal,
  );
  const reasons = playbackIncompatibilities(info, ctx.limits);
  if (reasons.length === 0) {
    // Diffusé tel quel : il doit donc se décoder entièrement sans erreur.
    await verifyVideoDecode(originalPath, detected.demuxer, info, ctx.tools, signal);
  }
  checkAbort(signal);
  const metadata = {
    container: info.formatName,
    major_brand: info.majorBrand,
    video_codec: info.video.codec,
    video_profile: info.video.profile,
    pixel_format: info.video.pixFmt,
    level: info.video.level,
    fps: Math.round(info.fps * 1000) / 1000,
    rotation: info.rotation,
    audio: info.audio.map((a) => a.codec),
    playback_incompatibilities: reasons,
    tool: await ffmpegVersion(ctx.tools),
  };
  const original =
    existingOriginal ??
    (await recordOriginal(
      ctx,
      organizationId,
      mediaId,
      detected,
      originalPath,
      digest,
      {
        width: info.displayWidth,
        height: info.displayHeight,
        durationMs: info.durationMs,
      },
      metadata,
    ));
  assets.set('original', original);

  let playbackPath = originalPath;
  let playbackDemuxer = detected.demuxer;
  if (!assets.has('playback')) {
    if (reasons.length === 0) {
      assets.set(
        'playback',
        await recordAsset(
          ctx,
          organizationId,
          mediaId,
          {
            variant: 'playback',
            profile: 'passthrough',
            storageKey: original.storageKey,
            mimeType: original.mimeType,
            sizeBytes: original.sizeBytes,
            checksumSha256: original.checksumSha256,
            width: info.displayWidth,
            height: info.displayHeight,
            durationMs: info.durationMs,
            codecMetadata: { video_codec: info.video.codec, audio: info.audio.map((a) => a.codec) },
          },
          false,
        ),
      );
    } else {
      playbackPath = join(dir, 'playback.mp4');
      playbackDemuxer = 'mov';
      await transcodeVideo(
        originalPath,
        detected.demuxer,
        info,
        playbackPath,
        ctx.limits,
        ctx.tools,
        signal,
      );
      const output = await probeVideo(playbackPath, 'mov', ctx.limits, ctx.tools, signal);
      const remaining = playbackIncompatibilities(output, ctx.limits);
      if (remaining.length > 0) throw new Error(`Sortie non conforme : ${remaining.join(', ')}`);
      const stored = await storeFile(
        ctx,
        organizationId,
        mediaId,
        'playback',
        playbackPath,
        'video/mp4',
      );
      assets.set(
        'playback',
        await recordAsset(
          ctx,
          organizationId,
          mediaId,
          {
            variant: 'playback',
            profile: 'h264-aac-mp4-v1',
            storageKey: stored.storageKey,
            mimeType: 'video/mp4',
            sizeBytes: stored.size,
            checksumSha256: stored.sha256,
            width: output.displayWidth,
            height: output.displayHeight,
            durationMs: output.durationMs,
            codecMetadata: {
              reasons,
              video_codec: output.video.codec,
              video_profile: output.video.profile,
              fps: Math.round(output.fps * 1000) / 1000,
              audio: output.audio.map((a) => a.codec),
              tool: await ffmpegVersion(ctx.tools),
            },
          },
          true,
        ),
      );
    }
  }
  checkAbort(signal);
  if (!assets.has('thumbnail')) {
    const frame = join(dir, 'frame.png');
    const at = Math.min(1000, Math.floor(info.durationMs / 2));
    await extractFrame(playbackPath, playbackDemuxer, at, frame, ctx.tools, signal);
    await recordThumbnail(ctx, organizationId, mediaId, frame, dir, assets);
  }
}

/** Échec définitif ou tentatives épuisées : le média passe en erreur, motif exploitable. */
async function markFailed(ctx: WorkerContext, job: ClaimedJob, error: unknown): Promise<void> {
  const organizationId = job.organizationId;
  const mediaId = job.payload.mediaId;
  if (!organizationId || typeof mediaId !== 'string') return;
  const permanent = error instanceof PermanentMediaError;
  const code: MediaErrorCode = permanent ? error.code : 'PROCESSING_FAILED';
  const detail = permanent
    ? error.detail
    : 'Préparation impossible après plusieurs essais. Réessayez plus tard ou contactez le support.';
  await withTenant(ctx.appDb, organizationId, (tx) =>
    tx
      .update(schema.media)
      .set({ status: 'error', errorCode: code, errorDetail: detail, updatedAt: ctx.now() })
      .where(and(eq(schema.media.id, mediaId), eq(schema.media.status, 'processing'))),
  );
}

export const ingestHandler: JobHandler = {
  kind: MEDIA_INGEST,
  run: ingest,
  onFailed: markFailed,
};
