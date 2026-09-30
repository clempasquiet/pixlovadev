/**
 * Supervision dans Chromium (L07, ADR-014) : signaux distincts d’un écran, commande signée
 * exécutée par un Player simulé avec transport et résultat séparés, capture demandée,
 * envoyée puis consultée, incident affiché et fenêtre de maintenance planifiée.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publicKeyFromSecret, verifyCommand, type CommandPayload } from '@pixlova/contracts';
import { schema } from '@pixlova/db';
import { skipDatabaseTests } from '@pixlova/db/testing';
import { login, NetworkPlayer, output, register, startStack, type Stack } from './support.js';

const instant = () => new Date().toISOString().replace(/\.[0-9]{3}Z$/, 'Z');

describe.skipIf(skipDatabaseTests)('dashboard : supervision, commandes et captures', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  }, 120_000);
  afterAll(async () => {
    await stack?.close();
  });

  /** Récupère et vérifie les commandes comme un Player, avec la clé publique de confiance. */
  async function fetchCommands(player: NetworkPlayer): Promise<CommandPayload[]> {
    const key = stack.test.services.supervision.commandKey!;
    const trust = new Map([[key.kid, publicKeyFromSecret(key.secretKey)]]);
    const { commands } = await player.call<{ commands: string[] }>('GET', '/commands');
    return commands.map((raw) => {
      const verified = verifyCommand(raw, trust);
      if (!verified.ok) throw new Error(verified.detail);
      return verified.command;
    });
  }

  it('présente les signaux, exécute une commande et affiche une capture datée', async () => {
    const page = await stack.browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await register(stack, page, 'ops@pixlova.test', 'Ops');
    await page.goto(`${stack.base}/login`);
    await login(page, 'ops@pixlova.test');
    await page.getByLabel('Nom de l’organisation').fill('Réseau de boutiques');
    await page.getByLabel('Fuseau horaire').fill('Europe/Paris');
    await page.getByRole('button', { name: 'Créer l’organisation' }).click();
    await page.getByRole('heading', { name: 'Réseau de boutiques' }).waitFor();

    const player = new NetworkPlayer(stack.apiUrl);
    const code = await player.register();
    await page.getByRole('link', { name: 'Players' }).click();
    await page.getByLabel('Code d’appairage').fill(code);
    await page.getByLabel('Nom du Player').fill('Mini-PC vitrine');
    await page.getByRole('button', { name: 'Appairer' }).click();
    await page.getByText('Player « Mini-PC vitrine » appairé').waitFor();
    await player.connect();
    await page.getByRole('link', { name: 'Écrans' }).click();
    await page.getByLabel('Nom', { exact: true }).fill('Vitrine');
    await page.getByRole('button', { name: 'Créer le Display' }).click();
    await page.getByRole('heading', { name: 'Vitrine' }).waitFor();
    await page.getByRole('button', { name: 'Affecter' }).click();
    await page.getByText('Mini-PC vitrine · sortie HDMI-A-1').waitFor();
    const displayId = page.url().split('/').pop()!;
    await player.heartbeat([{ display_id: displayId, assignment_generation: '1' }]);
    await player.call('POST', '/status', {
      observed_at: instant(),
      renderer: 'ok',
      renderer_restarts: 0,
      storage_persistent: null,
      metrics: {
        cpu_percent: null,
        memory_used_bytes: 2_000_000_000,
        memory_total_bytes: 8_000_000_000,
        disk_free_bytes: 40_000_000_000,
        disk_total_bytes: 64_000_000_000,
        temperature_c: null,
      },
      cache: null,
      outputs: [
        { output_key: 'HDMI-A-1', connected: true, width: 1920, height: 1080, refresh_hz: 60 },
      ],
    });
    await page.reload();

    // Signaux distincts et datés.
    const presence = page.getByLabel('Présence');
    await presence.getByText('En ligne').waitFor();
    await page
      .getByLabel('Santé du Player')
      .getByText('Disque libre : 40.0 Go sur 64.0 Go')
      .waitFor();
    await page.getByLabel('Rendu').getByText('Lecture').waitFor();
    await page.getByLabel('Sortie', { exact: true }).getByText('HDMI-A-1 : détectée').waitFor();

    // Commande : transmise, reçue, puis réussie — trois étapes visibles séparément.
    await page.getByRole('button', { name: 'Demander le statut' }).click();
    const commands = page.getByRole('table', { name: 'Commandes récentes' });
    await commands.getByText('En attente de récupération').waitFor();
    expect((await player.heartbeat()).pending_commands).toBe(1);
    const [command] = await fetchCommands(player);
    expect(command).toMatchObject({ type: 'GET_STATUS', player_id: player.playerId });
    await player.call('POST', `/commands/${command!.command_id}/ack`, {
      acknowledged_at: instant(),
    });
    await page.getByRole('button', { name: 'Mettre à jour les commandes' }).click();
    await commands.getByText('Reçue par le Player').waitFor();
    await player.call('POST', `/commands/${command!.command_id}/result`, {
      command_id: command!.command_id,
      status: 'success',
      finished_at: instant(),
      code: null,
      detail: null,
    });
    await page.getByRole('button', { name: 'Mettre à jour les commandes' }).click();
    await commands.getByText('Réussie').waitFor();

    // Capture : demandée, envoyée par le Player, consultée (URL courte, consultation auditée).
    await page.getByRole('button', { name: 'Demander une capture' }).click();
    await page
      .getByLabel('Captures')
      .getByText(/Demandée/)
      .waitFor();
    const [shot] = (await fetchCommands(player)).filter((c) => c.type === 'TAKE_SCREENSHOT');
    const png = await sharp({
      create: { width: 480, height: 270, channels: 3, background: '#1d6fb8' },
    })
      .png()
      .toBuffer();
    const screenshotId = (shot!.params as { screenshot_id: string }).screenshot_id;
    const session = await player.call<{ upload: { url: string; headers: Record<string, string> } }>(
      'POST',
      '/screenshots/upload-session',
      {
        command_id: shot!.command_id,
        screenshot_id: screenshotId,
        mime_type: 'image/png',
        size_bytes: png.length,
        sha256: createHash('sha256').update(png).digest('hex'),
        captured_at: instant(),
      },
    );
    const put = await fetch(`${stack.apiUrl}${session.upload.url}`, {
      method: 'PUT',
      headers: session.upload.headers,
      body: png,
    });
    expect(put.ok).toBe(true);
    await player.call('POST', `/screenshots/${screenshotId}/complete`);
    await player.call('POST', `/commands/${shot!.command_id}/result`, {
      command_id: shot!.command_id,
      status: 'success',
      finished_at: instant(),
      code: null,
      detail: null,
    });
    await page.reload();
    await page.getByRole('button', { name: /Capture du/ }).click();
    const image = page.getByRole('img', { name: /Capture du renderer/ });
    await image.waitFor();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480);
    await page.getByText('image du renderer, pas un flux direct').waitFor();
    await page.screenshot({ path: resolve(output, '40-supervision-ecran.png'), fullPage: true });

    // Chronologie : commande et capture tracées.
    const timeline = page.getByRole('table', { name: 'Chronologie' });
    await timeline.getByText('Commande terminée · Réussie').first().waitFor();
    await timeline.getByText('Capture reçue').waitFor();

    // Incident ouvert par le worker (simulé ici) : visible sur l’écran et dans la liste.
    const { organizationId } = (
      await stack.database.system
        .select({ id: schema.displays.id, organizationId: schema.displays.organizationId })
        .from(schema.displays)
    ).find((row) => row.id === displayId)!;
    await stack.database.system.insert(schema.alerts).values({
      organizationId,
      rule: 'delivery_failed',
      severity: 'error',
      targetType: 'display',
      targetId: displayId,
      siteId: null,
      openedAt: new Date(),
      details: { name: 'Vitrine' },
    });
    await page.reload();
    await page.getByLabel('Incidents ouverts').getByText('Échec de préparation').waitFor();
    await page.getByRole('link', { name: 'Incidents' }).click();
    await page.getByRole('table', { name: 'Incidents' }).getByText('Vitrine').waitFor();
    await page.getByLabel('Portée').selectOption({ label: 'Vitrine' });
    await page.getByLabel('Motif').fill('Remplacement de la dalle');
    await page.getByRole('button', { name: 'Planifier la maintenance' }).click();
    await page
      .getByLabel('Fenêtres de maintenance')
      .getByText(/Remplacement de la dalle/)
      .waitFor();
    await page.screenshot({
      path: resolve(output, '41-incidents-maintenance.png'),
      fullPage: true,
    });

    // Vue du parc : un signal par colonne.
    await page.getByRole('link', { name: 'Supervision' }).click();
    const overview = page.getByRole('table', { name: 'Vue du parc' });
    await overview.getByRole('link', { name: 'Vitrine' }).waitFor();
    await overview.getByText('En ligne').waitFor();
    await page.screenshot({ path: resolve(output, '42-vue-parc.png'), fullPage: true });
    expect(errors).toEqual([]);
  }, 180_000);
});
