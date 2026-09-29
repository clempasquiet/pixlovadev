export { consoleLogger, silentLogger, type Logger, type WorkerContext } from './context.js';
export { JobAbortedError, PermanentMediaError } from './errors.js';
export { Worker, retryDelayMs, type JobHandler, type WorkerOptions } from './runner.js';
export { ingestHandler, MEDIA_INGEST } from './media/ingest.js';
export { purgeHandler, MEDIA_PURGE } from './media/purge.js';
export { hardenImageDecoder } from './media/image.js';
export { DEFAULT_VIDEO_TOOLS, type VideoTools } from './media/video.js';
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
import { Worker, type WorkerOptions } from './runner.js';
import { runSweeps } from './sweeps.js';

/** Worker média complet : ingestion, purge et balayages. */
export function createMediaWorker(ctx: WorkerContext, options: WorkerOptions = {}): Worker {
  return new Worker(ctx, [ingestHandler, purgeHandler], { sweep: runSweeps, ...options });
}
