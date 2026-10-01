/**
 * Outils de test (entrée `@pixlova/billing/testing`, jamais importée en production) :
 * passerelle Stripe simulée en mémoire, avec vraie vérification de signature des webhooks
 * (algorithme du SDK Stripe) pour exercer le même code que la production.
 */
import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import type { BillingEnvironment } from '@pixlova/contracts';
import type { StripeSubscriptionStatus } from './entitlements.js';
import {
  WebhookSignatureError,
  type BillingGateway,
  type CheckoutSession,
  type CheckoutSessionInput,
  type DesiredItem,
  type GatewayDiscount,
  type GatewayEvent,
  type GatewaySubscription,
  type SubscriptionItemsChange,
  type UpgradePreview,
} from './gateway.js';
import { gatewayEventOf } from './stripe-gateway.js';

const id = (prefix: string) =>
  `${prefix}_${randomBytes(9).toString('base64url').replace(/[-_]/g, 'x')}`;

export class StripeOutageError extends Error {
  override readonly name = 'StripeOutageError';
}

interface StoredSession extends CheckoutSession {
  input: CheckoutSessionInput;
}

export class FakeStripeGateway implements BillingGateway {
  readonly environment: BillingEnvironment;
  readonly webhookSecret = `whsec_${randomBytes(24).toString('hex')}`;
  readonly customers = new Map<string, { id: string; organizationId: string; name: string }>();
  readonly sessions = new Map<string, StoredSession>();
  readonly subscriptions = new Map<string, GatewaySubscription>();
  /** Planifications de baisse : lignes appliquées à l’échéance. */
  readonly schedules = new Map<
    string,
    { subscriptionId: string; items: DesiredItem[]; metadata: Record<string, string> }
  >();
  /** Montant unitaire mensuel des prix connus, pour le calcul du prorata simulé. */
  readonly unitAmounts = new Map<string, number>();
  /** Nombre d’appels par opération (contrôle des doublons). */
  readonly calls = {
    createCustomer: 0,
    createCheckoutSession: 0,
    listSubscriptions: 0,
    upgradeSubscription: 0,
    scheduleDowngrade: 0,
  };
  /** Simule une indisponibilité de Stripe pour les `n` prochains appels. */
  outages = 0;
  /** Simule le refus du prochain paiement d’une hausse (SCA, carte refusée). */
  declineNextPayment = false;
  private readonly idempotency = new Map<string, unknown>();

  constructor(
    private readonly clock: () => Date = () => new Date(),
    environment: BillingEnvironment = 'test',
  ) {
    this.environment = environment;
  }

  private guard(): void {
    if (this.outages > 0) {
      this.outages -= 1;
      throw new StripeOutageError('Stripe indisponible (simulation).');
    }
  }

  private once<T>(key: string, create: () => T): T {
    if (this.idempotency.has(key)) return this.idempotency.get(key) as T;
    const value = create();
    this.idempotency.set(key, value);
    return value;
  }

  async createCustomer(
    input: { organizationId: string; name: string; email: string | null },
    idempotencyKey: string,
  ): Promise<{ id: string }> {
    this.guard();
    return this.once(`customer:${idempotencyKey}`, () => {
      this.calls.createCustomer += 1;
      const customer = { id: id('cus'), organizationId: input.organizationId, name: input.name };
      this.customers.set(customer.id, customer);
      return { id: customer.id };
    });
  }

  async createCheckoutSession(
    input: CheckoutSessionInput,
    idempotencyKey: string,
  ): Promise<CheckoutSession> {
    this.guard();
    const session = this.once(`checkout:${idempotencyKey}`, () => {
      this.calls.createCheckoutSession += 1;
      const sessionId = id('cs_test');
      const stored: StoredSession = {
        id: sessionId,
        url: `https://checkout.stripe.test/c/pay/${sessionId}`,
        status: 'open',
        paymentStatus: 'unpaid',
        customerId: input.customerId,
        subscriptionId: null,
        expiresAt: input.expiresAt,
        input,
      };
      this.sessions.set(sessionId, stored);
      return stored;
    });
    return this.publicSession(session);
  }

  private publicSession(session: StoredSession): CheckoutSession {
    const { input: _input, ...rest } = session;
    void _input;
    return { ...rest };
  }

  async retrieveCheckoutSession(sessionId: string): Promise<CheckoutSession> {
    this.guard();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session inconnue : ${sessionId}`);
    return this.publicSession(session);
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }) {
    this.guard();
    return { url: `https://billing.stripe.test/p/session/${input.customerId}` };
  }

  async listSubscriptions(customerId: string): Promise<GatewaySubscription[]> {
    this.guard();
    this.calls.listSubscriptions += 1;
    return [...this.subscriptions.values()]
      .filter((subscription) => subscription.customerId === customerId)
      .map((subscription) => structuredClone(subscription));
  }

  private recurring(items: readonly { priceId?: string; price?: string; quantity: number }[]) {
    return items.reduce(
      (sum, item) => sum + (this.unitAmounts.get(item.priceId ?? item.price!) ?? 0) * item.quantity,
      0,
    );
  }

  private stored(subscriptionId: string): GatewaySubscription {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) throw new Error(`Abonnement inconnu : ${subscriptionId}`);
    return subscription;
  }

  async previewUpgrade(input: SubscriptionItemsChange): Promise<UpgradePreview> {
    this.guard();
    const subscription = this.stored(input.subscriptionId);
    const start = subscription.currentPeriodStart!.getTime();
    const end = subscription.currentPeriodEnd!.getTime();
    const remaining = Math.max(0, end - input.prorationDate.getTime()) / (end - start);
    const delta = this.recurring(input.items) - this.recurring(subscription.items);
    return {
      amountDueMinor: Math.max(0, Math.round(delta * remaining)),
      currency: 'eur',
      prorationDate: input.prorationDate,
    };
  }

  async upgradeSubscription(
    input: SubscriptionItemsChange,
    idempotencyKey: string,
  ): Promise<GatewaySubscription> {
    this.guard();
    return structuredClone(
      this.once(`upgrade:${idempotencyKey}`, () => {
        this.calls.upgradeSubscription += 1;
        const subscription = this.stored(input.subscriptionId);
        if (this.declineNextPayment) {
          this.declineNextPayment = false;
          subscription.pendingUpdate = true;
          return structuredClone(subscription);
        }
        subscription.items = this.applyItems(subscription.items, input.items);
        subscription.pendingUpdate = false;
        return structuredClone(subscription);
      }),
    );
  }

  private applyItems(current: GatewaySubscription['items'], desired: readonly DesiredItem[]) {
    return desired
      .filter((item) => item.quantity > 0)
      .map((item) => ({
        id: current.find((line) => line.priceId === item.price)?.id ?? id('si'),
        priceId: item.price,
        quantity: item.quantity,
      }));
  }

  async scheduleDowngrade(
    input: { subscriptionId: string; items: DesiredItem[]; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<{ scheduleId: string; effectiveAt: Date }> {
    this.guard();
    return this.once(`schedule:${idempotencyKey}`, () => {
      this.calls.scheduleDowngrade += 1;
      const subscription = this.stored(input.subscriptionId);
      const scheduleId = subscription.scheduleId ?? id('sub_sched');
      this.schedules.set(scheduleId, {
        subscriptionId: subscription.id,
        items: input.items,
        metadata: { ...input.metadata },
      });
      subscription.scheduleId = scheduleId;
      return { scheduleId, effectiveAt: subscription.currentPeriodEnd! };
    });
  }

  async releaseSchedule(scheduleId: string): Promise<void> {
    this.guard();
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return;
    this.schedules.delete(scheduleId);
    const subscription = this.subscriptions.get(schedule.subscriptionId);
    if (subscription?.scheduleId === scheduleId) subscription.scheduleId = null;
  }

  async setCancelAtPeriodEnd(
    subscriptionId: string,
    cancel: boolean,
    idempotencyKey: string,
  ): Promise<GatewaySubscription> {
    this.guard();
    void idempotencyKey;
    const subscription = this.stored(subscriptionId);
    if (subscription.scheduleId) {
      throw new Error('Abonnement géré par une planification : annulation refusée.');
    }
    subscription.cancelAtPeriodEnd = cancel;
    subscription.canceledAt = cancel ? this.clock() : null;
    return structuredClone(subscription);
  }

  /**
   * Fin de période côté Stripe : annulation effective, ou renouvellement avec application de
   * la baisse planifiée (planification relâchée).
   */
  advancePeriod(subscriptionId: string): GatewaySubscription {
    const subscription = this.stored(subscriptionId);
    const end = subscription.currentPeriodEnd!;
    if (subscription.cancelAtPeriodEnd) {
      subscription.status = 'canceled';
      subscription.endedAt = end;
      return structuredClone(subscription);
    }
    const schedule = subscription.scheduleId ? this.schedules.get(subscription.scheduleId) : null;
    if (schedule) {
      subscription.items = this.applyItems(subscription.items, schedule.items);
      this.schedules.delete(subscription.scheduleId!);
      subscription.scheduleId = null;
    }
    subscription.currentPeriodStart = end;
    subscription.currentPeriodEnd = new Date(end.getTime() + 30 * 24 * 60 * 60 * 1000);
    return structuredClone(subscription);
  }

  verifyWebhook(rawBody: Buffer, signature: string): GatewayEvent {
    try {
      const event = Stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
      return gatewayEventOf(event as unknown as Record<string, unknown>);
    } catch {
      throw new WebhookSignatureError('Signature Stripe invalide.');
    }
  }

  // --- Simulation côté Stripe ----------------------------------------------------

  /**
   * Paiement d’une session Checkout : crée l’abonnement avec les lignes et métadonnées de
   * la session (comme `subscription_data.metadata`).
   */
  completeCheckout(
    sessionId: string,
    options: { status?: StripeSubscriptionStatus; discounts?: Partial<GatewayDiscount>[] } = {},
  ): GatewaySubscription {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session inconnue : ${sessionId}`);
    const now = this.clock();
    const subscription: GatewaySubscription = {
      id: id('sub'),
      customerId: session.input.customerId,
      status: options.status ?? 'active',
      created: now,
      currentPeriodStart: now,
      currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      endedAt: null,
      metadata: { ...session.input.metadata },
      items: session.input.lineItems.map((item) => ({
        id: id('si'),
        priceId: item.price,
        quantity: item.quantity,
      })),
      discounts: (options.discounts ?? []).map((discount) => ({
        id: id('di'),
        couponId: id('coupon'),
        promotionCodeId: id('promo'),
        code: 'BIENVENUE',
        percentOff: 20,
        amountOffMinor: null,
        currency: null,
        duration: 'once',
        durationInMonths: null,
        start: now,
        end: null,
        ...discount,
      })),
      scheduleId: null,
      pendingUpdate: false,
    };
    this.subscriptions.set(subscription.id, subscription);
    session.status = 'complete';
    session.paymentStatus = subscription.status === 'active' ? 'paid' : 'unpaid';
    session.subscriptionId = subscription.id;
    return structuredClone(subscription);
  }

  expireCheckout(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session inconnue : ${sessionId}`);
    session.status = 'expired';
    session.url = null;
  }

  /** Modification côté Stripe (portail, relance, impayé…). */
  updateSubscription(
    subscriptionId: string,
    patch: Partial<Omit<GatewaySubscription, 'id' | 'customerId'>>,
  ): GatewaySubscription {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) throw new Error(`Abonnement inconnu : ${subscriptionId}`);
    Object.assign(subscription, patch);
    return structuredClone(subscription);
  }

  /** Événement signé comme par Stripe : corps brut et en-tête `Stripe-Signature`. */
  signedEvent(
    type: string,
    object: Record<string, unknown>,
    options: { id?: string; livemode?: boolean; created?: Date } = {},
  ): { id: string; body: string; signature: string } {
    const eventId = options.id ?? id('evt');
    const body = JSON.stringify({
      id: eventId,
      object: 'event',
      type,
      api_version: Stripe.API_VERSION,
      created: Math.floor((options.created ?? this.clock()).getTime() / 1000),
      livemode: options.livemode ?? this.environment === 'live',
      data: { object },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: this.webhookSecret,
    });
    return { id: eventId, body, signature };
  }

  /** Représentation minimale d’un abonnement dans un événement. */
  subscriptionObject(subscription: GatewaySubscription): Record<string, unknown> {
    return {
      id: subscription.id,
      object: 'subscription',
      customer: subscription.customerId,
      status: subscription.status,
    };
  }
}
