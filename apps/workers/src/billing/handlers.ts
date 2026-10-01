import {
  clearStripeEventPayloads,
  customersToReconcile,
  failStripeEvent,
  processStripeEvent,
  reconcileCustomer,
  STRIPE_EVENT_JOB,
  SYNC_CUSTOMER_JOB,
  type BillingSyncContext,
} from '@pixlova/billing';
import { enqueueJob } from '@pixlova/db';
import type { WorkerContext } from '../context.js';
import type { JobHandler } from '../runner.js';

/** Resynchronisation d’un client sans changement : toutes les 6 heures (BILL-010). */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;
/** Rétention du contenu des événements Stripe reçus [à valider avec la politique RGPD]. */
const EVENT_PAYLOAD_RETENTION_DAYS = 30;

function syncContext(ctx: WorkerContext): BillingSyncContext {
  if (!ctx.billing) throw new Error('Facturation non configurée pour ce worker.');
  return {
    db: ctx.systemDb,
    gateway: ctx.billing.gateway,
    graceDays: ctx.billing.graceDays,
    now: ctx.now,
  };
}

function stringPayload(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string') throw new Error(`Charge de tâche invalide : ${key}.`);
  return value;
}

/** Traitement d’un événement Stripe enregistré par l’API (ADR-017). */
export const stripeEventHandler: JobHandler = {
  kind: STRIPE_EVENT_JOB,
  async run(ctx, job) {
    await processStripeEvent(syncContext(ctx), stringPayload(job.payload, 'event_id'));
  },
  // Tentatives épuisées : l’événement est marqué en échec, la réconciliation le rattrape.
  async onFailed(ctx, job, error) {
    await failStripeEvent(
      ctx.systemDb,
      stringPayload(job.payload, 'event_id'),
      error instanceof Error ? error.message : String(error),
    );
  },
};

/** Resynchronisation d’un client (réconciliation périodique ou rattrapage). */
export const syncCustomerHandler: JobHandler = {
  kind: SYNC_CUSTOMER_JOB,
  async run(ctx, job) {
    await reconcileCustomer(syncContext(ctx), stringPayload(job.payload, 'stripe_customer_id'));
  },
};

/**
 * Balayage de facturation (BILL-010) : planifie la relecture des clients en retard, en
 * erreur ou ayant une demande ouverte, ce qui corrige un webhook perdu ; efface le contenu
 * des événements anciens.
 */
export async function billingSweep(ctx: WorkerContext): Promise<void> {
  if (!ctx.billing) return;
  const now = ctx.now();
  const environment = ctx.billing.gateway.environment;
  for (const customer of await customersToReconcile(
    ctx.systemDb,
    environment,
    now,
    STALE_AFTER_MS,
  )) {
    await enqueueJob(ctx.systemDb, {
      organizationId: null,
      kind: SYNC_CUSTOMER_JOB,
      dedupeKey: `${environment}:${customer}`,
      payload: { stripe_customer_id: customer },
    });
  }
  await clearStripeEventPayloads(ctx.systemDb, now, EVENT_PAYLOAD_RETENTION_DAYS);
}
