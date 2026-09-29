import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from './index.js';
import { jobs } from './schema/index.js';

export interface NewJob {
  /** NULL : tâche système. Sinon, la transaction doit porter ce tenant. */
  organizationId: string | null;
  kind: string;
  /** Clé métier : une seule tâche active par (`kind`, `dedupeKey`). */
  dedupeKey: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  runAfter?: Date;
}

/**
 * Crée une tâche dans la transaction de la décision métier (outbox, ARC-004). Si une tâche
 * active existe déjà pour la même clé, elle est conservée : aucun doublon.
 */
export async function enqueueJob(
  tx: Transaction | Database,
  job: NewJob,
): Promise<{ id: string; created: boolean }> {
  const [created] = await tx
    .insert(jobs)
    .values({
      organizationId: job.organizationId,
      kind: job.kind,
      dedupeKey: job.dedupeKey,
      payload: job.payload ?? {},
      maxAttempts: job.maxAttempts ?? 5,
      ...(job.runAfter ? { runAfter: job.runAfter } : {}),
    })
    .onConflictDoNothing({
      target: [jobs.kind, jobs.dedupeKey],
      where: sql`${jobs.state} in ('queued', 'running')`,
    })
    .returning({ id: jobs.id });
  if (created) return { id: created.id, created: true };
  const [existing] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, job.kind),
        eq(jobs.dedupeKey, job.dedupeKey),
        inArray(jobs.state, ['queued', 'running']),
      ),
    );
  if (!existing) throw new Error('Tâche active introuvable après conflit.');
  return { id: existing.id, created: false };
}

export interface ClaimedJob {
  id: string;
  organizationId: string | null;
  kind: string;
  dedupeKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/**
 * Réclame la prochaine tâche due (rôle système) : tâche en file dont l’échéance est passée,
 * ou tâche dont le bail a expiré (worker arrêté). `SKIP LOCKED` : deux workers ne
 * réclament jamais la même ligne.
 */
export async function claimJob(
  db: Database,
  options: { workerId: string; kinds: readonly string[]; leaseSeconds: number; now: Date },
): Promise<ClaimedJob | null> {
  if (options.kinds.length === 0) return null;
  const now = options.now.toISOString();
  const leaseUntil = new Date(options.now.getTime() + options.leaseSeconds * 1000).toISOString();
  const result = await db.execute<{
    id: string;
    organization_id: string | null;
    kind: string;
    dedupe_key: string;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
  }>(sql`
    update jobs
       set state = 'running', attempts = attempts + 1, lease_owner = ${options.workerId},
           lease_expires_at = ${leaseUntil}, updated_at = ${now}
     where id = (
       select id from jobs
        where kind in (${sql.join(
          options.kinds.map((kind) => sql`${kind}`),
          sql`, `,
        )})
          and ((state = 'queued' and run_after <= ${now})
               or (state = 'running' and lease_expires_at < ${now}))
        order by run_after, created_at
        limit 1
        for update skip locked)
    returning id, organization_id, kind, dedupe_key, payload, attempts, max_attempts`);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

function ownedBy(jobId: string, workerId: string) {
  return and(eq(jobs.id, jobId), eq(jobs.state, 'running'), eq(jobs.leaseOwner, workerId));
}

/** Prolonge le bail ; `false` si la tâche a été reprise par un autre worker. */
export async function renewJobLease(
  db: Database,
  jobId: string,
  workerId: string,
  leaseSeconds: number,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1000), updatedAt: now })
    .where(ownedBy(jobId, workerId))
    .returning({ id: jobs.id });
  return rows.length === 1;
}

/** Termine la tâche si ce worker détient encore le bail (fencing). */
export async function completeJob(
  db: Database | Transaction,
  jobId: string,
  workerId: string,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({
      state: 'succeeded',
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(ownedBy(jobId, workerId))
    .returning({ id: jobs.id });
  return rows.length === 1;
}

/** Échec : nouvelle tentative à `retryAt`, ou échec définitif si `retryAt` est nul. */
export async function failJob(
  db: Database | Transaction,
  jobId: string,
  workerId: string,
  failure: { error: string; retryAt: Date | null },
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set(
      failure.retryAt
        ? {
            state: 'queued',
            runAfter: failure.retryAt,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: failure.error.slice(0, 2000),
            updatedAt: now,
          }
        : {
            state: 'failed',
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: failure.error.slice(0, 2000),
            finishedAt: now,
            updatedAt: now,
          },
    )
    .where(ownedBy(jobId, workerId))
    .returning({ id: jobs.id });
  return rows.length === 1;
}
