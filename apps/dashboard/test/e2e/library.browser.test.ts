import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { skipDatabaseTests } from '@pixlova/db/testing';
import { login, output, register, startStack, type Stack } from './support.js';

describe.skipIf(skipDatabaseTests)('bibliothèque média dans le navigateur (L03)', () => {
  let stack: Stack;
  let files: string;

  beforeAll(async () => {
    stack = await startStack();
    files = await mkdtemp(join(tmpdir(), 'pixlova-e2e-files-'));
    await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#1b7f79' } })
      .jpeg()
      .toFile(join(files, 'vitrine.jpg'));
    await sharp({ create: { width: 2688, height: 672, channels: 3, background: '#ffaa00' } })
      .png()
      .toFile(join(files, 'bandeau-led.png'));
  }, 120_000);
  afterAll(async () => {
    await stack?.close();
    if (files) await rm(files, { recursive: true, force: true });
  });

  it('envoi multiple, préparation suivie, dossiers, corbeille et restauration', async () => {
    const page = await stack.browser.newPage();
    try {
      await register(stack, page, 'media@e2e.test', 'Camille');
      await page.goto(`${stack.base}/login`);
      await login(page, 'media@e2e.test');
      await page.getByLabel('Nom de l’organisation').fill('Boutique Média');
      await page.getByLabel('Fuseau horaire').fill('Europe/Paris');
      await page.getByRole('button', { name: 'Créer l’organisation' }).click();
      await page.getByRole('heading', { name: 'Boutique Média' }).waitFor();
      await page.getByRole('link', { name: 'Bibliothèque' }).click();
      await page.getByRole('heading', { name: 'Bibliothèque' }).waitFor();
      await page
        .getByText('La corbeille est vide.')
        .or(page.getByText('Aucun média ici pour le moment.'))
        .waitFor();

      await page.getByLabel('Nouveau dossier').fill('Vitrines');
      await page.getByRole('button', { name: 'Créer' }).click();
      await page
        .getByRole('navigation', { name: 'Dossiers' })
        .getByRole('button', { name: 'Vitrines' })
        .click();

      await page
        .getByLabel('Fichiers à envoyer')
        .setInputFiles([join(files, 'vitrine.jpg'), join(files, 'bandeau-led.png')]);
      const grid = page.getByRole('list', { name: 'Médias' });
      await grid.getByText('Prêt').nth(1).waitFor({ timeout: 30_000 });
      await expect.poll(() => grid.getByRole('listitem').count()).toBe(2);
      await grid.getByText('Image · 2688×672').waitFor();
      // Vignettes servies par URL signée à travers le proxy du dashboard.
      const loaded = await grid
        .locator('img')
        .evaluateAll((images) => images.map((img) => (img as HTMLImageElement).naturalWidth));
      expect(loaded.every((width) => width > 0)).toBe(true);
      await page.getByText('Stockage :').waitFor();

      await page.getByRole('button', { name: 'Ouvrir bandeau-led.png' }).click();
      const panel = page.getByRole('complementary', { name: 'Détail du média' });
      await panel.getByRole('cell', { name: 'Diffusion' }).waitFor();
      await panel.getByLabel('Tags').fill('LED, soldes');
      await panel.getByRole('button', { name: 'Enregistrer' }).click();
      await page.getByLabel('Filtrer par tag').selectOption('soldes');
      await expect.poll(() => grid.getByRole('listitem').count()).toBe(1);
      await page.getByLabel('Filtrer par tag').selectOption('');

      page.once('dialog', (dialog) => void dialog.accept());
      await panel.getByRole('button', { name: 'Mettre à la corbeille' }).click();
      await expect.poll(() => grid.getByRole('listitem').count()).toBe(1);
      await page.getByRole('tab', { name: 'Corbeille' }).click();
      const trash = page.getByRole('list', { name: 'Corbeille' });
      await trash.getByText('bandeau-led.png').waitFor();
      await page.screenshot({ path: resolve(output, 'library-trash.png'), fullPage: true });
      await trash.getByRole('button', { name: 'Ouvrir bandeau-led.png' }).click();
      await page.getByRole('button', { name: 'Restaurer' }).click();
      await page.getByRole('tab', { name: 'Médias' }).click();
      await page
        .getByRole('navigation', { name: 'Dossiers' })
        .getByRole('button', { name: 'Tous les médias' })
        .click();
      await expect
        .poll(() => page.getByRole('list', { name: 'Médias' }).getByRole('listitem').count())
        .toBe(2);
      await page.screenshot({ path: resolve(output, 'library.png'), fullPage: true });
    } finally {
      await page.close();
    }
  }, 120_000);
});
