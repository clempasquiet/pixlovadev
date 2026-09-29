import { randomUUID } from 'node:crypto';
import { claimJob, completeJob, failJob, renewJobLease, type ClaimedJob } from '@pixlova/db';
import type { WorkerContext } from './context.js';
import { JobAbortedError, PermanentMediaError } from './errors.js';

export interface JobHandler {
  kind: string;
  run(ctx: WorkerContext, job: ClaimedJob, signal: AbortSignal): Promise<void>;
  /** Échec définitif (erreur permanente ou tentatives épuisées). */
  onFailed?(ctx: WorkerContext, job: ClaimedJob, error: unknown): Promise<void>;
}

export interface WorkerOptions {
  workerId?: string;
  leaseSeconds?: number;
  pollIntervalMs?: number;
  concurrency?: number;
  sweepIntervalMs?: number;
  /** Balayages périodiques (sessions expirées, quarantaine, corbeille). */
  sweep?: (ctx: WorkerContext) => Promise<void>;
}

/** Reprise : 15 s, 1 min, 4 min, 16 min… plafonnée à 30 min. */
export function retryDelayMs(attempt: number): number {
  return Math.min(15_000 * 4 ** Math.max(0, attempt - 1), 30 * 60_000);
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Worker de la file PostgreSQL (ADR-009). Chaque tâche s’exécute sous un bail renouvelé ;
 * si le bail est perdu, la tâche est interrompue et reprise ailleurs. Une tâche dont le bail
 * a expiré trop souvent (fichier qui fait tomber le worker) est close en échec.
 */
export class Worker {
  readonly workerId: string;
  private readonly handlers: Map<string, JobHandler>;
  private readonly leaseSeconds: number;
  private readonly pollIntervalMs: number;
  private readonly concurrency: number;
  private readonly sweepIntervalMs: number;
  private running = false;
  private readonly controllers = new Set<AbortController>();
  private loops: Promise<void>[] = [];
  private sweepTimer: NodeJS.Timeout | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly ctx: WorkerContext,
    handlers: readonly JobHandler[],
    private readonly options: WorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? `worker-${randomUUID()}`;
    this.handlers = new Map(handlers.map((handler) => [handler.kind, handler]));
    this.leaseSeconds = options.leaseSeconds ?? 60;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.concurrency = options.concurrency ?? 2;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
  }

  /** Réclame et exécute une tâche ; `false` si aucune n’est due. */
  async runOnce(): Promise<boolean> {
    const job = await claimJob(this.ctx.systemDb, {
      workerId: this.workerId,
      kinds: [...this.handlers.keys()],
      leaseSeconds: this.leaseSeconds,
      now: this.ctx.now(),
    });
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  /** Exécute les tâches dues jusqu’à épuisement (tests, outils). */
  async drain(max = 100): Promise<number> {
    let count = 0;
    while (count < max && (await this.runOnce())) count += 1;
    return count;
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const handler = this.handlers.get(job.kind);
    const log = {
      jobId: job.id,
      kind: job.kind,
      attempt: job.attempts,
      organizationId: job.organizationId,
    };
    if (!handler) return;
    if (job.attempts > job.maxAttempts) {
      // Bail expiré à chaque tentative : le traitement fait probablement tomber le worker.
      const error = new Error('Tentatives épuisées (worker interrompu à chaque essai).');
      this.ctx.logger.error(log, 'tâche abandonnée après interruptions répétées');
      await handler.onFailed?.(this.ctx, job, error);
      await failJob(
        this.ctx.systemDb,
        job.id,
        this.workerId,
        { error: describe(error), retryAt: null },
        this.ctx.now(),
      );
      return;
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    const renew = setInterval(
      () => {
        renewJobLease(this.ctx.systemDb, job.id, this.workerId, this.leaseSeconds, this.ctx.now())
          .then((owned) => {
            if (!owned) controller.abort();
          })
          .catch((error: unknown) => {
            this.ctx.logger.warn(
              { ...log, error: describe(error) },
              'renouvellement du bail impossible',
            );
          });
      },
      Math.max(1000, (this.leaseSeconds * 1000) / 3),
    );
    try {
      await handler.run(this.ctx, job, controller.signal);
      if (!(await completeJob(this.ctx.systemDb, job.id, this.workerId, this.ctx.now()))) {
        this.ctx.logger.warn(log, 'tâche terminée après perte du bail');
      }
    } catch (error) {
      if (error instanceof JobAbortedError) {
        this.ctx.logger.warn({ ...log, reason: error.message }, 'tâche interrompue');
        if (controller.signal.aborted) {
          // Arrêt du worker : la tâche retourne à la file. Bail perdu : sans effet (fencing).
          await failJob(
            this.ctx.systemDb,
            job.id,
            this.workerId,
            { error: describe(error), retryAt: this.ctx.now() },
            this.ctx.now(),
          );
        } else {
          // Plus rien à faire (média purgé pendant la préparation).
          await completeJob(this.ctx.systemDb, job.id, this.workerId, this.ctx.now());
        }
        return;
      }
      const permanent = error instanceof PermanentMediaError;
      const exhausted = job.attempts >= job.maxAttempts;
      this.ctx.logger[permanent ? 'warn' : 'error'](
        { ...log, error: describe(error), permanent, exhausted },
        'échec de tâche',
      );
      if (permanent || exhausted) {
        await handler.onFailed?.(this.ctx, job, error);
        await failJob(
          this.ctx.systemDb,
          job.id,
          this.workerId,
          { error: describe(error), retryAt: null },
          this.ctx.now(),
        );
      } else {
        const retryAt = new Date(this.ctx.now().getTime() + retryDelayMs(job.attempts));
        await failJob(
          this.ctx.systemDb,
          job.id,
          this.workerId,
          { error: describe(error), retryAt },
          this.ctx.now(),
        );
      }
    } finally {
      clearInterval(renew);
      this.controllers.delete(controller);
    }
  }

  async sweep(): Promise<void> {
    if (!this.options.sweep) return;
    try {
      await this.options.sweep(this.ctx);
    } catch (error) {
      this.ctx.logger.error({ error: describe(error) }, 'balayage en échec');
    }
  }

  /** Signale qu’une tâche vient d’être créée (évite d’attendre le prochain sondage). */
  notify(): void {
    this.wake?.();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loops = Array.from({ length: this.concurrency }, () => this.loop());
    if (this.options.sweep) {
      void this.sweep();
      this.sweepTimer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let worked = false;
      try {
        worked = await this.runOnce();
      } catch (error) {
        this.ctx.logger.error({ error: describe(error) }, 'file de tâches indisponible');
      }
      if (!worked && this.running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.pollIntervalMs);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }

  /** Arrêt propre : interrompt les tâches en cours, qui retournent à la file. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.wake?.();
    for (const controller of this.controllers) controller.abort();
    await Promise.all(this.loops);
    this.loops = [];
  }
}
