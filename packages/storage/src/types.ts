import type { Readable } from 'node:stream';

/** Requête signée à exécuter telle quelle par le client (navigateur, Player, worker). */
export interface SignedRequest {
  method: 'PUT' | 'GET';
  url: string;
  /** En-têtes que le client doit envoyer à l’identique (couverts par la signature). */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectHead {
  size: number;
  contentType: string | null;
}

export interface ByteRange {
  start: number;
  /** Inclusif. */
  end: number;
}

/**
 * Stockage objet privé (ARC-005, ADR-009). Les clés sont construites par le serveur et
 * validées par `assertValidKey` ; aucun appel ne donne d’accès général au bucket.
 */
export interface ObjectStorage {
  readonly driver: 'local' | 's3';
  presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<SignedRequest>;
  presignGet(key: string, options: { expiresInSeconds: number }): Promise<SignedRequest>;
  /** `null` si l’objet n’existe pas. */
  head(key: string): Promise<ObjectHead | null>;
  read(key: string, range?: ByteRange): Promise<Readable>;
  writeFile(key: string, path: string, contentType: string): Promise<void>;
  /** Idempotent : supprimer un objet absent n’est pas une erreur. */
  delete(key: string): Promise<void>;
}

/** Échec transitoire (réseau, service indisponible) : l’opération peut être reprise. */
export class StorageUnavailableError extends Error {
  override readonly name = 'StorageUnavailableError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Objet absent lors d’une lecture. */
export class ObjectNotFoundError extends Error {
  override readonly name = 'ObjectNotFoundError';
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Une clé est une suite de segments `[A-Za-z0-9._-]` séparés par `/`, sans segment vide,
 * `.` ou `..`, ni caractère de contrôle : elle ne peut sortir de la racine du stockage.
 */
export function assertValidKey(key: string): void {
  if (key.length === 0 || key.length > 512) throw new Error('Clé de stockage invalide.');
  for (const segment of key.split('/')) {
    if (!SEGMENT.test(segment) || segment === '.' || segment === '..' || segment.includes('..')) {
      throw new Error('Clé de stockage invalide.');
    }
  }
}
