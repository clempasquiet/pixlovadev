import { describe, expect, it } from 'vitest';
import { StripeGateway } from '@pixlova/billing';
import { billingFromEnv } from '../src/lib/billing.js';

const keys = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x' };

describe('configuration Stripe (ADR-017)', () => {
  it('transmet les horloges de test en recette', () => {
    let testClocks: boolean | null = null;
    billingFromEnv({ ...keys, PIXLOVA_STRIPE_TEST_CLOCKS: 'true' }, 'recette', (config) => {
      testClocks = config.testClocks;
      return new StripeGateway(config);
    });
    expect(testClocks).toBe(true);
  });

  it('refuse les horloges de test en production ou avec une clé live', () => {
    expect(() =>
      billingFromEnv({ ...keys, PIXLOVA_STRIPE_TEST_CLOCKS: 'true' }, 'production'),
    ).toThrow(/réservé/);
    expect(
      () =>
        new StripeGateway({ secretKey: 'sk_live_x', webhookSecret: 'whsec_x', testClocks: true }),
    ).toThrow(/clé de test/);
  });
});
