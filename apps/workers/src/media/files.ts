import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { ObjectStorage } from '@pixlova/storage';
import { ObjectNotFoundError } from '@pixlova/storage';
import { PermanentMediaError } from '../errors.js';

/**
 * Copie locale d’un objet avec calcul du SHA-256 en flux ; au-delà de `expectedSize`
 * octets, la copie s’arrête (fichier plus grand que déclaré).
 */
export async function downloadObject(
  storage: ObjectStorage,
  key: string,
  destination: string,
  expectedSize: number,
  signal?: AbortSignal,
): Promise<{ sha256: string; size: number }> {
  let source;
  try {
    source = await storage.read(key);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      throw new PermanentMediaError('UPLOAD_MISSING', 'Fichier reçu introuvable dans le stockage.');
    }
    throw error;
  }
  const hash = createHash('sha256');
  let size = 0;
  await pipeline(
    source,
    async function* (chunks: AsyncIterable<Buffer>) {
      for await (const chunk of chunks) {
        size += chunk.length;
        if (size > expectedSize) {
          throw new PermanentMediaError('UPLOAD_SIZE_MISMATCH', 'Fichier plus grand que déclaré.');
        }
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(destination),
    ...(signal ? [{ signal }] : []),
  );
  if (size !== expectedSize) {
    throw new PermanentMediaError('UPLOAD_SIZE_MISMATCH', 'Fichier incomplet.');
  }
  return { sha256: hash.digest('hex'), size };
}

export async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest('hex'), size };
}
