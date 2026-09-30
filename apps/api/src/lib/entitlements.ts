/**
 * Source des droits effectifs d’une organisation (BILL-005). L01 n’en utilise que la
 * limite d’utilisateurs ; la projection réelle issue du catalogue et de Stripe arrive
 * avec L08. Aucune condition ne porte sur le nom commercial d’une offre.
 */
export interface EntitlementsProvider {
  maxUsers(organizationId: string): Promise<number>;
  /** Displays actifs autorisés (BILL-002) : slots inclus + extras confirmés + dérogations. */
  displaySlots(organizationId: string): Promise<number>;
  /** Stockage média en octets (BILL-005, ADR-009) : originaux, corbeille comprise. */
  storageBytes(organizationId: string): Promise<number>;
  /** Fonctionnalités incluses (BILL-005) ; `templates` : instanciation des templates (TPL-001). */
  features(organizationId: string): Promise<readonly string[]>;
}

/** Free : 2 Go (10⁹ octets), valeur indicative de BILL-003 à valider. */
export const FREE_STORAGE_BYTES = 2_000_000_000;

/** Offre gratuite (BILL-003) : un utilisateur, un Display actif, 2 Go, sans templates. Seule source avant L08. */
export const FREE_ENTITLEMENTS: EntitlementsProvider = {
  maxUsers: async () => 1,
  displaySlots: async () => 1,
  storageBytes: async () => FREE_STORAGE_BYTES,
  features: async () => [],
};

export function fixedEntitlements(
  maxUsers: number,
  displaySlots = 1,
  storageBytes = FREE_STORAGE_BYTES,
  features: readonly string[] = [],
): EntitlementsProvider {
  return {
    maxUsers: async () => maxUsers,
    displaySlots: async () => displaySlots,
    storageBytes: async () => storageBytes,
    features: async () => features,
  };
}

export type Deployment = 'production' | 'recette' | 'development';

/**
 * Mode de déploiement (ADR-015) : `recette` garde les contrôles de production mais
 * autorise les quotas fixes tant que la facturation (L08) n’existe pas.
 */
export function deploymentFromEnv(env: NodeJS.ProcessEnv = process.env): Deployment {
  const production = env.NODE_ENV === 'production';
  const deployment = env.PIXLOVA_DEPLOYMENT ?? (production ? 'production' : 'development');
  if (deployment !== 'production' && deployment !== 'recette' && deployment !== 'development') {
    throw new Error('PIXLOVA_DEPLOYMENT doit valoir production, recette ou development.');
  }
  if (production && deployment === 'development') {
    throw new Error('PIXLOVA_DEPLOYMENT=development est incompatible avec NODE_ENV=production.');
  }
  return deployment;
}

/**
 * Droits appliqués selon l’environnement, partagés par l’API et l’administration :
 * offre gratuite, ou quotas fixes `PIXLOVA_DEV_*` hors production.
 */
export function entitlementsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deployment: Deployment = deploymentFromEnv(env),
): EntitlementsProvider {
  const maxUsers = env.PIXLOVA_DEV_MAX_USERS;
  const displaySlots = env.PIXLOVA_DEV_DISPLAY_SLOTS;
  const storageBytes = env.PIXLOVA_DEV_STORAGE_BYTES;
  const features = env.PIXLOVA_DEV_FEATURES;
  if (!(maxUsers || displaySlots || storageBytes || features)) return FREE_ENTITLEMENTS;
  if (deployment === 'production') {
    throw new Error('Les variables PIXLOVA_DEV_* sont interdites en production.');
  }
  return fixedEntitlements(
    Number(maxUsers ?? 1),
    Number(displaySlots ?? 1),
    storageBytes ? Number(storageBytes) : FREE_STORAGE_BYTES,
    (features ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean),
  );
}
