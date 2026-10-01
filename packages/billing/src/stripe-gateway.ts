import Stripe from 'stripe';
import type { BillingEnvironment } from '@pixlova/contracts';
import type { StripeSubscriptionStatus } from './entitlements.js';
import {
  WebhookSignatureError,
  type BillingGateway,
  type CheckoutSession,
  type CheckoutSessionInput,
  type GatewayDiscount,
  type GatewayEvent,
  type GatewaySubscription,
} from './gateway.js';

/**
 * Version d’API Stripe figée (BILL-010) : celle du SDK épinglé. Une montée de version du
 * SDK change cette valeur et doit être accompagnée d’une revue de la projection et de
 * l’endpoint webhook configuré chez Stripe (même version).
 */
export const STRIPE_API_VERSION = Stripe.API_VERSION;

/** Tolérance de la signature des webhooks (valeur par défaut de Stripe : 5 min). */
const WEBHOOK_TOLERANCE_SECONDS = 300;

export interface StripeGatewayConfig {
  secretKey: string;
  webhookSecret: string;
  /** Délai d’une requête Stripe ; un appel ne bloque jamais une action utilisateur. */
  timeoutMs?: number;
}

/** Mode déduit de la clé : une clé de test ne peut jamais débiter réellement. */
export function environmentOfKey(secretKey: string): BillingEnvironment {
  if (/^(sk|rk)_test_/.test(secretKey)) return 'test';
  if (/^(sk|rk)_live_/.test(secretKey)) return 'live';
  throw new Error('Clé Stripe non reconnue (sk_test_, rk_test_, sk_live_ ou rk_live_ attendu).');
}

const toDate = (seconds: number | null | undefined): Date | null =>
  typeof seconds === 'number' ? new Date(seconds * 1000) : null;

const idOf = (value: string | { id: string } | null | undefined): string | null =>
  typeof value === 'string' ? value : (value?.id ?? null);

function discountOf(discount: string | Stripe.Discount): GatewayDiscount | null {
  if (typeof discount === 'string') return null;
  const coupon = typeof discount.source.coupon === 'object' ? discount.source.coupon : null;
  const promotion = typeof discount.promotion_code === 'object' ? discount.promotion_code : null;
  return {
    id: discount.id,
    couponId: idOf(discount.source.coupon),
    promotionCodeId: idOf(discount.promotion_code),
    code: promotion?.code ?? null,
    percentOff: coupon?.percent_off ?? null,
    amountOffMinor: coupon?.amount_off ?? null,
    currency: coupon?.currency ?? null,
    duration: coupon?.duration ?? null,
    durationInMonths: coupon?.duration_in_months ?? null,
    start: new Date(discount.start * 1000),
    end: toDate(discount.end),
  };
}

export function subscriptionOf(subscription: Stripe.Subscription): GatewaySubscription {
  const items = subscription.items.data;
  // Depuis 2025-03-31, la période courante est portée par les lignes d’abonnement.
  const starts = items.map((item) => item.current_period_start);
  const ends = items.map((item) => item.current_period_end);
  return {
    id: subscription.id,
    customerId: idOf(subscription.customer) ?? '',
    status: subscription.status as StripeSubscriptionStatus,
    created: new Date(subscription.created * 1000),
    currentPeriodStart: starts.length ? new Date(Math.min(...starts) * 1000) : null,
    currentPeriodEnd: ends.length ? new Date(Math.min(...ends) * 1000) : null,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    canceledAt: toDate(subscription.canceled_at),
    endedAt: toDate(subscription.ended_at),
    metadata: { ...subscription.metadata },
    items: items.map((item) => ({
      id: item.id,
      priceId: item.price.id,
      quantity: item.quantity ?? 0,
    })),
    discounts: subscription.discounts
      .map(discountOf)
      .filter((d): d is GatewayDiscount => d !== null),
  };
}

function checkoutOf(session: Stripe.Checkout.Session): CheckoutSession {
  return {
    id: session.id,
    url: session.url,
    status:
      session.status === 'complete'
        ? 'complete'
        : session.status === 'expired'
          ? 'expired'
          : 'open',
    paymentStatus:
      session.payment_status === 'paid'
        ? 'paid'
        : session.payment_status === 'no_payment_required'
          ? 'no_payment_required'
          : 'unpaid',
    customerId: idOf(session.customer),
    subscriptionId: idOf(session.subscription),
    expiresAt: new Date(session.expires_at * 1000),
  };
}

/** Passerelle Stripe réelle, version d’API figée, reprises réseau idempotentes. */
export class StripeGateway implements BillingGateway {
  readonly environment: BillingEnvironment;
  private readonly client: Stripe;

  constructor(private readonly config: StripeGatewayConfig) {
    this.environment = environmentOfKey(config.secretKey);
    if (!config.webhookSecret.startsWith('whsec_')) {
      throw new Error('Secret de webhook Stripe invalide (whsec_ attendu).');
    }
    this.client = new Stripe(config.secretKey, {
      apiVersion: STRIPE_API_VERSION,
      maxNetworkRetries: 2,
      timeout: config.timeoutMs ?? 10_000,
      appInfo: { name: 'pixlova' },
    });
  }

  async createCustomer(
    input: { organizationId: string; name: string; email: string | null },
    idempotencyKey: string,
  ): Promise<{ id: string }> {
    const customer = await this.client.customers.create(
      {
        name: input.name,
        ...(input.email ? { email: input.email } : {}),
        metadata: { organization_id: input.organizationId },
      },
      { idempotencyKey },
    );
    return { id: customer.id };
  }

  async createCheckoutSession(
    input: CheckoutSessionInput,
    idempotencyKey: string,
  ): Promise<CheckoutSession> {
    const session = await this.client.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: input.customerId,
        line_items: input.lineItems,
        client_reference_id: input.clientReferenceId,
        metadata: input.metadata,
        subscription_data: { metadata: input.metadata },
        allow_promotion_codes: input.allowPromotionCodes,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        expires_at: Math.floor(input.expiresAt.getTime() / 1000),
      },
      { idempotencyKey },
    );
    return checkoutOf(session);
  }

  async retrieveCheckoutSession(id: string): Promise<CheckoutSession> {
    return checkoutOf(await this.client.checkout.sessions.retrieve(id));
  }

  async createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const session = await this.client.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return { url: session.url };
  }

  async listSubscriptions(customerId: string): Promise<GatewaySubscription[]> {
    const result: GatewaySubscription[] = [];
    for await (const subscription of this.client.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 100,
      expand: ['data.discounts', 'data.discounts.source.coupon', 'data.discounts.promotion_code'],
    })) {
      result.push(subscriptionOf(subscription));
    }
    return result;
  }

  verifyWebhook(rawBody: Buffer, signature: string): GatewayEvent {
    let event: Stripe.Event;
    try {
      event = this.client.webhooks.constructEvent(
        rawBody,
        signature,
        this.config.webhookSecret,
        WEBHOOK_TOLERANCE_SECONDS,
      );
    } catch {
      throw new WebhookSignatureError('Signature Stripe invalide.');
    }
    return gatewayEventOf(event as unknown as Record<string, unknown>);
  }
}

/** Normalise un événement Stripe déjà authentifié. */
export function gatewayEventOf(raw: Record<string, unknown>): GatewayEvent {
  const data = raw.data as { object?: Record<string, unknown> } | undefined;
  return {
    id: String(raw.id),
    type: String(raw.type),
    created: new Date(Number(raw.created) * 1000),
    livemode: raw.livemode === true,
    apiVersion: typeof raw.api_version === 'string' ? raw.api_version : null,
    object: data?.object ?? {},
    raw,
  };
}
