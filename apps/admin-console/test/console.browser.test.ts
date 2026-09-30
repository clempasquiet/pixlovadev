/**
 * Console d’administration dans Chromium (L09-A) : serveur d’administration réel servant
 * le build, PostgreSQL réel. Activation d’un SuperAdmin avec TOTP, consultation motivée
 * d’une organisation, action de support avec ressaisie du second facteur, création d’un
 * opérateur et journal.
 */
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAdminApp, buildPublicApp, DataCipher, MemoryRateLimiter } from '@pixlova/api';
import { createOperator, createTestServices, currentStep, totpAt } from '@pixlova/api/testing';
import { createTestDatabase, skipDatabaseTests, type TestDatabase } from '@pixlova/db/testing';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'test-results');
const PASSWORD = 'phrase de passe opérateur très longue';
const CUSTOMER_PASSWORD = 'une phrase de passe assez longue';

describe.skipIf(skipDatabaseTests)('console d’administration dans un vrai navigateur', () => {
  let database: TestDatabase;
  let admin: ReturnType<typeof buildAdminApp>;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    const test = createTestServices(database, {
      cookieSecure: false,
      allowedOrigins: ['http://client.test'],
      appBaseUrl: 'http://client.test',
    });
    // Client réel : inscription, vérification, organisation.
    const pub = buildPublicApp({ services: test.services });
    let cookie = '';
    const call = async (method: 'GET' | 'POST', url: string, payload?: object) => {
      const response = await pub.inject({
        method,
        url: `/api/v1${url}`,
        ...(payload ? { payload } : {}),
        headers: { origin: 'http://client.test', ...(cookie ? { cookie } : {}) },
      });
      const set = response.headers['set-cookie'];
      if (set) cookie = String(Array.isArray(set) ? set[0] : set).split(';')[0]!;
      return response;
    };
    await call('POST', '/auth/register', {
      email: 'owner@client.test',
      password: CUSTOMER_PASSWORD,
      display_name: 'Owner',
    });
    await test.flushEmails();
    const link = test.mailer.linkFor('owner@client.test', '/verify-email')!;
    await call('POST', '/auth/verify-email', { token: new URL(link).searchParams.get('token') });
    await call('POST', '/auth/login', { email: 'owner@client.test', password: CUSTOMER_PASSWORD });
    await call('POST', '/organizations', {
      name: 'Boulangerie Martin',
      country: 'FR',
      timezone: 'Europe/Paris',
    });
    await pub.close();

    const allowedOrigins: string[] = [];
    admin = buildAdminApp({
      services: {
        platform: database.platform,
        cipher: new DataCipher([{ kid: 'test', key: randomBytes(32) }]),
        limiter: new MemoryRateLimiter(),
        entitlements: test.services.entitlements,
        config: {
          allowedOrigins,
          cookieSecure: false,
          sessionIdleMinutes: 30,
          sessionAbsoluteHours: 8,
          // 3 s : l’action de support du parcours exige une ressaisie du second facteur.
          recentAuthMinutes: 0.05,
          activationHours: 24,
          presenceTimeoutSeconds: 90,
        },
        now: () => new Date(),
      },
      consoleDir: resolve(root, 'dist'),
    });
    await admin.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(admin.server.address() as AddressInfo).port}`;
    // Origine de la console connue une fois le port attribué (protection CSRF).
    allowedOrigins.push(base);
    browser = await chromium.launch();
    await mkdir(output, { recursive: true });
  });

  afterAll(async () => {
    await browser?.close();
    await admin?.close();
    await database?.close();
  });

  it('activation TOTP, consultation motivée, action de support et équipe', async () => {
    const issued = await createOperator(
      database.platform,
      { email: 'root@pixlova.test', displayName: 'Root', roles: ['super_admin'] },
      null,
      new Date(),
      24,
    );
    const page = await (await browser.newContext()).newPage();
    const code = (secret: string, offset: number) =>
      totpAt(secret, currentStep(Date.now()) + offset);

    await page.goto(`${base}/activate`);
    await page.getByLabel('Adresse email').fill('root@pixlova.test');
    await page.getByLabel('Code d’activation').fill(issued.activationCode);
    await page.getByLabel('Nouveau mot de passe').fill(PASSWORD);
    await page.getByRole('button', { name: 'Continuer' }).click();
    const secret = (await page.getByTestId('totp-secret').textContent())!.trim();
    await expect.poll(() => page.getByRole('img', { name: 'QR code TOTP' }).count()).toBe(1);
    await page.getByLabel('Code à 6 chiffres').fill(code(secret, 0));
    await page.getByRole('button', { name: 'Activer' }).click();
    await page.getByRole('heading', { name: 'Santé de la plateforme' }).waitFor();
    await page.getByText('Organisations').first().waitFor();

    // Organisation : motif avant chargement, adresses masquées.
    await page.getByRole('link', { name: 'Organisations' }).click();
    await page.getByRole('link', { name: 'Boulangerie Martin' }).click();
    await page.getByLabel('Motif (ticket, demande client…)').fill('Ticket #1 : écran noir signalé');
    await page.getByRole('button', { name: 'Consulter' }).click();
    await page.getByRole('heading', { name: 'Boulangerie Martin' }).waitFor();
    await page.getByText('ow•••@client.test').waitFor();
    await page.getByText('Abonnements non implémentés (L08).').waitFor();
    await page.getByRole('button', { name: 'Charger le diagnostic du parc' }).click();
    await page.getByText('Aucun Player.').waitFor();

    // Compte client : révocation des sessions après ressaisie du TOTP.
    await page.getByRole('link', { name: 'Comptes clients' }).click();
    await page.getByLabel('Adresse exacte du compte').fill('owner@client.test');
    await page.getByLabel('Motif (ticket, demande client…)').fill('Ticket #2 : appareil perdu');
    await page.getByRole('button', { name: 'Rechercher' }).click();
    await page.getByRole('heading', { name: 'owner@client.test' }).waitFor();
    await page.waitForTimeout(3_500);
    const revoke = page.locator('form', {
      has: page.getByRole('button', { name: 'Révoquer les sessions' }),
    });
    await revoke.getByLabel('Motif (ticket, demande client…)').fill('Ticket #2 : appareil perdu');
    await revoke.getByRole('button', { name: 'Révoquer les sessions' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirmer avec votre second facteur' });
    await dialog.getByLabel('Code à 6 chiffres').fill(code(secret, 1));
    await dialog.getByRole('button', { name: 'Confirmer' }).click();
    await page.getByText('1 session(s) révoquée(s).').waitFor();

    // Équipe : création d’un opérateur Support, code affiché une fois.
    await page.getByRole('link', { name: 'Équipe' }).click();
    await page.getByLabel('Adresse email').fill('support@pixlova.test');
    await page.getByLabel('Nom affiché').fill('Support');
    await page.getByLabel('Support', { exact: true }).check();
    await page.getByLabel('Motif (ticket, demande client…)').fill('Arrivée dans l’équipe support');
    await page.getByRole('button', { name: 'Créer l’opérateur' }).click();
    await expect
      .poll(async () => (await page.getByTestId('activation-code').textContent())?.length ?? 0)
      .toBeGreaterThan(20);

    // Journal : actions visibles avec leur motif.
    await page.getByRole('link', { name: 'Journal' }).click();
    await page.getByText('platform.customer.sessions_revoked').waitFor();
    await page.getByText('Ticket #2 : appareil perdu').first().waitFor();
    await page.screenshot({ path: resolve(output, 'admin-console-journal.png'), fullPage: true });
  });
});
