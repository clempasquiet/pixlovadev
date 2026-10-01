import { Redis } from 'ioredis';
import pg from 'pg';
import { mediaLimitsFromEnv } from '@pixlova/contracts';
import { createDatabase } from '@pixlova/db';
import { createStorageFromEnv } from '@pixlova/storage';
import { buildInternalApp, buildPublicApp } from './app.js';
import { loadConfig } from './config.js';
import type { Services } from './http/services.js';
import { DataCipher } from './lib/crypto.js';
import { dispatchAlertNotifications } from './lib/alert-notifications.js';
import { collectGauges, loggerOptions, Metrics } from './observability.js';
import { ConsoleMailer, dispatchEmails, SmtpMailer, type Mailer } from './lib/email.js';
import { billingFromEnv } from './lib/billing.js';
import { deploymentFromEnv, entitlementsFromEnv } from './lib/entitlements.js';
import { MemoryRateLimiter, RedisRateLimiter } from './lib/rate-limit.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} est requis.`);
  return value;
}

const config = loadConfig();
const production = process.env.NODE_ENV === 'production';
// Déploiement de recette (ADR-015) : garde-fous de production, quotas fixes autorisés.
const deployment = deploymentFromEnv();
const appPool = new pg.Pool({ connectionString: required('DATABASE_URL'), max: 20 });
const systemPool = new pg.Pool({ connectionString: required('DATABASE_SYSTEM_URL'), max: 5 });
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
if (!redis && production)
  throw new Error('REDIS_URL est requis en production (limitation de débit partagée).');

// Transport email (ADR-015) : SMTP, ou console en développement seulement (liens à jeton
// dans les logs, refusé en production).
let mailer: Mailer | null = null;
if (process.env.PIXLOVA_MAILER === 'console') {
  if (production) throw new Error('PIXLOVA_MAILER=console est interdit en production.');
  mailer = new ConsoleMailer();
} else if (process.env.PIXLOVA_MAILER === 'smtp') {
  mailer = new SmtpMailer(required('PIXLOVA_SMTP_URL'), required('PIXLOVA_MAIL_FROM'));
} else if (process.env.PIXLOVA_MAILER) {
  throw new Error('PIXLOVA_MAILER doit valoir smtp ou console.');
} else if (production) {
  throw new Error('PIXLOVA_MAILER est requis en production (vérification des comptes).');
}

const db = createDatabase(appPool);
// Facturation (ADR-017) : sans clé Stripe, catalogue et droits servis, achats indisponibles.
const billing = billingFromEnv(process.env, deployment);
const services: Services = {
  db,
  system: createDatabase(systemPool),
  cipher: DataCipher.fromEnv(process.env.PIXLOVA_DATA_KEYS),
  limiter: redis ? new RedisRateLimiter(redis) : new MemoryRateLimiter(),
  entitlements: entitlementsFromEnv(process.env, deployment, {
    db,
    environment: billing.environment,
  }),
  billing,
  security: config.security,
  storage: createStorageFromEnv(),
  media: { ...config.media, limits: mediaLimitsFromEnv(process.env) },
  supervision: config.supervision,
  now: () => new Date(),
};

const metrics = new Metrics();
if (deployment === 'recette') {
  console.warn(
    '[pixlova] déploiement de RECETTE : quotas fixes autorisés, ne pas exposer de clients réels.',
  );
}
const publicApp = buildPublicApp({ logger: loggerOptions(), services, metrics });
const internalApp = buildInternalApp({
  logger: loggerOptions(),
  metrics,
  gauges: () =>
    collectGauges(services.system, config.security.presenceTimeoutSeconds, services.now()),
  ready: async () => {
    await Promise.all([appPool.query('select 1'), systemPool.query('select 1'), redis?.ping()]);
  },
});

let emailTimer: NodeJS.Timeout | undefined;
if (mailer) {
  const activeMailer = mailer;
  emailTimer = setInterval(() => {
    // Notifications d’incident du worker (ADR-014) puis envoi de l’outbox email.
    dispatchAlertNotifications(services.system, services.cipher, config.security.appBaseUrl)
      .then(() => dispatchEmails(services.system, services.cipher, activeMailer))
      .catch((error: unknown) => publicApp.log.error({ err: error }, 'envoi des emails en échec'));
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
