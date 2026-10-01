/**
 * Modification d’un abonnement en cours (ADR-017, BILL-011, BILL-012, BILL-014) : hausse
 * immédiate au prorata, baisse et annulation à l’échéance avec choix explicite des Displays
 * conservés. Comme la souscription, chaque demande est enregistrée avant l’appel Stripe sous
 * une clé d’idempotence ; seule la projection relue chez Stripe la déclare appliquée.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import Type from 'typebox';
import {
  OPEN_CHANGE_STATUSES,
  capacitiesOf,
  checkSelection,
  displayCapacity,
  fallbackPlan,
  organizationUsage,
  purchasablePrice,
  recurringAmountMinor,
  syncCustomer,
  type BillingGateway,
  type DesiredItem,
  type PlanCapacities,
  type SelectionCheck,
} from '@pixlova/billing';
import { canonicalJson } from '@pixlova/contracts';
import { schema, withTenant, type Transaction } from '@pixlova/db';
import { ApiError } from '../errors.js';
import {
  authorize,
  rateLimit,
  requestMeta,
  requireAdminMfa,
  requireMember,
  type MemberContext,
} from '../http/context.js';
import type { Services } from '../http/services.js';
import { audit } from '../lib/audit.js';
import {
  ABANDONED_REQUEST_MS,
  idempotencyKey,
  lockOrganization,
  providerError,
  publicChange,
  requireGateway,
  syncContext,
} from './billing.js';
import { Strict, Uuid } from './schemas.js';

type ChangeRow = typeof schema.billingChanges.$inferSelect;
type SubscriptionRow = typeof schema.subscriptions.$inferSelect;
type PriceRow = typeof schema.planPrices.$inferSelect;
type PlanRow = typeof schema.plans.$inferSelect;

/** Écart toléré entre la prévisualisation et la confirmation d’une hausse. */
const PRORATION_WINDOW_MS = 30 * 60_000;

const TargetBody = {
  plan_key: Type.String({ pattern: '^[a-z][a-z0-9_-]{1,39}$' }),
  interval: Type.Union([Type.Literal('month'), Type.Literal('year')]),
  extra_display_slots: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
};
const KeepDisplays = Type.Array(Uuid, { maxItems: 10_000, uniqueItems: true });

interface TargetInput {
  plan_key: string;
  interval: 'month' | 'year';
  extra_display_slots?: number;
}

interface Current {
  customerId: string;
  subscription: SubscriptionRow;
  price: PriceRow;
  plan: PlanRow;
}

interface Target {
  plan: PlanRow;
  price: PriceRow;
  capacities: PlanCapacities;
  extra: number;
}

/** Abonnement modifiable : vivant, à jour de paiement, sans annulation ni hausse en attente. */
async function currentSubscription(
  tx: Transaction,
  organizationId: string,
  gateway: BillingGateway,
): Promise<Current> {
  const rows = await tx
    .select({
      subscription: schema.subscriptions,
      price: schema.planPrices,
      plan: schema.plans,
      customerId: schema.billingCustomers.stripeCustomerId,
    })
    .from(schema.subscriptions)
    .innerJoin(schema.planPrices, eq(schema.planPrices.id, schema.subscriptions.planPriceId))
    .innerJoin(schema.plans, eq(schema.plans.id, schema.subscriptions.planId))
    .innerJoin(
      schema.billingCustomers,
      eq(schema.billingCustomers.id, schema.subscriptions.billingCustomerId),
    )
    .where(
      and(
        eq(schema.subscriptions.organizationId, organizationId),
        eq(schema.subscriptions.environment, gateway.environment),
        inArray(schema.subscriptions.stripeStatus, ['active', 'trialing', 'past_due']),
      ),
    );
  const row = rows.sort(
    (a, b) => b.subscription.stripeCreatedAt.getTime() - a.subscription.stripeCreatedAt.getTime(),
  )[0];
  if (!row) {
    throw new ApiError(409, 'NO_ACTIVE_SUBSCRIPTION', 'Aucun abonnement payant en cours.');
  }
  if (row.subscription.stripeStatus === 'past_due') {
    throw new ApiError(
      409,
      'BILLING_PAST_DUE',
      'Un paiement est en retard : régularisez-le avant de modifier l’abonnement.',
    );
  }
  if (row.subscription.pendingUpdate) {
    throw new ApiError(409, 'BILLING_PENDING', 'Un paiement est déjà en attente.', true);
  }
  return row;
}

async function resolveTarget(
  tx: Transaction,
  gateway: BillingGateway,
  body: TargetInput,
): Promise<Target> {
  const offer = await purchasablePrice(tx, {
    planKey: body.plan_key,
    interval: body.interval,
    environment: gateway.environment,
  });
  if (!offer || offer.plan.isFallback) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Offre ou périodicité indisponible.', false, {
      field: 'plan_key',
    });
  }
  const extra = body.extra_display_slots ?? 0;
  if (
    extra > offer.plan.maxExtraDisplaySlots ||
    (extra > 0 && !offer.price.extraSlotStripePriceId)
  ) {
    throw new ApiError(
      422,
      'VALIDATION_ERROR',
      'Nombre de slots supplémentaires non autorisé pour cette offre.',
      false,
      { field: 'extra_display_slots', max: offer.plan.maxExtraDisplaySlots },
    );
  }
  return { plan: offer.plan, price: offer.price, capacities: capacitiesOf(offer.plan), extra };
}

function itemsOf(price: PriceRow, extra: number): DesiredItem[] {
  const items: DesiredItem[] = [{ price: price.baseStripePriceId!, quantity: 1 }];
  if (price.extraSlotStripePriceId) {
    items.push({ price: price.extraSlotStripePriceId, quantity: extra });
  }
  return items;
}

interface Plan {
  kind: 'upgrade' | 'downgrade';
  currentAmount: number;
  newAmount: number;
  currentCapacity: number;
  newCapacity: number;
}

/**
 * Nature de la modification (BILL-011, BILL-012) : une hausse du montant qui ne réduit
 * aucune capacité prend effet tout de suite ; toute autre modification attend l’échéance,
 * pour ne jamais retirer un droit déjà payé.
 */
function classify(current: Current, target: Target): Plan {
  if (target.price.interval !== current.price.interval) {
    throw new ApiError(
      422,
      'INTERVAL_CHANGE_UNSUPPORTED',
      'Le changement de périodicité n’est pas encore proposé.',
    );
  }
  if (target.price.currency !== current.price.currency) {
    throw new ApiError(422, 'CURRENCY_CHANGE_UNSUPPORTED', 'Changement de devise impossible.');
  }
  if (
    target.price.id === current.price.id &&
    target.extra === current.subscription.extraDisplaySlots
  ) {
    throw new ApiError(422, 'NO_CHANGE', 'L’abonnement correspond déjà à cette demande.');
  }
  const currentPlan = capacitiesOf(current.plan);
  const currentAmount = recurringAmountMinor(current.price, current.subscription.extraDisplaySlots);
  const newAmount = recurringAmountMinor(target.price, target.extra);
  const currentCapacity = displayCapacity(currentPlan, current.subscription.extraDisplaySlots);
  const newCapacity = displayCapacity(target.capacities, target.extra);
  const reduces =
    newCapacity < currentCapacity ||
    target.capacities.entitlements.max_users < currentPlan.entitlements.max_users ||
    target.capacities.entitlements.storage_quota_bytes <
      currentPlan.entitlements.storage_quota_bytes ||
    currentPlan.entitlements.features.some(
      (feature) => !target.capacities.entitlements.features.includes(feature),
    );
  return {
    kind: newAmount > currentAmount && !reduces ? 'upgrade' : 'downgrade',
    currentAmount,
    newAmount,
    currentCapacity,
    newCapacity,
  };
}

function selectionView(check: SelectionCheck) {
  return {
    display_slots: check.capacity,
    active_displays: check.active.length,
    selection_required: !check.fits,
  };
}

function requireValidSelection(check: SelectionCheck): void {
  if (check.valid) return;
  throw new ApiError(
    422,
    'DISPLAY_SELECTION_REQUIRED',
    'Choisissez les Displays à conserver actifs : la capacité future est inférieure à l’usage actuel.',
    false,
    {
      display_slots: check.capacity,
      active_displays: check.active.length,
      field: 'keep_display_ids',
    },
  );
}

/** Dépassements conservés après l’échéance (BILL-013) : affichés, jamais supprimés. */
async function quotaWarnings(
  tx: Transaction,
  organizationId: string,
  plan: PlanCapacities,
  now: Date,
): Promise<{ code: string; allowed: number; used: number }[]> {
  const usage = await organizationUsage(tx, organizationId, now);
  const warnings: { code: string; allowed: number; used: number }[] = [];
  if (usage.users > plan.entitlements.max_users) {
    warnings.push({
      code: 'USERS_OVER_LIMIT',
      allowed: plan.entitlements.max_users,
      used: usage.users,
    });
  }
  if (usage.storageBytes > plan.entitlements.storage_quota_bytes) {
    warnings.push({
      code: 'STORAGE_OVER_LIMIT',
      allowed: plan.entitlements.storage_quota_bytes,
      used: usage.storageBytes,
    });
  }
  return warnings;
}

function planView(plan: PlanRow) {
  return { key: plan.key, version: plan.version, name: plan.name };
}

function requestHashOf(value: object): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Enregistre une demande sous verrou de l’organisation (idempotence, une seule modification
 * en cours) ; renvoie la demande existante en cas de rejeu.
 */
async function recordChange(
  tx: Transaction,
  member: MemberContext,
  key: string,
  requestHash: string,
  now: Date,
  create: () => Promise<ChangeRow>,
): Promise<ChangeRow> {
  await lockOrganization(tx, member.organizationId);
  const [existing] = await tx
    .select()
    .from(schema.billingChanges)
    .where(eq(schema.billingChanges.idempotencyKey, key));
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new ApiError(
        409,
        'IDEMPOTENCY_CONFLICT',
        'Cette clé d’idempotence a déjà servi pour une autre requête.',
      );
    }
    return existing;
  }
  const [open] = await tx
    .select()
    .from(schema.billingChanges)
    .where(
      and(
        inArray(schema.billingChanges.kind, ['upgrade', 'downgrade', 'cancel']),
        inArray(schema.billingChanges.status, [...OPEN_CHANGE_STATUSES]),
      ),
    );
  if (open) {
    const abandoned =
      open.status === 'requested' &&
      now.getTime() - open.createdAt.getTime() > ABANDONED_REQUEST_MS;
    if (!abandoned) {
      throw new ApiError(
        409,
        'BILLING_CHANGE_PENDING',
        'Une modification de l’abonnement est déjà en cours ; annulez-la ou attendez son échéance.',
        false,
        { change_id: open.id },
      );
    }
    await tx
      .update(schema.billingChanges)
      .set({ status: 'failed', failureReason: 'provider_call_not_completed', updatedAt: now })
      .where(eq(schema.billingChanges.id, open.id));
  }
  return create();
}

async function setChange(
  services: Services,
  organizationId: string,
  id: string,
  values: Partial<typeof schema.billingChanges.$inferInsert>,
): Promise<ChangeRow> {
  return withTenant(services.db, organizationId, async (tx) => {
    await tx
      .update(schema.billingChanges)
      .set({ ...values, updatedAt: services.now() })
      .where(and(eq(schema.billingChanges.id, id), eq(schema.billingChanges.status, 'requested')));
    const [row] = await tx
      .select()
      .from(schema.billingChanges)
      .where(eq(schema.billingChanges.id, id));
    return row!;
  });
}

/** Relecture immédiate après un appel Stripe ; le webhook ou la réconciliation suivront. */
async function syncQuietly(
  services: Services,
  gateway: BillingGateway,
  request: FastifyRequest,
  customerId: string,
): Promise<void> {
  try {
    await syncCustomer(syncContext(services, gateway), customerId);
  } catch (error) {
    request.log.warn({ err: error }, 'relecture Stripe différée');
  }
}

async function readChange(services: Services, organizationId: string, id: string) {
  const [row] = await withTenant(services.db, organizationId, (tx) =>
    tx.select().from(schema.billingChanges).where(eq(schema.billingChanges.id, id)),
  );
  return row!;
}

export function subscriptionChangeRoutes(app: FastifyInstance, services: Services): void {
  /**
   * Prévisualisation (BILL-004, BILL-011, BILL-012) : nouveau montant récurrent, montant dû
   * immédiatement (prorata calculé par Stripe), date d’effet, prochaine échéance, capacité
   * future et Displays à choisir. Aucun effet.
   */
  app.post(
    '/billing/subscription/preview',
    { schema: { body: Type.Object(TargetBody, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      authorize(member, 'billing.manage');
      const gateway = requireGateway(services);
      await rateLimit(services, `billing-preview:${member.organizationId}`, 60, 3600);
      const body = request.body as TargetInput;
      const now = services.now();
      const prepared = await withTenant(services.db, member.organizationId, async (tx) => {
        const current = await currentSubscription(tx, member.organizationId, gateway);
        const target = await resolveTarget(tx, gateway, body);
        const plan = classify(current, target);
        const check = await checkSelection(tx, member.organizationId, plan.newCapacity, null);
        const warnings = await quotaWarnings(tx, member.organizationId, target.capacities, now);
        return { current, target, plan, check, warnings };
      });
      const { current, target, plan, check, warnings } = prepared;
      const prorationDate = new Date(Math.floor(now.getTime() / 1000) * 1000);
      let amountDueNow = 0;
      if (plan.kind === 'upgrade') {
        try {
          const preview = await gateway.previewUpgrade({
            customerId: current.customerId,
            subscriptionId: current.subscription.stripeSubscriptionId,
            items: itemsOf(target.price, target.extra),
            prorationDate,
          });
          amountDueNow = preview.amountDueMinor;
        } catch (error) {
          request.log.error({ err: error }, 'prévisualisation Stripe en échec');
          providerError(error);
        }
      }
      return {
        kind: plan.kind,
        plan: planView(target.plan),
        interval: target.price.interval,
        currency: target.price.currency,
        extra_display_slots: target.extra,
        current_amount_minor: plan.currentAmount,
        new_amount_minor: plan.newAmount,
        // Hausse : prorata facturé maintenant ; baisse : rien avant l’échéance.
        amount_due_now_minor: amountDueNow,
        proration_date: plan.kind === 'upgrade' ? prorationDate.toISOString() : null,
        effective_at:
          plan.kind === 'upgrade'
            ? now.toISOString()
            : (current.subscription.currentPeriodEnd?.toISOString() ?? null),
        next_period_end: current.subscription.currentPeriodEnd?.toISOString() ?? null,
        capacity: selectionView(check),
        warnings,
        indicative: target.plan.indicative,
      };
    },
  );

  /** Confirmation d’une hausse (immédiate) ou d’une baisse (à l’échéance). */
  app.post(
    '/billing/subscription/change',
    {
      schema: {
        body: Type.Object(
          {
            ...TargetBody,
            proration_date: Type.Optional(Type.String({ format: 'date-time' })),
            keep_display_ids: Type.Optional(KeepDisplays),
          },
          Strict,
        ),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      authorize(member, 'billing.manage');
      requireAdminMfa(member, services);
      const gateway = requireGateway(services);
      const key = idempotencyKey(request);
      await rateLimit(services, `billing-change:${member.organizationId}`, 20, 3600);
      const body = request.body as TargetInput & {
        proration_date?: string;
        keep_display_ids?: string[];
      };
      const now = services.now();
      const prorationDate = body.proration_date ? new Date(body.proration_date) : now;
      if (
        prorationDate.getTime() > now.getTime() + 60_000 ||
        now.getTime() - prorationDate.getTime() > PRORATION_WINDOW_MS
      ) {
        throw new ApiError(
          422,
          'PREVIEW_EXPIRED',
          'La prévisualisation a expiré : relancez-la avant de confirmer.',
          false,
          { field: 'proration_date' },
        );
      }
      const organizationId = member.organizationId;
      let current: Current | undefined;
      const change = await withTenant(services.db, organizationId, (tx) =>
        recordChange(tx, member, key, requestHashOf(body), now, async () => {
          current = await currentSubscription(tx, organizationId, gateway);
          if (current.subscription.cancelAtPeriodEnd) {
            throw new ApiError(
              409,
              'CANCELLATION_SCHEDULED',
              'L’abonnement est en cours d’annulation : reprenez-le avant de le modifier.',
            );
          }
          const target = await resolveTarget(tx, gateway, body);
          const plan = classify(current, target);
          let keep: string[] | null = null;
          if (plan.kind === 'downgrade') {
            const check = await checkSelection(
              tx,
              organizationId,
              plan.newCapacity,
              body.keep_display_ids ?? null,
            );
            requireValidSelection(check);
            keep = check.fits ? null : check.kept;
          }
          const [created] = await tx
            .insert(schema.billingChanges)
            .values({
              organizationId,
              environment: gateway.environment,
              kind: plan.kind,
              requestedBy: member.auth.user.id,
              idempotencyKey: key,
              requestHash: requestHashOf(body),
              planId: target.plan.id,
              planPriceId: target.price.id,
              extraDisplaySlots: target.extra,
              subscriptionId: current.subscription.id,
              effectiveAt: plan.kind === 'upgrade' ? now : current.subscription.currentPeriodEnd,
              prorationDate: plan.kind === 'upgrade' ? prorationDate : null,
              keepDisplayIds: keep,
              selectionStatus: keep ? 'pending' : null,
            })
            .returning();
          await audit(tx, {
            organizationId,
            actorType: 'user',
            actorId: member.auth.user.id,
            action: `billing.${plan.kind}.requested`,
            permission: 'billing.manage',
            targetType: 'billing_change',
            targetId: created!.id,
            result: 'success',
            metadata: {
              plan_key: target.plan.key,
              plan_version: target.plan.version,
              extra_display_slots: target.extra,
              current_amount_minor: plan.currentAmount,
              new_amount_minor: plan.newAmount,
              kept_display_ids: keep,
            },
            ...requestMeta(request),
          });
          return created!;
        }),
      );
      if (change.status !== 'requested') return reply.code(200).send(publicChange(change));
      current ??= await withTenant(services.db, organizationId, (tx) =>
        currentSubscription(tx, organizationId, gateway),
      );
      const [price] = await withTenant(services.db, organizationId, (tx) =>
        tx.select().from(schema.planPrices).where(eq(schema.planPrices.id, change.planPriceId!)),
      );
      const items = itemsOf(price!, change.extraDisplaySlots);
      try {
        if (change.kind === 'upgrade') {
          await gateway.upgradeSubscription(
            {
              customerId: current.customerId,
              subscriptionId: current.subscription.stripeSubscriptionId,
              items,
              prorationDate: change.prorationDate ?? now,
            },
            `pixlova:upgrade:${change.id}`,
          );
          // En attente de la confirmation relue chez Stripe (paiement du prorata, SCA).
          await setChange(services, organizationId, change.id, { status: 'pending_payment' });
        } else {
          const scheduled = await gateway.scheduleDowngrade(
            {
              subscriptionId: current.subscription.stripeSubscriptionId,
              items,
              metadata: { organization_id: organizationId, billing_change_id: change.id },
            },
            `pixlova:downgrade:${change.id}`,
          );
          await setChange(services, organizationId, change.id, {
            status: 'scheduled',
            stripeScheduleId: scheduled.scheduleId,
            effectiveAt: scheduled.effectiveAt,
          });
        }
      } catch (error) {
        request.log.error({ err: error, change_id: change.id }, 'modification Stripe en échec');
        return providerError(error);
      }
      await syncQuietly(services, gateway, request, current.customerId);
      return reply
        .code(201)
        .send(publicChange(await readChange(services, organizationId, change.id)));
    },
  );

  /**
   * Annulation à l’échéance (BILL-014) : retour à l’offre de repli en fin de période, avec
   * le choix des Displays conservés. Ce n’est pas une demande d’effacement.
   */
  app.post(
    '/billing/subscription/cancel',
    {
      schema: {
        body: Type.Object({ keep_display_ids: Type.Optional(KeepDisplays) }, Strict),
      },
    },
    async (request, reply) => {
      const member = await requireMember(request, services);
      authorize(member, 'billing.manage');
      requireAdminMfa(member, services);
      const gateway = requireGateway(services);
      const key = idempotencyKey(request);
      await rateLimit(services, `billing-change:${member.organizationId}`, 20, 3600);
      const body = request.body as { keep_display_ids?: string[] };
      const now = services.now();
      const organizationId = member.organizationId;
      let current: Current | undefined;
      const change = await withTenant(services.db, organizationId, (tx) =>
        recordChange(tx, member, key, requestHashOf({ cancel: true, ...body }), now, async () => {
          current = await currentSubscription(tx, organizationId, gateway);
          if (current.subscription.cancelAtPeriodEnd) {
            throw new ApiError(409, 'CANCELLATION_SCHEDULED', 'L’annulation est déjà programmée.');
          }
          const fallback = await fallbackPlan(tx);
          const check = await checkSelection(
            tx,
            organizationId,
            displayCapacity(fallback, 0),
            body.keep_display_ids ?? null,
          );
          requireValidSelection(check);
          const keep = check.fits ? null : check.kept;
          const [created] = await tx
            .insert(schema.billingChanges)
            .values({
              organizationId,
              environment: gateway.environment,
              kind: 'cancel',
              requestedBy: member.auth.user.id,
              idempotencyKey: key,
              requestHash: requestHashOf({ cancel: true, ...body }),
              subscriptionId: current.subscription.id,
              effectiveAt: current.subscription.currentPeriodEnd,
              keepDisplayIds: keep,
              selectionStatus: keep ? 'pending' : null,
            })
            .returning();
          await audit(tx, {
            organizationId,
            actorType: 'user',
            actorId: member.auth.user.id,
            action: 'billing.cancel.requested',
            permission: 'billing.manage',
            targetType: 'billing_change',
            targetId: created!.id,
            result: 'success',
            metadata: {
              effective_at: current.subscription.currentPeriodEnd?.toISOString() ?? null,
              kept_display_ids: keep,
              fallback_plan: fallback.key,
            },
            ...requestMeta(request),
          });
          return created!;
        }),
      );
      if (change.status !== 'requested') return reply.code(200).send(publicChange(change));
      current ??= await withTenant(services.db, organizationId, (tx) =>
        currentSubscription(tx, organizationId, gateway),
      );
      try {
        await gateway.setCancelAtPeriodEnd(
          current.subscription.stripeSubscriptionId,
          true,
          `pixlova:cancel:${change.id}`,
        );
        await setChange(services, organizationId, change.id, { status: 'scheduled' });
      } catch (error) {
        request.log.error({ err: error, change_id: change.id }, 'annulation Stripe en échec');
        return providerError(error);
      }
      await syncQuietly(services, gateway, request, current.customerId);
      return reply
        .code(201)
        .send(publicChange(await readChange(services, organizationId, change.id)));
    },
  );

  /** Modification du choix des Displays avant l’échéance (BILL-012), auditée. */
  app.put(
    '/billing/changes/:id/selection',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        body: Type.Object({ keep_display_ids: KeepDisplays }, Strict),
      },
    },
    async (request) => {
      const member = await requireMember(request, services);
      authorize(member, 'billing.manage');
      requireAdminMfa(member, services);
      const { id } = request.params as { id: string };
      const body = request.body as { keep_display_ids: string[] };
      return withTenant(services.db, member.organizationId, async (tx) => {
        await lockOrganization(tx, member.organizationId);
        const [change] = await tx
          .select()
          .from(schema.billingChanges)
          .where(eq(schema.billingChanges.id, id));
        if (!change) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Demande introuvable.');
        if (change.status !== 'scheduled' || !['downgrade', 'cancel'].includes(change.kind)) {
          throw new ApiError(409, 'CHANGE_NOT_SCHEDULED', 'Cette demande n’est plus modifiable.');
        }
        const capacity =
          change.kind === 'cancel'
            ? displayCapacity(await fallbackPlan(tx), 0)
            : await tx
                .select()
                .from(schema.plans)
                .where(eq(schema.plans.id, change.planId!))
                .then(([plan]) => displayCapacity(capacitiesOf(plan!), change.extraDisplaySlots));
        const check = await checkSelection(
          tx,
          member.organizationId,
          capacity,
          body.keep_display_ids,
        );
        requireValidSelection(check);
        const keep = check.fits ? null : check.kept;
        const [updated] = await tx
          .update(schema.billingChanges)
          .set({
            keepDisplayIds: keep,
            selectionStatus: keep ? 'pending' : null,
            updatedAt: services.now(),
          })
          .where(eq(schema.billingChanges.id, id))
          .returning();
        await audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'billing.display_selection.updated',
          permission: 'billing.manage',
          targetType: 'billing_change',
          targetId: id,
          result: 'success',
          metadata: { previous: change.keepDisplayIds ?? null, kept_display_ids: keep },
          ...requestMeta(request),
        });
        return publicChange(updated!);
      });
    },
  );

  /**
   * Renoncer à une baisse ou à une annulation avant l’échéance : la planification Stripe est
   * relâchée, ou l’annulation levée ; l’abonnement continue à l’identique.
   */
  app.delete(
    '/billing/changes/:id',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      authorize(member, 'billing.manage');
      requireAdminMfa(member, services);
      const gateway = requireGateway(services);
      const { id } = request.params as { id: string };
      const organizationId = member.organizationId;
      const found = await withTenant(services.db, organizationId, async (tx) => {
        const [row] = await tx
          .select({ change: schema.billingChanges, subscription: schema.subscriptions })
          .from(schema.billingChanges)
          .innerJoin(
            schema.subscriptions,
            eq(schema.subscriptions.id, schema.billingChanges.subscriptionId),
          )
          .where(eq(schema.billingChanges.id, id));
        if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Demande introuvable.');
        if (row.change.status !== 'scheduled') {
          throw new ApiError(409, 'CHANGE_NOT_SCHEDULED', 'Cette demande n’est plus modifiable.');
        }
        const [customer] = await tx
          .select({ id: schema.billingCustomers.stripeCustomerId })
          .from(schema.billingCustomers)
          .where(eq(schema.billingCustomers.id, row.subscription.billingCustomerId));
        return { ...row, customerId: customer!.id };
      });
      try {
        if (found.change.kind === 'downgrade') {
          await gateway.releaseSchedule(found.change.stripeScheduleId!);
        } else {
          await gateway.setCancelAtPeriodEnd(
            found.subscription.stripeSubscriptionId,
            false,
            `pixlova:resume:${found.change.id}`,
          );
        }
      } catch (error) {
        request.log.error({ err: error, change_id: id }, 'abandon Stripe en échec');
        return providerError(error);
      }
      const updated = await withTenant(services.db, organizationId, async (tx) => {
        const [row] = await tx
          .update(schema.billingChanges)
          .set({ status: 'cancelled', failureReason: 'withdrawn', updatedAt: services.now() })
          .where(
            and(eq(schema.billingChanges.id, id), eq(schema.billingChanges.status, 'scheduled')),
          )
          .returning();
        await audit(tx, {
          organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: `billing.${found.change.kind}.withdrawn`,
          permission: 'billing.manage',
          targetType: 'billing_change',
          targetId: id,
          result: 'success',
          ...requestMeta(request),
        });
        return row ?? (await readChange(services, organizationId, id));
      });
      await syncQuietly(services, gateway, request, found.customerId);
      return publicChange(updated);
    },
  );
}
