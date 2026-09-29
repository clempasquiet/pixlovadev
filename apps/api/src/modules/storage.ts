import type { FastifyInstance } from 'fastify';
import { LOCAL_STORAGE_PREFIX, type LocalObjectStorage } from '@pixlova/storage';
import { ApiError } from '../errors.js';

/**
 * Service des URLs signées du pilote local (développement et tests, ADR-009). La signature
 * est l’unique autorisation : ni cookie ni session. Le corps n’est jamais chargé en mémoire.
 */
export async function localStorageRoutes(
  app: FastifyInstance,
  storage: LocalObjectStorage,
): Promise<void> {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_request, payload, done) => done(null, payload));

  const keyOf = (url: string) =>
    decodeURIComponent(url.split('?')[0]!.slice(LOCAL_STORAGE_PREFIX.length));

  app.put(`${LOCAL_STORAGE_PREFIX}*`, async (request, reply) => {
    const result = await storage.receivePut(
      keyOf(request.url),
      request.query as Record<string, string>,
      request.headers,
      request.raw,
    );
    if (result.status >= 400) {
      throw new ApiError(result.status, result.code ?? 'STORAGE_REJECTED', 'Envoi refusé.');
    }
    return reply.status(200).send();
  });

  app.get(`${LOCAL_STORAGE_PREFIX}*`, async (request, reply) => {
    const result = await storage.serveGet(
      keyOf(request.url),
      request.query as Record<string, string>,
      request.headers.range,
    );
    if (result.status >= 400) {
      if (result.status === 416) reply.headers(result.headers);
      throw new ApiError(result.status, result.code ?? 'STORAGE_REJECTED', 'Lecture refusée.');
    }
    reply.status(result.status).headers(result.headers);
    // Réponse privée : l’en-tête `no-store` global s’applique aussi.
    return reply.send(result.body);
  });
}
