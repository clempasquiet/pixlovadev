import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Type from 'typebox';
import {
  LIVE_STATUSES,
  organizationBilling,
  organizationUsage,
  publishedCatalog,
  purchasablePrice,
  reconcileOpenChanges,
  recordStripeEvent,
  syncCustomer,
  WebhookSignatureError,
  type BillingGateway,
  type BillingSyncContext,
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
import { subscriptionChangeRoutes } from './billing-changes.js';
import { Strict, Uuid } from './schemas.js';

type ChangeRow = typeof schema.billingChanges.$inferSelect;

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_.:-]{8,128}$/;
const OPEN_STATUSES = ['requested', 'pending_payment'] as const;
/** Demandes affichées comme en cours, y compris les baisses et annulations planifiées. */
const VISIBLE_STATUSES = ['requested', 'pending_payment', 'scheduled'] as const;
/** Demande sans session Checkout (appel Stripe échoué, non rejoué) considérée abandonnée. */
export const ABANDONED_REQUEST_MS = 2 * 60_000;

export function requireGateway(services: Services): BillingGateway {
  const gateway = services.billing.gateway;
  if (!gateway) {
    throw new ApiError(
      503,
      'BILLING_UNAVAILABLE',
      'La souscription en ligne n’est pas disponible sur cette instance.',
    );
  }
  return gateway;
}

export function syncContext(services: Services, gateway: BillingGateway): BillingSyncContext {
  return {
    db: services.system,
    gateway,
    graceDays: services.billing.graceDays,
    now: services.now,
  };
}

export function providerError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  // Aucun détail Stripe transmis au client ; l’erreur reste dans les logs du processus.
  throw new ApiError(
    502,
    'BILLING_PROVIDER_UNAVAILABLE',
    'Le prestataire de paiement est momentanément indisponible. Réessayez.',
    true,
  );
}

export function publicChange(change: ChangeRow) {
  return {
    id: change.id,
    kind: change.kind,
    status: change.status,
    plan_id: change.planId,
    extra_display_slots: change.extraDisplaySlots,
    effective_at: change.effectiveAt?.toISOString() ?? null,
    keep_display_ids: change.keepDisplayIds ?? null,
    selection_status: change.selectionStatus,
    // L’URL de paiement n’est utile que tant que la session est ouverte.
    checkout_url: change.status === 'pending_payment' ? change.checkoutUrl : null,
    checkout_expires_at: change.checkoutExpiresAt?.toISOString() ?? null,
    failure_reason: change.failureReason,
    applied_at: change.appliedAt?.toISOString() ?? null,
    created_at: change.createdAt.toISOString(),
  };
}

export async function lockOrganization(tx: Transaction, organizationId: string): Promise<void> {
  await tx
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, organizationId))
    .for('update');
}

/** Client Stripe canonique de l’organisation (BILL-006), créé une seule fois. */
export async function ensureCustomer(
  services: Services,
  gateway: BillingGateway,
  organizationId: string,
): Promise<string> {
  const find = (tx: Transaction) =>
    tx
      .select({ id: schema.billingCustomers.stripeCustomerId })
      .from(schema.billingCustomers)
      .where(eq(schema.billingCustomers.environment, gateway.environment));
  const [known] = await withTenant(services.db, organizationId, find);
  if (known) return known.id;
  const [organization] = await withTenant(services.db, organizationId, (tx) =>
    tx
      .select({ name: schema.organizations.name })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, organizationId)),
  );
  // Même clé d’idempotence pour toute tentative : un seul client Stripe par organisation.
  const created = await gateway.createCustomer(
    { organizationId, name: organization?.name ?? organizationId, email: null },
    `pixlova:customer:${gateway.environment}:${organizationId}`,
  );
  return withTenant(services.db, organizationId, async (tx) => {
    await tx
      .insert(schema.billingCustomers)
      .values({ organizationId, environment: gateway.environment, stripeCustomerId: created.id })
      .onConflictDoNothing();
    const [row] = await find(tx);
    return row!.id;
  });
}

export function idempotencyKey(request: FastifyRequest): string {
  const header = request.headers['idempotency-key'];
  const key = typeof header === 'string' ? header : '';
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'En-tête Idempotency-Key requis (8 à 128 caractères).',
    );
  }
  return key;
}

async function subscriptionView(services: Services, member: MemberContext) {
  const environment = services.billing.environment;
  const now = services.now();
  return withTenant(services.db, member.organizationId, async (tx) => {
    const billing = await organizationBilling(tx, member.organizationId, environment, now);
    const usage = await organizationUsage(tx, member.organizationId, now);
    const [customer] = await tx
      .select()
      .from(schema.billingCustomers)
      .where(eq(schema.billingCustomers.environment, environment));
    const changes = await tx
      .select()
      .from(schema.billingChanges)
      .where(
        and(
          eq(schema.billingChanges.environment, environment),
          inArray(schema.billingChanges.status, [...VISIBLE_STATUSES]),
        ),
      )
      .orderBy(desc(schema.billingChanges.createdAt));
    const [price] = billing.subscription
      ? await tx
          .select()
          .from(schema.planPrices)
          .where(eq(schema.planPrices.id, billing.subscription.planPriceId))
      : [];
    const { effective, subscription } = billing;
    const plan = (p: typeof effective.plan) => ({ key: p.key, version: p.version, name: p.name });
    return {
      environment,
      state: effective.state,
      plan: plan(effective.plan),
      subscribed_plan: effective.subscribedPlan ? plan(effective.subscribedPlan) : null,
      subscription: subscription
        ? {
            status: subscription.stripeStatus,
            interval: price?.interval ?? null,
            currency: price?.currency ?? null,
            base_amount_minor: price?.baseAmountMinor ?? null,
            extra_slot_amount_minor: price?.extraSlotAmountMinor ?? null,
            extra_display_slots: subscription.extraDisplaySlots,
            current_period_end: subscription.currentPeriodEnd?.toISOString() ?? null,
            cancel_at_period_end: subscription.cancelAtPeriodEnd,
            pending_update: subscription.pendingUpdate,
            grace_until: subscription.graceUntil?.toISOString() ?? null,
          }
        : null,
      // BILL-004 : inclus, extras, utilisés et disponibles. Un dépassement (après downgrade
      // ou impayé) conserve tout ; seules les nouvelles activations sont bloquées.
      display_slots: {
        included: effective.displaySlots.included,
        extra: effective.displaySlots.extra,
        total: effective.displaySlots.total,
        active: usage.activeDisplays,
        available: Math.max(0, effective.displaySlots.total - usage.activeDisplays),
        over_capacity: usage.activeDisplays > effective.displaySlots.total,
      },
      users: { allowed: effective.maxUsers, used: usage.users },
      storage: { allowed_bytes: effective.storageBytes, used_bytes: usage.storageBytes },
      features: [...effective.features],
      // BILL-009 : un retard de synchronisation est visible ; le détail reste côté serveur.
      sync: customer
        ? {
            status: customer.syncStatus,
            last_synced_at: customer.lastSyncedAt?.toISOString() ?? null,
          }
        : null,
      open_changes: changes.map(publicChange),
      purchase_available: services.billing.gateway !== null,
    };
  });
}

export function billingRoutes(app: FastifyInstance, services: Services): void {
  /**
   * Catalogue publié (API §17.2) : public, sans session ni identifiant Stripe ; consommé
   * par le dashboard et le site commercial. Mis en cache quelques minutes.
   */
  app.get('/billing/catalog', async (_request, reply) => {
    const catalog = await services.db.transaction((tx) =>
      publishedCatalog(tx, services.billing.environment, services.now()),
    );
    reply.header('cache-control', 'public, max-age=300');
    reply.header('access-control-allow-origin', '*');
    return catalog;
  });

  subscriptionChangeRoutes(app, services);

  app.get('/billing/subscription', async (request) => {
    const member = await requireMember(request, services);
    authorize(member, 'billing.read');
    return subscriptionView(services, member);
  });

  /**
   * Souscription par Stripe Checkout (BILL-006, BILL-007, BILL-008, API-005). L’intention
   * est enregistrée avant tout appel Stripe, sous une clé durable ; prix et quantités
   * viennent du catalogue serveur. Aucun droit n’est accordé ici : la projection relue
   * chez Stripe (webhook ou réconciliation) fait passer la demande à `applied`.
   */
  app.post(
    '/billing/checkout-session',
    {
      schema: {
        body: Type.Object(
          {
            plan_key: Type.String({ pattern: '^[a-z][a-z0-9_-]{1,39}$' }),
            interval: Type.Union([Type.Literal('month'), Type.Literal('year')]),
            extra_display_slots: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
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
      const body = request.body as {
        plan_key: string;
        interval: 'month' | 'year';
        extra_display_slots?: number;
      };
      const extra = body.extra_display_slots ?? 0;
      const requestHash = createHash('sha256').update(canonicalJson(body)).digest('hex');
      await rateLimit(services, `checkout:${member.organizationId}`, 20, 3600);
      const now = services.now();
      const organizationId = member.organizationId;

      const change = await withTenant(services.db, organizationId, async (tx) => {
        // Sérialise les demandes de l’organisation (double clic, deux onglets).
        await lockOrganization(tx, organizationId);
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
        const billing = await organizationBilling(tx, organizationId, gateway.environment, now);
        const current = billing.subscription;
        if (current && LIVE_STATUSES.has(current.stripeStatus)) {
          if (current.stripeStatus === 'incomplete') {
            throw new ApiError(409, 'BILLING_PENDING', 'Un paiement est déjà en attente.', true);
          }
          throw new ApiError(
            409,
            'SUBSCRIPTION_EXISTS',
            'Un abonnement est déjà en cours ; utilisez la gestion de l’abonnement.',
          );
        }
        const [open] = await tx
          .select()
          .from(schema.billingChanges)
          .where(
            and(
              eq(schema.billingChanges.environment, gateway.environment),
              eq(schema.billingChanges.kind, 'subscribe'),
              inArray(schema.billingChanges.status, [...OPEN_STATUSES]),
            ),
          );
        if (open) {
          // Session Checkout échue (Stripe n’accepte plus de paiement), ou demande dont la
          // création de session a échoué sans être rejouée : la place se libère.
          const expired =
            (open.checkoutExpiresAt && open.checkoutExpiresAt <= now) ||
            (open.status === 'requested' &&
              now.getTime() - open.createdAt.getTime() > ABANDONED_REQUEST_MS);
          if (!expired) {
            throw new ApiError(
              409,
              'BILLING_PENDING',
              'Une souscription est déjà en cours pour cette organisation.',
              true,
              { change_id: open.id },
            );
          }
          await tx
            .update(schema.billingChanges)
            .set(
              open.status === 'requested'
                ? { status: 'failed', failureReason: 'checkout_not_created', updatedAt: now }
                : { status: 'expired', checkoutUrl: null, updatedAt: now },
            )
            .where(eq(schema.billingChanges.id, open.id));
        }
        const offer = await purchasablePrice(tx, {
          planKey: body.plan_key,
          interval: body.interval,
          environment: gateway.environment,
        });
        if (!offer) {
          throw new ApiError(422, 'VALIDATION_ERROR', 'Offre ou périodicité indisponible.', false, {
            field: 'plan_key',
          });
        }
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
        const [created] = await tx
          .insert(schema.billingChanges)
          .values({
            organizationId,
            environment: gateway.environment,
            kind: 'subscribe',
            requestedBy: member.auth.user.id,
            idempotencyKey: key,
            requestHash,
            planId: offer.plan.id,
            planPriceId: offer.price.id,
            extraDisplaySlots: extra,
          })
          .returning();
        await audit(tx, {
          organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'billing.checkout.requested',
          permission: 'billing.manage',
          targetType: 'billing_change',
          targetId: created!.id,
          result: 'success',
          metadata: {
            plan_key: offer.plan.key,
            plan_version: offer.plan.version,
            interval: body.interval,
            extra_display_slots: extra,
          },
          ...requestMeta(request),
        });
        return created!;
      });

      if (change.status !== 'requested') {
        // Rejeu : même réponse tant que la demande existe ; aucun nouvel appel Stripe.
        return reply.code(200).send(publicChange(change));
      }
      // Appels Stripe hors transaction (DATA-007), rejouables sous la même clé.
      try {
        const customerId = await ensureCustomer(services, gateway, organizationId);
        const [price] = await withTenant(services.db, organizationId, (tx) =>
          tx.select().from(schema.planPrices).where(eq(schema.planPrices.id, change.planPriceId!)),
        );
        const lineItems = [{ price: price!.baseStripePriceId!, quantity: 1 }];
        if (change.extraDisplaySlots > 0) {
          lineItems.push({
            price: price!.extraSlotStripePriceId!,
            quantity: change.extraDisplaySlots,
          });
        }
        const base = services.security.appBaseUrl.replace(/\/$/, '');
        const session = await gateway.createCheckoutSession(
          {
            customerId,
            lineItems,
            clientReferenceId: change.id,
            metadata: { organization_id: organizationId, billing_change_id: change.id },
            successUrl: `${base}/billing?change=${change.id}`,
            cancelUrl: `${base}/billing?change=${change.id}&cancelled=1`,
            expiresAt: new Date(now.getTime() + services.billing.checkoutMinutes * 60_000),
            allowPromotionCodes: true,
          },
          `pixlova:checkout:${change.id}`,
        );
        const updated = await withTenant(services.db, organizationId, async (tx) => {
          const [row] = await tx
            .update(schema.billingChanges)
            .set({
              status: 'pending_payment',
              stripeCheckoutSessionId: session.id,
              checkoutUrl: session.url,
              checkoutExpiresAt: session.expiresAt,
              updatedAt: services.now(),
            })
            .where(
              and(
                eq(schema.billingChanges.id, change.id),
                eq(schema.billingChanges.status, 'requested'),
              ),
            )
            .returning();
          if (row) return row;
          const [current] = await tx
            .select()
            .from(schema.billingChanges)
            .where(eq(schema.billingChanges.id, change.id));
          return current!;
        });
        return reply.code(201).send(publicChange(updated));
      } catch (error) {
        request.log.error({ err: error, change_id: change.id }, 'création Checkout en échec');
        return providerError(error);
      }
    },
  );

  /**
   * Suivi d’une demande (BILL-008) : au retour de Checkout, le serveur relit Stripe avant
   * d’annoncer un résultat ; le retour navigateur seul ne prouve rien.
   */
  app.get(
    '/billing/changes/:id',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      const member = await requireMember(request, services);
      authorize(member, 'billing.read');
      const { id } = request.params as { id: string };
      const read = () =>
        withTenant(services.db, member.organizationId, async (tx) => {
          const [row] = await tx
            .select()
            .from(schema.billingChanges)
            .where(eq(schema.billingChanges.id, id));
          if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Demande introuvable.');
          return row;
        });
      let change = await read();
      const gateway = services.billing.gateway;
      if (
        gateway &&
        change.stripeCheckoutSessionId &&
        (OPEN_STATUSES as readonly string[]).includes(change.status)
      ) {
        await rateLimit(services, `billing-reconcile:${change.id}`, 30, 60);
        try {
          const ctx = syncContext(services, gateway);
          const session = await gateway.retrieveCheckoutSession(change.stripeCheckoutSessionId);
          if (session.customerId) await syncCustomer(ctx, session.customerId);
          await reconcileOpenChanges(ctx, member.organizationId);
        } catch (error) {
          // Stripe indisponible : la demande reste affichée en attente (BILL-008).
          request.log.warn({ err: error, change_id: change.id }, 'relecture Stripe impossible');
        }
        change = await read();
      }
      return publicChange(change);
    },
  );

  /** Portail Stripe (BILL-007) : factures, moyens de paiement, annulation selon configuration. */
  app.post('/billing/portal-session', async (request) => {
    const member = await requireMember(request, services);
    authorize(member, 'billing.manage');
    requireAdminMfa(member, services);
    const gateway = requireGateway(services);
    await rateLimit(services, `portal:${member.organizationId}`, 30, 3600);
    const [customer] = await withTenant(services.db, member.organizationId, (tx) =>
      tx
        .select()
        .from(schema.billingCustomers)
        .where(eq(schema.billingCustomers.environment, gateway.environment)),
    );
    if (!customer) {
      throw new ApiError(
        409,
        'NO_BILLING_ACCOUNT',
        'Aucun compte de facturation pour cette organisation.',
      );
    }
    try {
      const base = services.security.appBaseUrl.replace(/\/$/, '');
      const session = await gateway.createPortalSession({
        customerId: customer.stripeCustomerId,
        returnUrl: `${base}/billing`,
      });
      await withTenant(services.db, member.organizationId, (tx) =>
        audit(tx, {
          organizationId: member.organizationId,
          actorType: 'user',
          actorId: member.auth.user.id,
          action: 'billing.portal.opened',
          permission: 'billing.manage',
          targetType: 'billing_customer',
          targetId: customer.id,
          result: 'success',
          ...requestMeta(request),
        }),
      );
      return { url: session.url };
    } catch (error) {
      request.log.error({ err: error }, 'création de session Portal en échec');
      return providerError(error);
    }
  });
}

/**
 * Webhooks Stripe (BILL-010, API §17.2) : endpoint technique public, sans session ni
 * CSRF, authentifié par la signature calculée sur le corps brut. L’événement est stocké
 * puis traité par le worker ; la réponse ne dépend pas de ce traitement.
 */
export async function stripeWebhookRoutes(app: FastifyInstance, services: Services): Promise<void> {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    ['application/json', 'application/json; charset=utf-8'],
    { parseAs: 'buffer', bodyLimit: 512 * 1024 },
    (_request, body, done) => done(null, body),
  );
  app.post('/stripe', async (request: FastifyRequest, reply: FastifyReply) => {
    const gateway = services.billing.gateway;
    if (!gateway) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Ressource introuvable.');
    const signature = request.headers['stripe-signature'];
    if (typeof signature !== 'string' || !Buffer.isBuffer(request.body)) {
      throw new ApiError(400, 'WEBHOOK_SIGNATURE_INVALID', 'Signature absente ou invalide.');
    }
    let event;
    try {
      event = gateway.verifyWebhook(request.body, signature);
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        throw new ApiError(400, 'WEBHOOK_SIGNATURE_INVALID', 'Signature absente ou invalide.');
      }
      throw error;
    }
    const received = await recordStripeEvent(services.system, gateway, event, services.now());
    request.log.info(
      { stripe_event_id: received.eventId, type: received.type, duplicate: received.duplicate },
      'événement Stripe reçu',
    );
    return reply.code(200).send({ received: true });
  });
}
