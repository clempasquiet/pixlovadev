/**
 * Configuration du site, fixée au build (pages statiques). Les origines par défaut suivent
 * la proposition de l’ADR-017 et ne valent pas décision DNS.
 */
export interface SiteConfig {
  /** Origine canonique du site, sans barre finale (liens canoniques, sitemap). */
  readonly origin: string;
  /** Origine du dashboard : liens de connexion et d’inscription. */
  readonly appUrl: string;
  /** Page d’état du service hébergée indépendamment (WEB-002) ; absente tant qu’elle n’existe pas. */
  readonly statusUrl: string | undefined;
  /** Indexation par les moteurs : refusée par défaut (recette, préproduction). */
  readonly indexable: boolean;
}

export const DEFAULT_ORIGIN = 'https://pixlova.com';
export const DEFAULT_APP_URL = 'https://app.pixlova.com';

function origin(name: string, value: string | undefined, fallback: string | undefined) {
  const raw = value?.trim() || fallback;
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} : URL invalide`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${name} : http ou https attendu`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(`${name} : ni paramètres, ni fragment, ni identifiants`);
  }
  return url.href.replace(/\/+$/, '');
}

export function readConfig(env: Record<string, string | undefined>): SiteConfig {
  const indexable = env.PIXLOVA_SITE_INDEXABLE?.trim() ?? '';
  if (indexable !== '' && indexable !== 'true' && indexable !== 'false') {
    throw new Error('PIXLOVA_SITE_INDEXABLE : true ou false attendu');
  }
  return {
    origin: origin('PIXLOVA_SITE_ORIGIN', env.PIXLOVA_SITE_ORIGIN, DEFAULT_ORIGIN)!,
    appUrl: origin('PIXLOVA_SITE_APP_URL', env.PIXLOVA_SITE_APP_URL, DEFAULT_APP_URL)!,
    statusUrl: origin('PIXLOVA_SITE_STATUS_URL', env.PIXLOVA_SITE_STATUS_URL, undefined),
    indexable: indexable === 'true',
  };
}
