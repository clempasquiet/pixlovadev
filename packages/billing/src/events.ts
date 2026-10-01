import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { enqueueJob, schema, type Database } from '@pixlova/db';
import { eventCustomerId, type BillingGateway, type GatewayEvent } from './gateway.js';
import { reconcileOpenChanges, syncCustomer, type BillingSyncContext } from './projection.js';

/** Tâche de traitement d’un événement Stripe enregistré (worker). */
export const STRIPE_EVENT_JOB = 'billing.stripe_event';
/** Tâche de resynchronisation d’un client Stripe (réconciliation périodique). */
export const SYNC_CUSTOMER_JOB = 'billing.sync_customer';

/**
 * Événements traités (BILL-010). Chacun déclenche la relecture de l’état du client chez
 * Stripe : l’effet ne dépend ni de l’ordre ni du nombre de réceptions. Les événements
 * sans effet direct sur les droits (`payment_method.attached`, `customer.updated`) sont
 * enregistrés et relisent l’état sans rien changer s’il est déjà à jour. Les autres types
 * sont conservés et marqués `ignored`.
 */
export const HANDLED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
  'customer.subscription.pending_update_applied',
  'customer.subscription.pending_update_expired',
  'subscription_schedule.canceled',
  'subscription_schedule.completed',
  'subscription_schedule.released',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_action_required',
  'payment_method.attached',
  'customer.updated',
  'customer.discount.created',
  'customer.discount.updated',
  'customer.discount.deleted',
]);

export interface ReceivedEvent {
  eventId: string;
  type: string;
  duplicate: boolean;
}

/**
 * Enregistre durablement un événement authentifié puis planifie son traitement (BILL-010) :
 * même transaction, déduplication par (environnement, identifiant d’événement). La
 * réponse HTTP peut partir dès le retour de cette fonction.
 */
export async function recordStripeEvent(
  db: Database,
  gateway: BillingGateway,
  event: GatewayEvent,
  now: Date,
): Promise<ReceivedEvent> {
  const environment = gateway.environment;
  // Un événement d’un autre mode n’a aucun effet (BILL-006) ; il est gardé pour diagnostic.
  const foreignMode = event.livemode !== (environment === 'live');
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(schema.stripeWebhookEvents)
      .values({
        environment,
        stripeEventId: event.id,
        type: event.type,
        apiVersion: event.apiVersion,
        objectId: typeof event.object.id === 'string' ? event.object.id : null,
        stripeCustomerId: eventCustomerId(event),
        stripeCreatedAt: event.created,
        payload: event.raw,
        status: foreignMode ? 'ignored' : 'received',
        error: foreignMode ? 'Mode Stripe différent de l’environnement.' : null,
        receivedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.stripeWebhookEvents.id });
    if (created && !foreignMode) {
      await enqueueJob(tx, {
        organizationId: null,
        kind: STRIPE_EVENT_JOB,
        dedupeKey: created.id,
        payload: { event_id: created.id },
        maxAttempts: 8,
      });
    }
    return { eventId: event.id, type: event.type, duplicate: !created };
  });
}

/**
 * Traite un événement enregistré : relecture du client concerné, suivi des sessions
 * Checkout expirées. Idempotent : un événement déjà traité n’a plus d’effet. En cas
 * d’erreur, l’événement reste `received` (nouvelle tentative de la tâche) avec son erreur.
 */
export async function processStripeEvent(
  ctx: BillingSyncContext,
  eventRowId: string,
): Promise<'processed' | 'ignored' | 'skipped'> {
  const [event] = await ctx.db
    .select()
    .from(schema.stripeWebhookEvents)
    .where(eq(schema.stripeWebhookEvents.id, eventRowId));
  if (!event || event.status !== 'received') return 'skipped';
  const finish = async (status: 'processed' | 'ignored', error: string | null = null) => {
    await ctx.db
      .update(schema.stripeWebhookEvents)
      .set({
        status,
        error,
        attempts: sql`${schema.stripeWebhookEvents.attempts} + 1`,
        processedAt: ctx.now(),
      })
      .where(eq(schema.stripeWebhookEvents.id, event.id));
    return status;
  };
  if (!HANDLED_EVENT_TYPES.has(event.type)) return finish('ignored', 'Type non traité.');
  if (!event.stripeCustomerId) return finish('ignored', 'Aucun client Stripe associé.');
  try {
    const outcome = await syncCustomer(ctx, event.stripeCustomerId);
    if (outcome.status === 'unknown_customer') {
      return finish('ignored', 'Client Stripe inconnu de cet environnement.');
    }
    if (event.type.startsWith('checkout.session.')) {
      await reconcileOpenChanges(ctx, outcome.organizationId);
    }
    return finish('processed');
  } catch (error) {
    await ctx.db
      .update(schema.stripeWebhookEvents)
      .set({
        attempts: sql`${schema.stripeWebhookEvents.attempts} + 1`,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      })
      .where(eq(schema.stripeWebhookEvents.id, event.id));
    throw error;
  }
}

/** Échec définitif d’un événement (tentatives épuisées) : la réconciliation prendra le relais. */
export async function failStripeEvent(
  db: Database,
  eventRowId: string,
  error: string,
): Promise<void> {
  await db
    .update(schema.stripeWebhookEvents)
    .set({ status: 'failed', error: error.slice(0, 500) })
    .where(
      and(
        eq(schema.stripeWebhookEvents.id, eventRowId),
        eq(schema.stripeWebhookEvents.status, 'received'),
      ),
    );
}

/** Resynchronisation d’un client puis de ses demandes ouvertes (tâche de réconciliation). */
export async function reconcileCustomer(
  ctx: BillingSyncContext,
  stripeCustomerId: string,
): Promise<void> {
  const outcome = await syncCustomer(ctx, stripeCustomerId);
  if (outcome.status === 'synced') await reconcileOpenChanges(ctx, outcome.organizationId);
}

/**
 * Contenu des événements conservé `retentionDays` jours (DATA §16 : payload protégé avec
 * rétention) ; la ligne reste pour la déduplication et l’audit.
 */
export async function clearStripeEventPayloads(
  db: Database,
  now: Date,
  retentionDays: number,
): Promise<number> {
  const before = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .update(schema.stripeWebhookEvents)
    .set({ payload: null })
    .where(
      and(
        lt(schema.stripeWebhookEvents.receivedAt, before),
        isNotNull(schema.stripeWebhookEvents.payload),
        inArray(schema.stripeWebhookEvents.status, ['processed', 'ignored', 'failed']),
      ),
    )
    .returning({ id: schema.stripeWebhookEvents.id });
  return rows.length;
}
