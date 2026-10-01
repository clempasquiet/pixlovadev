import { describe, expect, it } from 'vitest';
import { outputFile, renderPage, robots, sitemap } from '../../src/build.js';
import { cheapestQuote, formula, quote, SITE_CATALOG } from '../../src/catalog.js';
import { readConfig } from '../../src/config.js';
import { NOT_FOUND, PAGES } from '../../src/pages.js';

const ASSETS = { css: '/assets/site.test.css', js: '/assets/site.test.js' };
const config = readConfig({
  PIXLOVA_SITE_ORIGIN: 'https://site.test/',
  PIXLOVA_SITE_APP_URL: 'https://app.site.test',
  PIXLOVA_SITE_INDEXABLE: 'true',
});

function plan(key: string) {
  const found = SITE_CATALOG.plans.find((p) => p.key === key);
  if (!found) throw new Error(key);
  return found;
}

describe('configuration', () => {
  it('applique les valeurs par défaut sans indexation', () => {
    expect(readConfig({})).toEqual({
      origin: 'https://www.pixlova.com',
      appUrl: 'https://app.pixlova.com',
      statusUrl: undefined,
      indexable: false,
    });
  });

  it('normalise et refuse les URL invalides', () => {
    expect(config.origin).toBe('https://site.test');
    expect(() => readConfig({ PIXLOVA_SITE_APP_URL: 'javascript:alert(1)' })).toThrow();
    expect(() => readConfig({ PIXLOVA_SITE_ORIGIN: 'https://site.test/?a=1' })).toThrow();
    expect(() => readConfig({ PIXLOVA_SITE_INDEXABLE: 'oui' })).toThrow();
  });
});

describe('catalogue indicatif', () => {
  it('reprend l’exemple BILL-004 : 14 écrans en Pro coûtent 55 € HT', () => {
    const q = quote(plan('pro'), 14);
    expect(q?.totalCents).toBe(5500);
    expect(formula(q!)).toBe('39 € + (14 − 10) × 4 € = 55 € HT / mois');
  });

  it('refuse un second écran en Free (BILL-003)', () => {
    expect(quote(plan('free'), 1)?.totalCents).toBe(0);
    expect(quote(plan('free'), 2)).toBeNull();
    expect(quote(plan('pro'), 0)).toBeNull();
  });

  it('propose l’offre la moins chère, la plus simple à égalité', () => {
    expect(cheapestQuote(SITE_CATALOG, 1)?.plan.key).toBe('free');
    expect(cheapestQuote(SITE_CATALOG, 10)?.plan.key).toBe('pro');
    expect(cheapestQuote(SITE_CATALOG, 25)?.plan.key).toBe('pro');
    expect(cheapestQuote(SITE_CATALOG, 26)?.plan.key).toBe('business');
    expect(formula(cheapestQuote(SITE_CATALOG, 1)!)).toBe('Gratuit, sans carte bancaire');
    expect(formula(cheapestQuote(SITE_CATALOG, 30)!)).toBe('99 € HT / mois');
  });
});

describe('pages générées', () => {
  const pages = [...PAGES, NOT_FOUND].map((page) => ({
    page,
    html: renderPage(page, config, ASSETS),
  }));
  const paths = new Set(PAGES.map((p) => p.path));

  it('produisent un document complet, une seule h1 et des métadonnées', () => {
    for (const { page, html } of pages) {
      expect(html.startsWith('<!doctype html><html lang="fr">')).toBe(true);
      expect(html.match(/<h1[ >]/g)?.length, page.path).toBe(1);
      expect(html).toContain('<meta name="description"');
      expect(html).toContain('href="#contenu"');
      expect(html).toContain('<main id="contenu"');
      if (page !== NOT_FOUND) {
        expect(html).toContain(`<link rel="canonical" href="https://site.test${page.path}"/>`);
      }
    }
  });

  it('ne laissent aucun lien interne cassé', () => {
    for (const { page, html } of pages) {
      for (const [, href] of html.matchAll(/href="(\/[^"#]*)"/g)) {
        if (
          href!.startsWith('/assets/') ||
          href!.startsWith('/brand/') ||
          href!.startsWith('/fonts/')
        )
          continue;
        expect(paths.has(href!), `${page.path} → ${href}`).toBe(true);
      }
    }
  });

  it('mènent à l’inscription et à la connexion du dashboard', () => {
    const home = pages[0]!.html;
    expect(home).toContain('href="https://app.site.test/register"');
    expect(home).toContain('href="https://app.site.test/login"');
  });

  it('signalent des tarifs indicatifs et n’annoncent ni essai ni remise annuelle', () => {
    const tarifs = pages.find((p) => p.page.path === '/tarifs/')!.html;
    expect(tarifs).toContain('Tarifs indicatifs, en cours de validation');
    expect(tarifs).toContain('55 € HT / mois');
    for (const { html } of pages) {
      expect(html).not.toMatch(/essai de 14|deux mois offerts|annuel/i);
    }
  });

  it('excluent de l’index les pages légales en attente et la page 404', () => {
    for (const { page, html } of pages) {
      const legal = page.noindex === true;
      expect(html.includes('<meta name="robots" content="noindex"/>'), page.path).toBe(legal);
    }
    expect(sitemap(config)).not.toContain('mentions-legales');
    expect(sitemap(config)).toContain('<loc>https://site.test/tarifs/</loc>');
    expect(robots(config)).toContain('Sitemap: https://site.test/sitemap.xml');
  });

  it('publient des textes légaux génériques sans identité juridique inventée', () => {
    for (const path of [
      '/mentions-legales/',
      '/cgv/',
      '/confidentialite/',
      '/traitement-des-donnees/',
    ]) {
      const html = pages.find((p) => p.page.path === path)!.html;
      expect(html, path).toContain('<mark class="todo">[Raison sociale]</mark>');
      expect(html.match(/<h2>/g)?.length ?? 0, path).toBeGreaterThanOrEqual(4);
      expect(html, path).not.toMatch(/\b\d{9}\b/);
    }
  });

  it('refusent l’indexation hors production', () => {
    const recette = readConfig({});
    expect(renderPage(PAGES[0]!, recette, ASSETS)).toContain('content="noindex"');
    expect(robots(recette)).toBe('User-agent: *\nDisallow: /\n');
  });

  it('n’affichent pas de lien d’état du service tant qu’il n’existe pas', () => {
    expect(pages[0]!.html).not.toContain('État du service');
    const withStatus = readConfig({ PIXLOVA_SITE_STATUS_URL: 'https://status.site.test' });
    expect(renderPage(PAGES[0]!, withStatus, ASSETS)).toContain('href="https://status.site.test"');
  });

  it('écrivent chaque page dans un fichier distinct', () => {
    expect(outputFile('/')).toBe('index.html');
    expect(outputFile('/tarifs/')).toBe('tarifs/index.html');
    expect(outputFile('/404.html')).toBe('404.html');
    expect(new Set(PAGES.map((p) => outputFile(p.path))).size).toBe(PAGES.length);
  });
});
