import { LocalObjectStorage } from './local.js';
import { S3ObjectStorage } from './s3.js';
import type { ObjectStorage } from './types.js';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} est requis pour le stockage objet.`);
  return value;
}

/**
 * Stockage configuré par l’environnement (ADR-009). Le pilote `local` est refusé en
 * production : il ne sert qu’au développement et aux tests.
 */
export function createStorageFromEnv(env: NodeJS.ProcessEnv = process.env): ObjectStorage {
  const driver = env.PIXLOVA_STORAGE_DRIVER ?? 'local';
  if (driver === 'local') {
    if (env.NODE_ENV === 'production') {
      throw new Error('PIXLOVA_STORAGE_DRIVER=local est interdit en production.');
    }
    return new LocalObjectStorage({
      root: required(env, 'PIXLOVA_STORAGE_LOCAL_ROOT'),
      secret: required(env, 'PIXLOVA_STORAGE_LOCAL_SECRET'),
      publicBaseUrl: env.PIXLOVA_STORAGE_PUBLIC_URL ?? '',
    });
  }
  if (driver === 's3') {
    return new S3ObjectStorage({
      bucket: required(env, 'PIXLOVA_S3_BUCKET'),
      region: env.PIXLOVA_S3_REGION ?? 'auto',
      ...(env.PIXLOVA_S3_ENDPOINT ? { endpoint: env.PIXLOVA_S3_ENDPOINT } : {}),
      ...(env.PIXLOVA_S3_PUBLIC_ENDPOINT ? { publicEndpoint: env.PIXLOVA_S3_PUBLIC_ENDPOINT } : {}),
      forcePathStyle: env.PIXLOVA_S3_FORCE_PATH_STYLE === 'true',
      accessKeyId: required(env, 'PIXLOVA_S3_ACCESS_KEY_ID'),
      secretAccessKey: required(env, 'PIXLOVA_S3_SECRET_ACCESS_KEY'),
    });
  }
  throw new Error(`Pilote de stockage inconnu : ${driver}.`);
}
