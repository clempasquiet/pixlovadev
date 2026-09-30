import { adjustUsage, enqueueJob, schema } from '@pixlova/db';
import { and, eq, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import { renewManifestHorizons } from './programming/compile.js';
import type { WorkerContext } from './context.js';
import { MEDIA_PURGE } from './media/purge.js';

const BATCH = 100;

/**
 * Sessions d’upload non finalisées à échéance (MED-002) : réservation libérée, média
 * placé en corbeille avec purge immédiate. Rôle système : balayage inter-tenants.
 */
export async function expireUploadSessions(ctx: WorkerContext): Promise<number> {
  const now = ctx.now();
  const expired = await ctx.systemDb
    .select({ id: schema.uploadSessions.id })
    .from(schema.uploadSessions)
    .where(
      and(eq(schema.uploadSessions.state, 'pending'), lt(schema.uploadSessions.expiresAt, now)),
    )
    .limit(BATCH);
  let count = 0;
  for (const { id } of expired) {
    await ctx.systemDb.transaction(async (tx) => {
      const [session] = await tx
        .update(schema.uploadSessions)
        .set({ state: 'expired' })
        .where(and(eq(schema.uploadSessions.id, id), eq(schema.uploadSessions.state, 'pending')))
        .returning();
      if (!session) return;
      await adjustUsage(
        tx,
        session.organizationId,
        'storage_bytes',
        { reserved: -session.reservedBytes },
        now,
      );
      await tx
        .update(schema.media)
        .set({
          status: 'error',
          errorCode: 'UPLOAD_EXPIRED',
          errorDetail: 'Envoi non finalisé dans le délai.',
          deletedAt: sql`coalesce(${schema.media.deletedAt}, ${now.toISOString()}::timestamptz)`,
          purgeAfter: now,
          updatedAt: now,
        })
        .where(and(eq(schema.media.id, session.mediaId), eq(schema.media.status, 'uploading')));
      count += 1;
    });
  }
  return count;
}

/**
 * Suppression des objets de quarantaine devenus inutiles, une fois l’URL d’envoi expirée :
 * session abandonnée ou expirée, ou original déjà copié vers sa clé définitive.
 */
export async function cleanQuarantine(ctx: WorkerContext): Promise<number> {
  const now = ctx.now();
  const candidates = await ctx.systemDb
    .select({ id: schema.uploadSessions.id, key: schema.uploadSessions.objectKey })
    .from(schema.uploadSessions)
    .where(
      and(
        isNull(schema.uploadSessions.cleanedAt),
        lt(schema.uploadSessions.expiresAt, now),
        sql`(${schema.uploadSessions.state} in ('aborted', 'expired') or (${schema.uploadSessions.state} = 'completed' and exists (
          select 1 from media_assets a where a.media_id = ${schema.uploadSessions.mediaId} and a.variant = 'original')))`,
      ),
    )
    .limit(BATCH);
  let count = 0;
  for (const candidate of candidates) {
    try {
      await ctx.storage.delete(candidate.key);
    } catch (error) {
      ctx.logger.warn({ uploadId: candidate.id, error: String(error) }, 'quarantaine non nettoyée');
      continue;
    }
    await ctx.systemDb
      .update(schema.uploadSessions)
      .set({ cleanedAt: now })
      .where(eq(schema.uploadSessions.id, candidate.id));
    count += 1;
  }
  return count;
}

/** Corbeille arrivée à échéance : une tâche de purge par média (sans doublon). */
export async function schedulePurges(ctx: WorkerContext): Promise<number> {
  const due = await ctx.systemDb
    .select({ id: schema.media.id, organizationId: schema.media.organizationId })
    .from(schema.media)
    .where(and(isNotNull(schema.media.deletedAt), lte(schema.media.purgeAfter, ctx.now())))
    .limit(BATCH);
  let created = 0;
  for (const media of due) {
    const result = await enqueueJob(ctx.systemDb, {
      organizationId: media.organizationId,
      kind: MEDIA_PURGE,
      dedupeKey: media.id,
      payload: { mediaId: media.id },
    });
    if (result.created) created += 1;
  }
  return created;
}

/** Tâches terminées depuis plus de 30 jours : supprimées (l’audit conserve les décisions). */
export async function pruneFinishedJobs(ctx: WorkerContext): Promise<void> {
  const before = new Date(ctx.now().getTime() - 30 * 86_400_000);
  await ctx.systemDb
    .delete(schema.jobs)
    .where(
      and(inArray(schema.jobs.state, ['succeeded', 'failed']), lt(schema.jobs.finishedAt, before)),
    );
}

export async function runSweeps(ctx: WorkerContext): Promise<void> {
  await expireUploadSessions(ctx);
  await cleanQuarantine(ctx);
  await schedulePurges(ctx);
  await pruneFinishedJobs(ctx);
  await renewManifestHorizons(ctx);
}
