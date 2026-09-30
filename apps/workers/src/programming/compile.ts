import { COMPILE_DISPLAY, compileDisplay, scheduleRenewals } from '@pixlova/scheduling/compiler';
import type { WorkerContext } from '../context.js';
import type { JobHandler } from '../runner.js';

/**
 * Compilation d’un Display (ADR-011). Rejouée après perte de bail, elle aboutit à
 * `unchanged` ou `superseded` : un job ancien n’écrase jamais une version plus récente.
 */
export const compileHandler: JobHandler = {
  kind: COMPILE_DISPLAY,
  async run(ctx, job) {
    if (!ctx.manifestSigner) throw new Error('Clé de signature des manifests absente.');
    const displayId = String(job.payload.display_id ?? '');
    const configRevision = String(job.payload.config_revision ?? '');
    if (!job.organizationId || !displayId || !/^[0-9]+$/.test(configRevision)) {
      throw new Error('Tâche de compilation mal formée.');
    }
    const outcome = await compileDisplay({
      db: ctx.appDb,
      organizationId: job.organizationId,
      displayId,
      configRevision,
      signer: ctx.manifestSigner,
      now: ctx.now(),
    });
    ctx.logger.info(
      {
        jobId: job.id,
        displayId,
        configRevision,
        status: outcome.status,
        ...(outcome.status === 'published' ? { version: outcome.version } : {}),
      },
      'compilation de manifest',
    );
  },
};

/** Balayage : renouvelle les horizons qui s’épuisent (PLN-011). */
export async function renewManifestHorizons(ctx: WorkerContext): Promise<void> {
  const count = await scheduleRenewals(ctx.systemDb, ctx.now());
  if (count > 0) ctx.logger.info({ count }, 'renouvellement des horizons de manifest');
}
