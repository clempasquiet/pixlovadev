import { and, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import { schema, type Transaction } from '@pixlova/db';
import { requestRecompile } from '@pixlova/scheduling/compiler';
import { capacitiesOf, fallbackPlan } from './catalog.js';
import type { PlanCapacities } from './entitlements.js';
import type { GatewaySubscription } from './gateway.js';

type ChangeRow = typeof schema.billingChanges.$inferSelect;
type DisplaySelectionStatus = NonNullable<ChangeRow['selectionStatus']>;

/** Demandes de modification encore ouvertes (hors première souscription). */
export const OPEN_CHANGE_STATUSES = ['requested', 'pending_payment', 'scheduled'] as const;

/** Capacité de Displays d’une offre avec ses slots supplémentaires (bornés par l’offre). */
export function displayCapacity(plan: PlanCapacities, extra: number): number {
  return plan.includedDisplaySlots + Math.min(Math.max(0, extra), plan.maxExtraDisplaySlots);
}

export interface SelectionCheck {
  /** Displays actifs au moment du contrôle. */
  active: string[];
  capacity: number;
  /** La capacité future couvre l’usage : aucune sélection nécessaire. */
  fits: boolean;
  /** Displays conservés encore actifs ; `null` sans sélection. */
  kept: string[] | null;
  valid: boolean;
}

/**
 * Contrôle d’une sélection de Displays à conserver (BILL-012) : seuls des Displays actifs,
 * au plus la capacité future, au moins un. Refait à l’échéance : un Display supprimé
 * entre-temps sort de la sélection sans l’invalider.
 */
export async function checkSelection(
  tx: Transaction,
  organizationId: string,
  capacity: number,
  keep: readonly string[] | null,
): Promise<SelectionCheck> {
  const rows = await tx
    .select({ id: schema.displays.id })
    .from(schema.displays)
    .where(
      and(
        eq(schema.displays.organizationId, organizationId),
        eq(schema.displays.lifecycleStatus, 'active'),
        isNull(schema.displays.deletedAt),
      ),
    );
  const active = rows.map((row) => row.id);
  const fits = active.length <= capacity;
  if (keep === null) return { active, capacity, fits, kept: null, valid: fits };
  const kept = [...new Set(keep)].filter((id) => active.includes(id));
  return {
    active,
    capacity,
    fits,
    kept,
    valid: fits || (kept.length > 0 && kept.length <= capacity),
  };
}

/**
 * Application de la sélection à l’échéance (BILL-012, BILL-014) : les Displays actifs non
 * retenus passent `inactive`, sans suppression ni perte de programmation (BILL-013) ; leur
 * diffusion s’arrête par recompilation. Sans sélection valide, aucun Display n’est choisi
 * au hasard : rien n’est désactivé, le dépassement reste signalé et bloque les activations.
 */
async function applySelection(
  tx: Transaction,
  change: ChangeRow,
  capacity: number,
  now: Date,
): Promise<DisplaySelectionStatus | null> {
  const check = await checkSelection(tx, change.organizationId, capacity, change.keepDisplayIds);
  if (check.fits) return change.keepDisplayIds ? 'applied' : null;
  if (!check.valid || !check.kept) {
    await tx.insert(schema.auditLogs).values({
      organizationId: change.organizationId,
      actorType: 'system',
      action: 'billing.display_selection.invalid',
      targetType: 'billing_change',
      targetId: change.id,
      result: 'failed',
      metadata: {
        capacity,
        active_displays: check.active.length,
        kept_display_ids: check.kept ?? [],
      },
    });
    return 'invalid';
  }
  const deactivated = await tx
    .update(schema.displays)
    .set({ lifecycleStatus: 'inactive', updatedAt: now })
    .where(
      and(
        eq(schema.displays.organizationId, change.organizationId),
        eq(schema.displays.lifecycleStatus, 'active'),
        isNull(schema.displays.deletedAt),
        notInArray(schema.displays.id, check.kept),
      ),
    )
    .returning({ id: schema.displays.id });
  const ids = deactivated.map((row) => row.id);
  await requestRecompile(tx, change.organizationId, ids, 'billing.capacity_reduced');
  await tx.insert(schema.auditLogs).values({
    organizationId: change.organizationId,
    actorType: 'system',
    action: 'billing.displays.deactivated',
    targetType: 'billing_change',
    targetId: change.id,
    result: 'success',
    metadata: { capacity, kept_display_ids: check.kept, deactivated_display_ids: ids },
  });
  return 'applied';
}

async function finish(
  tx: Transaction,
  change: ChangeRow,
  values: Partial<typeof schema.billingChanges.$inferInsert>,
  now: Date,
): Promise<void> {
  await tx
    .update(schema.billingChanges)
    .set({ ...values, updatedAt: now })
    .where(
      and(
        eq(schema.billingChanges.id, change.id),
        inArray(schema.billingChanges.status, [...OPEN_CHANGE_STATUSES]),
      ),
    );
  await tx.insert(schema.auditLogs).values({
    organizationId: change.organizationId,
    actorType: 'system',
    action: `billing.change.${values.status}`,
    targetType: 'billing_change',
    targetId: change.id,
    result: values.status === 'applied' ? 'success' : 'failed',
    metadata: {
      kind: change.kind,
      plan_id: change.planId,
      extra_display_slots: change.extraDisplaySlots,
      reason: values.failureReason ?? null,
      selection_status: values.selectionStatus ?? null,
    },
  });
}

/**
 * Suivi des modifications d’un abonnement d’après l’état relu chez Stripe (BILL-011,
 * BILL-012, BILL-014). Une modification n’est `applied` que lorsque Stripe porte les
 * nouvelles lignes (ou l’annulation) ; la sélection des Displays est appliquée à ce moment.
 */
export async function settleSubscriptionChanges(
  tx: Transaction,
  subscriptionRowId: string,
  subscription: GatewaySubscription,
  current: { planPriceId: string; extra: number },
  now: Date,
): Promise<void> {
  const open = await tx
    .select()
    .from(schema.billingChanges)
    .where(
      and(
        eq(schema.billingChanges.subscriptionId, subscriptionRowId),
        inArray(schema.billingChanges.status, [...OPEN_CHANGE_STATUSES]),
      ),
    );
  for (const change of open) {
    const reached =
      change.planPriceId === current.planPriceId && change.extraDisplaySlots === current.extra;
    if (change.kind === 'upgrade') {
      if (reached && !subscription.pendingUpdate) {
        await finish(tx, change, { status: 'applied', appliedAt: now }, now);
      } else if (change.status === 'pending_payment' && !subscription.pendingUpdate) {
        // Paiement non confirmé avant l’expiration de la mise à jour : droits inchangés.
        await finish(tx, change, { status: 'failed', failureReason: 'payment_not_completed' }, now);
      }
    } else if (change.kind === 'downgrade' && change.status === 'scheduled') {
      if (reached) {
        const [plan] = await tx
          .select()
          .from(schema.plans)
          .where(eq(schema.plans.id, change.planId!));
        const capacity = displayCapacity(capacitiesOf(plan!), change.extraDisplaySlots);
        const selectionStatus = await applySelection(tx, change, capacity, now);
        await finish(tx, change, { status: 'applied', appliedAt: now, selectionStatus }, now);
      } else if (subscription.scheduleId !== change.stripeScheduleId) {
        // Planification relâchée hors de pixlova : la baisse n’aura pas lieu.
        await finish(tx, change, { status: 'cancelled', failureReason: 'schedule_released' }, now);
      }
    } else if (change.kind === 'cancel' && change.status === 'scheduled') {
      if (subscription.status === 'canceled' || subscription.endedAt) {
        const fallback = await fallbackPlan(tx);
        const selectionStatus = await applySelection(tx, change, displayCapacity(fallback, 0), now);
        await finish(tx, change, { status: 'applied', appliedAt: now, selectionStatus }, now);
      } else if (!subscription.cancelAtPeriodEnd) {
        await finish(tx, change, { status: 'cancelled', failureReason: 'resumed' }, now);
      }
    }
  }
}
