import { randomBytes } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createTestDatabase, type TestDatabase } from '@pixlova/db/testing';
import { buildPublicApp } from '../../src/app.js';
import { defaultSecurityConfig, type SecurityConfig } from '../../src/config.js';
import type { Services } from '../../src/http/services.js';
import { DataCipher } from '../../src/lib/crypto.js';
import { dispatchEmails, MemoryMailer } from '../../src/lib/email.js';
import { fixedEntitlements } from '../../src/lib/entitlements.js';
import { MemoryRateLimiter } from '../../src/lib/rate-limit.js';
import { currentStep, totpAt } from '../../src/lib/totp.js';

export const ORIGIN = 'https://app.pixlova.test';

export interface Harness {
  app: FastifyInstance;
  database: TestDatabase;
  services: Services;
  mailer: MemoryMailer;
  clock: { now: Date; advance(ms: number): void };
  setMaxUsers(value: number): void;
  flushEmails(): Promise<void>;
  close(): Promise<void>;
}

export async function createHarness(security: Partial<SecurityConfig> = {}): Promise<Harness> {
  const database = await createTestDatabase();
  const clock = {
    now: new Date(),
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  let maxUsers = 1;
  const mailer = new MemoryMailer();
  const services: Services = {
    db: database.app,
    system: database.system,
    cipher: new DataCipher([{ kid: 'test', key: randomBytes(32) }]),
    limiter: new MemoryRateLimiter(() => clock.now.getTime()),
    entitlements: { maxUsers: async (orgId) => fixedEntitlements(maxUsers).maxUsers(orgId) },
    security: {
      ...defaultSecurityConfig({}),
      allowedOrigins: [ORIGIN],
      appBaseUrl: ORIGIN,
      cookieSecure: true,
      requireMfaForAdmins: false,
      ...security,
    },
    now: () => clock.now,
  };
  const app = buildPublicApp({ services });
  await app.ready();
  return {
    app,
    database,
    services,
    mailer,
    clock,
    setMaxUsers(value) {
      maxUsers = value;
    },
    async flushEmails() {
      await dispatchEmails(database.system, services.cipher, mailer, 100);
    },
    async close() {
      await app.close();
      await database.close();
    },
  };
}

/** Client HTTP avec cookie de session, origine autorisée et organisation active. */
export class Client {
  cookie: string | null = null;
  organizationId: string | null = null;

  constructor(
    private readonly harness: Harness,
    readonly email: string,
  ) {}

  async request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ): Promise<LightMyRequestResponse> {
    const response = await this.harness.app.inject({
      method,
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload: payload as object }),
      headers: {
        origin: ORIGIN,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.organizationId ? { 'x-organization-id': this.organizationId } : {}),
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

  get = (url: string) => this.request('GET', url);
  post = (url: string, payload: unknown = {}) => this.request('POST', url, payload);
  put = (url: string, payload: unknown) => this.request('PUT', url, payload);
  patch = (url: string, payload: unknown) => this.request('PATCH', url, payload);
  delete = (url: string) => this.request('DELETE', url);
}

export const PASSWORD = 'correct horse battery staple';

function tokenFrom(link: string | undefined): string {
  const token = link ? new URL(link).searchParams.get('token') : null;
  if (!token) throw new Error('Lien à jeton introuvable dans les emails.');
  return token;
}

export async function lastLinkToken(
  harness: Harness,
  email: string,
  path: string,
): Promise<string> {
  await harness.flushEmails();
  return tokenFrom(harness.mailer.linkFor(email, path));
}

/** Inscription, vérification et connexion d’un nouvel utilisateur. */
export async function signUp(harness: Harness, email: string): Promise<Client> {
  const client = new Client(harness, email);
  const registered = await client.post('/auth/register', {
    email,
    password: PASSWORD,
    display_name: email.split('@')[0],
  });
  if (registered.statusCode !== 202) throw new Error(`inscription : ${registered.body}`);
  const token = await lastLinkToken(harness, email, '/verify-email');
  const verified = await client.post('/auth/verify-email', { token });
  if (verified.statusCode !== 200) throw new Error(`vérification : ${verified.body}`);
  const login = await client.post('/auth/login', { email, password: PASSWORD });
  if (login.statusCode !== 200) throw new Error(`connexion : ${login.body}`);
  return client;
}

export async function createOrganization(
  client: Client,
  name: string,
): Promise<{ id: string; siteId: string }> {
  const response = await client.post('/organizations', {
    name,
    country: 'FR',
    timezone: 'Europe/Paris',
  });
  if (response.statusCode !== 201) throw new Error(`organisation : ${response.body}`);
  client.organizationId = response.json().id;
  const sites = await client.get('/sites');
  return { id: client.organizationId!, siteId: sites.json().items[0].id };
}

export function totpNow(secret: string, harness: Harness, offsetSteps = 0): string {
  return totpAt(secret, currentStep(harness.clock.now.getTime()) + offsetSteps);
}
