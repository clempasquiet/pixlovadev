import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyManifest } from '@pixlova/contracts';
import { skipDatabaseTests } from '@pixlova/db/testing';
import { login, NetworkPlayer, output, register, startStack, type Stack } from './support.js';

describe.skipIf(skipDatabaseTests)(
  'playlists, planning, diffusion immédiate et suivi (L05)',
  () => {
    let stack: Stack;
    let files: string;

    beforeAll(async () => {
      stack = await startStack();
      files = await mkdtemp(join(tmpdir(), 'pixlova-e2e-prog-'));
      await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#1d3557' } })
        .png()
        .toFile(join(files, 'accueil.png'));
      await sharp({ create: { width: 1920, height: 1080, channels: 3, background: '#e63946' } })
        .png()
        .toFile(join(files, 'alerte.png'));
    }, 120_000);
    afterAll(async () => {
      await stack?.close();
      if (files) await rm(files, { recursive: true, force: true });
    });

    it('publie une playlist planifiée, suit désiré/préparé/appliqué et explique un override', async () => {
      const page = await stack.browser.newPage({ viewport: { width: 1500, height: 1000 } });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await register(stack, page, 'programmation@e2e.test', 'Camille');
        await page.goto(`${stack.base}/login`);
        await login(page, 'programmation@e2e.test');
        await page.getByLabel('Nom de l’organisation').fill('Café des Arts');
        await page.getByLabel('Fuseau horaire').fill('Europe/Paris');
        await page.getByRole('button', { name: 'Créer l’organisation' }).click();
        await page.getByRole('heading', { name: 'Café des Arts' }).waitFor();

        // Deux images prêtes.
        await page.getByRole('link', { name: 'Bibliothèque' }).click();
        await page
          .getByLabel('Fichiers à envoyer')
          .setInputFiles([join(files, 'accueil.png'), join(files, 'alerte.png')]);
        await expect
          .poll(() => page.getByRole('list', { name: 'Médias' }).getByText('Prêt').count(), {
            timeout: 60_000,
          })
          .toBe(2);

        // Player appairé et écran affecté.
        const player = new NetworkPlayer(stack.apiUrl);
        const code = await player.register();
        await page.getByRole('link', { name: 'Players' }).click();
        await page.getByLabel('Code d’appairage').fill(code);
        await page.getByLabel('Nom du Player').fill('Mini-PC salle');
        await page.getByRole('button', { name: 'Appairer' }).click();
        await page.getByText('Player « Mini-PC salle » appairé').waitFor();
        await player.connect();
        await page.getByRole('link', { name: 'Écrans' }).click();
        await page.getByLabel('Nom', { exact: true }).fill('Écran salle');
        await page.getByRole('button', { name: 'Créer le Display' }).click();
        await page.getByRole('heading', { name: 'Écran salle' }).waitFor();
        await page.getByRole('button', { name: 'Affecter' }).click();
        await page.getByText('Mini-PC salle · sortie HDMI-A-1').waitFor();
        const displayUrl = page.url();
        const displayId = displayUrl.split('/').pop()!;

        // Playlist : une image, 10 s par défaut, publiée.
        await page.getByRole('link', { name: 'Playlists' }).click();
        await page.getByLabel('Nom').fill('Accueil');
        await page.getByRole('button', { name: 'Créer la playlist' }).click();
        await page.getByRole('heading', { name: 'Accueil', level: 1 }).waitFor();
        await page.getByRole('button', { name: '+ Ajouter un contenu' }).click();
        await page.getByRole('button', { name: 'Utiliser accueil.png' }).click();
        await page.getByRole('table', { name: 'Éléments de la playlist' }).waitFor();
        expect(await page.getByLabel('Durée de l’élément 1 en secondes').inputValue()).toBe('10');
        await page.getByRole('button', { name: 'Publier' }).click();
        await page.getByText('Version 1 publiée').waitFor();
        await page.screenshot({ path: resolve(output, '30-playlist.png'), fullPage: true });

        // Planning toute la journée, toute l’organisation.
        await page.getByRole('link', { name: 'Plannings' }).click();
        await page.getByLabel('Nom').fill('Semaine');
        await page.getByRole('button', { name: 'Créer' }).click();
        await page.getByRole('heading', { name: 'Semaine', level: 1 }).waitFor();
        await page.getByRole('button', { name: '+ Ajouter un créneau' }).click();
        await page.getByRole('dialog').getByRole('tab', { name: 'Playlists' }).click();
        await page.getByRole('dialog').getByRole('button', { name: 'Accueil' }).click();
        await page.getByLabel('Début du créneau 1').fill('00:00');
        await page.getByText('jusqu’à minuit').click();
        await page.getByRole('button', { name: 'Inclure' }).click();
        await page.getByRole('button', { name: 'Publier' }).click();
        await page.getByText('publiée pour 1 écran(s)').waitFor();
        await page.screenshot({ path: resolve(output, '31-planning.png'), fullPage: true });

        // Le worker compile ; le Player reçoit un manifest signé et le déclare appliqué.
        let raw: string | null = null;
        await expect
          .poll(async () => (raw = await player.manifest(displayId)) !== null, { timeout: 30_000 })
          .toBe(true);
        const verified = verifyManifest(
          raw!,
          new Map([[stack.signer.kid, stack.signer.publicKey]]),
        );
        expect(verified.ok).toBe(true);
        if (!verified.ok) return;
        expect(verified.manifest.timeline[0]!.source.type).toBe('schedule');
        await page.goto(displayUrl);
        await page
          .getByRole('table', { name: 'Programme expliqué' })
          .getByText('Planning « Semaine »')
          .first()
          .waitFor();
        await page.getByText('Europe/Paris', { exact: true }).first().waitFor();
        const states = page.getByRole('table', { name: 'États de diffusion' });
        await states.getByText('Reçu par le Player').waitFor();
        expect(await states.getByRole('row', { name: /Appliquée/ }).innerText()).toContain(
          'Aucune',
        );
        await player.report(verified.manifest.manifest_id, 'ready');
        await player.report(verified.manifest.manifest_id, 'applied');
        await page.getByRole('button', { name: 'Actualiser' }).click();
        await states
          .getByRole('row', { name: /Appliquée/ })
          .getByText(`Version ${verified.manifest.version}`)
          .waitFor();

        // Diffuser maintenant : l’override l’emporte, le planning est masqué et expliqué.
        await page.getByText('Contenu interrompu sur cet écran : Accueil').waitFor();
        await page.getByRole('button', { name: 'Choisir', exact: true }).first().click();
        await page.getByRole('button', { name: 'Utiliser alerte.png' }).click();
        await page.getByLabel('Durée de la diffusion').selectOption('15');
        await page.getByRole('button', { name: 'Diffuser', exact: true }).click();
        await page.getByText('Retour à la programmation le').waitFor();
        await page.reload();
        const explanation = page.getByRole('table', { name: 'Programme expliqué' });
        await explanation
          .getByText(/Diffusion immédiate «/)
          .first()
          .waitFor();
        await explanation
          .getByText(/Planning « Semaine » \(priorité 10\) : priorité inférieure/)
          .first()
          .waitFor();
        await page.screenshot({
          path: resolve(output, '32-programme-explique.png'),
          fullPage: true,
        });

        // Nouveau manifest désiré pour l’override, distinct de la version appliquée.
        await expect
          .poll(async () => (await player.config()).assignments[0]?.manifest_version, {
            timeout: 30_000,
          })
          .not.toBe(verified.manifest.version);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 240_000);
  },
);
