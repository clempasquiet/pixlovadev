import type { BillingEnvironment } from '@pixlova/contracts';
import type { StripeSubscriptionStatus } from './entitlements.js';

/**
 * Accès à Stripe (ADR-017), réduit aux opérations dont pixlova a besoin et aux champs
 * qu’il projette. L’implémentation réelle (`StripeGateway`) fige la version d’API ; les
 * tests utilisent `FakeStripeGateway` (`@pixlova/billing/testing`).
 */
export interface BillingGateway {
  readonly environment: BillingEnvironment;
  createCustomer(
    input: { organizationId: string; name: string; email: string | null },
    idempotencyKey: string,
  ): Promise<{ id: string }>;
  createCheckoutSession(
    input: CheckoutSessionInput,
    idempotencyKey: string,
  ): Promise<CheckoutSession>;
  retrieveCheckoutSession(id: string): Promise<CheckoutSession>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Abonnements du client, tous statuts, avec réductions développées. */
  listSubscriptions(customerId: string): Promise<GatewaySubscription[]>;
  /**
   * Montant facturé immédiatement par une hausse (BILL-011) : prorata calculé par Stripe à
   * la date `prorationDate`, réutilisée par `upgradeSubscription`.
   */
  previewUpgrade(input: SubscriptionItemsChange): Promise<UpgradePreview>;
  /**
   * Hausse immédiate facturée au prorata (`always_invoice`). Avec `pending_if_incomplete`,
   * Stripe n’applique les nouvelles lignes qu’une fois le paiement confirmé.
   */
  upgradeSubscription(
    input: SubscriptionItemsChange,
    idempotencyKey: string,
  ): Promise<GatewaySubscription>;
  /**
   * Baisse à l’échéance (BILL-012) : planification Stripe dont la phase suivante porte les
   * nouvelles lignes, sans prorata ; la planification est relâchée ensuite.
   */
  scheduleDowngrade(
    input: { subscriptionId: string; items: DesiredItem[]; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<{ scheduleId: string; effectiveAt: Date }>;
  /** Abandon d’une baisse planifiée : l’abonnement garde ses lignes actuelles. */
  releaseSchedule(scheduleId: string): Promise<void>;
  /** Annulation à l’échéance (BILL-014) ou reprise avant l’échéance. */
  setCancelAtPeriodEnd(
    subscriptionId: string,
    cancel: boolean,
    idempotencyKey: string,
  ): Promise<GatewaySubscription>;
  /**
   * Vérifie la signature sur le corps brut (BILL-010) et renvoie l’événement ; lève
   * `WebhookSignatureError` sinon.
   */
  verifyWebhook(rawBody: Buffer, signature: string): GatewayEvent;
}

export interface CheckoutSessionInput {
  customerId: string;
  lineItems: { price: string; quantity: number }[];
  /** Identifiant de la demande locale (`billing_changes.id`). */
  clientReferenceId: string;
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  /** BILL-017 : saisie des codes promotionnels par Stripe Checkout. */
  allowPromotionCodes: boolean;
}

/** Ligne souhaitée d’un abonnement ; une quantité nulle retire la ligne. */
export interface DesiredItem {
  price: string;
  quantity: number;
}

export interface SubscriptionItemsChange {
  customerId: string;
  subscriptionId: string;
  items: DesiredItem[];
  prorationDate: Date;
}

export interface UpgradePreview {
  /** Montant dû immédiatement (prorata, réductions et taxes configurées comprises). */
  amountDueMinor: number;
  currency: string;
  prorationDate: Date;
}

export interface CheckoutSession {
  id: string;
  url: string | null;
  status: 'open' | 'complete' | 'expired';
  paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
  customerId: string | null;
  subscriptionId: string | null;
  expiresAt: Date;
}

export interface GatewayDiscount {
  id: string;
  couponId: string | null;
  promotionCodeId: string | null;
  code: string | null;
  percentOff: number | null;
  amountOffMinor: number | null;
  currency: string | null;
  duration: string | null;
  durationInMonths: number | null;
  start: Date;
  end: Date | null;
}

export interface GatewaySubscription {
  id: string;
  customerId: string;
  status: StripeSubscriptionStatus;
  created: Date;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  endedAt: Date | null;
  metadata: Record<string, string>;
  items: { id: string; priceId: string; quantity: number }[];
  discounts: GatewayDiscount[];
  /** Planification Stripe attachée (baisse à l’échéance). */
  scheduleId: string | null;
  /** Hausse en attente de paiement : les lignes ci-dessus restent celles en vigueur. */
  pendingUpdate: boolean;
}

/**
 * Lignes Stripe à transmettre pour passer de `current` à `desired` : mise à jour de la
 * quantité d’un prix conservé, ajout d’un nouveau prix, suppression des autres lignes.
 */
export function itemsDiff(
  current: GatewaySubscription['items'],
  desired: readonly DesiredItem[],
): (
  | { id: string; quantity: number }
  | { price: string; quantity: number }
  | { id: string; deleted: true }
)[] {
  const wanted = desired.filter((item) => item.quantity > 0);
  const result: (
    | { id: string; quantity: number }
    | { price: string; quantity: number }
    | { id: string; deleted: true }
  )[] = [];
  for (const item of wanted) {
    const existing = current.find((line) => line.priceId === item.price);
    result.push(existing ? { id: existing.id, quantity: item.quantity } : { ...item });
  }
  for (const line of current) {
    if (!wanted.some((item) => item.price === line.priceId)) {
      result.push({ id: line.id, deleted: true });
    }
  }
  return result;
}

export interface GatewayEvent {
  id: string;
  type: string;
  created: Date;
  livemode: boolean;
  apiVersion: string | null;
  /** Objet principal de l’événement (`data.object`), non typé. */
  object: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export class WebhookSignatureError extends Error {
  override readonly name = 'WebhookSignatureError';
}

/** Identifiant du client Stripe porté par l’objet d’un événement, s’il existe. */
export function eventCustomerId(event: GatewayEvent): string | null {
  const object = event.object;
  if (object.object === 'customer' && typeof object.id === 'string') return object.id;
  const customer = object.customer;
  if (typeof customer === 'string') return customer;
  if (
    customer &&
    typeof customer === 'object' &&
    typeof (customer as { id?: unknown }).id === 'string'
  ) {
    return (customer as { id: string }).id;
  }
  return null;
}
