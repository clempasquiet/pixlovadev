import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importCatalog, parseCatalogFile } from '@pixlova/billing';
import type { FakeStripeGateway } from '@pixlova/billing/testing';
import { DEFAULT_MEDIA_LIMITS } from '@pixlova/contracts';
import { schema } from '@pixlova/db';
import { skipDatabaseTests } from '@pixlova/db/testing';
import {
  DEFAULT_VIDEO_TOOLS,
  silentLogger,
  stripeEventHandler,
  syncCustomerHandler,
  Worker,
} from '@pixlova/workers';
import {
  createHarness,
  createOrganization,
  signUp,
  type Client,
  type Harness,
} from './support/harness.js';

const DAY = 24 * 60 * 60 * 1000;
const AMOUNTS: Record<string, [number, number]> = {
  starter: [1490, 500],
  pro: [3900, 400],
  business: [9900, 300],
};

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

const key = () => ({ 'idempotency-key': `change-${randomUUID()}` });

describe.skipIf(skipDatabaseTests)('Changements d’abonnement et choix des Displays (L08)', () => {
  let h: Harness;
  let stripe: FakeStripeGateway;
  let worker: Worker;
  let owner: Client;
  let org: { id: string; siteId: string };
  let rival: Client;
  let rivalOrg: { id: string; siteId: string };
  const subscriptions = new Map<string, string>();

  async function deliver(type: string, subscriptionId: string) {
    const subscription = stripe.subscriptions.get(subscriptionId)!;
    const event = stripe.signedEvent(type, stripe.subscriptionObject(subscription));
    const response = await h.app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': event.signature },
      payload: event.body,
    });
    expect(response.statusCode).toBe(200);
    await worker.drain();
  }

  async function view(client: Client) {
    const response = await client.get('/billing/subscription');
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  async function subscribe(client: Client, orgId: string, planKey: string, extra = 0) {
    const created = await client.request(
      'POST',
      '/billing/checkout-session',
      { plan_key: planKey, interval: 'month', extra_display_slots: extra },
      key(),
    );
    expect(created.statusCode).toBe(201);
    const session = [...stripe.sessions.values()].find(
      (s) => s.input.metadata.billing_change_id === created.json().id,
    )!;
    const subscription = stripe.completeCheckout(session.id);
    subscriptions.set(orgId, subscription.id);
    await deliver('customer.subscription.created', subscription.id);
    return subscription.id;
  }

  async function addDisplays(client: Client, siteId: string, count: number, prefix: string) {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const response = await client.post('/displays', {
        site_id: siteId,
        name: `${prefix} ${i + 1}`,
        width: 1920,
        height: 1080,
      });
      expect(response.statusCode).toBe(201);
      ids.push(response.json().id);
    }
    return ids;
  }

  async function displayStates(orgId: string) {
    const rows = await h.database.system
      .select({
        id: schema.displays.id,
        status: schema.displays.lifecycleStatus,
        deletedAt: schema.displays.deletedAt,
      })
      .from(schema.displays)
      .where(eq(schema.displays.organizationId, orgId));
    return new Map(rows.map((row) => [row.id, row]));
  }

  async function actions(orgId: string) {
    const rows = await h.database.system
      .select({ action: schema.auditLogs.action })
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.organizationId, orgId));
    return rows.map((row) => row.action);
  }

  beforeAll(async () => {
    h = await createHarness(
      { sessionIdleHours: 24 * 90, sessionAbsoluteDays: 120 },
      { billing: true },
    );
    stripe = h.stripe!;
    for (const [plan, [base, slot]] of Object.entries(AMOUNTS)) {
      stripe.unitAmounts.set(`price_${plan}_base`, base);
      stripe.unitAmounts.set(`price_${plan}_slot`, slot);
    }
    await h.database.platform.transaction((tx) =>
      testCatalog().then((file) => importCatalog(tx, file, h.clock.now)),
    );
    worker = new Worker(
      {
        appDb: h.database.app,
        systemDb: h.database.system,
        storage: h.storage,
        limits: DEFAULT_MEDIA_LIMITS,
        tools: DEFAULT_VIDEO_TOOLS,
        tmpRoot: '/nonexistent',
        trashRetentionDays: 30,
        now: () => new Date(h.clock.now.getTime() + 60_000),
        logger: silentLogger,
        billing: { gateway: stripe, graceDays: 7 },
      },
      [stripeEventHandler, syncCustomerHandler],
      { workerId: 'billing-changes-worker' },
    );
    owner = await signUp(h, 'owner@changes.test');
    org = await createOrganization(owner, 'Réseau Changements');
    rival = await signUp(h, 'owner@rival-changes.test');
    rivalOrg = await createOrganization(rival, 'Réseau Rival');
  });
  afterAll(async () => {
    await h?.close();
  });

  describe('hausse immédiate au prorata (BILL-011)', () => {
    it('sans abonnement payant, aucune modification n’est possible', async () => {
      const response = await owner.request('POST', '/billing/subscription/preview', {
        plan_key: 'pro',
        interval: 'month',
      });
      expect(response.json().error.code).toBe('NO_ACTIVE_SUBSCRIPTION');
    });

    it('prévisualise montant, prorata, date d’effet et prochaine échéance, sans effet', async () => {
      await subscribe(owner, org.id, 'starter');
      await addDisplays(owner, org.siteId, 3, 'Écran');
      h.clock.advance(15 * DAY);
      const response = await owner.request('POST', '/billing/subscription/preview', {
        plan_key: 'pro',
        interval: 'month',
        extra_display_slots: 2,
      });
      expect(response.statusCode).toBe(200);
      const preview = response.json();
      expect(preview).toMatchObject({
        kind: 'upgrade',
        plan: { key: 'pro', version: 1 },
        current_amount_minor: 1490,
        new_amount_minor: 4700,
        capacity: { display_slots: 12, active_displays: 3, selection_required: false },
        indicative: true,
      });
      // Moitié de période restante : (4700 − 1490) / 2.
      expect(preview.amount_due_now_minor).toBe(1605);
      expect(preview.proration_date).not.toBeNull();
      expect(preview.next_period_end).not.toBeNull();
      expect(stripe.calls.upgradeSubscription).toBe(0);
      expect((await view(owner)).display_slots.total).toBe(3);
    });

    it('confirmée, la hausse est appliquée une fois relue chez Stripe, rejouable sans double débit', async () => {
      const preview = (
        await owner.request('POST', '/billing/subscription/preview', {
          plan_key: 'pro',
          interval: 'month',
          extra_display_slots: 2,
        })
      ).json();
      const body = {
        plan_key: 'pro',
        interval: 'month',
        extra_display_slots: 2,
        proration_date: preview.proration_date,
      };
      const headers = key();
      const response = await owner.request('POST', '/billing/subscription/change', body, headers);
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ kind: 'upgrade', status: 'applied' });
      const replay = await owner.request('POST', '/billing/subscription/change', body, headers);
      expect(replay.json().id).toBe(response.json().id);
      expect(stripe.calls.upgradeSubscription).toBe(1);
      const current = await view(owner);
      expect(current).toMatchObject({
        state: 'active',
        plan: { key: 'pro' },
        display_slots: { total: 12, active: 3 },
        open_changes: [],
      });
      expect(await actions(org.id)).toEqual(
        expect.arrayContaining(['billing.upgrade.requested', 'billing.change.applied']),
      );
    });

    it('une prévisualisation trop ancienne doit être refaite', async () => {
      const response = await owner.request(
        'POST',
        '/billing/subscription/change',
        {
          plan_key: 'pro',
          interval: 'month',
          extra_display_slots: 3,
          proration_date: new Date(h.clock.now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
        },
        key(),
      );
      expect(response.json().error.code).toBe('PREVIEW_EXPIRED');
    });

    it('paiement refusé : droits inchangés, puis demande en échec à l’expiration de la mise à jour', async () => {
      stripe.declineNextPayment = true;
      const response = await owner.request(
        'POST',
        '/billing/subscription/change',
        { plan_key: 'pro', interval: 'month', extra_display_slots: 5 },
        key(),
      );
      expect(response.statusCode).toBe(201);
      expect(response.json().status).toBe('pending_payment');
      expect((await view(owner)).display_slots.total).toBe(12);
      const blocked = await owner.request('POST', '/billing/subscription/preview', {
        plan_key: 'pro',
        interval: 'month',
        extra_display_slots: 6,
      });
      expect(blocked.json().error.code).toBe('BILLING_PENDING');

      const subscriptionId = subscriptions.get(org.id)!;
      stripe.updateSubscription(subscriptionId, { pendingUpdate: false });
      await deliver('customer.subscription.pending_update_expired', subscriptionId);
      const change = (await owner.get(`/billing/changes/${response.json().id}`)).json();
      expect(change).toMatchObject({ status: 'failed', failure_reason: 'payment_not_completed' });
      expect((await view(owner)).display_slots.total).toBe(12);
    });
  });

  let kept: string[];
  let downgradeId: string;

  describe('baisse à l’échéance avec choix des Displays (BILL-012, BILL-013)', () => {
    it('exige un choix explicite quand la capacité future est inférieure à l’usage', async () => {
      await addDisplays(owner, org.siteId, 2, 'Renfort');
      const preview = (
        await owner.request('POST', '/billing/subscription/preview', {
          plan_key: 'starter',
          interval: 'month',
        })
      ).json();
      expect(preview).toMatchObject({
        kind: 'downgrade',
        amount_due_now_minor: 0,
        proration_date: null,
        capacity: { display_slots: 3, active_displays: 5, selection_required: true },
      });
      expect(preview.effective_at).toBe(preview.next_period_end);

      const missing = await owner.request(
        'POST',
        '/billing/subscription/change',
        { plan_key: 'starter', interval: 'month' },
        key(),
      );
      expect(missing.json().error.code).toBe('DISPLAY_SELECTION_REQUIRED');
      const ids = [...(await displayStates(org.id)).keys()];
      const tooMany = await owner.request(
        'POST',
        '/billing/subscription/change',
        { plan_key: 'starter', interval: 'month', keep_display_ids: ids.slice(0, 4) },
        key(),
      );
      expect(tooMany.json().error.code).toBe('DISPLAY_SELECTION_REQUIRED');
      // Un Display d’une autre organisation n’est jamais retenu.
      const rivalDisplays = await addDisplays(rival, rivalOrg.siteId, 1, 'Rival');
      const foreign = await owner.request(
        'POST',
        '/billing/subscription/change',
        { plan_key: 'starter', interval: 'month', keep_display_ids: rivalDisplays },
        key(),
      );
      expect(foreign.json().error.code).toBe('DISPLAY_SELECTION_REQUIRED');
    });

    it('programmée sans prorata : droits actuels conservés jusqu’à l’échéance', async () => {
      const ids = [...(await displayStates(org.id)).keys()];
      kept = ids.slice(0, 3);
      const response = await owner.request(
        'POST',
        '/billing/subscription/change',
        { plan_key: 'starter', interval: 'month', keep_display_ids: kept },
        key(),
      );
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        kind: 'downgrade',
        status: 'scheduled',
        selection_status: 'pending',
      });
      expect(response.json().keep_display_ids.sort()).toEqual([...kept].sort());
      downgradeId = response.json().id;
      expect(stripe.calls.scheduleDowngrade).toBe(1);
      const current = await view(owner);
      expect(current.display_slots.total).toBe(12);
      expect(current.open_changes).toHaveLength(1);
      // Une seule modification en cours.
      const other = await owner.request('POST', '/billing/subscription/cancel', {}, key());
      expect(other.json().error.code).toBe('BILLING_CHANGE_PENDING');
    });

    it('le choix reste modifiable avant l’échéance, et seulement par l’organisation', async () => {
      kept = kept.slice(0, 2);
      const response = await owner.request('PUT', `/billing/changes/${downgradeId}/selection`, {
        keep_display_ids: kept,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().keep_display_ids.sort()).toEqual([...kept].sort());
      const foreign = await rival.request('PUT', `/billing/changes/${downgradeId}/selection`, {
        keep_display_ids: kept,
      });
      expect(foreign.statusCode).toBe(404);
      expect(await actions(org.id)).toContain('billing.display_selection.updated');
    });

    it('à l’échéance : offre réduite, Displays non retenus inactifs, rien n’est supprimé', async () => {
      const subscriptionId = subscriptions.get(org.id)!;
      h.clock.advance(16 * DAY);
      stripe.advancePeriod(subscriptionId);
      await deliver('customer.subscription.updated', subscriptionId);

      const change = (await owner.get(`/billing/changes/${downgradeId}`)).json();
      expect(change).toMatchObject({ status: 'applied', selection_status: 'applied' });
      const current = await view(owner);
      expect(current).toMatchObject({
        state: 'active',
        plan: { key: 'starter' },
        display_slots: { total: 3, active: 2, over_capacity: false },
      });
      const states = await displayStates(org.id);
      expect(states.size).toBe(5);
      for (const [id, display] of states) {
        expect(display.deletedAt).toBeNull();
        expect(display.status).toBe(kept.includes(id) ? 'active' : 'inactive');
      }
      // Les Displays retirés de la diffusion sont recompilés (aucun manifest désiré).
      const jobs = await h.database.system
        .select({ payload: schema.jobs.payload })
        .from(schema.jobs)
        .where(
          and(eq(schema.jobs.organizationId, org.id), eq(schema.jobs.kind, 'compile_display')),
        );
      const recompiled = jobs.map((job) => (job.payload as { display_id: string }).display_id);
      for (const [id] of [...states].filter(([id]) => !kept.includes(id))) {
        expect(recompiled).toContain(id);
      }
      expect(await actions(org.id)).toContain('billing.displays.deactivated');
    });
  });

  describe('annulation à l’échéance (BILL-014)', () => {
    let cancelId: string;

    it('demande le Display à conserver, puis peut être retirée avant l’échéance', async () => {
      const missing = await owner.request('POST', '/billing/subscription/cancel', {}, key());
      expect(missing.json().error.code).toBe('DISPLAY_SELECTION_REQUIRED');
      const response = await owner.request(
        'POST',
        '/billing/subscription/cancel',
        { keep_display_ids: [kept[0]] },
        key(),
      );
      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ kind: 'cancel', status: 'scheduled' });
      expect((await view(owner)).subscription.cancel_at_period_end).toBe(true);

      const withdrawn = await owner.request('DELETE', `/billing/changes/${response.json().id}`);
      expect(withdrawn.statusCode).toBe(200);
      expect(withdrawn.json().status).toBe('cancelled');
      const current = await view(owner);
      expect(current.subscription.cancel_at_period_end).toBe(false);
      expect(current.open_changes).toEqual([]);
    });

    it('à l’échéance : retour à l’offre de repli avec le Display retenu, données conservées', async () => {
      const response = await owner.request(
        'POST',
        '/billing/subscription/cancel',
        { keep_display_ids: [kept[1]] },
        key(),
      );
      cancelId = response.json().id;
      const subscriptionId = subscriptions.get(org.id)!;
      h.clock.advance(31 * DAY);
      stripe.advancePeriod(subscriptionId);
      await deliver('customer.subscription.deleted', subscriptionId);

      expect((await owner.get(`/billing/changes/${cancelId}`)).json()).toMatchObject({
        status: 'applied',
        selection_status: 'applied',
      });
      const current = await view(owner);
      expect(current).toMatchObject({
        state: 'free',
        display_slots: { total: 1, active: 1, over_capacity: false },
      });
      const states = await displayStates(org.id);
      expect(states.get(kept[1]!)!.status).toBe('active');
      expect([...states.values()].every((display) => display.deletedAt === null)).toBe(true);
    });
  });

  describe('annulation reçue hors du parcours (DEC-20)', () => {
    it('aucun Display n’est choisi au hasard : tous restent actifs, le dépassement est signalé', async () => {
      const subscriptionId = await subscribe(rival, rivalOrg.id, 'starter');
      await addDisplays(rival, rivalOrg.siteId, 1, 'Second');
      // Annulation depuis le portail Stripe, sans sélection dans pixlova.
      stripe.updateSubscription(subscriptionId, { cancelAtPeriodEnd: true });
      h.clock.advance(31 * DAY);
      stripe.advancePeriod(subscriptionId);
      await deliver('customer.subscription.deleted', subscriptionId);
      const current = await view(rival);
      expect(current).toMatchObject({
        state: 'free',
        display_slots: { total: 1, active: 2, over_capacity: true, available: 0 },
      });
      const rows = await h.database.system
        .select({ status: schema.displays.lifecycleStatus })
        .from(schema.displays)
        .where(
          and(
            eq(schema.displays.organizationId, rivalOrg.id),
            inArray(schema.displays.lifecycleStatus, ['active']),
          ),
        );
      expect(rows).toHaveLength(2);
    });
  });
});
