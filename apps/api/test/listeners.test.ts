import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildInternalApp, buildPublicApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function track(app: FastifyInstance): FastifyInstance {
  apps.push(app);
  return app;
}

describe('séparation des listeners (API-001)', () => {
  it('le listener public ne sert aucune route interne', async () => {
    const app = track(buildPublicApp());
    const response = await app.inject({ method: 'GET', url: '/internal/v1/health' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('refuse l’enregistrement d’une route interne sur le listener public', async () => {
    const app = track(buildPublicApp());
    expect(() => app.get('/internal/v1/admin/organizations', async () => ({}))).toThrow(
      /Route interne interdite/,
    );
  });

  it('le listener interne sert ses routes', async () => {
    const app = track(buildInternalApp());
    const response = await app.inject({ method: 'GET', url: '/internal/v1/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('enveloppe d’erreur (API-006)', () => {
  it('porte un request_id généré par le serveur et renvoyé en en-tête', async () => {
    const app = track(buildPublicApp());
    const response = await app.inject({
      method: 'GET',
      url: '/inconnue',
      headers: { 'x-request-id': 'fourni-par-le-client' },
    });
    const { error } = response.json();
    expect(error.request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['x-request-id']).toBe(error.request_id);
    expect(error.retryable).toBe(false);
  });

  it('ne divulgue pas le détail d’une erreur interne', async () => {
    const app = track(buildPublicApp());
    app.get('/boom', async () => {
      throw new Error('secret de connexion postgres://user:pass@db');
    });
    const response = await app.inject({ method: 'GET', url: '/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('postgres://');
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
  });
});

describe('configuration', () => {
  it('écoute par défaut le listener interne sur la boucle locale', () => {
    const config = loadConfig({});
    expect(config.internal.host).toBe('127.0.0.1');
    expect(config.public.port).not.toBe(config.internal.port);
  });

  it('refuse des ports identiques ou invalides', () => {
    expect(() => loadConfig({ PUBLIC_PORT: '4000', INTERNAL_PORT: '4000' })).toThrow();
    expect(() => loadConfig({ PUBLIC_PORT: '70000' })).toThrow();
  });
});
