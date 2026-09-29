import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertValidKey,
  LOCAL_STORAGE_PREFIX,
  LocalObjectStorage,
  ObjectNotFoundError,
  parseRange,
} from '../src/index.js';

const SECRET = 'test-secret-with-at-least-32-bytes!!';

function query(url: string): { key: string; query: Record<string, string> } {
  const parsed = new URL(url, 'http://localhost');
  return {
    key: parsed.pathname.slice(LOCAL_STORAGE_PREFIX.length),
    query: Object.fromEntries(parsed.searchParams),
  };
}

describe('clés de stockage', () => {
  it.each(['org/a/media/b/original', 'a.b-c_d', 'x/y.webp'])('accepte %s', (key) => {
    expect(() => assertValidKey(key)).not.toThrow();
  });
  it.each([
    '',
    '../etc/passwd',
    'a/../b',
    'a//b',
    'a/./b',
    '/a',
    'a/',
    'a\\b',
    'a b',
    '.hidden',
    'a/..',
    'é',
  ])('refuse %j', (key) => {
    expect(() => assertValidKey(key)).toThrow();
  });
});

describe('plages', () => {
  it('interprète les formes usuelles', () => {
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=50-500', 100)).toEqual({ start: 50, end: 99 });
  });
  it('refuse les plages non satisfaisables ou multiples', () => {
    expect(parseRange('bytes=100-', 100)).toBeNull();
    expect(parseRange('bytes=5-1', 100)).toBeNull();
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('bytes=-0', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
  });
});

describe('pilote local', () => {
  let root: string;
  let now: Date;
  let storage: LocalObjectStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pixlova-storage-'));
    now = new Date('2026-09-29T12:00:00Z');
    storage = new LocalObjectStorage({ root, secret: SECRET, now: () => now });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function put(url: string, body: string, contentType = 'image/png', length?: number) {
    const { key, query: q } = query(url);
    return storage.receivePut(
      key,
      q,
      { 'content-type': contentType, 'content-length': String(length ?? Buffer.byteLength(body)) },
      Readable.from([Buffer.from(body)]),
    );
  }

  it('exige un secret suffisant', () => {
    expect(() => new LocalObjectStorage({ root, secret: 'court' })).toThrow();
  });

  it('reçoit un envoi signé de la taille exacte, puis le sert avec Range', async () => {
    const signed = await storage.presignPut('org/o/uploads/u', {
      contentType: 'image/png',
      contentLength: 10,
      expiresInSeconds: 900,
    });
    expect(signed.headers).toEqual({ 'content-type': 'image/png' });
    expect(await put(signed.url, '0123456789')).toMatchObject({ status: 200 });
    expect(await storage.head('org/o/uploads/u')).toEqual({ size: 10, contentType: 'image/png' });

    const get = await storage.presignGet('org/o/uploads/u', { expiresInSeconds: 300 });
    const { key, query: q } = query(get.url);
    const full = await storage.serveGet(key, q, undefined);
    expect(full.status).toBe(200);
    expect(await text(full.body!)).toBe('0123456789');
    const partial = await storage.serveGet(key, q, 'bytes=2-4');
    expect(partial).toMatchObject({
      status: 206,
      headers: { 'content-range': 'bytes 2-4/10', 'content-length': '3' },
    });
    expect(await text(partial.body!)).toBe('234');
    expect((await storage.serveGet(key, q, 'bytes=20-')).status).toBe(416);
  });

  it('refuse signature altérée, URL expirée, clé ou opération détournées', async () => {
    const signed = await storage.presignPut('org/o/uploads/u', {
      contentType: 'image/png',
      contentLength: 3,
      expiresInSeconds: 60,
    });
    const { key, query: q } = query(signed.url);
    const body = () => Readable.from([Buffer.from('abc')]);
    const headers = { 'content-type': 'image/png' };
    expect(await storage.receivePut(key, { ...q, len: '4' }, headers, body())).toMatchObject({
      status: 403,
      code: 'INVALID_SIGNATURE',
    });
    expect(await storage.receivePut('org/o/uploads/v', q, headers, body())).toMatchObject({
      status: 403,
    });
    expect(await storage.receivePut('../x', q, headers, body())).toMatchObject({
      status: 403,
      code: 'INVALID_KEY',
    });
    expect(await storage.serveGet(key, { ...q, op: 'get' }, undefined)).toMatchObject({
      status: 403,
    });
    now = new Date(now.getTime() + 61_000);
    expect(await storage.receivePut(key, q, headers, body())).toMatchObject({
      status: 403,
      code: 'URL_EXPIRED',
    });
  });

  it('refuse un type différent, un corps trop long ou trop court, sans laisser d’objet', async () => {
    const signed = await storage.presignPut('org/o/uploads/u', {
      contentType: 'video/mp4',
      contentLength: 5,
      expiresInSeconds: 60,
    });
    expect(await put(signed.url, '12345', 'image/png')).toMatchObject({
      status: 400,
      code: 'CONTENT_TYPE_MISMATCH',
    });
    const { key, query: q } = query(signed.url);
    const tooLong = await storage.receivePut(
      key,
      q,
      { 'content-type': 'video/mp4' },
      Readable.from([Buffer.from('123'), Buffer.from('456')]),
    );
    expect(tooLong).toMatchObject({ status: 413 });
    const tooShort = await storage.receivePut(
      key,
      q,
      { 'content-type': 'video/mp4' },
      Readable.from([Buffer.from('123')]),
    );
    expect(tooShort).toMatchObject({ status: 400, code: 'CONTENT_LENGTH_MISMATCH' });
    expect(await storage.head(key)).toBeNull();
  });

  it('écrit, lit, supprime de façon idempotente', async () => {
    const source = join(root, 'source.bin');
    await writeFile(source, 'hello');
    await storage.writeFile('org/o/media/m/original', source, 'text/plain');
    expect(await text(await storage.read('org/o/media/m/original', { start: 1, end: 3 }))).toBe(
      'ell',
    );
    await storage.delete('org/o/media/m/original');
    await storage.delete('org/o/media/m/original');
    expect(await storage.head('org/o/media/m/original')).toBeNull();
    await expect(storage.read('org/o/media/m/original')).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    expect(
      (
        await storage.serveGet(
          'org/o/media/m/original',
          query((await storage.presignGet('org/o/media/m/original', { expiresInSeconds: 60 })).url)
            .query,
          undefined,
        )
      ).status,
    ).toBe(404);
  });
});
