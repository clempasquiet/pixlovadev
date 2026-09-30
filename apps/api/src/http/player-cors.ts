import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.js';

/**
 * CORS des routes utilisées par le Player Web servi depuis une autre origine (ADR-013) :
 * liste explicite d’origines, jamais de credentials (jeton Bearer, aucun cookie), en-têtes
 * et méthodes limités. Même origine que l’API : aucun en-tête n’est nécessaire.
 */
export function registerPlayerCors(app: FastifyInstance, origins: readonly string[]): void {
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    const allowed = origin !== undefined && origins.includes(origin);
    if (allowed) {
      reply.header('access-control-allow-origin', origin);
      reply.header(
        'access-control-expose-headers',
        'etag, retry-after, x-request-id, content-range',
      );
    }
    reply.header('vary', 'Origin');
    if (request.method !== 'OPTIONS') return;
    if (!allowed) throw new ApiError(403, 'CORS_REJECTED', 'Origine non autorisée.');
    reply.header('access-control-allow-methods', 'GET, POST');
    reply.header(
      'access-control-allow-headers',
      'authorization, content-type, if-none-match, range',
    );
    reply.header('access-control-max-age', '600');
    return reply.status(204).send();
  });
  // Route de repli pour que les requêtes préliminaires atteignent le hook ci-dessus.
  app.options('/*', async (_request, reply) => reply.status(204).send());
}
