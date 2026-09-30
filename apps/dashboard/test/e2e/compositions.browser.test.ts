import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { skipDatabaseTests } from '@pixlova/db/testing';
import { login, output, register, startStack, type Stack } from './support.js';

describe.skipIf(skipDatabaseTests)('créateur de compositions et modèles (L04)', () => {
  let stack: Stack;
  let files: string;

  beforeAll(async () => {
    stack = await startStack();
    files = await mkdtemp(join(tmpdir(), 'pixlova-e2e-compo-'));
    await sharp({ create: { width: 800, height: 800, channels: 3, background: '#e63946' } })
      .png()
      .toFile(join(files, 'logo.png'));
  }, 120_000);
  afterAll(async () => {
    await stack?.close();
    if (files) await rm(files, { recursive: true, force: true });
  });

  it('bandeau LED : édition directe, média, annulation, publication, preview ; modèles selon l’offre', async () => {
    const page = await stack.browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await register(stack, page, 'createur@e2e.test', 'Alex');
      await page.goto(`${stack.base}/login`);
      await login(page, 'createur@e2e.test');
      await page.getByLabel('Nom de l’organisation').fill('Boutique LED');
      await page.getByLabel('Fuseau horaire').fill('Europe/Paris');
      await page.getByRole('button', { name: 'Créer l’organisation' }).click();
      await page.getByRole('heading', { name: 'Boutique LED' }).waitFor();

      // Offre gratuite : modèles prévisualisables, non utilisables.
      await page.getByRole('link', { name: 'Modèles' }).click();
      await page.getByText('Les modèles sont inclus dans les offres payantes.').waitFor();
      const firstTemplate = page
        .getByRole('list', { name: 'Modèles' })
        .getByRole('listitem')
        .first();
      await expect.poll(() => firstTemplate.locator('[data-composition]').count()).toBe(1);
      expect(
        await firstTemplate.getByRole('button', { name: 'Utiliser ce modèle' }).isDisabled(),
      ).toBe(true);

      // Un logo prêt dans la bibliothèque.
      await page.getByRole('link', { name: 'Bibliothèque' }).click();
      await page.getByLabel('Fichiers à envoyer').setInputFiles(join(files, 'logo.png'));
      await page
        .getByRole('list', { name: 'Médias' })
        .getByText('Prêt')
        .waitFor({ timeout: 30_000 });

      // Nouvelle composition LED 2688×672.
      await page.getByRole('link', { name: 'Compositions' }).click();
      await page.getByLabel('Nom').fill('Soldes vitrine');
      await page.getByLabel('Format').selectOption({ label: 'Bandeau LED 2688×672' });
      await page.getByRole('button', { name: 'Créer et ouvrir le créateur' }).click();
      await page.getByRole('heading', { name: 'Soldes vitrine' }).waitFor();
      await page.getByText('2688×672 px').waitFor();

      await page.getByRole('button', { name: '+ Texte' }).click();
      const props = page.getByRole('complementary', { name: 'Propriétés' });
      await props.getByLabel('Texte', { exact: true }).fill('Soldes d’hiver');
      await props.getByLabel('Police').selectOption('Montserrat');
      const x = props.getByLabel('X (px)');
      const before = Number(await x.inputValue());

      // Déplacement direct sur le canvas (glisser).
      const box = page.locator('.box-selected');
      const bounds = (await box.boundingBox())!;
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 + 120, bounds.y + bounds.height / 2, {
        steps: 8,
      });
      await page.mouse.up();
      const moved = Number(await x.inputValue());
      expect(moved).toBeGreaterThan(before);

      // Annuler le déplacement (une seule entrée d’historique), puis rétablir.
      await page.getByRole('button', { name: 'Annuler' }).click();
      expect(Number(await x.inputValue())).toBe(before);
      await page.getByRole('button', { name: 'Rétablir' }).click();
      expect(Number(await x.inputValue())).toBe(moved);

      // Image choisie dans la bibliothèque (médias prêts seulement).
      await page.getByRole('button', { name: '+ Image' }).click();
      await page.getByRole('button', { name: 'Utiliser logo.png' }).click();
      await page
        .getByRole('complementary', { name: 'Calques' })
        .getByText('Image image-2')
        .waitFor();

      // Rendu par le moteur partagé : texte dans la police empaquetée.
      const text = page.locator('[data-element-type="text"]').first();
      await expect.poll(() => text.textContent()).toBe('Soldes d’hiver');
      // Le canvas se reconstruit quand l’aperçu de l’image arrive : relire jusqu’à obtenir le
      // nœud stable (un nœud détaché a un style calculé vide).
      await expect
        .poll(() => text.evaluate((node) => getComputedStyle(node).fontFamily))
        .toContain('Montserrat Variable');
      await expect
        .poll(() => page.evaluate(() => document.fonts.check('800 40px "Montserrat Variable"')))
        .toBe(true);

      await page.getByRole('button', { name: 'Enregistrer' }).click();
      await page.getByText('Brouillon enregistré.').waitFor();
      await page.getByRole('button', { name: 'Publier' }).click();
      await page.getByText('Version 1 publiée.').waitFor();
      await page.getByText('version publiée 1').waitFor();
      await page.screenshot({ path: resolve(output, 'createur-led.png'), fullPage: true });

      // Preview sur un format personnalisé (canvas libre, sans hypothèse 16:9).
      await page.getByRole('button', { name: 'Prévisualiser' }).click();
      const preview = page.getByRole('dialog', { name: 'Prévisualisation' });
      await preview.getByLabel('Profil de prévisualisation').selectOption('custom');
      await preview.getByLabel('Largeur personnalisée').fill('1080');
      await preview.getByLabel('Hauteur personnalisée').fill('1920');
      await preview.getByText('des bandes apparaîtront').waitFor();
      await page.screenshot({ path: resolve(output, 'createur-preview.png') });
      await preview.getByRole('button', { name: 'Fermer' }).click();

      // Offre avec modèles : la composition créée signale le logo à choisir.
      stack.test.setFeatures(['templates']);
      await page.getByRole('link', { name: 'Modèles' }).click();
      const led = page.getByRole('listitem').filter({ hasText: 'Bandeau LED promotion' });
      await led.getByRole('button', { name: 'Utiliser ce modèle' }).click();
      const dialog = page.getByRole('dialog', { name: 'Utiliser le modèle Bandeau LED promotion' });
      await dialog.getByLabel('Message').fill('Braderie de printemps');
      await dialog.getByRole('button', { name: 'Créer la composition' }).click();
      await page.getByRole('heading', { name: 'Bandeau LED promotion', level: 1 }).waitFor();
      await page
        .getByRole('complementary', { name: 'Calques' })
        .getByText(/Choisissez un média/)
        .waitFor();
      expect(await page.getByRole('button', { name: 'Publier' }).isDisabled()).toBe(true);
      await expect
        .poll(() => page.locator('[data-element-type="text"]').first().textContent())
        .toBe('Braderie de printemps');
      await page.screenshot({ path: resolve(output, 'createur-modele.png'), fullPage: true });
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 180_000);
});
