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
