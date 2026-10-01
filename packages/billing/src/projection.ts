import { and, desc, eq, inArray, isNotNull, lt, lte, or, sql } from 'drizzle-orm';
import type { BillingEnvironment } from '@pixlova/contracts';
import { schema, type Database, type Transaction } from '@pixlova/db';
import { settleSubscriptionChanges } from './changes.js';
import type { BillingGateway, GatewaySubscription } from './gateway.js';

/** Dépendances de la synchronisation : rôle système (inter-tenants nommé, ADR-004). */
export interface BillingSyncContext {
  /** Rôle `pixlova_system`. */
  db: Database;
  gateway: BillingGateway;
  /** Durée de grâce d’un impayé, en jours (BILL-015, valeur à valider). */
  graceDays: number;
  now(): Date;
}

export type SyncOutcome =
  | { status: 'unknown_customer' }
  | {
      status: 'synced';
      organizationId: string;
      subscriptions: number;
      /** Prix Stripe absents du catalogue : projection de ces abonnements inchangée. */
      unmapped: string[];
    };

type PriceRow = typeof schema.planPrices.$inferSelect;
type SubscriptionRow = typeof schema.subscriptions.$inferSelect;

const describe = (error: unknown) =>
  (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 500);

/**
 * Rattache un abonnement Stripe à une version de l’offre (BILL-005) : un abonnement
 * existant reste lié à sa version tant que son prix de base ne change pas ; sinon, le prix
 * actif du catalogue fait foi, puis la version la plus récente qui l’a porté.
 */
async function resolvePrice(
  tx: Transaction,
  environment: BillingEnvironment,
  subscription: GatewaySubscription,
  existing: SubscriptionRow | undefined,
): Promise<{ price: PriceRow; baseItem: string; extraItem: string | null; extra: number } | null> {
  const priceIds = subscription.items.map((item) => item.priceId);
  if (priceIds.length === 0) return null;
  const candidates = await tx
    .select()
    .from(schema.planPrices)
    .where(
      and(
        eq(schema.planPrices.environment, environment),
        inArray(schema.planPrices.baseStripePriceId, priceIds),
      ),
    )
    .orderBy(desc(schema.planPrices.active), desc(schema.planPrices.createdAt));
  const price =
    candidates.find((candidate) => candidate.id === existing?.planPriceId) ?? candidates[0];
  if (!price) return null;
  const base = subscription.items.find((item) => item.priceId === price.baseStripePriceId)!;
  const extra = price.extraSlotStripePriceId
    ? subscription.items.find((item) => item.priceId === price.extraSlotStripePriceId)
    : undefined;
  return {
    price,
    baseItem: base.id,
    extraItem: extra?.id ?? null,
    extra: Math.max(0, extra?.quantity ?? 0),
  };
}

async function recordDiscounts(
  tx: Transaction,
  organizationId: string,
  environment: BillingEnvironment,
  subscriptionId: string,
  subscription: GatewaySubscription,
): Promise<void> {
  if (subscription.discounts.length === 0) return;
  // Acteur connu seulement si la demande locale est identifiée ; sinon origine système.
  const changeId = subscription.metadata.billing_change_id;
  const [change] = changeId
    ? await tx
        .select({ id: schema.billingChanges.id, requestedBy: schema.billingChanges.requestedBy })
        .from(schema.billingChanges)
        .where(
          and(
            eq(schema.billingChanges.organizationId, organizationId),
            sql`${schema.billingChanges.id}::text = ${changeId}`,
          ),
        )
    : [];
  for (const discount of subscription.discounts) {
    await tx
      .insert(schema.promotionRedemptions)
      .values({
        organizationId,
        environment,
        subscriptionId,
        billingChangeId: change?.id ?? null,
        stripeDiscountId: discount.id,
        stripeCouponId: discount.couponId,
        stripePromotionCodeId: discount.promotionCodeId,
        codeSnapshot: discount.code,
        percentOff: discount.percentOff === null ? null : String(discount.percentOff),
        amountOffMinor: discount.amountOffMinor,
        currency: discount.currency,
        duration: discount.duration,
        durationInMonths: discount.durationInMonths,
        appliedAt: discount.start,
        endsAt: discount.end,
        appliedBy: change?.requestedBy ?? null,
      })
      .onConflictDoNothing();
  }
}

/** Suivi de la demande à l’origine de l’abonnement (BILL-008, BILL-011). */
async function settleChange(
  tx: Transaction,
  organizationId: string,
  subscription: GatewaySubscription,
  now: Date,
): Promise<void> {
  const changeId = subscription.metadata.billing_change_id;
  if (!changeId || !/^[0-9a-f-]{36}$/.test(changeId)) return;
  const open = and(
    eq(schema.billingChanges.organizationId, organizationId),
    eq(schema.billingChanges.id, changeId),
    inArray(schema.billingChanges.status, ['requested', 'pending_payment', 'expired']),
  );
  if (subscription.status === 'active' || subscription.status === 'trialing') {
    await tx
      .update(schema.billingChanges)
      .set({
        status: 'applied',
        stripeSubscriptionId: subscription.id,
        appliedAt: now,
        failureReason: null,
        updatedAt: now,
      })
      .where(open);
  } else if (subscription.status === 'incomplete') {
    await tx
      .update(schema.billingChanges)
      .set({ status: 'pending_payment', stripeSubscriptionId: subscription.id, updatedAt: now })
      .where(open);
  } else if (subscription.status === 'incomplete_expired') {
    await tx
      .update(schema.billingChanges)
      .set({
        status: 'failed',
        stripeSubscriptionId: subscription.id,
        failureReason: 'payment_not_completed',
        updatedAt: now,
      })
      .where(open);
  }
}

/**
 * Synchronise la projection d’un client Stripe (BILL-009, BILL-010) en relisant l’état
 * courant de ses abonnements : un événement dupliqué, perdu ou reçu dans le désordre
 * converge vers le même résultat. Le verrou de la ligne client sérialise les
 * synchronisations concurrentes d’un même client (lecture Stripe comprise) sans bloquer
 * les lectures des droits. Une erreur Stripe laisse la projection précédente intacte.
 */
export async function syncCustomer(
  ctx: BillingSyncContext,
  stripeCustomerId: string,
): Promise<SyncOutcome> {
  const environment = ctx.gateway.environment;
  const where = and(
    eq(schema.billingCustomers.environment, environment),
    eq(schema.billingCustomers.stripeCustomerId, stripeCustomerId),
  );
  try {
    return await ctx.db.transaction(async (tx) => {
      const [customer] = await tx.select().from(schema.billingCustomers).where(where).for('update');
      if (!customer) return { status: 'unknown_customer' } as const;
      const organizationId = customer.organizationId;
      const remote = await ctx.gateway.listSubscriptions(stripeCustomerId);
      const now = ctx.now();
      const existing = await tx
        .select()
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.billingCustomerId, customer.id));
      const unmapped: string[] = [];
      for (const subscription of remote) {
        const previous = existing.find((row) => row.stripeSubscriptionId === subscription.id);
        const resolved = await resolvePrice(tx, environment, subscription, previous);
        if (!resolved) {
          unmapped.push(...subscription.items.map((item) => item.priceId));
          continue;
        }
        const graceUntil =
          subscription.status === 'past_due'
            ? (previous?.graceUntil ??
              new Date(now.getTime() + ctx.graceDays * 24 * 60 * 60 * 1000))
            : null;
        const values = {
          planId: resolved.price.planId,
          planPriceId: resolved.price.id,
          stripeStatus: subscription.status,
          extraDisplaySlots: resolved.extra,
          stripeBaseItemId: resolved.baseItem,
          stripeExtraItemId: resolved.extraItem,
          stripeCreatedAt: subscription.created,
          currentPeriodStart: subscription.currentPeriodStart,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
          canceledAt: subscription.canceledAt,
          endedAt: subscription.endedAt,
          graceUntil,
          stripeScheduleId: subscription.scheduleId,
          pendingUpdate: subscription.pendingUpdate,
          lastSyncedAt: now,
          updatedAt: now,
        };
        const [row] = await tx
          .insert(schema.subscriptions)
          .values({
            organizationId,
            environment,
            billingCustomerId: customer.id,
            stripeSubscriptionId: subscription.id,
            ...values,
          })
          .onConflictDoUpdate({
            target: [schema.subscriptions.environment, schema.subscriptions.stripeSubscriptionId],
            set: values,
          })
          .returning({ id: schema.subscriptions.id });
        await recordDiscounts(tx, organizationId, environment, row!.id, subscription);
        await settleChange(tx, organizationId, subscription, now);
        await settleSubscriptionChanges(
          tx,
          row!.id,
          subscription,
          { planPriceId: resolved.price.id, extra: resolved.extra },
          now,
        );
        const changed =
          !previous ||
          previous.stripeStatus !== subscription.status ||
          previous.planId !== resolved.price.planId ||
          previous.extraDisplaySlots !== resolved.extra ||
          previous.cancelAtPeriodEnd !== subscription.cancelAtPeriodEnd;
        if (changed) {
          // Audit de chaque changement de droits (SEC-016), acteur système (relecture Stripe).
          await tx.insert(schema.auditLogs).values({
            organizationId,
            actorType: 'system',
            action: previous ? 'billing.subscription.updated' : 'billing.subscription.created',
            targetType: 'subscription',
            targetId: row!.id,
            result: 'success',
            metadata: {
              stripe_subscription_id: subscription.id,
              stripe_status: subscription.status,
              previous_status: previous?.stripeStatus ?? null,
              plan_id: resolved.price.planId,
              extra_display_slots: resolved.extra,
              cancel_at_period_end: subscription.cancelAtPeriodEnd,
            },
          });
        }
      }
      await tx
        .update(schema.billingCustomers)
        .set(
          unmapped.length
            ? {
                syncStatus: 'error',
                syncError:
                  `Prix Stripe absent du catalogue : ${[...new Set(unmapped)].join(', ')}`.slice(
                    0,
                    500,
                  ),
                lastSyncedAt: now,
                updatedAt: now,
              }
            : { syncStatus: 'ok', syncError: null, lastSyncedAt: now, updatedAt: now },
        )
        .where(eq(schema.billingCustomers.id, customer.id));
      return {
        status: 'synced',
        organizationId,
        subscriptions: remote.length,
        unmapped: [...new Set(unmapped)],
      } as const;
    });
  } catch (error) {
    // La projection précédente est conservée (BILL-009) ; l’erreur reste visible.
    await ctx.db
      .update(schema.billingCustomers)
      .set({ syncStatus: 'error', syncError: describe(error), updatedAt: ctx.now() })
      .where(where);
    throw error;
  }
}

/**
 * Demandes ouvertes d’une organisation (BILL-008) : une session Checkout expirée sans
 * abonnement termine la demande ; une demande restée sans session (appel Stripe échoué)
 * est close après une heure. Aucune n’accorde de droit : seule la projection le fait.
 */
export async function reconcileOpenChanges(
  ctx: BillingSyncContext,
  organizationId: string,
): Promise<number> {
  const now = ctx.now();
  const open = await ctx.db
    .select()
    .from(schema.billingChanges)
    .where(
      and(
        eq(schema.billingChanges.organizationId, organizationId),
        eq(schema.billingChanges.environment, ctx.gateway.environment),
        inArray(schema.billingChanges.status, ['requested', 'pending_payment']),
      ),
    );
  let settled = 0;
  for (const change of open) {
    if (change.kind !== 'subscribe') {
      // Appel Stripe d’une modification jamais abouti (panne, arrêt) : demande close.
      if (change.status !== 'requested') continue;
      if (now.getTime() - change.createdAt.getTime() < 60 * 60 * 1000) continue;
      await ctx.db
        .update(schema.billingChanges)
        .set({ status: 'failed', failureReason: 'provider_call_not_completed', updatedAt: now })
        .where(
          and(
            eq(schema.billingChanges.id, change.id),
            eq(schema.billingChanges.status, 'requested'),
          ),
        );
      settled += 1;
      continue;
    }
    if (!change.stripeCheckoutSessionId) {
      if (now.getTime() - change.createdAt.getTime() < 60 * 60 * 1000) continue;
      await ctx.db
        .update(schema.billingChanges)
        .set({ status: 'failed', failureReason: 'checkout_not_created', updatedAt: now })
        .where(
          and(
            eq(schema.billingChanges.id, change.id),
            eq(schema.billingChanges.status, 'requested'),
          ),
        );
      settled += 1;
      continue;
    }
    if (change.stripeSubscriptionId) continue;
    const session = await ctx.gateway.retrieveCheckoutSession(change.stripeCheckoutSessionId);
    if (session.status === 'expired') {
      await ctx.db
        .update(schema.billingChanges)
        .set({ status: 'expired', checkoutUrl: null, updatedAt: now })
        .where(
          and(
            eq(schema.billingChanges.id, change.id),
            inArray(schema.billingChanges.status, ['requested', 'pending_payment']),
          ),
        );
      settled += 1;
    } else if (session.status === 'complete' && session.customerId) {
      await syncCustomer(ctx, session.customerId);
    }
  }
  return settled;
}

/**
 * Réconciliation périodique (BILL-010, DATA-008) : clients jamais synchronisés, en erreur
 * ou plus anciens que `staleAfterMs`, et clients ayant une demande ouverte. Renvoie les
 * identifiants Stripe à resynchroniser, par lots.
 */
export async function customersToReconcile(
  db: Database,
  environment: BillingEnvironment,
  now: Date,
  staleAfterMs: number,
  limit = 100,
): Promise<string[]> {
  const stale = new Date(now.getTime() - staleAfterMs);
  const rows = await db
    .selectDistinct({ id: schema.billingCustomers.stripeCustomerId })
    .from(schema.billingCustomers)
    .leftJoin(
      schema.billingChanges,
      and(
        eq(schema.billingChanges.organizationId, schema.billingCustomers.organizationId),
        eq(schema.billingChanges.environment, schema.billingCustomers.environment),
        or(
          inArray(schema.billingChanges.status, ['requested', 'pending_payment']),
          // Échéance d’une baisse ou d’une annulation : constater l’effet sans attendre.
          and(
            eq(schema.billingChanges.status, 'scheduled'),
            lte(schema.billingChanges.effectiveAt, now),
          ),
        ),
      ),
    )
    .where(
      and(
        eq(schema.billingCustomers.environment, environment),
        or(
          sql`${schema.billingCustomers.lastSyncedAt} is null`,
          lt(schema.billingCustomers.lastSyncedAt, stale),
          eq(schema.billingCustomers.syncStatus, 'error'),
          isNotNull(schema.billingChanges.id),
        ),
      ),
    )
    .limit(limit);
  return rows.map((row) => row.id);
}
