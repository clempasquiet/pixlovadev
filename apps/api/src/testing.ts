/**
 * Outils de test (entrée `@pixlova/api/testing`) : services de l’API branchés sur une base
 * éphémère, transport email en mémoire, horloge contrôlable. Jamais utilisé en production.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MEDIA_LIMITS } from '@pixlova/contracts';
import type { TestDatabase } from '@pixlova/db/testing';
import { LocalObjectStorage } from '@pixlova/storage';
import { defaultMediaConfig, defaultSecurityConfig, type SecurityConfig } from './config.js';
import type { Services } from './http/services.js';
import { DataCipher } from './lib/crypto.js';
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
  flushEmails(): Promise<void>;
}

export function createTestServices(
  database: TestDatabase,
  security: Partial<SecurityConfig> = {},
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
  const services: Services = {
    db: database.app,
    system: database.system,
    cipher: new DataCipher([{ kid: 'test', key: randomBytes(32) }]),
    limiter: new MemoryRateLimiter(() => clock.now.getTime()),
    entitlements: {
      maxUsers: async () => maxUsers,
      displaySlots: async () => displaySlots,
      storageBytes: async () => storageBytes,
      features: async () => features,
    },
    security: { ...defaultSecurityConfig({}), requireMfaForAdmins: false, ...security },
    storage,
    media: { ...defaultMediaConfig({}), limits: DEFAULT_MEDIA_LIMITS },
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
    flushEmails: async () => {
      await dispatchEmails(database.system, services.cipher, mailer, 100);
    },
  };
}
