/**
 * Rétentions de la supervision (DEC-11, ADR-014) [à valider] : captures supprimées à leur
 * échéance (objet puis ligne), événements de timeline au-delà de leur durée de conservation.
 */
import { schema } from '@pixlova/db';
import { eq, lt } from 'drizzle-orm';
import type { WorkerContext } from '../context.js';

const BATCH = 100;
export const DEFAULT_TIMELINE_RETENTION_DAYS = 90;

/** Captures expirées : objet privé supprimé d’abord ; en cas d’échec, nouvel essai plus tard. */
export async function purgeScreenshots(ctx: WorkerContext): Promise<number> {
  const expired = await ctx.systemDb
    .select({ id: schema.screenshots.id, key: schema.screenshots.objectKey })
    .from(schema.screenshots)
    .where(lt(schema.screenshots.expiresAt, ctx.now()))
    .limit(BATCH);
  let purged = 0;
  for (const screenshot of expired) {
    try {
      await ctx.storage.delete(screenshot.key);
    } catch (error) {
      ctx.logger.warn({ screenshotId: screenshot.id, error: String(error) }, 'capture non purgée');
      continue;
    }
    await ctx.systemDb.delete(schema.screenshots).where(eq(schema.screenshots.id, screenshot.id));
    purged += 1;
  }
  return purged;
}

export async function pruneTimeline(ctx: WorkerContext): Promise<void> {
  const days = ctx.timelineRetentionDays ?? DEFAULT_TIMELINE_RETENTION_DAYS;
  await ctx.systemDb
    .delete(schema.timelineEvents)
    .where(lt(schema.timelineEvents.receivedAt, new Date(ctx.now().getTime() - days * 86_400_000)));
}
