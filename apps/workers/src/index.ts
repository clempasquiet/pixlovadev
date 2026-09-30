export { consoleLogger, silentLogger, type Logger, type WorkerContext } from './context.js';
export { JobAbortedError, PermanentMediaError } from './errors.js';
export { Worker, retryDelayMs, type JobHandler, type WorkerOptions } from './runner.js';
export { ingestHandler, MEDIA_INGEST } from './media/ingest.js';
export { purgeHandler, MEDIA_PURGE } from './media/purge.js';
export { hardenImageDecoder } from './media/image.js';
export { compileHandler, renewManifestHorizons } from './programming/compile.js';
export { DEFAULT_VIDEO_TOOLS, type VideoTools } from './media/video.js';
export {
  ALERT_NOTIFICATION,
  DEFAULT_ALERTING,
  PLAYBACK_ERROR_EVENTS,
  evaluateAlerts,
  recordPresenceLost,
  type AlertingConfig,
  type EvaluationReport,
} from './supervision/alerts.js';
export { pruneTimeline, purgeScreenshots } from './supervision/purge.js';
export {
  cleanQuarantine,
  expireUploadSessions,
  pruneFinishedJobs,
  runSweeps,
  schedulePurges,
} from './sweeps.js';

import type { WorkerContext } from './context.js';
import { ingestHandler } from './media/ingest.js';
import { purgeHandler } from './media/purge.js';
import { compileHandler } from './programming/compile.js';
import { Worker, type WorkerOptions } from './runner.js';
import { runSweeps } from './sweeps.js';

/** Worker complet : ingestion et purge des médias, compilation des manifests, balayages. */
export function createWorker(ctx: WorkerContext, options: WorkerOptions = {}): Worker {
  return new Worker(ctx, [ingestHandler, purgeHandler, compileHandler], {
    sweep: runSweeps,
    ...options,
  });
}

/** @deprecated Nom historique de `createWorker`. */
export const createMediaWorker = createWorker;
