/**
 * Outils de test (entrée `@pixlova/api/testing`) : services de l’API branchés sur une base
 * éphémère, transport email en mémoire, horloge contrôlable. Jamais utilisé en production.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeStripeGateway } from '@pixlova/billing/testing';
import {
  DEFAULT_MEDIA_LIMITS,
  RELEASE_ENVELOPE_TYPE,
  publicKeyFromSecret,
  signEnvelope,
  type TrustStore,
} from '@pixlova/contracts';
import type { TestDatabase } from '@pixlova/db/testing';
import { LocalObjectStorage } from '@pixlova/storage';
import {
  defaultMediaConfig,
  defaultSupervisionConfig,
  defaultSecurityConfig,
  type SecurityConfig,
} from './config.js';
import type { Services } from './http/services.js';
import { DataCipher } from './lib/crypto.js';
import { projectedEntitlements } from './lib/entitlements.js';
import { dispatchAlertNotifications } from './lib/alert-notifications.js';
import { dispatchEmails, MemoryMailer } from './lib/email.js';
import { MemoryRateLimiter } from './lib/rate-limit.js';

export interface TestServices {
  services: Services;
  mailer: MemoryMailer;
  clock: { now: Date; advance(ms: number): void };
  setMaxUsers(value: number): void;
  setDisplaySlots(value: number): void;
  setStorageBytes(value: number): void;
  setFeatures(value: string[]): void;
  /** Stockage local à URLs signées, dans un répertoire temporaire propre au test. */
  storage: LocalObjectStorage;
  storageRoot: string;
  /** Stripe simulé (option `billing`) ; `null` sinon. */
  stripe: FakeStripeGateway | null;
  flushEmails(): Promise<void>;
}

export interface TestOptions {
  /**
   * Droits issus de la projection de facturation (ADR-017) et Stripe simulé, au lieu des
   * quotas fixes réglables par `setMaxUsers`, `setDisplaySlots`…
   */
  billing?: boolean;
}

export function createTestServices(
  database: TestDatabase,
  security: Partial<SecurityConfig> = {},
  options: TestOptions = {},
): TestServices {
  const clock = {
    now: new Date(),
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  let maxUsers = 1;
  let displaySlots = 1;
  let storageBytes = 2_000_000_000;
  let features: string[] = [];
  const mailer = new MemoryMailer();
  const storageRoot = mkdtempSync(join(tmpdir(), 'pixlova-api-storage-'));
  const storage = new LocalObjectStorage({
    root: storageRoot,
    secret: randomBytes(32).toString('hex'),
    now: () => clock.now,
  });
  const stripe = options.billing ? new FakeStripeGateway(() => clock.now) : null;
  const services: Services = {
    db: database.app,
    system: database.system,
    cipher: new DataCipher([{ kid: 'test', key: randomBytes(32) }]),
    limiter: new MemoryRateLimiter(() => clock.now.getTime()),
    entitlements: options.billing
      ? projectedEntitlements(database.app, 'test', () => clock.now)
      : {
          maxUsers: async () => maxUsers,
          displaySlots: async () => displaySlots,
          storageBytes: async () => storageBytes,
          features: async () => features,
        },
    billing: { gateway: stripe, environment: 'test', graceDays: 7, checkoutMinutes: 60 },
    security: { ...defaultSecurityConfig({}), requireMfaForAdmins: false, ...security },
    storage,
    media: { ...defaultMediaConfig({}), limits: DEFAULT_MEDIA_LIMITS },
    supervision: {
      ...defaultSupervisionConfig({}),
      commandKey: { kid: 'command-test', secretKey: new Uint8Array(randomBytes(32)) },
    },
    now: () => clock.now,
  };
  return {
    services,
    mailer,
    clock,
    setMaxUsers(value) {
      maxUsers = value;
    },
    setDisplaySlots(value) {
      displaySlots = value;
    },
    setStorageBytes(value) {
      storageBytes = value;
    },
    setFeatures(value) {
      features = value;
    },
    storage,
    storageRoot,
    stripe,
    flushEmails: async () => {
      await dispatchAlertNotifications(
        database.system,
        services.cipher,
        services.security.appBaseUrl,
        100,
      );
      await dispatchEmails(database.system, services.cipher, mailer, 100);
    },
  };
}

/** Outils des tests de la console d’administration (ADR-016). */
export { currentStep, totpAt } from './lib/totp.js';
export { createOperator } from './admin/operators.js';

/**
 * Chaîne de signature de releases de test (ADR-019) : clé éphémère, magasin de confiance
 * correspondant et enveloppe SIGNAGE_RELEASE_V1 pour un paquet Linux x86_64 donné.
 */
export function testReleaseSigner(kid = 'release-test') {
  const secret = new Uint8Array(randomBytes(32));
  const trust: TrustStore = new Map([[kid, publicKeyFromSecret(secret)]]);
  return {
    trust,
    sign(version: string, bytes: Uint8Array): string {
      const payload = {
        schema_version: 1,
        release_id: randomUUID(),
        version,
        os: 'linux',
        arch: 'x86_64',
        package: {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size_bytes: bytes.length,
        },
        protocol_min: 1,
        protocol_max: 1,
        sqlite_schema: 3,
        sqlite_reader_level: 1,
        renderer_build: version,
        published_at: new Date().toISOString(),
      };
      return JSON.stringify(signEnvelope(RELEASE_ENVELOPE_TYPE, kid, payload, secret));
    },
  };
}
