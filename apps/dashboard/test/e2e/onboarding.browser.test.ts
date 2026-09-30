/**
 * Parcours de bout en bout (TST-010 partiel, TST-021) dans Chromium headless, contre l’API
 * réelle et PostgreSQL : inscription → vérification → connexion → organisation → site →
 * invitation → acceptation par un second compte → droits limités → audit.
 */
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { preview, type PreviewServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPublicApp } from '@pixlova/api';
import { createTestServices, type TestServices } from '@pixlova/api/testing';
import { createTestDatabase, skipDatabaseTests, type TestDatabase } from '@pixlova/db/testing';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, 'test-results');
const PASSWORD = 'une phrase de passe assez longue';

describe.skipIf(skipDatabaseTests)('dashboard : premier parcours dans un vrai navigateur', () => {
  let database: TestDatabase;
  let test: TestServices;
  let api: ReturnType<typeof buildPublicApp>;
  let server: PreviewServer;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    test = createTestServices(database, { cookieSecure: false });
    test.setMaxUsers(5);
    api = buildPublicApp({ services: test.services });
    await api.listen({ host: '127.0.0.1', port: 0 });
    process.env.PIXLOVA_API_URL = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;
    server = await preview({
      root,
      logLevel: 'silent',
      preview: { port: 0, strictPort: false, host: '127.0.0.1' },
    });
    base = server.resolvedUrls!.local[0]!.replace(/\/$/, '');
    // L’origine réelle du dashboard n’est connue qu’après démarrage.
    test.services.security.allowedOrigins = [base];
    test.services.security.appBaseUrl = base;
    browser = await chromium.launch();
    await mkdir(output, { recursive: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    await api?.close();
    await database?.close();
  });

  async function emailLink(to: string, path: string): Promise<string> {
    await test.flushEmails();
    const link = test.mailer.linkFor(to, path);
    if (!link) throw new Error(`Aucun lien ${path} pour ${to}`);
    return link;
  }

  async function register(page: Page, email: string, name: string) {
    await page.goto(`${base}/register`);
    await page.getByLabel('Nom affiché').fill(name);
    await page.getByLabel('Adresse email').fill(email);
    await page.getByLabel('Mot de passe').fill(PASSWORD);
    await page.getByRole('button', { name: 'Créer mon compte' }).click();
    await page.getByRole('heading', { name: 'Vérifiez votre boîte mail' }).waitFor();
    await page.goto(await emailLink(email, '/verify-email'));
    await page.getByText('Adresse confirmée').waitFor();
  }

  async function login(page: Page, email: string) {
    await page.getByLabel('Adresse email').fill(email);
    await page.getByLabel('Mot de passe').fill(PASSWORD);
    await page.getByRole('button', { name: 'Se connecter' }).click();
  }

  it('crée une organisation, invite un gestionnaire de contenus limité à un site et trace les actions', async () => {
    const owner = await browser.newPage();
    const pageErrors: string[] = [];
    owner.on('pageerror', (error) => pageErrors.push(error.message));

    await register(owner, 'owner@pixlova.test', 'Zoé');
    await owner.goto(`${base}/login`);
    await login(owner, 'owner@pixlova.test');
    await owner.getByRole('heading', { name: 'Créer une organisation' }).waitFor();
    await owner.getByLabel('Nom de l’organisation').fill('Crêperie Chez Zoé');
    await owner.getByLabel('Fuseau horaire').fill('Europe/Paris');
    await owner.getByRole('button', { name: 'Créer l’organisation' }).click();
    await owner.getByRole('heading', { name: 'Crêperie Chez Zoé' }).waitFor();
    await expect(owner.getByText('Propriétaire — toute l’organisation').isVisible()).resolves.toBe(
      true,
    );
    await owner.screenshot({ path: resolve(output, '01-tableau-de-bord.png'), fullPage: true });

    await owner.getByRole('link', { name: 'Sites' }).click();
    await owner.getByLabel('Nom du site').fill('Boutique Lyon');
    await owner.getByRole('button', { name: 'Ajouter' }).click();
    await owner.getByRole('cell', { name: 'Boutique Lyon' }).waitFor();

    await owner.getByRole('link', { name: 'Membres' }).click();
    await owner.getByLabel('Adresse email').fill('carla@pixlova.test');
    await owner.getByLabel('Rôle').selectOption('ContentManager');
    await owner.getByLabel('Périmètre').selectOption({ label: 'Site : Boutique Lyon' });
    await owner.getByRole('button', { name: 'Envoyer l’invitation' }).click();
    await owner.getByRole('cell', { name: 'carla@pixlova.test' }).waitFor();
    await owner.screenshot({ path: resolve(output, '02-membres.png'), fullPage: true });

    const invitation = await emailLink('carla@pixlova.test', '/invitations/accept');
    const carla = await (await browser.newContext()).newPage();
    await register(carla, 'carla@pixlova.test', 'Carla');
    await carla.goto(invitation);
    await carla.getByRole('link', { name: 'Se connecter' }).click();
    await login(carla, 'carla@pixlova.test');
    await carla.getByRole('button', { name: 'Accepter l’invitation' }).click();
    await carla.getByRole('heading', { name: 'Crêperie Chez Zoé' }).waitFor();
    await carla.getByText('Gestionnaire de contenus — 1 site(s)').waitFor();
    await carla.getByRole('link', { name: 'Membres' }).click();
    await carla.getByText('La liste des membres est réservée').waitFor();
    await carla.getByRole('link', { name: 'Sites' }).click();
    await carla.getByRole('cell', { name: 'Boutique Lyon' }).waitFor();
    expect(await carla.getByRole('cell', { name: 'Site principal' }).count()).toBe(0);
    await carla.screenshot({ path: resolve(output, '03-contenus-limite.png'), fullPage: true });

    await owner.getByRole('link', { name: 'Journal d’audit' }).click();
    await owner.getByRole('cell', { name: 'invitation.accepted' }).waitFor();
    await owner.screenshot({ path: resolve(output, '04-audit.png'), fullPage: true });
    expect(pageErrors).toEqual([]);
  }, 120_000);

  it('redirige une personne non connectée vers la connexion', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${base}/members`);
    await page.getByRole('heading', { name: 'Connexion' }).waitFor();
    expect(new URL(page.url()).searchParams.get('next')).toBe('/members');
  }, 60_000);
});
