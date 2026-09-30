import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiRequestError, setActiveOrganization } from '../../src/api.js';

afterEach(() => {
  vi.unstubAllGlobals();
  setActiveOrganization(null);
});

describe('client API du dashboard', () => {
  it('envoie l’organisation active et le cookie de même origine', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    setActiveOrganization('55555555-5555-4555-8555-555555555555');
    await api('POST', '/sites', { name: 'A' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/sites');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['x-organization-id']).toBe(
      '55555555-5555-4555-8555-555555555555',
    );
  });

  it('expose le code et le message de l’enveloppe d’erreur', async () => {
    const body = {
      error: {
        code: 'FORBIDDEN',
        message: 'Action non autorisée.',
        request_id: 'r',
        retryable: false,
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 403 })),
    );
    const error = await api('GET', '/members').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).code).toBe('FORBIDDEN');
    expect((error as ApiRequestError).message).toBe('Action non autorisée.');
  });

  it('traduit une panne réseau en erreur explicite et récupérable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('failed'))),
    );
    const error = (await api('GET', '/auth/me').catch((e: unknown) => e)) as ApiRequestError;
    expect([error.code, error.body.retryable]).toEqual(['NETWORK_ERROR', true]);
  });
});
