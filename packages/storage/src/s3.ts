import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  assertValidKey,
  ObjectNotFoundError,
  StorageUnavailableError,
  type ByteRange,
  type ObjectHead,
  type ObjectStorage,
  type SignedRequest,
} from './types.js';

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Point d’accès compatible S3 (R2, MinIO…) ; absent : AWS. */
  endpoint?: string;
  /** Point d’accès utilisé dans les URLs signées remises aux clients, s’il diffère. */
  publicEndpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  now?: () => Date;
}

function isMissing(error: unknown): boolean {
  if (error instanceof S3ServiceException) {
    return (
      error.name === 'NotFound' ||
      error.name === 'NoSuchKey' ||
      error.$metadata.httpStatusCode === 404
    );
  }
  return false;
}

function classify(error: unknown): Error {
  if (isMissing(error)) return new ObjectNotFoundError('Objet absent.');
  // Toute autre erreur (réseau, 5xx, throttling, credentials) est traitée comme
  // transitoire par les appelants : la reprise est bornée par la politique de la tâche.
  return new StorageUnavailableError('Stockage objet indisponible.', { cause: error });
}

/**
 * Pilote S3 compatible (ARC-005, ADR-009). Les URLs présignées d’envoi signent le type et
 * la taille exacts ; le serveur revérifie l’objet reçu avant toute exploitation.
 */
export class S3ObjectStorage implements ObjectStorage {
  readonly driver = 's3' as const;
  private readonly client: S3Client;
  private readonly signer: S3Client;
  private readonly now: () => Date;

  constructor(private readonly options: S3StorageOptions) {
    const base = {
      region: options.region,
      forcePathStyle: options.forcePathStyle ?? false,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      // Pas de somme de contrôle ajoutée d’office aux URLs présignées (compatibilité S3).
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.client = new S3Client({
      ...base,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    });
    const publicEndpoint = options.publicEndpoint ?? options.endpoint;
    this.signer = new S3Client({
      ...base,
      ...(publicEndpoint ? { endpoint: publicEndpoint } : {}),
    });
    this.now = options.now ?? (() => new Date());
  }

  async presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<SignedRequest> {
    assertValidKey(key);
    const url = await getSignedUrl(
      this.signer,
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: key,
        ContentType: options.contentType,
        ContentLength: options.contentLength,
      }),
      {
        expiresIn: options.expiresInSeconds,
        signableHeaders: new Set(['content-type', 'content-length']),
        unhoistableHeaders: new Set(['content-type', 'content-length']),
      },
    );
    return {
      method: 'PUT',
      url,
      headers: { 'content-type': options.contentType },
      expiresAt: new Date(this.now().getTime() + options.expiresInSeconds * 1000),
    };
  }

  async presignGet(key: string, options: { expiresInSeconds: number }): Promise<SignedRequest> {
    assertValidKey(key);
    const url = await getSignedUrl(
      this.signer,
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      { expiresIn: options.expiresInSeconds },
    );
    return {
      method: 'GET',
      url,
      headers: {},
      expiresAt: new Date(this.now().getTime() + options.expiresInSeconds * 1000),
    };
  }

  async head(key: string): Promise<ObjectHead | null> {
    assertValidKey(key);
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      return { size: result.ContentLength ?? 0, contentType: result.ContentType ?? null };
    } catch (error) {
      if (isMissing(error)) return null;
      throw classify(error);
    }
  }

  async read(key: string, range?: ByteRange): Promise<Readable> {
    assertValidKey(key);
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
        }),
      );
      if (!(result.Body instanceof Readable)) throw new Error('Corps de réponse inattendu.');
      return result.Body;
    } catch (error) {
      throw classify(error);
    }
  }

  async writeFile(key: string, path: string, contentType: string): Promise<void> {
    assertValidKey(key);
    try {
      const { size } = await stat(path);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.options.bucket,
          Key: key,
          Body: createReadStream(path),
          ContentType: contentType,
          ContentLength: size,
        }),
      );
    } catch (error) {
      throw classify(error);
    }
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
    } catch (error) {
      if (isMissing(error)) return;
      throw classify(error);
    }
  }
}
