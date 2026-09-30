/**
 * Parcours du parc dans Chromium (TST-011, TST-018 côté interface) : appairage par code
 * saisi dans le dashboard, Display LED, affectation, présence, remplacement du Player
 * avec conservation du Display et de son historique.
 */
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { skipDatabaseTests } from '@pixlova/db/testing';
import { login, NetworkPlayer, output, register, startStack, type Stack } from './support.js';

describe.skipIf(skipDatabaseTests)(
  'dashboard : appairage, Display et remplacement du Player',
  () => {
    let stack: Stack;
    beforeAll(async () => {
      stack = await startStack();
    }, 120_000);
    afterAll(async () => {
      await stack?.close();
    });

    it('appaire deux Players, affecte un bandeau LED puis remplace le Player sans perdre le Display', async () => {
      const page = await stack.browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await register(stack, page, 'tech@pixlova.test', 'Tech');
      await page.goto(`${stack.base}/login`);
      await login(page, 'tech@pixlova.test');
      await page.getByLabel('Nom de l’organisation').fill('Galerie marchande');
      await page.getByLabel('Fuseau horaire').fill('Europe/Paris');
      await page.getByRole('button', { name: 'Créer l’organisation' }).click();
      await page.getByRole('heading', { name: 'Galerie marchande' }).waitFor();

      const first = new NetworkPlayer(stack.apiUrl);
      const code = await first.register();
      await page.getByRole('link', { name: 'Players' }).click();
      await page.getByLabel('Code d’appairage').fill(code.toLowerCase());
      await page.getByLabel('Nom du Player').fill('Mini-PC entrée');
      await page.getByRole('button', { name: 'Appairer' }).click();
      await page.getByText('Player « Mini-PC entrée » appairé').waitFor();
      await first.connect();
      await first.heartbeat();

      await page.getByRole('link', { name: 'Écrans' }).click();
      await page.getByText('Displays actifs : 0 / 5 licence(s)').waitFor();
      await page.getByLabel('Nom', { exact: true }).fill('Bandeau entrée');
      await page.getByLabel('Format').selectOption({ label: 'Bandeau LED 2688×672' });
      await page.getByRole('button', { name: 'Créer le Display' }).click();
      await page.getByRole('heading', { name: 'Bandeau entrée' }).waitFor();
      await page.getByText('2688×672 px').waitFor();
      await page.getByRole('button', { name: 'Affecter' }).click();
      await page.getByText('Mini-PC entrée · sortie HDMI-A-1').waitFor();
      await page.getByText('En ligne').waitFor();
      expect((await first.config()).assignments.map((a) => a.assignment_generation)).toEqual(['1']);
      await page.screenshot({ path: resolve(output, '10-display-affecte.png'), fullPage: true });

      const second = new NetworkPlayer(stack.apiUrl);
      const secondCode = await second.register();
      await page.getByRole('link', { name: 'Players' }).click();
      await page.getByLabel('Code d’appairage').fill(secondCode);
      await page.getByLabel('Nom du Player').fill('Mini-PC remplacement');
      await page.getByRole('button', { name: 'Appairer' }).click();
      await page.getByText('Player « Mini-PC remplacement » appairé').waitFor();
      await second.connect();

      await page.getByRole('link', { name: 'Écrans' }).click();
      await page.getByRole('link', { name: 'Bandeau entrée' }).click();
      await page.getByLabel('Sortie').selectOption({ label: 'Mini-PC remplacement · HDMI-A-1' });
      page.once('dialog', (dialog) => void dialog.accept());
      await page.getByRole('button', { name: 'Remplacer le Player' }).click();
      await page.getByText('Mini-PC remplacement · sortie HDMI-A-1').waitFor();
      const rows = page.locator('table tbody tr');
      await expect.poll(() => rows.count()).toBe(2);
      await page.screenshot({ path: resolve(output, '11-player-remplace.png'), fullPage: true });

      expect((await first.config()).assignments).toEqual([]);
      expect((await second.config()).assignments.map((a) => a.assignment_generation)).toEqual([
        '2',
      ]);
      expect(errors).toEqual([]);
    }, 120_000);
  },
);
