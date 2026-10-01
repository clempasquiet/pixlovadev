import type { PlanEntitlements, PlanFeature } from '@pixlova/contracts';

/** Offre telle que lue dans le catalogue (version précise). */
export interface PlanCapacities {
  planId: string | null;
  key: string;
  version: number;
  name: string;
  includedDisplaySlots: number;
  maxExtraDisplaySlots: number;
  entitlements: PlanEntitlements;
}

/** Free = 2 Go (10⁹ octets), valeur indicative de BILL-003 à valider (ADR-009). */
export const FREE_STORAGE_BYTES = 2_000_000_000;

/**
 * Offre gratuite intégrée (BILL-003) : appliquée tant qu’aucune offre de repli n’est publiée
 * dans le catalogue. Un utilisateur, un Display actif, 2 Go, sans templates.
 */
export const BUILTIN_FALLBACK_PLAN: PlanCapacities = {
  planId: null,
  key: 'free',
  version: 0,
  name: 'Free',
  includedDisplaySlots: 1,
  maxExtraDisplaySlots: 0,
  entitlements: { max_users: 1, storage_quota_bytes: FREE_STORAGE_BYTES, features: [] },
};

export type StripeSubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused';

/**
 * État commercial présenté (BILL-015) :
 * - `free` : aucun abonnement payant en cours ;
 * - `active` : abonnement réglé (ou en essai) ;
 * - `grace` : impayé, droits payants maintenus jusqu’à `grace_until` ;
 * - `restricted` : impayé au-delà de la grâce, suspendu ou non réglé : droits de l’offre de
 *   repli pour les nouvelles opérations, aucune donnée supprimée (BILL-013) ;
 * - `pending` : premier paiement non confirmé (SCA, moyen asynchrone) : droits de repli.
 */
export type BillingState = 'free' | 'active' | 'grace' | 'restricted' | 'pending';

export interface SubscriptionSnapshot {
  stripeStatus: StripeSubscriptionStatus;
  extraDisplaySlots: number;
  graceUntil: Date | null;
}

export interface EffectiveEntitlements {
  state: BillingState;
  /** Offre dont les capacités s’appliquent (repli ou abonnement). */
  plan: PlanCapacities;
  /** Offre souscrite, même si ses droits ne s’appliquent plus (impayé). */
  subscribedPlan: PlanCapacities | null;
  displaySlots: { included: number; extra: number; total: number };
  maxUsers: number;
  storageBytes: number;
  features: readonly PlanFeature[];
}

/** Statuts conservant un abonnement « courant » (affiché, facturable) côté Stripe. */
export const LIVE_STATUSES: ReadonlySet<StripeSubscriptionStatus> = new Set([
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'paused',
  'incomplete',
]);

function stateOf(subscription: SubscriptionSnapshot, now: Date): BillingState {
  switch (subscription.stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      // Sans échéance de grâce connue, les droits acquis sont maintenus (BILL-009).
      return !subscription.graceUntil || now < subscription.graceUntil ? 'grace' : 'restricted';
    case 'unpaid':
    case 'paused':
      return 'restricted';
    case 'incomplete':
      return 'pending';
    case 'incomplete_expired':
    case 'canceled':
      return 'free';
  }
}

/**
 * Droits effectifs d’une organisation (BILL-002, BILL-005, BILL-015). Fonction pure : la
 * projection locale suffit, aucun appel Stripe n’est fait pour une action utilisateur
 * (BILL-009). Les capacités viennent de l’offre, jamais de son nom.
 */
export function effectiveEntitlements(
  fallback: PlanCapacities,
  current: { subscription: SubscriptionSnapshot; plan: PlanCapacities } | null,
  now: Date,
): EffectiveEntitlements {
  const state = current ? stateOf(current.subscription, now) : 'free';
  const paid = current && (state === 'active' || state === 'grace');
  const plan = paid ? current.plan : fallback;
  const extra = paid
    ? Math.min(current.subscription.extraDisplaySlots, current.plan.maxExtraDisplaySlots)
    : 0;
  return {
    state,
    plan,
    subscribedPlan: current && state !== 'free' ? current.plan : null,
    displaySlots: {
      included: plan.includedDisplaySlots,
      extra,
      total: plan.includedDisplaySlots + extra,
    },
    maxUsers: plan.entitlements.max_users,
    storageBytes: plan.entitlements.storage_quota_bytes,
    features: plan.entitlements.features,
  };
}

/**
 * Montant récurrent hors taxes et remises (BILL-004) : base + slots supplémentaires
 * au-delà des slots inclus. Exemple indicatif : 14 Displays en Pro = 39 + 4 × 4 = 55 €.
 */
export function recurringAmountMinor(
  price: { baseAmountMinor: number; extraSlotAmountMinor: number | null },
  extraDisplaySlots: number,
): number {
  if (extraDisplaySlots > 0 && price.extraSlotAmountMinor === null) {
    throw new Error('Cette offre ne propose pas de slot supplémentaire.');
  }
  return price.baseAmountMinor + extraDisplaySlots * (price.extraSlotAmountMinor ?? 0);
}

/** Slots supplémentaires nécessaires pour `displays` Displays actifs dans une offre. */
export function extraSlotsFor(plan: PlanCapacities, displays: number): number {
  return Math.max(0, displays - plan.includedDisplaySlots);
}
