/**
 * Point d’entrée du worker (ADR-009, ADR-011). Deux connexions : rôle applicatif sous RLS
 * pour les écritures métier, rôle système pour la file et les balayages. La clé de
 * signature des manifests est obligatoire : sans elle, aucune diffusion ne serait possible.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mediaLimitsFromEnv } from '@pixlova/contracts';
import { environmentOfKey, StripeGateway } from '@pixlova/billing';
import { createDatabase } from '@pixlova/db';
import { manifestSignerFromSeed } from '@pixlova/scheduling/compiler';
import { createStorageFromEnv } from '@pixlova/storage';
import pg from 'pg';
import { consoleLogger } from './context.js';
import {
  createWorker,
  DEFAULT_ALERTING,
  hardenImageDecoder,
  type AlertingConfig,
} from './index.js';
import { DEFAULT_VIDEO_TOOLS } from './media/video.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} est requis.`);
  return value;
}

/** Seuils des alertes [à valider] : surchargeables sans nouvelle version. */
function alertingFromEnv(): AlertingConfig {
  const read = (name: string, fallback: number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} invalide.`);
    return value;
  };
  return {
    ...DEFAULT_ALERTING,
    presenceTimeoutSeconds: read(
      'PIXLOVA_PRESENCE_TIMEOUT_SECONDS',
      DEFAULT_ALERTING.presenceTimeoutSeconds,
    ),
    offlineMinutes: read('PIXLOVA_ALERT_OFFLINE_MINUTES', DEFAULT_ALERTING.offlineMinutes),
    manifestMinutes: read('PIXLOVA_ALERT_MANIFEST_MINUTES', DEFAULT_ALERTING.manifestMinutes),
    diskOpenRatio: read('PIXLOVA_ALERT_DISK_RATIO', DEFAULT_ALERTING.diskOpenRatio),
    reminderHours: read('PIXLOVA_ALERT_REMINDER_HOURS', DEFAULT_ALERTING.reminderHours),
  };
}

const logger = consoleLogger();
const appPool = new pg.Pool({ connectionString: required('DATABASE_URL'), max: 5 });
const systemPool = new pg.Pool({ connectionString: required('DATABASE_SYSTEM_URL'), max: 3 });
const tmpRoot = process.env.PIXLOVA_WORKER_TMP_DIR ?? join(tmpdir(), 'pixlova-worker');
await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
hardenImageDecoder();

const manifestSigner = manifestSignerFromSeed(
  required('PIXLOVA_MANIFEST_KEY_ID'),
  required('PIXLOVA_MANIFEST_SIGNING_KEY'),
);

// Facturation (ADR-017) : mêmes variables que l’API ; sans clé, les tâches Stripe attendent.
const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
if (Boolean(stripeKey) !== Boolean(stripeWebhookSecret)) {
  throw new Error('STRIPE_SECRET_KEY et STRIPE_WEBHOOK_SECRET vont ensemble.');
}
if (
  stripeKey &&
  environmentOfKey(stripeKey) === 'live' &&
  (process.env.PIXLOVA_DEPLOYMENT ??
    (process.env.NODE_ENV === 'production' ? 'production' : 'development')) !== 'production'
) {
  throw new Error('Une clé Stripe de production est interdite hors déploiement production.');
}
const billing =
  stripeKey && stripeWebhookSecret
    ? {
        gateway: new StripeGateway({ secretKey: stripeKey, webhookSecret: stripeWebhookSecret }),
        graceDays: Number(process.env.PIXLOVA_BILLING_GRACE_DAYS ?? 7),
      }
    : null;

const worker = createWorker(
  {
    appDb: createDatabase(appPool),
    systemDb: createDatabase(systemPool),
    storage: createStorageFromEnv(),
    limits: mediaLimitsFromEnv(process.env),
    tools: DEFAULT_VIDEO_TOOLS,
    tmpRoot,
    trashRetentionDays: Number(process.env.PIXLOVA_MEDIA_TRASH_RETENTION_DAYS ?? 30),
    manifestSigner,
    alerting: alertingFromEnv(),
    timelineRetentionDays: Number(process.env.PIXLOVA_TIMELINE_RETENTION_DAYS ?? 90),
    billing,
    now: () => new Date(),
    logger,
  },
  { concurrency: Number(process.env.PIXLOVA_WORKER_CONCURRENCY ?? 2) },
);
worker.start();
logger.info({ workerId: worker.workerId }, 'worker démarré');

// Témoin de vie pour le health check du conteneur (ADR-015) : horodatage réécrit tant que
// le processus tourne et joint la base. Le conteneur vérifie sa fraîcheur.
const healthFile = process.env.PIXLOVA_WORKER_HEALTH_FILE;
const healthTimer = healthFile
  ? setInterval(() => {
      systemPool
        .query('select 1')
        .then(() => writeFile(healthFile, new Date().toISOString()))
        .catch((error: unknown) => logger.warn({ err: String(error) }, 'témoin de vie non écrit'));
    }, 15_000)
  : undefined;

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'arrêt du worker');
  clearInterval(healthTimer);
  await worker.stop();
  await Promise.all([appPool.end(), systemPool.end()]);
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
