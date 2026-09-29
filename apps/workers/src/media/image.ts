import type { MediaLimits } from '@pixlova/contracts';
import sharp, { type Metadata, type SharpOptions } from 'sharp';
import { PermanentMediaError } from '../errors.js';

export type ImageFormat = 'jpeg' | 'png' | 'webp';

export interface ImageInfo {
  format: ImageFormat;
  /** Dimensions affichées, orientation EXIF appliquée. */
  width: number;
  height: number;
  orientation: number;
  hasAlpha: boolean;
}

let hardened = false;

/**
 * Restreint libvips aux décodeurs JPEG, PNG et WebP depuis un fichier (SEC-014) : SVG,
 * TIFF, HEIF, PDF… sont bloqués quelle que soit la signature. Pas de cache partagé.
 */
export function hardenImageDecoder(): void {
  if (hardened) return;
  sharp.block({ operation: ['VipsForeignLoad'] });
  sharp.unblock({
    operation: ['VipsForeignLoadJpegFile', 'VipsForeignLoadPngFile', 'VipsForeignLoadWebpFile'],
  });
  sharp.cache(false);
  sharp.concurrency(2);
  hardened = true;
}

function input(limits: MediaLimits): SharpOptions {
  return { limitInputPixels: limits.imageMaxPixels, failOn: 'error', sequentialRead: true };
}

function decodeError(error: unknown): PermanentMediaError {
  const message = error instanceof Error ? error.message : String(error);
  if (/pixel limit/i.test(message)) {
    return new PermanentMediaError('LIMIT_EXCEEDED', 'Image trop grande (pixels).');
  }
  return new PermanentMediaError('CORRUPTED_FILE', 'Image illisible ou incomplète.');
}

/** Métadonnées fiables et décodage complet : un fichier tronqué ou altéré échoue ici. */
export async function analyzeImage(
  path: string,
  expected: ImageFormat,
  limits: MediaLimits,
): Promise<ImageInfo> {
  hardenImageDecoder();
  let metadata: Metadata;
  try {
    metadata = await sharp(path, input(limits)).metadata();
  } catch (error) {
    throw decodeError(error);
  }
  if (metadata.format !== expected) {
    throw new PermanentMediaError('CORRUPTED_FILE', 'Contenu incohérent avec la signature.');
  }
  if ((metadata.pages ?? 1) > 1) {
    throw new PermanentMediaError(
      'UNSUPPORTED_FORMAT',
      'Les images animées ne sont pas acceptées.',
    );
  }
  if (
    metadata.width > limits.imageMaxSide ||
    metadata.height > limits.imageMaxSide ||
    metadata.width * metadata.height > limits.imageMaxPixels
  ) {
    throw new PermanentMediaError(
      'LIMIT_EXCEEDED',
      `Image de ${metadata.width}×${metadata.height} px.`,
    );
  }
  try {
    await sharp(path, input(limits)).resize(64, 64, { fit: 'inside' }).raw().toBuffer();
  } catch (error) {
    throw decodeError(error);
  }
  return {
    format: expected,
    width: metadata.autoOrient.width,
    height: metadata.autoOrient.height,
    orientation: metadata.orientation ?? 1,
    hasAlpha: metadata.hasAlpha,
  };
}

/** Image lisible par les Players sans transformation : format accepté, orientation neutre. */
export function isImagePlaybackReady(info: ImageInfo): boolean {
  return info.orientation === 1;
}

/** Orientation appliquée, métadonnées retirées, même format. */
export async function normalizeImage(
  source: string,
  destination: string,
  info: ImageInfo,
  limits: MediaLimits,
): Promise<{ width: number; height: number }> {
  hardenImageDecoder();
  let pipeline = sharp(source, input(limits)).autoOrient();
  pipeline =
    info.format === 'jpeg'
      ? pipeline.jpeg({ quality: 92 })
      : info.format === 'png'
        ? pipeline.png()
        : pipeline.webp({ quality: 90 });
  const result = await pipeline.toFile(destination);
  return { width: result.width, height: result.height };
}

/** Vignette WebP, 480 px sur le grand côté au plus (`webp-thumb-480-v1`). */
export async function makeThumbnail(
  source: string,
  destination: string,
  limits: MediaLimits,
): Promise<{ width: number; height: number }> {
  hardenImageDecoder();
  const result = await sharp(source, input(limits))
    .autoOrient()
    .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(destination);
  return { width: result.width, height: result.height };
}

export function imageLibraryVersion(): string {
  return `sharp ${sharp.versions.sharp} / libvips ${sharp.versions.vips}`;
}
