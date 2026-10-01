/**
 * Point d’entrée de l’administration plateforme (ADR-016) : conteneur distinct, listener
 * privé (8081 par défaut), rôle PostgreSQL `pixlova_platform`. Jamais relayé par la
 * passerelle publique ni par un hostname public du tunnel (ADM-001).
 */
import { Redis } from 'ioredis';
import pg from 'pg';
import { createDatabase } from '@pixlova/db';
import { createStorageFromEnv } from '@pixlova/storage';
import { buildAdminApp } from './admin/app.js';
import { loadAdminConfig } from './admin/config.js';
import { releaseTrustFromEnv } from './admin/releases.js';
import { billingEnvironmentFromEnv } from './lib/billing.js';
import { DataCipher } from './lib/crypto.js';
import { deploymentFromEnv, entitlementsFromEnv } from './lib/entitlements.js';
import { MemoryRateLimiter, RedisRateLimiter } from './lib/rate-limit.js';
import { loggerOptions } from './observability.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} est requis.`);
  return value;
}

const production = process.env.NODE_ENV === 'production';
const deployment = deploymentFromEnv();
const pool = new pg.Pool({ connectionString: required('DATABASE_PLATFORM_URL'), max: 5 });
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
if (!redis && production) {
  throw new Error('REDIS_URL est requis en production (limitation des tentatives).');
}
const config = loadAdminConfig();
if (production && !config.cookieSecure) {
  throw new Error('PIXLOVA_ADMIN_COOKIE_SECURE=false est interdit en production.');
}

const platform = createDatabase(pool);
const app = buildAdminApp({
  logger: loggerOptions(),
  services: {
    platform,
    cipher: DataCipher.fromEnv(process.env.PIXLOVA_DATA_KEYS),
    limiter: redis ? new RedisRateLimiter(redis) : new MemoryRateLimiter(),
    entitlements: entitlementsFromEnv(process.env, deployment, {
      db: platform,
      environment: billingEnvironmentFromEnv(process.env),
    }),
    billingEnvironment: billingEnvironmentFromEnv(process.env),
    config,
    // Registre des releases (ADR-019) : clés publiques seulement ; stockage des paquets
    // facultatif, sous le préfixe `releases/`.
    releaseTrust: releaseTrustFromEnv(process.env.PIXLOVA_RELEASE_PUBLIC_KEYS),
    storage: process.env.PIXLOVA_STORAGE_DRIVER ? createStorageFromEnv(process.env) : null,
    now: () => new Date(),
  },
  consoleDir: process.env.PIXLOVA_ADMIN_CONSOLE_DIR,
  ready: async () => {
    await Promise.all([pool.query('select 1'), redis?.ping()]);
  },
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'arrêt demandé');
  await app.close();
  await Promise.allSettled([pool.end(), redis?.quit()]);
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

await app.listen({
  host: process.env.ADMIN_HOST ?? '127.0.0.1',
  port: Number(process.env.ADMIN_PORT ?? 8081),
});
