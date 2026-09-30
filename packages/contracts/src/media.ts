/**
 * Formats et limites de la bibliothèque média (MED-002, MED-004, ADR-009), partagés par
 * l’API (contrôle à la demande d’upload) et les workers (contrôle des octets réels).
 * Valeurs proposées, configurables et à valider par le responsable produit.
 */
export type MediaCategory = 'image' | 'video';

/** Types MIME acceptés à la déclaration ; le format réel est revérifié par signature. */
export const ACCEPTED_MEDIA_MIME_TYPES: Readonly<Record<string, MediaCategory>> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
  'video/webm': 'video',
  'video/x-matroska': 'video',
};

export interface MediaLimits {
  imageMaxBytes: number;
  imageMaxSide: number;
  imageMaxPixels: number;
  videoMaxBytes: number;
  videoMaxDurationMs: number;
  /** Vidéo en entrée : au-delà, refus (décodage trop coûteux). */
  videoInputMaxSide: number;
  /** Sortie de lecture : au-delà, réduction lors du transcodage. */
  outputMaxSide: number;
  outputMaxPixels: number;
  outputMaxFps: number;
}

export const DEFAULT_MEDIA_LIMITS: MediaLimits = {
  imageMaxBytes: 50 * 1024 * 1024,
  imageMaxSide: 16_384,
  imageMaxPixels: 100_000_000,
  videoMaxBytes: 2 * 1024 * 1024 * 1024,
  videoMaxDurationMs: 4 * 60 * 60 * 1000,
  videoInputMaxSide: 8192,
  outputMaxSide: 4096,
  outputMaxPixels: 3840 * 2160,
  outputMaxFps: 60,
};

/**
 * Limites d’envoi ajustées au transport (ADR-015) : un tunnel ou un proxy qui borne la taille
 * d’une requête impose de refuser plus tôt, avec un message clair, plutôt qu’en cours
 * d’envoi. Seules des valeurs plus basses que les limites par défaut sont acceptées.
 */
export function mediaLimitsFromEnv(
  env: Record<string, string | undefined>,
  defaults: MediaLimits = DEFAULT_MEDIA_LIMITS,
): MediaLimits {
  const cap = (name: string, fallback: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1_000_000 || value > fallback) {
      throw new Error(`${name} doit être un entier entre 1000000 et ${fallback}.`);
    }
    return value;
  };
  return {
    ...defaults,
    imageMaxBytes: cap('PIXLOVA_MEDIA_IMAGE_MAX_BYTES', defaults.imageMaxBytes),
    videoMaxBytes: cap('PIXLOVA_MEDIA_VIDEO_MAX_BYTES', defaults.videoMaxBytes),
  };
}

export function mediaCategoryOf(mimeType: string): MediaCategory | null {
  return Object.hasOwn(ACCEPTED_MEDIA_MIME_TYPES, mimeType)
    ? (ACCEPTED_MEDIA_MIME_TYPES[mimeType] ?? null)
    : null;
}

export function maxBytesFor(
  category: MediaCategory,
  limits: MediaLimits = DEFAULT_MEDIA_LIMITS,
): number {
  return category === 'image' ? limits.imageMaxBytes : limits.videoMaxBytes;
}

/** Codes d’erreur de préparation exposés au dashboard (motif exploitable, SEC-014). */
export const MEDIA_ERROR_CODES = [
  'UNSUPPORTED_FORMAT',
  'TYPE_MISMATCH',
  'CORRUPTED_FILE',
  'LIMIT_EXCEEDED',
  'CHECKSUM_MISMATCH',
  'UPLOAD_MISSING',
  'UPLOAD_SIZE_MISMATCH',
  'UPLOAD_EXPIRED',
  'UPLOAD_ABORTED',
  'PROCESSING_FAILED',
] as const;
export type MediaErrorCode = (typeof MEDIA_ERROR_CODES)[number];
