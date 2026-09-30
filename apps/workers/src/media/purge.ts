import { adjustUsage, schema, withTenant, type ClaimedJob } from '@pixlova/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { WorkerContext } from '../context.js';
import type { JobHandler } from '../runner.js';
import { MEDIA_INGEST } from './ingest.js';

export const MEDIA_PURGE = 'media.purge';

/**
 * Purge définitive d’un média en corbeille (MED-008) :
 * 1. marque la purge engagée (restauration refusée à partir de là) ;
 * 2. supprime les objets (idempotent, repris en cas de stockage indisponible) ;
 * 3. supprime les lignes et libère le quota dans une même transaction.
 * Un média restauré entre-temps n’est pas purgé ; une préparation active diffère la purge.
 */
async function purge(ctx: WorkerContext, job: ClaimedJob): Promise<void> {
  const organizationId = job.organizationId;
  const mediaId = job.payload.mediaId;
  if (!organizationId || typeof mediaId !== 'string') throw new Error('Tâche de purge invalide.');

  const keys = await withTenant(ctx.appDb, organizationId, async (tx) => {
    const [media] = await tx
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, mediaId))
      .for('update');
    if (!media || !media.deletedAt) return null;
    const [active] = await tx
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.kind, MEDIA_INGEST),
          eq(schema.jobs.dedupeKey, mediaId),
          inArray(schema.jobs.state, ['queued', 'running']),
        ),
      );
    if (active) throw new Error('Préparation en cours : purge différée.');
    if (!media.purgeStartedAt) {
      await tx
        .update(schema.media)
        .set({ purgeStartedAt: ctx.now(), updatedAt: ctx.now() })
        .where(eq(schema.media.id, mediaId));
    }
    const assets = await tx
      .select({ key: schema.mediaAssets.storageKey })
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.mediaId, mediaId));
    const sessions = await tx
      .select({ key: schema.uploadSessions.objectKey })
      .from(schema.uploadSessions)
      .where(eq(schema.uploadSessions.mediaId, mediaId));
    return [...new Set([...assets, ...sessions].map((row) => row.key))];
  });
  if (keys === null) return;

  for (const key of keys) await ctx.storage.delete(key);

  await withTenant(ctx.appDb, organizationId, async (tx) => {
    const [media] = await tx
      .select()
      .from(schema.media)
      .where(eq(schema.media.id, mediaId))
      .for('update');
    if (!media) return;
    const pending = await tx
      .select({ reserved: schema.uploadSessions.reservedBytes })
      .from(schema.uploadSessions)
      .where(
        and(eq(schema.uploadSessions.mediaId, mediaId), eq(schema.uploadSessions.state, 'pending')),
      );
    await tx.delete(schema.mediaAssets).where(eq(schema.mediaAssets.mediaId, mediaId));
    await tx.delete(schema.uploadSessions).where(eq(schema.uploadSessions.mediaId, mediaId));
    await tx.delete(schema.media).where(eq(schema.media.id, mediaId));
    await adjustUsage(
      tx,
      organizationId,
      'storage_bytes',
      {
        observed: -media.quotaBytes,
        reserved: -pending.reduce((sum, row) => sum + row.reserved, 0),
      },
      ctx.now(),
    );
    await tx.insert(schema.auditLogs).values({
      organizationId,
      actorType: 'system',
      actorId: null,
      action: 'media.purged',
      targetType: 'media',
      targetId: mediaId,
      result: 'success',
      metadata: { name: media.name, released_bytes: media.quotaBytes, objects: keys.length },
    });
  });
  ctx.logger.info({ mediaId, organizationId, objects: keys.length }, 'média purgé');
}

export const purgeHandler: JobHandler = { kind: MEDIA_PURGE, run: purge };
