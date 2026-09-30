/**
 * Parcours de bout en bout (TST-010 partiel, TST-021) dans Chromium headless, contre l’API
 * réelle et PostgreSQL : inscription → vérification → connexion → organisation → site →
 * invitation → acceptation par un second compte → droits limités → audit.
 */
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { skipDatabaseTests } from '@pixlova/db/testing';
import {
  emailLink as link,
  login as signIn,
  output,
  register as signUp,
  startStack,
  type Stack,
} from './support.js';

describe.skipIf(skipDatabaseTests)('dashboard : premier parcours dans un vrai navigateur', () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  }, 120_000);
  afterAll(async () => {
    await stack?.close();
  });
  const emailLink = (to: string, path: string) => link(stack, to, path);
  const register = (page: Parameters<typeof signUp>[1], email: string, name: string) =>
    signUp(stack, page, email, name);
  const login = signIn;

  it('crée une organisation, invite un gestionnaire de contenus limité à un site et trace les actions', async () => {
    const owner = await stack.browser.newPage();
    const pageErrors: string[] = [];
    owner.on('pageerror', (error) => pageErrors.push(error.message));

    await register(owner, 'owner@pixlova.test', 'Zoé');
    await owner.goto(`${stack.base}/login`);
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
    const carla = await (await stack.browser.newContext()).newPage();
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
    const page = await (await stack.browser.newContext()).newPage();
    await page.goto(`${stack.base}/members`);
    await page.getByRole('heading', { name: 'Connexion' }).waitFor();
    expect(new URL(page.url()).searchParams.get('next')).toBe('/members');
  }, 60_000);
});
