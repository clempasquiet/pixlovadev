/**
 * Page Abonnement dans Chromium (ADR-017, BILL-004, BILL-008, BILL-011, BILL-014) : offre
 * gratuite, souscription Checkout (Stripe simulé), retour confirmé par le serveur, hausse
 * avec prorata affiché, annulation avec choix de l’écran conservé.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importCatalog, parseCatalogFile, syncCustomer } from '@pixlova/billing';
import { skipDatabaseTests } from '@pixlova/db/testing';
import { login, output, register, root, startStack, type Stack } from './support.js';

const AMOUNTS: Record<string, [number, number]> = {
  starter: [1490, 500],
  pro: [3900, 400],
  business: [9900, 300],
};

describe.skipIf(skipDatabaseTests)('dashboard : abonnement Stripe', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack({ billing: true });
    const stripe = stack.test.stripe!;
    const file = parseCatalogFile(
      JSON.parse(
        await readFile(resolve(root, '../../packages/billing/catalog/indicatif.json'), 'utf8'),
      ),
    );
    for (const plan of file.plans) {
      if (plan.fallback) continue;
      for (const price of plan.prices) {
        price.base_stripe_price_id = `price_${plan.key}_base`;
        price.extra_slot_stripe_price_id = `price_${plan.key}_slot`;
        stripe.unitAmounts.set(`price_${plan.key}_base`, AMOUNTS[plan.key]![0]);
        stripe.unitAmounts.set(`price_${plan.key}_slot`, AMOUNTS[plan.key]![1]);
      }
    }
    await stack.database.platform.transaction((tx) =>
      importCatalog(tx, file, stack.test.clock.now),
    );
  }, 120_000);
  afterAll(async () => {
    await stack?.close();
  });

  it('souscrit, augmente avec prorata affiché puis programme l’annulation en gardant un écran', async () => {
    const stripe = stack.test.stripe!;
    const sync = (customerId: string) =>
      syncCustomer(
        {
          db: stack.database.system,
          gateway: stripe,
          graceDays: 7,
          now: () => stack.test.clock.now,
        },
        customerId,
      );
    const page = await stack.browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('https://checkout.stripe.test/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p>Stripe Checkout</p>' }),
    );
    await register(stack, page, 'gerant@pixlova.test', 'Gérant');
    await page.goto(`${stack.base}/login`);
    await login(page, 'gerant@pixlova.test');
    await page.getByLabel('Nom de l’organisation').fill('Boutique Centre');
    await page.getByLabel('Fuseau horaire').fill('Europe/Paris');
    await page.getByRole('button', { name: 'Créer l’organisation' }).click();
    await page.getByRole('heading', { name: 'Boutique Centre' }).waitFor();

    await page.getByRole('link', { name: 'Abonnement' }).click();
    await page.getByText('Offre gratuite').waitFor();
    await page.getByText('Écrans actifs : 0 / 1').waitFor();
    await page.getByLabel('Offre').selectOption('pro');
    await page.getByLabel('Écrans supplémentaires').fill('4');
    await page.getByText('14 écrans · 55,00 € par mois hors taxes').waitFor();
    await page.screenshot({ path: resolve(output, '40-abonnement-gratuit.png'), fullPage: true });
    await page.getByRole('button', { name: 'Souscrire' }).click();
    // Redirection vers la page de paiement Stripe, jamais chargée dans ce test.
    await page.waitForURL(/^https:\/\/checkout\.stripe\.test\/c\/pay\//);

    // Paiement confirmé chez Stripe, projection relue ; le retour affiche le verdict serveur.
    const session = [...stripe.sessions.values()][0]!;
    const subscription = stripe.completeCheckout(session.id);
    await sync(subscription.customerId);
    await page.goto(`${stack.base}/billing?change=${session.input.clientReferenceId}`);
    await page.getByText('Paiement confirmé : votre abonnement est actif.').waitFor();
    await page.getByText('Écrans actifs : 0 / 14').waitFor();

    await page.getByLabel('Écrans supplémentaires').fill('6');
    await page.getByRole('button', { name: 'Voir le détail' }).click();
    await page.getByText('Montant facturé maintenant au prorata').waitFor();
    await page.screenshot({ path: resolve(output, '41-abonnement-hausse.png'), fullPage: true });
    await page.getByRole('button', { name: 'Confirmer et payer' }).click();
    await page.getByText('Écrans actifs : 0 / 16').waitFor();

    // Deux écrans actifs, retour à l’offre gratuite (un écran) : choix explicite requis.
    for (const name of ['Vitrine', 'Caisse']) {
      await page
        .getByRole('navigation', { name: 'Navigation principale' })
        .getByRole('link', { name: 'Écrans' })
        .click();
      await page.getByLabel('Nom', { exact: true }).fill(name);
      await page.getByRole('button', { name: 'Créer le Display' }).click();
      await page.getByRole('heading', { name }).waitFor();
    }
    await page
      .getByRole('navigation', { name: 'Navigation principale' })
      .getByRole('link', { name: 'Abonnement' })
      .click();
    await page.getByText('Écrans actifs : 2 / 16').waitFor();
    await page.getByRole('button', { name: 'Annuler l’abonnement' }).click();
    await page.getByText('Écrans à garder actifs (0 / 1)').waitFor();
    const confirm = page.getByRole('button', { name: 'Confirmer l’annulation' });
    expect(await confirm.isDisabled()).toBe(true);
    await page.getByLabel('Vitrine').check();
    await page.screenshot({
      path: resolve(output, '42-abonnement-annulation.png'),
      fullPage: true,
    });
    await confirm.click();
    await page.getByText(/Annulation programmée au .* · 1 écran\(s\) conservé\(s\)/).waitFor();
    await page.getByRole('button', { name: 'Renoncer' }).waitFor();
    expect(errors).toEqual([]);
  }, 120_000);
});
