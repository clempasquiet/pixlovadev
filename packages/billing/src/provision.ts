import Stripe from 'stripe';
import type { CatalogFile } from '@pixlova/contracts';
import { parseCatalogFile } from './catalog.js';
import { environmentOfKey, STRIPE_API_VERSION } from './stripe-gateway.js';

/**
 * Prépare un compte Stripe **de test** pour la recette (ADR-017) : crée, ou réutilise, les
 * produits et prix récurrents du catalogue, puis renvoie le catalogue complété de leurs
 * identifiants, prêt pour `admin-cli catalog-import`. Refuse toute clé de production :
 * le catalogue de production se configure par une décision commerciale validée.
 *
 * La clé de recherche (`lookup_key`) inclut le montant : un changement de prix crée un
 * nouveau prix Stripe au lieu de réutiliser un prix existant au mauvais montant.
 */
export async function provisionStripeTestPrices(
  secretKey: string,
  input: CatalogFile,
  log: (message: string) => void = () => undefined,
): Promise<CatalogFile> {
  if (environmentOfKey(secretKey) !== 'test') {
    throw new Error(
      'Ce provisionnement n’accepte qu’une clé Stripe de test (sk_test_ ou rk_test_).',
    );
  }
  const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION, maxNetworkRetries: 2 });
  const file = structuredClone(parseCatalogFile(input));

  async function product(id: string, name: string): Promise<string> {
    try {
      return (await stripe.products.retrieve(id)).id;
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      log(`produit créé : ${id}`);
      return (await stripe.products.create({ id, name, metadata: { pixlova: 'catalog' } })).id;
    }
  }

  async function price(
    lookupKey: string,
    productId: string,
    amount: number,
    currency: string,
    interval: 'month' | 'year',
  ): Promise<string> {
    const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
    const found = existing.data[0];
    if (found) return found.id;
    log(`prix créé : ${lookupKey}`);
    const created = await stripe.prices.create(
      {
        product: productId,
        currency,
        unit_amount: amount,
        recurring: { interval },
        lookup_key: lookupKey,
        metadata: { pixlova: 'catalog' },
      },
      { idempotencyKey: `pixlova:price:${lookupKey}` },
    );
    return created.id;
  }

  for (const plan of file.plans) {
    if (plan.fallback) continue;
    for (const entry of plan.prices) {
      if (entry.environment !== 'test') continue;
      const prefix = `pixlova_${plan.key}_${entry.interval}_${entry.currency}`;
      if (!entry.base_stripe_price_id) {
        const base = await product(`pixlova_${plan.key}`, `pixlova ${plan.name}`);
        entry.base_stripe_price_id = await price(
          `${prefix}_base_${entry.base_amount_minor}`,
          base,
          entry.base_amount_minor,
          entry.currency,
          entry.interval,
        );
      }
      if (entry.extra_slot_amount_minor !== undefined && !entry.extra_slot_stripe_price_id) {
        const slot = await product(
          `pixlova_${plan.key}_slot`,
          `pixlova ${plan.name} — Display supplémentaire`,
        );
        entry.extra_slot_stripe_price_id = await price(
          `${prefix}_slot_${entry.extra_slot_amount_minor}`,
          slot,
          entry.extra_slot_amount_minor,
          entry.currency,
          entry.interval,
        );
      }
    }
  }
  return parseCatalogFile(file);
}
