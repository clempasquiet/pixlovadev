import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  assertValidKey,
  ObjectNotFoundError,
  StorageUnavailableError,
  type ByteRange,
  type ObjectHead,
  type ObjectStorage,
  type SignedRequest,
} from './types.js';

export const LOCAL_STORAGE_PREFIX = '/storage/v1/objects/';

export interface LocalStorageOptions {
  /** Répertoire racine, hors de toute arborescence servie statiquement. */
  root: string;
  /** Secret HMAC d’au moins 32 octets, propre à l’environnement. */
  secret: string;
  /** Origine publique des URLs signées ; vide : chemin relatif (même origine, proxy). */
  publicBaseUrl?: string;
  now?: () => Date;
}

export interface LocalResponse {
  status: number;
  headers: Record<string, string>;
  body?: Readable;
  code?: string;
}

type Operation = 'put' | 'get';

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function unavailable(error: unknown): StorageUnavailableError {
  return new StorageUnavailableError('Stockage local indisponible.', { cause: error });
}

/**
 * Pilote de développement et de test (ADR-009) : fichiers sous `root/objects`, métadonnées
 * sous `root/meta`. Les URLs signées HMAC sont servies par l’API (`/storage/v1/objects/…`) ;
 * une URL ne vaut que pour une opération, une clé, une taille et une échéance.
 * Refusé en production par la configuration de l’API et des workers.
 */
export class LocalObjectStorage implements ObjectStorage {
  readonly driver = 'local' as const;
  private readonly secret: Buffer;
  private readonly base: string;
  private readonly now: () => Date;

  constructor(private readonly options: LocalStorageOptions) {
    this.secret = Buffer.from(options.secret, 'utf8');
    if (this.secret.length < 32)
      throw new Error('Le secret du stockage local doit faire 32 octets.');
    this.base = (options.publicBaseUrl ?? '').replace(/\/$/, '');
    this.now = options.now ?? (() => new Date());
  }

  private objectPath(key: string): string {
    assertValidKey(key);
    return join(this.options.root, 'objects', key);
  }

  private metaPath(key: string): string {
    assertValidKey(key);
    return join(this.options.root, 'meta', `${key}.json`);
  }

  private sign(fields: string[]): string {
    return createHmac('sha256', this.secret)
      .update(['pixlova-local-storage-v1', ...fields].join('\n'))
      .digest('base64url');
  }

  private url(key: string, params: Record<string, string>): string {
    return `${this.base}${LOCAL_STORAGE_PREFIX}${key}?${new URLSearchParams(params).toString()}`;
  }

  async presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<SignedRequest> {
    assertValidKey(key);
    const expiresAt = new Date(this.now().getTime() + options.expiresInSeconds * 1000);
    const exp = String(Math.floor(expiresAt.getTime() / 1000));
    const len = String(options.contentLength);
    const sig = this.sign(['put', key, exp, len, options.contentType]);
    return {
      method: 'PUT',
      url: this.url(key, { op: 'put', exp, len, ct: options.contentType, sig }),
      headers: { 'content-type': options.contentType },
      expiresAt,
    };
  }

  async presignGet(key: string, options: { expiresInSeconds: number }): Promise<SignedRequest> {
    assertValidKey(key);
    const expiresAt = new Date(this.now().getTime() + options.expiresInSeconds * 1000);
    const exp = String(Math.floor(expiresAt.getTime() / 1000));
    return {
      method: 'GET',
      url: this.url(key, { op: 'get', exp, sig: this.sign(['get', key, exp]) }),
      headers: {},
      expiresAt,
    };
  }

  /** Vérifie une URL signée ; renvoie le motif du refus ou `null`. */
  private verify(
    op: Operation,
    key: string,
    query: Record<string, string | undefined>,
  ): string | null {
    try {
      assertValidKey(key);
    } catch {
      return 'INVALID_KEY';
    }
    if (query.op !== op || !query.exp || !query.sig) return 'INVALID_SIGNATURE';
    const fields =
      op === 'put'
        ? ['put', key, query.exp, query.len ?? '', query.ct ?? '']
        : ['get', key, query.exp];
    const expected = Buffer.from(this.sign(fields));
    const actual = Buffer.from(query.sig);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return 'INVALID_SIGNATURE';
    }
    if (!/^\d+$/.test(query.exp) || Number(query.exp) * 1000 <= this.now().getTime()) {
      return 'URL_EXPIRED';
    }
    return null;
  }

  /** Traitement d’un `PUT` signé : taille exacte, type signé, écriture atomique. */
  async receivePut(
    key: string,
    query: Record<string, string | undefined>,
    headers: Record<string, string | string[] | undefined>,
    body: Readable,
  ): Promise<LocalResponse> {
    const refused = this.verify('put', key, query);
    if (refused) return { status: 403, headers: {}, code: refused };
    const expectedLength = Number(query.len);
    if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) {
      return { status: 403, headers: {}, code: 'INVALID_SIGNATURE' };
    }
    if (headers['content-type'] !== query.ct) {
      return { status: 400, headers: {}, code: 'CONTENT_TYPE_MISMATCH' };
    }
    const declared = headers['content-length'];
    if (declared !== undefined && Number(declared) !== expectedLength) {
      return { status: 400, headers: {}, code: 'CONTENT_LENGTH_MISMATCH' };
    }
    const path = this.objectPath(key);
    const temporary = `${path}.part-${randomBytes(8).toString('hex')}`;
    let received = 0;
    try {
      await mkdir(dirname(path), { recursive: true });
      await pipeline(
        body,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            received += chunk.length;
            if (received > expectedLength) throw new Error('TOO_LARGE');
            yield chunk;
          }
        },
        createWriteStream(temporary, { flags: 'wx' }),
      );
      if (received !== expectedLength) {
        await rm(temporary, { force: true });
        return { status: 400, headers: {}, code: 'CONTENT_LENGTH_MISMATCH' };
      }
      await this.writeMeta(key, { contentType: query.ct ?? 'application/octet-stream' });
      await rename(temporary, path);
      return { status: 200, headers: {} };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if ((error as Error).message === 'TOO_LARGE') {
        return { status: 413, headers: {}, code: 'CONTENT_LENGTH_MISMATCH' };
      }
      throw error;
    }
  }

  /** Traitement d’un `GET` signé, avec une plage `Range: bytes=a-b` au plus. */
  async serveGet(
    key: string,
    query: Record<string, string | undefined>,
    rangeHeader: string | undefined,
  ): Promise<LocalResponse> {
    const refused = this.verify('get', key, query);
    if (refused) return { status: 403, headers: {}, code: refused };
    const head = await this.head(key);
    if (!head) return { status: 404, headers: {}, code: 'NOT_FOUND' };
    const common = {
      'content-type': head.contentType ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    };
    if (rangeHeader) {
      const range = parseRange(rangeHeader, head.size);
      if (!range) {
        return { status: 416, headers: { 'content-range': `bytes */${head.size}` }, code: 'RANGE' };
      }
      return {
        status: 206,
        headers: {
          ...common,
          'content-range': `bytes ${range.start}-${range.end}/${head.size}`,
          'content-length': String(range.end - range.start + 1),
        },
        body: await this.read(key, range),
      };
    }
    return {
      status: 200,
      headers: { ...common, 'content-length': String(head.size) },
      body: await this.read(key),
    };
  }

  private async writeMeta(key: string, meta: { contentType: string }): Promise<void> {
    const path = this.metaPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(meta));
  }

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const info = await stat(this.objectPath(key));
      let contentType: string | null = null;
      try {
        contentType = (
          JSON.parse(await readFile(this.metaPath(key), 'utf8')) as { contentType: string }
        ).contentType;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      return { size: info.size, contentType };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw unavailable(error);
    }
  }

  async read(key: string, range?: ByteRange): Promise<Readable> {
    const path = this.objectPath(key);
    try {
      await stat(path);
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(`Objet absent : ${key}`);
      throw unavailable(error);
    }
    return createReadStream(path, range ? { start: range.start, end: range.end } : {});
  }

  async writeFile(key: string, source: string, contentType: string): Promise<void> {
    const path = this.objectPath(key);
    const temporary = `${path}.part-${randomBytes(8).toString('hex')}`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await copyFile(source, temporary);
      await this.writeMeta(key, { contentType });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw unavailable(error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.objectPath(key), { force: true });
      await rm(this.metaPath(key), { force: true });
    } catch (error) {
      throw unavailable(error);
    }
  }
}

/** Une seule plage `bytes=a-b`, `bytes=a-` ou `bytes=-n` ; `null` si non satisfaisable. */
export function parseRange(header: string, size: number): ByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '') || size === 0) return null;
  let start: number;
  let end: number;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || start > end || start >= size) return null;
  return { start, end };
}
