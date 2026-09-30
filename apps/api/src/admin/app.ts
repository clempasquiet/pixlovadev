import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { createBase } from '../app.js';
import { ApiError } from '../errors.js';
import { adminAuthRoutes } from './auth.js';
import type { AdminServices } from './services.js';
import { adminSupportRoutes } from './support.js';
import { adminTeamRoutes } from './team.js';
import { adminViewRoutes } from './views.js';

export interface AdminAppOptions {
  logger?: FastifyServerOptions['logger'];
  services: AdminServices;
  /** Build de la console (`apps/admin-console/dist`) ; absent : API seule. */
  consoleDir?: string | undefined;
  /** Dépendances indispensables (base) : sonde du conteneur. */
  ready?: () => Promise<void>;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Application d’administration plateforme (ADM-001, ADR-016), servie sur son propre
 * listener (8081) dans un conteneur distinct, jamais par la passerelle publique. Elle
 * n’enregistre aucune route du dashboard, des Players ou du listener interne.
 */
export function buildAdminApp(options: AdminAppOptions): FastifyInstance {
  const app = createBase({ logger: options.logger ?? false });
  app.addHook('onRoute', (route) => {
    if (/^\/(api|player|internal)(\/|$)/.test(route.url)) {
      throw new Error(`Route hors administration interdite : ${route.url}`);
    }
  });
  app.addHook('onSend', async (_request, reply) => {
    reply.header(
      'content-security-policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
  });

  app.get('/admin-ready', async (_request, reply) => {
    try {
      await options.ready?.();
      return { status: 'ready' };
    } catch (error) {
      app.log.warn({ err: error }, 'dépendance indisponible');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  const { services } = options;
  void app.register(
    async (instance) => {
      await instance.register(cookie);
      instance.addHook('onRequest', async (request) => {
        if (!UNSAFE.has(request.method)) return;
        const origin = request.headers.origin;
        if (!origin || !services.config.allowedOrigins.includes(origin)) {
          throw new ApiError(403, 'CSRF_REJECTED', 'Origine de la requête non autorisée.');
        }
      });
      adminAuthRoutes(instance, services);
      adminViewRoutes(instance, services);
      adminSupportRoutes(instance, services);
      adminTeamRoutes(instance, services);
    },
    { prefix: '/admin-api/v1' },
  );

  if (options.consoleDir) {
    const root = resolve(options.consoleDir);
    // Console monopage : fichiers du build, sinon index.html (routes du client).
    app.get('/*', async (request, reply) => {
      if (request.url.startsWith('/admin-api/')) {
        throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Ressource introuvable.');
      }
      let path: string;
      try {
        path = decodeURIComponent(request.url.split('?')[0] ?? '/');
      } catch {
        throw new ApiError(400, 'VALIDATION_ERROR', 'Chemin invalide.');
      }
      const candidate = normalize(join(root, path));
      const inside = candidate === root || candidate.startsWith(root + sep);
      const file = inside && extname(candidate) ? candidate : join(root, 'index.html');
      try {
        const content = await readFile(file);
        return reply.type(CONTENT_TYPES[extname(file)] ?? 'application/octet-stream').send(content);
      } catch {
        throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Ressource introuvable.');
      }
    });
  }
  return app;
}
