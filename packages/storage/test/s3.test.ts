/**
 * Pilote S3 contre un service compatible (moto en local et en CI, voir ADR-009).
 * `PIXLOVA_TEST_S3_ENDPOINT` absent : ignoré localement, échec en CI.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectNotFoundError, S3ObjectStorage, StorageUnavailableError } from '../src/index.js';

const endpoint = process.env.PIXLOVA_TEST_S3_ENDPOINT;
const skip = !endpoint && !process.env.CI;
const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };

describe.skipIf(skip)('pilote S3 (service compatible)', () => {
  const bucket = `pixlova-test-${Date.now()}`;
  let storage: S3ObjectStorage;
  let dir: string;

  beforeAll(async () => {
    if (!endpoint) throw new Error('PIXLOVA_TEST_S3_ENDPOINT est requis en CI.');
    const admin = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials,
    });
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    storage = new S3ObjectStorage({
      bucket,
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      ...credentials,
    });
    dir = await mkdtemp(join(tmpdir(), 'pixlova-s3-'));
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('envoi par URL présignée, head, lecture partielle et URL de lecture', async () => {
    const signed = await storage.presignPut('org/o/uploads/u', {
      contentType: 'image/png',
      contentLength: 10,
      expiresInSeconds: 900,
    });
    expect(signed.url).toContain('X-Amz-Signature=');
    // Taille et type font partie de la signature : le client ne peut pas les changer.
    expect(new URL(signed.url).searchParams.get('X-Amz-SignedHeaders')).toBe(
      'content-length;content-type;host',
    );
    const put = await fetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: '0123456789',
    });
    expect(put.status).toBe(200);
    expect(await storage.head('org/o/uploads/u')).toEqual({ size: 10, contentType: 'image/png' });
    expect(await text(await storage.read('org/o/uploads/u', { start: 3, end: 5 }))).toBe('345');
    const get = await storage.presignGet('org/o/uploads/u', { expiresInSeconds: 60 });
    const response = await fetch(get.url, { headers: { range: 'bytes=0-1' } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('01');
  });

  it('écriture depuis un fichier, suppression idempotente, objet absent', async () => {
    const source = join(dir, 'variant.webp');
    await writeFile(source, 'variant');
    await storage.writeFile('org/o/media/m/thumbnail', source, 'image/webp');
    expect(await storage.head('org/o/media/m/thumbnail')).toEqual({
      size: 7,
      contentType: 'image/webp',
    });
    await storage.delete('org/o/media/m/thumbnail');
    await storage.delete('org/o/media/m/thumbnail');
    expect(await storage.head('org/o/media/m/thumbnail')).toBeNull();
    await expect(storage.read('org/o/media/m/thumbnail')).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  it('un service injoignable est une indisponibilité transitoire', async () => {
    const down = new S3ObjectStorage({
      bucket,
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9',
      forcePathStyle: true,
      ...credentials,
    });
    await expect(down.head('org/o/x')).rejects.toBeInstanceOf(StorageUnavailableError);
  });
});
