import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import { LocalObjectStorage } from '@pixlova/storage';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { ApiError, registerErrorHandling } from './errors.js';
import { registerPlayerCors } from './http/player-cors.js';
import type { Services } from './http/services.js';
import { auditRoutes } from './modules/audit-log.js';
import { authRoutes } from './modules/auth.js';
import { compositionRoutes } from './modules/compositions.js';
import { displayProgramRoutes } from './modules/display-program.js';
import { playlistRoutes } from './modules/playlists.js';
import { programRoutes } from './modules/programs.js';
import { fleetRoutes } from './modules/fleet.js';
import { mediaRoutes } from './modules/media.js';
import { memberRoutes } from './modules/members.js';
import { organizationRoutes } from './modules/organizations.js';
import { playerApiRoutes } from './modules/player-api.js';
import { localStorageRoutes } from './modules/storage.js';

export interface AppOptions {
  logger?: FastifyServerOptions['logger'];
  /** Dépendances des routes `/api/v1` ; absentes, seules les routes techniques sont servies. */
  services?: Services;
}

function createBase(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    // Identifiant généré côté serveur : un en-tête client n’est pas une source fiable.
    genReqId: () => randomUUID(),
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
    bodyLimit: 1024 * 1024,
    // Derrière le tunnel, l’adresse du client vient de l’en-tête du proxy de confiance.
    trustProxy: process.env.PIXLOVA_TRUST_PROXY === 'true',
    ajv: { customOptions: { removeAdditional: false, allErrors: false, coerceTypes: false } },
  });
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
  });
  registerErrorHandling(app);
  return app;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Routes du dashboard : session par cookie, protection CSRF par origine (SEC-002). */
async function apiV1(app: FastifyInstance, services: Services): Promise<void> {
  await app.register(cookie);
  app.addHook('onRequest', async (request) => {
    if (!UNSAFE.has(request.method)) return;
    const origin = request.headers.origin;
    if (!origin || !services.security.allowedOrigins.includes(origin)) {
      throw new ApiError(403, 'CSRF_REJECTED', 'Origine de la requête non autorisée.');
    }
  });
  authRoutes(app, services);
  organizationRoutes(app, services);
  memberRoutes(app, services);
  fleetRoutes(app, services);
  mediaRoutes(app, services);
  compositionRoutes(app, services);
  playlistRoutes(app, services);
  programRoutes(app, services);
  displayProgramRoutes(app, services);
  auditRoutes(app, services);
}

/** API des Players : jeton Bearer, aucun cookie, aucune route d’administration (API-001). */
async function playerV1(app: FastifyInstance, services: Services): Promise<void> {
  registerPlayerCors(app, services.security.webPlayerOrigins);
  playerApiRoutes(app, services);
}

/**
 * Application exposée publiquement (dashboard, Players, webhooks).
 * Aucune route `/internal` ne doit y être enregistrée (API-001).
 */
export function buildPublicApp(options: AppOptions = {}): FastifyInstance {
  const app = createBase(options);
  app.addHook('onRoute', (route) => {
    if (route.url.startsWith('/internal')) {
      throw new Error(`Route interne interdite sur le listener public : ${route.url}`);
    }
  });
  app.get('/health', async () => ({ status: 'ok' }));
  const { services } = options;
  if (services) {
    void app.register((instance) => apiV1(instance, services), { prefix: '/api/v1' });
    void app.register((instance) => playerV1(instance, services), { prefix: '/player/v1' });
    if (services.storage instanceof LocalObjectStorage) {
      const storage = services.storage;
      void app.register(async (instance) => {
        // Lecture des assets par un Player Web d’une autre origine (ADR-013).
        registerPlayerCors(instance, services.security.webPlayerOrigins);
        await localStorageRoutes(instance, storage);
      });
    }
  }
  return app;
}

/** Application du réseau privé : workers, services et back-office plateforme. */
export function buildInternalApp(options: AppOptions = {}): FastifyInstance {
  const app = createBase(options);
  app.get('/internal/v1/health', async () => ({ status: 'ok' }));
  return app;
}
