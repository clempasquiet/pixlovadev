/** Opérateur de la plateforme simulé (console d’administration, ADR-016). */
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { totpNow, type Harness } from './harness.js';

export const ADMIN_ORIGIN = 'http://127.0.0.1:8081';
export const OPERATOR_PASSWORD = 'phrase de passe opérateur très longue';
export const REASON = 'Ticket #4242 : diagnostic demandé par le client';

export class Operator {
  cookie: string | null = null;
  secret = '';

  constructor(
    private readonly app: FastifyInstance,
    private readonly h: Harness,
    readonly email: string,
  ) {}

  async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    const response = await this.app.inject({
      method,
      url: url.startsWith('/admin-api') ? url : `/admin-api/v1${url}`,
      ...(payload === undefined ? {} : { payload: payload as object }),
      headers: {
        origin: ADMIN_ORIGIN,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
    });
    const setCookie = response.headers['set-cookie'];
    for (const value of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const [pair] = value.split(';');
      if (/Expires=Thu, 01 Jan 1970/.test(value) || pair?.endsWith('=')) this.cookie = null;
      else if (pair) this.cookie = pair;
    }
    return response;
  }

  get = (url: string, reason?: string) =>
    this.request('GET', url, undefined, reason ? { 'x-support-reason': reason } : {});
  post = (url: string, payload: unknown = {}) => this.request('POST', url, payload);
  put = (url: string, payload: unknown) => this.request('PUT', url, payload);
  /** Code TOTP d’un pas donné : chaque pas n’est accepté qu’une fois. */
  code = (offset = 0) => totpNow(this.secret, this.h, offset);

  async activate(activationCode: string): Promise<void> {
    const activated = await this.post('/auth/activate', {
      email: this.email,
      activation_code: activationCode,
      password: OPERATOR_PASSWORD,
    });
    expect(activated.statusCode, activated.body).toBe(200);
    this.secret = activated.json().secret;
    const confirmed = await this.post('/auth/activate/confirm', { code: this.code() });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
  }

  async login(): Promise<void> {
    this.h.clock.advance(31_000); // nouveau pas TOTP
    expect(
      (await this.post('/auth/login', { email: this.email, password: OPERATOR_PASSWORD }))
        .statusCode,
    ).toBe(200);
    expect((await this.post('/auth/mfa/verify', { code: this.code() })).statusCode).toBe(200);
  }
}
