/**
 * CORS des routes Player pour un Player Web servi depuis une autre origine (ADR-013) :
 * seules les origines configurées sont servies, sans credentials ; le dashboard reste
 * protégé par sa propre vérification d’origine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './support/harness.js';

const PLAYER_ORIGIN = 'https://play.pixlova.test';

describe('CORS du Player Web (ADR-013)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ webPlayerOrigins: [PLAYER_ORIGIN] });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('répond à la requête préliminaire d’une origine autorisée, sans credentials', async () => {
    const response = await h.app.inject({
      method: 'OPTIONS',
      url: '/player/v1/manifest?display_id=x',
      headers: {
        origin: PLAYER_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization, if-none-match',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(PLAYER_ORIGIN);
    expect(response.headers['access-control-allow-headers']).toContain('authorization');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('expose l’ETag aux réponses d’une origine autorisée', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/player/v1/token/challenge',
      headers: { origin: PLAYER_ORIGIN, 'content-type': 'application/json' },
      payload: { player_id: '00000000-0000-4000-8000-000000000000' },
    });
    expect(response.headers['access-control-allow-origin']).toBe(PLAYER_ORIGIN);
    expect(response.headers['access-control-expose-headers']).toContain('etag');
  });

  it('refuse une origine inconnue et ne s’étend pas aux routes du dashboard', async () => {
    const preflight = await h.app.inject({
      method: 'OPTIONS',
      url: '/player/v1/config',
      headers: { origin: 'https://evil.test', 'access-control-request-method': 'GET' },
    });
    expect(preflight.statusCode).toBe(403);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    const dashboard = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: PLAYER_ORIGIN, 'content-type': 'application/json' },
      payload: { email: 'a@b.test', password: 'x' },
    });
    expect(dashboard.statusCode).toBe(403);
    expect(dashboard.headers['access-control-allow-origin']).toBeUndefined();
  });
});
