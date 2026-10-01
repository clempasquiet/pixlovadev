#!/usr/bin/env node
/**
 * Provisionne les produits et prix d’un compte Stripe de TEST à partir d’un catalogue, puis
 * écrit le catalogue complété des identifiants de prix (ADR-017, docs/operations/FACTURATION.md) :
 *
 *   STRIPE_SECRET_KEY=sk_test_… node packages/billing/scripts/stripe-test-setup.mjs \
 *     packages/billing/catalog/indicatif.json > catalogue-test.json
 *
 * Refuse une clé de production. Rejouable : les prix existants sont réutilisés.
 */
import { readFile } from 'node:fs/promises';
import { provisionStripeTestPrices } from '../dist/provision.js';

const [path] = process.argv.slice(2);
const key = process.env.STRIPE_SECRET_KEY;
if (!path || !key) {
  console.error('Usage : STRIPE_SECRET_KEY=sk_test_… stripe-test-setup.mjs <catalogue.json>');
  process.exit(2);
}
try {
  const input = JSON.parse(await readFile(path, 'utf8'));
  const output = await provisionStripeTestPrices(key, input, (m) => console.error(m));
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
