import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Writable } from 'node:stream';
import { buildInternalApp, buildPublicApp } from '../src/app.js';
import { loggerOptions, Metrics } from '../src/observability.js';
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

  it('la sonde de disponibilité reflète les dépendances, sans détail', async () => {
    let failure: Error | null = null;
    const app = track(
      buildInternalApp({
        ready: async () => {
          if (failure) throw failure;
        },
      }),
    );
    expect((await app.inject({ method: 'GET', url: '/internal/v1/ready' })).statusCode).toBe(200);
    failure = new Error('connect ECONNREFUSED 10.0.0.5:5432');
    const response = await app.inject({ method: 'GET', url: '/internal/v1/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('ECONNREFUSED');
    const pub = track(buildPublicApp());
    expect((await pub.inject({ method: 'GET', url: '/internal/v1/ready' })).statusCode).toBe(404);
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

describe('observabilité (OBS-001, OBS-002)', () => {
  it('métriques sur le seul listener interne, labels à cardinalité bornée', async () => {
    const metrics = new Metrics();
    const pub = track(buildPublicApp({ metrics }));
    const internal = track(
      buildInternalApp({
        metrics,
        gauges: async () => [
          {
            name: 'pixlova_players',
            help: 'test',
            samples: [{ labels: { presence: 'online' }, value: 2 }],
          },
        ],
      }),
    );
    await pub.inject({ method: 'GET', url: '/health' });
    await pub.inject({
      method: 'GET',
      url: '/storage/v1/objects/org/0f0f/x?sig=secret-signature',
    });
    expect((await pub.inject({ method: 'GET', url: '/internal/v1/metrics' })).statusCode).toBe(404);
    const response = await internal.inject({ method: 'GET', url: '/internal/v1/metrics' });
    expect(response.headers['content-type']).toMatch(/^text\/plain; version=0.0.4/);
    const text = response.body;
    expect(text).toContain(
      'pixlova_http_requests_total{route="/health",method="GET",status_class="2xx"} 1',
    );
    expect(text).toContain('route="unmatched"');
    expect(text).toContain('pixlova_players{presence="online"} 2');
    expect(text).not.toMatch(/secret-signature|0f0f/);
  });

  it('journaux expurgés : ni jeton, ni cookie, ni URL signée', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = track(buildPublicApp({ logger: { ...loggerOptions('info'), stream } }));
    await app.inject({
      method: 'GET',
      url: '/player/v1/assets/x/url?manifest_id=y&sig=secret-signature',
      headers: { authorization: 'Bearer jeton-secret', cookie: 'session=cookie-secret' },
    });
    const output = lines.join('');
    expect(output).toContain('/player/v1/assets/x/url');
    expect(output).not.toMatch(/secret-signature|jeton-secret|cookie-secret/);
  });
});
