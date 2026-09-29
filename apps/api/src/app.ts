import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { registerErrorHandling } from './errors.js';

export interface AppOptions {
  logger?: FastifyServerOptions['logger'];
}

function createBase(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    // Identifiant généré côté serveur : un en-tête client n’est pas une source fiable.
    genReqId: () => randomUUID(),
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
    bodyLimit: 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, allErrors: false } },
  });
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  registerErrorHandling(app);
  return app;
}

/**
 * Application exposée publiquement (dashboard, Players, webhooks).
 * Aucune route `/internal` ne doit y être enregistrée (API-001).
 */
export function buildPublicApp(options: AppOptions = {}): FastifyInstance {
  const app = createBase(options);
  app.get('/health', async () => ({ status: 'ok' }));
  app.addHook('onRoute', (route) => {
    if (route.url.startsWith('/internal')) {
      throw new Error(`Route interne interdite sur le listener public : ${route.url}`);
    }
  });
  return app;
}

/** Application du réseau privé : workers, services et back-office plateforme. */
export function buildInternalApp(options: AppOptions = {}): FastifyInstance {
  const app = createBase(options);
  app.get('/internal/v1/health', async () => ({ status: 'ok' }));
  return app;
}
