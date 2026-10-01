import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_FALLBACK_PLAN,
  CatalogError,
  effectiveEntitlements,
  extraSlotsFor,
  parseCatalogFile,
  recurringAmountMinor,
  type PlanCapacities,
  type StripeSubscriptionStatus,
} from '../src/index.js';

const PRO: PlanCapacities = {
  planId: '00000000-0000-4000-8000-000000000001',
  key: 'pro',
  version: 1,
  name: 'Pro',
  includedDisplaySlots: 10,
  maxExtraDisplaySlots: 1000,
  entitlements: { max_users: 10, storage_quota_bytes: 100e9, features: ['templates'] },
};
const NOW = new Date('2026-10-01T10:00:00Z');

function subscribed(status: StripeSubscriptionStatus, graceUntil: Date | null = null, extra = 4) {
  return effectiveEntitlements(
    BUILTIN_FALLBACK_PLAN,
    { subscription: { stripeStatus: status, extraDisplaySlots: extra, graceUntil }, plan: PRO },
    NOW,
  );
}

describe('droits effectifs (BILL-002, BILL-003, BILL-015)', () => {
  it('sans abonnement : offre de repli, un Display, un utilisateur, sans templates', () => {
    const free = effectiveEntitlements(BUILTIN_FALLBACK_PLAN, null, NOW);
    expect(free.state).toBe('free');
    expect(free.displaySlots).toEqual({ included: 1, extra: 0, total: 1 });
    expect(free.maxUsers).toBe(1);
    expect(free.storageBytes).toBe(2_000_000_000);
    expect(free.features).toEqual([]);
  });

  it('abonnement actif : slots inclus + extras confirmés', () => {
    const active = subscribed('active');
    expect(active.state).toBe('active');
    expect(active.displaySlots).toEqual({ included: 10, extra: 4, total: 14 });
    expect(active.features).toEqual(['templates']);
    expect(subscribed('trialing').state).toBe('active');
  });

  it('les extras ne dépassent jamais le maximum de l’offre', () => {
    expect(subscribed('active', null, 5000).displaySlots.extra).toBe(1000);
  });

  it('impayé : droits maintenus pendant la grâce, puis restreints sans suppression', () => {
    const grace = subscribed('past_due', new Date(NOW.getTime() + 1000));
    expect(grace.state).toBe('grace');
    expect(grace.displaySlots.total).toBe(14);
    const after = subscribed('past_due', new Date(NOW.getTime() - 1000));
    expect(after.state).toBe('restricted');
    expect(after.displaySlots.total).toBe(1);
    expect(after.subscribedPlan?.key).toBe('pro');
    // Échéance de grâce inconnue : les droits acquis ne sont pas retirés (BILL-009).
    expect(subscribed('past_due', null).state).toBe('grace');
  });

  it.each([
    ['unpaid', 'restricted'],
    ['paused', 'restricted'],
    ['incomplete', 'pending'],
    ['incomplete_expired', 'free'],
    ['canceled', 'free'],
  ] as const)('statut Stripe %s → état %s, droits de repli', (status, state) => {
    const result = subscribed(status);
    expect(result.state).toBe(state);
    expect(result.displaySlots.total).toBe(1);
    expect(result.features).toEqual([]);
  });
});

describe('calcul transparent (BILL-004)', () => {
  it('14 Displays en Pro indicatif : 39 + (14 − 10) × 4 = 55 €', () => {
    const extra = extraSlotsFor(PRO, 14);
    expect(extra).toBe(4);
    expect(recurringAmountMinor({ baseAmountMinor: 3900, extraSlotAmountMinor: 400 }, extra)).toBe(
      5500,
    );
  });

  it('refuse des extras sur une offre qui n’en vend pas', () => {
    expect(() =>
      recurringAmountMinor({ baseAmountMinor: 0, extraSlotAmountMinor: null }, 1),
    ).toThrow();
  });
});

describe('fichier de catalogue', () => {
  it('le catalogue indicatif du dépôt est valide et reprend la grille du §11.1', async () => {
    const file = parseCatalogFile(
      JSON.parse(await readFile(new URL('../catalog/indicatif.json', import.meta.url), 'utf8')),
    );
    const byKey = Object.fromEntries(file.plans.map((plan) => [plan.key, plan]));
    expect(Object.keys(byKey)).toEqual(['free', 'starter', 'pro', 'business']);
    expect(file.plans.every((plan) => plan.indicative)).toBe(true);
    expect(byKey.free!.fallback).toBe(true);
    expect(byKey.pro!.prices[0]).toMatchObject({
      base_amount_minor: 3900,
      extra_slot_amount_minor: 400,
    });
    // Aucun prix Stripe dans le dépôt : affichable, pas achetable.
    expect(file.plans.flatMap((p) => p.prices).some((p) => p.base_stripe_price_id)).toBe(false);
    // Aucune remise annuelle inventée (BILL-016 : proposition non acquise).
    expect(file.plans.flatMap((p) => p.prices).every((p) => p.interval === 'month')).toBe(true);
  });

  const plan = {
    key: 'pro',
    name: 'Pro',
    included_display_slots: 10,
    max_extra_display_slots: 100,
    entitlements: { max_users: 10, storage_quota_bytes: 1, features: [] },
    indicative: true,
    prices: [
      {
        environment: 'test',
        interval: 'month',
        currency: 'eur',
        base_amount_minor: 3900,
        extra_slot_amount_minor: 400,
        base_stripe_price_id: 'price_base',
        extra_slot_stripe_price_id: 'price_slot',
      },
    ],
  };

  it.each([
    [
      'clé de fonctionnalité inconnue',
      { ...plan, entitlements: { ...plan.entitlements, features: ['sso'] } },
    ],
    ['offre en double', null],
    [
      'prix Stripe de slot manquant',
      { ...plan, prices: [{ ...plan.prices[0], extra_slot_stripe_price_id: undefined }] },
    ],
    [
      'slot vendu sans montant',
      {
        ...plan,
        prices: [
          {
            ...plan.prices[0],
            extra_slot_amount_minor: undefined,
            extra_slot_stripe_price_id: undefined,
          },
        ],
      },
    ],
    ['offre de repli payante', { ...plan, fallback: true, max_extra_display_slots: 0 }],
  ])('refuse : %s', (_label, variant) => {
    const plans = variant ? [JSON.parse(JSON.stringify(variant))] : [plan, plan];
    expect(() => parseCatalogFile({ plans })).toThrow(CatalogError);
  });
});
