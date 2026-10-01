import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CatalogFile } from '@pixlova/contracts';
import { schema, withTenant } from '@pixlova/db';
import { createTestDatabase, skipDatabaseTests, type TestDatabase } from '@pixlova/db/testing';
import {
  importCatalog,
  organizationBilling,
  publishedCatalog,
  syncCustomer,
  type BillingSyncContext,
} from '../src/index.js';
import { FakeStripeGateway } from '../src/testing.js';

function catalog(overrides: { proStorage?: number; proPrice?: string } = {}): CatalogFile {
  return {
    plans: [
      {
        key: 'free',
        name: 'Free',
        fallback: true,
        included_display_slots: 1,
        max_extra_display_slots: 0,
        entitlements: { max_users: 1, storage_quota_bytes: 2e9, features: [] },
        indicative: true,
        prices: [],
      },
      {
        key: 'pro',
        name: 'Pro',
        included_display_slots: 10,
        max_extra_display_slots: 100,
        entitlements: {
          max_users: 10,
          storage_quota_bytes: overrides.proStorage ?? 100e9,
          features: ['templates'],
        },
        indicative: true,
        prices: [
          {
            environment: 'test',
            interval: 'month',
            currency: 'eur',
            base_amount_minor: 3900,
            extra_slot_amount_minor: 400,
            base_stripe_price_id: overrides.proPrice ?? 'price_pro_v1',
            extra_slot_stripe_price_id: 'price_pro_slot',
          },
        ],
      },
    ],
  };
}

describe.skipIf(skipDatabaseTests)('catalogue versionné et projection Stripe (ADR-017)', () => {
  let database: TestDatabase;
  let stripe: FakeStripeGateway;
  let ctx: BillingSyncContext;
  let organizationId: string;
  let customerId: string;
  const now = new Date();

  beforeAll(async () => {
    database = await createTestDatabase();
    stripe = new FakeStripeGateway(() => now);
    ctx = { db: database.system, gateway: stripe, graceDays: 7, now: () => now };
    await database.platform.transaction((tx) => importCatalog(tx, catalog(), now));
    organizationId = randomUUID();
    await database.system.insert(schema.organizations).values({
      id: organizationId,
      name: 'Org',
      slug: `org-${organizationId.slice(0, 8)}`,
      country: 'FR',
      timezone: 'Europe/Paris',
    });
    customerId = (await stripe.createCustomer({ organizationId, name: 'Org', email: null }, 'k'))
      .id;
    await database.system
      .insert(schema.billingCustomers)
      .values({ organizationId, environment: 'test', stripeCustomerId: customerId });
  });
  afterAll(async () => {
    await database?.close();
  });

  const effective = () =>
    withTenant(database.app, organizationId, (tx) =>
      organizationBilling(tx, organizationId, 'test', now),
    );

  it('synchronisations concurrentes d’un même client : un seul abonnement, un seul audit de création', async () => {
    const session = await stripe.createCheckoutSession(
      {
        customerId,
        lineItems: [
          { price: 'price_pro_v1', quantity: 1 },
          { price: 'price_pro_slot', quantity: 2 },
        ],
        clientReferenceId: randomUUID(),
        metadata: {},
        successUrl: 'https://app.test/ok',
        cancelUrl: 'https://app.test/ko',
        expiresAt: new Date(now.getTime() + 3600_000),
        allowPromotionCodes: true,
      },
      'checkout-1',
    );
    stripe.completeCheckout(session.id);
    const results = await Promise.all([1, 2, 3, 4].map(() => syncCustomer(ctx, customerId)));
    expect(results.every((r) => r.status === 'synced')).toBe(true);
    const rows = await database.system.select().from(schema.subscriptions);
    expect(rows).toHaveLength(1);
    const audits = await database.system
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.action, 'billing.subscription.created'));
    expect(audits).toHaveLength(1);
    expect((await effective()).effective.displaySlots.total).toBe(12);
  });

  it('une nouvelle version d’offre ne change pas silencieusement un abonnement en cours (BILL-005)', async () => {
    const result = await database.platform.transaction((tx) =>
      importCatalog(tx, catalog({ proStorage: 200e9, proPrice: 'price_pro_v2' }), now),
    );
    expect(result).toMatchObject({ published: [{ key: 'pro', version: 2 }], unchanged: ['free'] });
    const published = await database.app.transaction((tx) => publishedCatalog(tx, 'test', now));
    expect(published.plans.find((p) => p.key === 'pro')).toMatchObject({
      version: 2,
      entitlements: { storage_quota_bytes: 200e9 },
    });
    await syncCustomer(ctx, customerId);
    const billing = await effective();
    // L’abonnement existant reste sur la version 1 et ses capacités.
    expect(billing.effective.plan).toMatchObject({ key: 'pro', version: 1 });
    expect(billing.effective.storageBytes).toBe(100e9);
    const archived = await database.system
      .select()
      .from(schema.planPrices)
      .where(eq(schema.planPrices.baseStripePriceId, 'price_pro_v1'));
    expect(archived[0]!.active).toBe(false);
  });

  it('l’offre de repli publiée remplace la Free intégrée', async () => {
    const [plan] = await database.system
      .select()
      .from(schema.plans)
      .where(eq(schema.plans.isFallback, true));
    expect(plan).toMatchObject({ key: 'free', status: 'published' });
  });
});
