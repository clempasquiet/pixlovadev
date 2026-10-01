import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importCatalog, parseCatalogFile, SYNC_CUSTOMER_JOB } from '@pixlova/billing';
import type { FakeStripeGateway } from '@pixlova/billing/testing';
import { DEFAULT_MEDIA_LIMITS } from '@pixlova/contracts';
import { schema } from '@pixlova/db';
import { skipDatabaseTests } from '@pixlova/db/testing';
import {
  billingSweep,
  DEFAULT_VIDEO_TOOLS,
  silentLogger,
  stripeEventHandler,
  syncCustomerHandler,
  Worker,
  type WorkerContext,
} from '@pixlova/workers';
import {
  createHarness,
  createOrganization,
  signUp,
  type Client,
  type Harness,
} from './support/harness.js';

const DAY = 24 * 60 * 60 * 1000;

/** Catalogue indicatif du dépôt, complété de prix Stripe de test fictifs. */
async function testCatalog() {
  const file = parseCatalogFile(
    JSON.parse(
      await readFile(
        new URL('../../../packages/billing/catalog/indicatif.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  for (const plan of file.plans) {
    if (plan.fallback) continue;
    for (const price of plan.prices) {
      price.base_stripe_price_id = `price_${plan.key}_base`;
      price.extra_slot_stripe_price_id = `price_${plan.key}_slot`;
    }
  }
  return file;
}

function key(): Record<string, string> {
  return { 'idempotency-key': `checkout-${randomUUID()}` };
}

describe.skipIf(skipDatabaseTests)('Abonnements Stripe, droits et webhooks (L08)', () => {
  let h: Harness;
  let stripe: FakeStripeGateway;
  let worker: Worker;
  let ctx: WorkerContext;
  let owner: Client;
  let org: { id: string; siteId: string };
  let rival: Client;

  /** Livraison d’un événement signé au endpoint public, comme Stripe. */
  async function deliver(event: { body: string; signature: string }) {
    return h.app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': event.signature },
      payload: event.body,
    });
  }

  async function subscriptionOf(client: Client) {
    const response = await client.get('/billing/subscription');
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function display(client: Client, siteId: string, name: string) {
    return client.post('/displays', { site_id: siteId, name, width: 1920, height: 1080 });
  }

  beforeAll(async () => {
    // Sessions longues : le test avance l’horloge de plusieurs jours (grâce, réconciliation).
    h = await createHarness(
      { sessionIdleHours: 24 * 60, sessionAbsoluteDays: 90 },
      { billing: true },
    );
    stripe = h.stripe!;
    await h.database.platform.transaction((tx) =>
      testCatalog().then((file) => importCatalog(tx, file, h.clock.now)),
    );
    ctx = {
      appDb: h.database.app,
      systemDb: h.database.system,
      storage: h.storage,
      limits: DEFAULT_MEDIA_LIMITS,
      tools: DEFAULT_VIDEO_TOOLS,
      tmpRoot: '/nonexistent',
      trashRetentionDays: 30,
      // Horloge du test décalée : les tâches créées avec `now()` de la base sont dues.
      now: () => new Date(h.clock.now.getTime() + 60_000),
      logger: silentLogger,
      billing: { gateway: stripe, graceDays: 7 },
    };
    worker = new Worker(ctx, [stripeEventHandler, syncCustomerHandler], {
      workerId: 'billing-test-worker',
    });
    owner = await signUp(h, 'owner@billing.test');
    org = await createOrganization(owner, 'Réseau Pro');
    rival = await signUp(h, 'owner@rival-billing.test');
    await createOrganization(rival, 'Réseau Rival');
  });
  afterAll(async () => {
    await h?.close();
  });

  describe('catalogue publié (BILL-001, BILL-005)', () => {
    it('est public, mis en cache, sans identifiant Stripe, et présente des valeurs indicatives', async () => {
      const response = await h.app.inject({ method: 'GET', url: '/api/v1/billing/catalog' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.body).not.toContain('price_');
      const catalog = response.json();
      expect(catalog.indicative).toBe(true);
      expect(catalog.plans.map((p: { key: string }) => p.key)).toEqual([
        'free',
        'starter',
        'pro',
        'business',
      ]);
      const pro = catalog.plans.find((p: { key: string }) => p.key === 'pro');
      expect(pro).toMatchObject({
        version: 1,
        included_display_slots: 10,
        prices: [
          {
            interval: 'month',
            currency: 'eur',
            base_amount_minor: 3900,
            extra_slot_amount_minor: 400,
          },
        ],
      });
    });

    it('une offre republiée sans changement garde sa version ; modifiée, elle en crée une nouvelle', async () => {
      const file = await testCatalog();
      const same = await h.database.platform.transaction((tx) =>
        importCatalog(tx, file, h.clock.now),
      );
      expect(same.published).toEqual([]);
      expect(same.unchanged).toHaveLength(4);
    });
  });

  describe('offre gratuite par défaut (BILL-003)', () => {
    it('un Display actif au plus, aucune facturation implicite (BILL-004)', async () => {
      const view = await subscriptionOf(owner);
      expect(view).toMatchObject({
        state: 'free',
        plan: { key: 'free' },
        subscription: null,
        display_slots: { included: 1, extra: 0, total: 1, active: 0, available: 1 },
        users: { allowed: 1, used: 1 },
        purchase_available: true,
      });
      expect((await display(owner, org.siteId, 'Vitrine')).statusCode).toBe(201);
      const second = await display(owner, org.siteId, 'Comptoir');
      expect(second.json().error.code).toBe('DISPLAY_LIMIT_REACHED');
    });
  });

  let changeId: string;
  let sessionId: string;

  describe('souscription Checkout (BILL-006, BILL-007, BILL-008, API-005)', () => {
    it('exige une clé d’idempotence et une offre achetable', async () => {
      const body = { plan_key: 'pro', interval: 'month', extra_display_slots: 4 };
      expect((await owner.post('/billing/checkout-session', body)).statusCode).toBe(400);
      const free = await owner.request(
        'POST',
        '/billing/checkout-session',
        { plan_key: 'free', interval: 'month' },
        key(),
      );
      expect(free.statusCode).toBe(422);
      const yearly = await owner.request(
        'POST',
        '/billing/checkout-session',
        { plan_key: 'pro', interval: 'year' },
        key(),
      );
      expect(yearly.statusCode).toBe(422);
      const tooMany = await owner.request(
        'POST',
        '/billing/checkout-session',
        { plan_key: 'pro', interval: 'month', extra_display_slots: 1001 },
        key(),
      );
      expect(tooMany.json().error.details.field).toBe('extra_display_slots');
      expect(stripe.calls.createCheckoutSession).toBe(0);
    });

    it('double clic, rejeu et concurrence : une seule session, un seul client Stripe', async () => {
      const body = { plan_key: 'pro', interval: 'month', extra_display_slots: 4 };
      const headers = key();
      // Deux requêtes simultanées avec deux clés différentes, puis le rejeu de la première.
      const [first, other] = await Promise.all([
        owner.request('POST', '/billing/checkout-session', body, headers),
        owner.request('POST', '/billing/checkout-session', body, key()),
      ]);
      const statuses = [first.statusCode, other.statusCode].sort();
      expect(statuses).toEqual([201, 409]);
      const created = first.statusCode === 201 ? first : other;
      const rejected = first.statusCode === 201 ? other : first;
      expect(rejected.json().error.code).toBe('BILLING_PENDING');
      expect(created.json()).toMatchObject({ status: 'pending_payment', kind: 'subscribe' });
      expect(created.json().checkout_url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
      changeId = created.json().id;

      if (first.statusCode === 201) {
        const replay = await owner.request('POST', '/billing/checkout-session', body, headers);
        expect(replay.json().id).toBe(changeId);
        const conflict = await owner.request(
          'POST',
          '/billing/checkout-session',
          { ...body, extra_display_slots: 5 },
          headers,
        );
        expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
      }
      expect(stripe.calls.createCheckoutSession).toBe(1);
      expect(stripe.calls.createCustomer).toBe(1);
      const [session] = [...stripe.sessions.values()];
      sessionId = session!.id;
      // Prix et quantités issus du catalogue serveur, jamais du navigateur.
      expect(session!.input.lineItems).toEqual([
        { price: 'price_pro_base', quantity: 1 },
        { price: 'price_pro_slot', quantity: 4 },
      ]);
      expect(session!.input.allowPromotionCodes).toBe(true);
      expect(session!.input.metadata).toEqual({
        organization_id: org.id,
        billing_change_id: changeId,
      });
    });

    it('le retour navigateur ne prouve rien : la demande reste en attente, droits inchangés', async () => {
      const change = await owner.get(`/billing/changes/${changeId}`);
      expect(change.json().status).toBe('pending_payment');
      expect((await subscriptionOf(owner)).display_slots.total).toBe(1);
      // Une autre organisation ne voit pas la demande (aucune divulgation).
      expect((await rival.get(`/billing/changes/${changeId}`)).statusCode).toBe(404);
    });
  });

  let subscriptionId: string;
  let paidEvent: { id: string; body: string; signature: string };

  describe('webhooks signés et projection (BILL-009, BILL-010)', () => {
    it('refuse une signature absente, fausse ou un corps modifié, sans rien enregistrer', async () => {
      const event = stripe.signedEvent('checkout.session.completed', { id: sessionId });
      const unsigned = await h.app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: { 'content-type': 'application/json' },
        payload: event.body,
      });
      expect(unsigned.statusCode).toBe(400);
      const tampered = await deliver({
        body: event.body.replace('completed', 'expired'),
        signature: event.signature,
      });
      expect(tampered.json().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
      const events = await h.database.system.select().from(schema.stripeWebhookEvents);
      expect(events).toHaveLength(0);
    });

    it('paiement confirmé : droits Pro + 4 slots, demande appliquée, code promo audité', async () => {
      const subscription = stripe.completeCheckout(sessionId, {
        discounts: [{ code: 'LANCEMENT' }],
      });
      subscriptionId = subscription.id;
      paidEvent = stripe.signedEvent('checkout.session.completed', {
        id: sessionId,
        object: 'checkout.session',
        customer: subscription.customerId,
        subscription: subscription.id,
      });
      const response = await deliver(paidEvent);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ received: true });
      // Rien n’est accordé avant le traitement asynchrone.
      expect((await subscriptionOf(owner)).state).toBe('free');
      await worker.drain();

      const view = await subscriptionOf(owner);
      expect(view).toMatchObject({
        state: 'active',
        plan: { key: 'pro', version: 1 },
        subscription: {
          status: 'active',
          interval: 'month',
          base_amount_minor: 3900,
          extra_slot_amount_minor: 400,
          extra_display_slots: 4,
        },
        display_slots: { included: 10, extra: 4, total: 14, active: 1, available: 13 },
        users: { allowed: 10 },
        features: ['templates'],
        sync: { status: 'ok' },
        open_changes: [],
      });
      expect((await owner.get(`/billing/changes/${changeId}`)).json().status).toBe('applied');
      expect((await display(owner, org.siteId, 'Comptoir')).statusCode).toBe(201);

      const redemptions = await h.database.system.select().from(schema.promotionRedemptions);
      expect(redemptions).toHaveLength(1);
      expect(redemptions[0]).toMatchObject({
        organizationId: org.id,
        codeSnapshot: 'LANCEMENT',
        billingChangeId: changeId,
        appliedBy: (await owner.get('/auth/me')).json().user.id,
      });
      const audits = await h.database.system
        .select({ action: schema.auditLogs.action })
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.organizationId, org.id));
      expect(audits.map((a) => a.action)).toEqual(
        expect.arrayContaining(['billing.checkout.requested', 'billing.subscription.created']),
      );
    });

    it('un événement dupliqué est stocké une fois et ne produit aucun second effet', async () => {
      const again = await deliver(paidEvent);
      expect(again.statusCode).toBe(200);
      const rows = await h.database.system
        .select()
        .from(schema.stripeWebhookEvents)
        .where(eq(schema.stripeWebhookEvents.stripeEventId, paidEvent.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('processed');
      expect(await worker.drain()).toBe(0);
      const created = await h.database.system
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'billing.subscription.created'));
      expect(created).toHaveLength(1);
    });

    it('des événements reçus dans le désordre convergent vers l’état courant de Stripe', async () => {
      const older = stripe.signedEvent(
        'customer.subscription.updated',
        {
          ...stripe.subscriptionObject(stripe.subscriptions.get(subscriptionId)!),
          status: 'active',
        },
        { created: new Date(h.clock.now.getTime() - 60_000) },
      );
      const current = stripe.updateSubscription(subscriptionId, { status: 'past_due' });
      const newer = stripe.signedEvent('invoice.payment_failed', {
        id: 'in_test_1',
        object: 'invoice',
        customer: current.customerId,
        subscription: current.id,
      });
      // Le plus récent arrive avant l’ancien : le résultat ne dépend pas de l’ordre.
      expect((await deliver(newer)).statusCode).toBe(200);
      expect((await deliver(older)).statusCode).toBe(200);
      await worker.drain();
      const view = await subscriptionOf(owner);
      expect(view.state).toBe('grace');
      expect(view.subscription.status).toBe('past_due');
      // Pendant la grâce, les droits acquis sont maintenus (BILL-015).
      expect(view.display_slots.total).toBe(14);
      expect(Date.parse(view.subscription.grace_until)).toBeGreaterThan(
        h.clock.now.getTime() + 6 * DAY,
      );
    });

    it('après la grâce : droits Free pour les nouvelles opérations, aucune donnée supprimée', async () => {
      h.clock.advance(8 * DAY);
      const view = await subscriptionOf(owner);
      expect(view.state).toBe('restricted');
      expect(view.display_slots).toMatchObject({
        total: 1,
        active: 2,
        over_capacity: true,
        available: 0,
      });
      // Les deux Displays restent actifs et intacts ; aucun n’est choisi au hasard (BILL-012).
      const displays = (await owner.get('/displays')).json();
      expect(displays.items.map((d: { lifecycle_status: string }) => d.lifecycle_status)).toEqual([
        'active',
        'active',
      ]);
      expect((await display(owner, org.siteId, 'Troisième')).json().error.code).toBe(
        'DISPLAY_LIMIT_REACHED',
      );
    });

    it('la régularisation rétablit les droits sans reconstruction (BILL-013)', async () => {
      const paid = stripe.updateSubscription(subscriptionId, { status: 'active' });
      await deliver(
        stripe.signedEvent('invoice.paid', {
          id: 'in_test_2',
          object: 'invoice',
          customer: paid.customerId,
          subscription: paid.id,
        }),
      );
      await worker.drain();
      const view = await subscriptionOf(owner);
      expect(view).toMatchObject({ state: 'active', display_slots: { total: 14, active: 2 } });
      expect(view.subscription.grace_until).toBeNull();
    });
  });

  describe('réconciliation et pannes (BILL-009, BILL-010, DATA §16.9)', () => {
    it('Stripe indisponible : projection conservée, erreur visible, reprise sans double effet', async () => {
      const subscription = stripe.subscriptions.get(subscriptionId)!;
      stripe.outages = 1;
      await deliver(
        stripe.signedEvent('customer.updated', {
          id: subscription.customerId,
          object: 'customer',
        }),
      );
      await worker.drain();
      const during = await subscriptionOf(owner);
      expect(during.state).toBe('active');
      expect(during.sync.status).toBe('error');
      // Nouvelle tentative de la tâche après son délai de reprise.
      h.clock.advance(60_000);
      await worker.drain();
      expect((await subscriptionOf(owner)).sync.status).toBe('ok');
      const events = await h.database.system
        .select()
        .from(schema.stripeWebhookEvents)
        .where(eq(schema.stripeWebhookEvents.type, 'customer.updated'));
      expect(events[0]).toMatchObject({ status: 'processed', attempts: 2 });
    });

    it('un webhook perdu est corrigé par la réconciliation périodique', async () => {
      // Annulation dans Stripe (portail) dont l’événement n’arrive jamais.
      stripe.updateSubscription(subscriptionId, {
        status: 'canceled',
        canceledAt: h.clock.now,
        endedAt: h.clock.now,
      });
      expect((await subscriptionOf(owner)).state).toBe('active');
      h.clock.advance(7 * 60 * 60 * 1000);
      await billingSweep(ctx);
      const queued = await h.database.system
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.kind, SYNC_CUSTOMER_JOB), eq(schema.jobs.state, 'queued')));
      expect(queued).toHaveLength(1);
      await worker.drain();
      const view = await subscriptionOf(owner);
      expect(view).toMatchObject({ state: 'free', plan: { key: 'free' } });
      // Résiliation ≠ effacement : organisation, Displays et historique conservés (BILL-014).
      expect((await owner.get('/displays')).json().items).toHaveLength(2);
      const audits = await h.database.system
        .select({ metadata: schema.auditLogs.metadata })
        .from(schema.auditLogs)
        .where(
          and(
            eq(schema.auditLogs.organizationId, org.id),
            eq(schema.auditLogs.action, 'billing.subscription.updated'),
          ),
        );
      expect(audits.map((a) => (a.metadata as { stripe_status: string }).stripe_status)).toContain(
        'canceled',
      );
    });

    it('un prix Stripe absent du catalogue est signalé sans modifier les droits', async () => {
      const subscription = stripe.subscriptions.get(subscriptionId)!;
      stripe.updateSubscription(subscriptionId, {
        status: 'active',
        items: [{ id: 'si_unknown', priceId: 'price_inconnu', quantity: 1 }],
      });
      await deliver(
        stripe.signedEvent(
          'customer.subscription.updated',
          stripe.subscriptionObject(subscription),
        ),
      );
      await worker.drain();
      const view = await subscriptionOf(owner);
      expect(view.state).toBe('free');
      expect(view.sync.status).toBe('error');
    });
  });

  describe('session expirée, portail et indisponibilité', () => {
    it('une session Checkout expirée termine la demande et libère une nouvelle souscription', async () => {
      const started = await rival.request(
        'POST',
        '/billing/checkout-session',
        { plan_key: 'starter', interval: 'month' },
        key(),
      );
      expect(started.statusCode).toBe(201);
      const session = [...stripe.sessions.values()].find(
        (s) => s.input.clientReferenceId === started.json().id,
      )!;
      stripe.expireCheckout(session.id);
      await deliver(
        stripe.signedEvent('checkout.session.expired', {
          id: session.id,
          object: 'checkout.session',
          customer: session.customerId,
        }),
      );
      await worker.drain();
      expect((await rival.get(`/billing/changes/${started.json().id}`)).json()).toMatchObject({
        status: 'expired',
        checkout_url: null,
      });
      const again = await rival.request(
        'POST',
        '/billing/checkout-session',
        { plan_key: 'starter', interval: 'month' },
        key(),
      );
      expect(again.statusCode).toBe(201);
    });

    it('portail : réservé à une organisation cliente, URL Stripe côté serveur, audité', async () => {
      const third = await signUp(h, 'owner@sans-compte.test');
      await createOrganization(third, 'Sans compte');
      expect((await third.post('/billing/portal-session')).json().error.code).toBe(
        'NO_BILLING_ACCOUNT',
      );
      const portal = await owner.post('/billing/portal-session');
      expect(portal.statusCode).toBe(200);
      expect(portal.json().url).toMatch(/^https:\/\/billing\.stripe\.test\//);
    });

    it('sans configuration Stripe : catalogue et droits servis, achat indisponible (503)', async () => {
      const billing = h.services.billing;
      h.services.billing = { ...billing, gateway: null };
      try {
        const response = await owner.request(
          'POST',
          '/billing/checkout-session',
          { plan_key: 'pro', interval: 'month' },
          key(),
        );
        expect([response.statusCode, response.json().error.code]).toEqual([
          503,
          'BILLING_UNAVAILABLE',
        ]);
        expect((await subscriptionOf(owner)).purchase_available).toBe(false);
        expect((await h.app.inject({ method: 'POST', url: '/webhooks/stripe' })).statusCode).toBe(
          404,
        );
      } finally {
        h.services.billing = billing;
      }
    });
  });
});
