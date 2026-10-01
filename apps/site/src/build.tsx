/**
 * Générateur du site statique : rend chaque page en HTML, copie les polices et les visuels
 * de marque, puis écrit `sitemap.xml` et `robots.txt`. Exécuté par `pnpm run build`.
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { SITE_CATALOG } from './catalog.js';
import type { SiteConfig } from './config.js';
import { readConfig } from './config.js';
import type { Assets } from './layout.js';
import { Document } from './layout.js';
import type { Page } from './pages.js';
import { NOT_FOUND, PAGES } from './pages.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'package.json'));

const FONTS: readonly (readonly [string, string])[] = [
  ['@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2', 'archivo-wdth.woff2'],
  [
    '@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2',
    'instrument-sans.woff2',
  ],
  ['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2', 'plex-mono-400.woff2'],
  ['@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2', 'plex-mono-500.woff2'],
];

const FONT_PACKAGES = [
  '@fontsource-variable/archivo',
  '@fontsource-variable/instrument-sans',
  '@fontsource/ibm-plex-mono',
];

const BRAND = [
  'logo.png',
  'logo-blanc.png',
  'favicon-32.png',
  'apple-touch-icon.png',
  'icon-512.png',
];

function hashed(name: string, ext: string, content: string) {
  const digest = createHash('sha256').update(content).digest('hex').slice(0, 10);
  return `/assets/${name}.${digest}.${ext}`;
}

export function renderPage(page: Page, config: SiteConfig, assets: Assets): string {
  const body = renderToStaticMarkup(
    <Document meta={page} config={config} assets={assets}>
      {page.render({ config, catalog: SITE_CATALOG })}
    </Document>,
  );
  return `<!doctype html>${body}`;
}

export function outputFile(path: string): string {
  return path.endsWith('.html') ? path.slice(1) : join(path.slice(1), 'index.html');
}

export function sitemap(config: SiteConfig): string {
  const urls = PAGES.filter((p) => !p.noindex)
    .map((p) => `  <url><loc>${config.origin}${p.path}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function robots(config: SiteConfig): string {
  return config.indexable
    ? `User-agent: *\nAllow: /\n\nSitemap: ${config.origin}/sitemap.xml\n`
    : 'User-agent: *\nDisallow: /\n';
}

async function main() {
  const config = readConfig(process.env);
  const out = join(root, 'dist');
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'assets'), { recursive: true });
  await mkdir(join(out, 'fonts'), { recursive: true });
  await mkdir(join(out, 'brand'), { recursive: true });

  const css = await readFile(join(root, 'src/styles.css'), 'utf8');
  const js = await readFile(join(root, 'src/site.js'), 'utf8');
  const assets: Assets = { css: hashed('site', 'css', css), js: hashed('site', 'js', js) };
  await writeFile(join(out, assets.css), css);
  await writeFile(join(out, assets.js), js);

  for (const [from, to] of FONTS) await copyFile(require.resolve(from), join(out, 'fonts', to));
  // Licence SIL OFL 1.1 distribuée avec les fichiers de police.
  for (const pkg of FONT_PACKAGES) {
    const license = join(dirname(require.resolve(`${pkg}/LICENSE`)), 'LICENSE');
    await copyFile(license, join(out, 'fonts', `${pkg.split('/')[1]}-LICENSE.txt`));
  }
  for (const name of BRAND)
    await copyFile(join(root, 'public/brand', name), join(out, 'brand', name));

  for (const page of [...PAGES, NOT_FOUND]) {
    const file = join(out, outputFile(page.path));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, renderPage(page, config, assets));
  }
  await writeFile(join(out, 'sitemap.xml'), sitemap(config));
  await writeFile(join(out, 'robots.txt'), robots(config));
  console.log(
    `site : ${PAGES.length + 1} pages → ${out} (origine ${config.origin}, indexable ${config.indexable})`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
