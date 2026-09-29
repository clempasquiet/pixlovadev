/**
 * Point d’entrée du worker média (ADR-009). Deux connexions : rôle applicatif sous RLS
 * pour les écritures métier, rôle système pour la file et les balayages.
 */
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MEDIA_LIMITS } from '@pixlova/contracts';
import { createDatabase } from '@pixlova/db';
import { createStorageFromEnv } from '@pixlova/storage';
import pg from 'pg';
import { consoleLogger } from './context.js';
import { createMediaWorker, hardenImageDecoder } from './index.js';
import { DEFAULT_VIDEO_TOOLS } from './media/video.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} est requis.`);
  return value;
}

const logger = consoleLogger();
const appPool = new pg.Pool({ connectionString: required('DATABASE_URL'), max: 5 });
const systemPool = new pg.Pool({ connectionString: required('DATABASE_SYSTEM_URL'), max: 3 });
const tmpRoot = process.env.PIXLOVA_WORKER_TMP_DIR ?? join(tmpdir(), 'pixlova-worker');
await mkdir(tmpRoot, { recursive: true, mode: 0o700 });
hardenImageDecoder();

const worker = createMediaWorker(
  {
    appDb: createDatabase(appPool),
    systemDb: createDatabase(systemPool),
    storage: createStorageFromEnv(),
    limits: DEFAULT_MEDIA_LIMITS,
    tools: DEFAULT_VIDEO_TOOLS,
    tmpRoot,
    trashRetentionDays: Number(process.env.PIXLOVA_MEDIA_TRASH_RETENTION_DAYS ?? 30),
    now: () => new Date(),
    logger,
  },
  { concurrency: Number(process.env.PIXLOVA_WORKER_CONCURRENCY ?? 2) },
);
worker.start();
logger.info({ workerId: worker.workerId }, 'worker démarré');

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'arrêt du worker');
  await worker.stop();
  await Promise.all([appPool.end(), systemPool.end()]);
  process.exit(0);
}
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
