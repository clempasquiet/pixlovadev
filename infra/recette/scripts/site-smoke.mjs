#!/usr/bin/env node
/**
 * Recette du site public (L09-M, ADR-018), sur le serveur qui exécute Docker Compose :
 *   - le conteneur `site` sert les pages statiques sur la boucle locale (port 8090) ;
 *   - les liens d’inscription et de connexion mènent au dashboard de la recette ;
 *   - en-têtes de sécurité, page 404 et refus d’indexation ;
 *   - le conteneur n’atteint ni l’API ni la base (réseau `edge` seulement).
 *
 *   node infra/recette/scripts/site-smoke.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
let dotenv = '';
try {
  dotenv = readFileSync(join(root, '.env'), 'utf8');
} catch {
  // Sans .env : valeurs fournies par l’environnement (essai hors Compose).
}
for (const line of dotenv.split('\n')) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match) env[match[1]] = match[2];
}
const setting = (name, fallback) => process.env[name] ?? env[name] ?? fallback;
const publicUrl = setting('PIXLOVA_PUBLIC_URL').replace(/\/$/, '');
const site = `http://127.0.0.1:${setting('PIXLOVA_SITE_PORT', '8090')}`;

function check(condition, message) {
  if (!condition) throw new Error(`Échec : ${message}`);
  console.log(`ok  ${message}`);
}

const home = await fetch(`${site}/`);
const html = await home.text();
check(home.status === 200, 'accueil servi par le conteneur site');
check(html.includes(`href="${publicUrl}/register"`), 'lien d’inscription vers le dashboard');
check(html.includes(`href="${publicUrl}/login"`), 'lien de connexion vers le dashboard');
check(html.includes('<meta name="robots" content="noindex"/>'), 'pages non indexables');
const csp = home.headers.get('content-security-policy') ?? '';
check(csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'"), 'CSP stricte');
check(home.headers.get('x-content-type-options') === 'nosniff', 'nosniff');

for (const path of ['/tarifs/', '/players/', '/fonctionnalites/', '/faq/', '/mentions-legales/']) {
  check((await fetch(`${site}${path}`)).status === 200, `page ${path}`);
}
const tarifs = await (await fetch(`${site}/tarifs/`)).text();
check(tarifs.includes('Tarifs indicatifs, en cours de validation'), 'tarifs marqués indicatifs');
const missing = await fetch(`${site}/inexistant`);
check(
  missing.status === 404 && (await missing.text()).includes('Cette page n’existe pas'),
  'page 404',
);
check((await (await fetch(`${site}/robots.txt`)).text()).includes('Disallow: /'), 'robots.txt');

// Isolement réseau : depuis le conteneur site, ni l’API ni la base ne résolvent.
// PIXLOVA_SITE_SMOKE_NO_DOCKER=1 : essai hors Compose, sans cette partie.
if (process.env.PIXLOVA_SITE_SMOKE_NO_DOCKER === '1') {
  console.log('\nSite public : recette réussie (isolement réseau non vérifié)');
  process.exit(0);
}
const probe = (host) => {
  try {
    execFileSync(
      'docker',
      ['compose', '-f', join(root, 'compose.yaml'), 'exec', '-T', 'site', 'wget', '-q', '-T', '3', '-O', '/dev/null', `http://${host}`],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
};
check(probe('127.0.0.1:8090/site-health'), 'sonde exécutée dans le conteneur site');
check(!probe('api:3000/'), 'API injoignable depuis le site');
check(!probe('postgres:5432/'), 'base injoignable depuis le site');

console.log('\nSite public : recette réussie');
