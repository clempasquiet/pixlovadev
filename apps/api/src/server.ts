import { Redis } from 'ioredis';
import pg from 'pg';
import { DEFAULT_MEDIA_LIMITS } from '@pixlova/contracts';
import { createDatabase } from '@pixlova/db';
import { createStorageFromEnv } from '@pixlova/storage';
import { buildInternalApp, buildPublicApp } from './app.js';
import { loadConfig } from './config.js';
import type { Services } from './http/services.js';
import { DataCipher } from './lib/crypto.js';
import { ConsoleMailer, dispatchEmails, type Mailer } from './lib/email.js';
import { FREE_ENTITLEMENTS, FREE_STORAGE_BYTES, fixedEntitlements } from './lib/entitlements.js';
import { MemoryRateLimiter, RedisRateLimiter } from './lib/rate-limit.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} est requis.`);
  return value;
}

const config = loadConfig();
const production = process.env.NODE_ENV === 'production';
const appPool = new pg.Pool({ connectionString: required('DATABASE_URL'), max: 20 });
const systemPool = new pg.Pool({ connectionString: required('DATABASE_SYSTEM_URL'), max: 5 });
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
if (!redis && production)
  throw new Error('REDIS_URL est requis en production (limitation de débit partagée).');

// Transport email de production à choisir avec L09-I ; en attendant, seul le mode console
// de développement est disponible et il est refusé en production (liens à jeton dans les logs).
let mailer: Mailer | null = null;
if (process.env.PIXLOVA_MAILER === 'console') {
  if (production) throw new Error('PIXLOVA_MAILER=console est interdit en production.');
  mailer = new ConsoleMailer();
}

const devMaxUsers = process.env.PIXLOVA_DEV_MAX_USERS;
const devDisplaySlots = process.env.PIXLOVA_DEV_DISPLAY_SLOTS;
const devStorageBytes = process.env.PIXLOVA_DEV_STORAGE_BYTES;
if ((devMaxUsers || devDisplaySlots || devStorageBytes) && production) {
  throw new Error('Les variables PIXLOVA_DEV_* sont interdites en production.');
}

const services: Services = {
  db: createDatabase(appPool),
  system: createDatabase(systemPool),
  cipher: DataCipher.fromEnv(process.env.PIXLOVA_DATA_KEYS),
  limiter: redis ? new RedisRateLimiter(redis) : new MemoryRateLimiter(),
  entitlements:
    devMaxUsers || devDisplaySlots || devStorageBytes
      ? fixedEntitlements(
          Number(devMaxUsers ?? 1),
          Number(devDisplaySlots ?? 1),
          devStorageBytes ? Number(devStorageBytes) : FREE_STORAGE_BYTES,
        )
      : FREE_ENTITLEMENTS,
  security: config.security,
  storage: createStorageFromEnv(),
  media: { ...config.media, limits: DEFAULT_MEDIA_LIMITS },
  now: () => new Date(),
};

const publicApp = buildPublicApp({ logger: true, services });
const internalApp = buildInternalApp({ logger: true });

let emailTimer: NodeJS.Timeout | undefined;
if (mailer) {
  const activeMailer = mailer;
  emailTimer = setInterval(() => {
    dispatchEmails(services.system, services.cipher, activeMailer).catch((error: unknown) =>
      publicApp.log.error({ err: error }, 'envoi des emails en échec'),
    );
  }, 2000);
}

async function shutdown(signal: string): Promise<void> {
  publicApp.log.info({ signal }, 'arrêt demandé');
  clearInterval(emailTimer);
  await Promise.allSettled([publicApp.close(), internalApp.close()]);
  await Promise.allSettled([appPool.end(), systemPool.end(), redis?.quit()]);
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await internalApp.listen(config.internal);
await publicApp.listen(config.public);
