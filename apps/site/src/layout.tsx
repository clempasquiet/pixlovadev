import type { ReactNode } from 'react';
import type { SiteConfig } from './config.js';

export interface PageMeta {
  /** Chemin public, avec barre finale (`/`, `/tarifs/`). */
  readonly path: string;
  readonly title: string;
  readonly description: string;
  /** Page exclue de l’index et du sitemap (pages en attente de validation). */
  readonly noindex?: boolean;
}

export interface Assets {
  readonly css: string;
  readonly js: string;
}

export const NAV = [
  { href: '/fonctionnalites/', label: 'Fonctionnalités' },
  { href: '/players/', label: 'Player natif & Web' },
  { href: '/cas-usage/', label: 'Cas d’usage' },
  { href: '/tarifs/', label: 'Tarifs' },
  { href: '/faq/', label: 'FAQ' },
] as const;

export const LEGAL = [
  { href: '/mentions-legales/', label: 'Mentions légales' },
  { href: '/cgv/', label: 'CGV' },
  { href: '/confidentialite/', label: 'Confidentialité' },
  { href: '/traitement-des-donnees/', label: 'Traitement des données' },
] as const;

export function appLinks(config: SiteConfig) {
  return { login: `${config.appUrl}/login`, register: `${config.appUrl}/register` };
}

export function Document(props: {
  meta: PageMeta;
  config: SiteConfig;
  assets: Assets;
  children: ReactNode;
}) {
  const { meta, config, assets } = props;
  const canonical = `${config.origin}${meta.path}`;
  const title = meta.path === '/' ? meta.title : `${meta.title} · pixlova`;
  const app = appLinks(config);
  return (
    <html lang="fr">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={meta.description} />
        {!config.indexable || meta.noindex ? <meta name="robots" content="noindex" /> : null}
        {meta.path.endsWith('.html') ? null : <link rel="canonical" href={canonical} />}
        <meta property="og:type" content="website" />
        <meta property="og:locale" content="fr_FR" />
        <meta property="og:site_name" content="pixlova" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={meta.description} />
        <meta property="og:url" content={canonical} />
        <meta property="og:image" content={`${config.origin}/brand/icon-512.png`} />
        <meta name="theme-color" content="#fffff2" />
        <link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png" />
        <link rel="apple-touch-icon" href="/brand/apple-touch-icon.png" />
        <link
          rel="preload"
          href="/fonts/archivo-wdth.woff2"
          as="font"
          type="font/woff2"
          crossOrigin=""
        />
        <link rel="stylesheet" href={assets.css} />
        <script src={assets.js} defer />
      </head>
      <body>
        <a className="skip" href="#contenu">
          Aller au contenu
        </a>
        <div className="topbar">
          <div className="wrap mono">
            <span>Diffusez. Partout. Simplement.</span>
            {config.statusUrl ? (
              <a href={config.statusUrl}>
                <span className="dot" aria-hidden="true" />
                État du service
              </a>
            ) : null}
          </div>
        </div>
        <header className="site-header">
          <div className="wrap">
            <a className="brand" href="/" aria-label="pixlova, accueil">
              <img src="/brand/logo.png" alt="" width="290" height="64" />
            </a>
            <button
              className="menu-toggle"
              type="button"
              aria-expanded="false"
              aria-controls="navigation"
            >
              <span className="sr-only">Menu</span>
              <span className="bars" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </button>
            <nav id="navigation" aria-label="Navigation principale">
              <ul className="links">
                {NAV.map((item) => (
                  <li key={item.href}>
                    <a
                      href={item.href}
                      {...(item.href === meta.path ? { 'aria-current': 'page' as const } : {})}
                    >
                      {item.label}
                    </a>
                  </li>
                ))}
              </ul>
              <div className="account">
                <a href={app.login}>Connexion</a>
                <a className="btn solid" href={app.register}>
                  Créer un compte gratuit
                </a>
              </div>
            </nav>
          </div>
        </header>
        <main id="contenu" tabIndex={-1}>
          {props.children}
        </main>
        <footer className="site-footer">
          <div className="wrap">
            <div className="f-grid">
              <div>
                <img src="/brand/logo-blanc.png" alt="pixlova" width="254" height="56" />
                <p>Affichage dynamique pour écrans et murs LED.</p>
              </div>
              <div>
                <h2>Produit</h2>
                <ul>
                  {NAV.slice(0, 4).map((item) => (
                    <li key={item.href}>
                      <a href={item.href}>{item.label}</a>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h2>Ressources</h2>
                <ul>
                  <li>
                    <a href="/faq/">FAQ</a>
                  </li>
                  {config.statusUrl ? (
                    <li>
                      <a href={config.statusUrl}>État du service</a>
                    </li>
                  ) : null}
                </ul>
              </div>
              <div>
                <h2>Légal</h2>
                <ul>
                  {LEGAL.map((item) => (
                    <li key={item.href}>
                      <a href={item.href}>{item.label}</a>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h2>Compte</h2>
                <ul>
                  <li>
                    <a href={app.login}>Connexion</a>
                  </li>
                  <li>
                    <a href={app.register}>Créer un compte</a>
                  </li>
                </ul>
              </div>
            </div>
            <div className="f-bottom mono">
              <span>© {new Date().getUTCFullYear()} pixlova</span>
              <span>{new URL(config.origin).host}</span>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}

/** En-tête de section : index en mono, titre, chapeau. */
export function SectionHead(props: { index: string; title: string; id: string; lede?: ReactNode }) {
  return (
    <div className="s-head">
      <span className="idx mono">{props.index}</span>
      <h2 id={props.id}>{props.title}</h2>
      {props.lede ? <p>{props.lede}</p> : null}
    </div>
  );
}
