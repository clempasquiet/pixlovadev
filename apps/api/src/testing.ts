/**
 * Outils de test (entrée `@pixlova/api/testing`) : services de l’API branchés sur une base
 * éphémère, transport email en mémoire, horloge contrôlable. Jamais utilisé en production.
 */
import { randomBytes } from 'node:crypto';
import type { TestDatabase } from '@pixlova/db/testing';
import { defaultSecurityConfig, type SecurityConfig } from './config.js';
import type { Services } from './http/services.js';
import { DataCipher } from './lib/crypto.js';
import { dispatchEmails, MemoryMailer } from './lib/email.js';
import { MemoryRateLimiter } from './lib/rate-limit.js';

export interface TestServices {
  services: Services;
  mailer: MemoryMailer;
  clock: { now: Date; advance(ms: number): void };
  setMaxUsers(value: number): void;
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
  const mailer = new MemoryMailer();
  const services: Services = {
    db: database.app,
    system: database.system,
    cipher: new DataCipher([{ kid: 'test', key: randomBytes(32) }]),
    limiter: new MemoryRateLimiter(() => clock.now.getTime()),
    entitlements: { maxUsers: async () => maxUsers },
    security: { ...defaultSecurityConfig({}), requireMfaForAdmins: false, ...security },
    now: () => clock.now,
  };
  return {
    services,
    mailer,
    clock,
    setMaxUsers(value) {
      maxUsers = value;
    },
    flushEmails: async () => {
      await dispatchEmails(database.system, services.cipher, mailer, 100);
    },
  };
}
