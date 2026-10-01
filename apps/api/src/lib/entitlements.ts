import { BUILTIN_FALLBACK_PLAN, organizationBilling } from '@pixlova/billing';
import type { BillingEnvironment } from '@pixlova/contracts';
import { withTenant, type Database } from '@pixlova/db';

/**
 * Source des droits effectifs d’une organisation (BILL-005) : projection locale du
 * catalogue et de Stripe (ADR-017). Aucune condition ne porte sur le nom commercial
 * d’une offre.
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
export const FREE_STORAGE_BYTES = BUILTIN_FALLBACK_PLAN.entitlements.storage_quota_bytes;

/** Offre gratuite intégrée (BILL-003) : un utilisateur, un Display actif, 2 Go, sans templates. */
export const FREE_ENTITLEMENTS: EntitlementsProvider = {
  maxUsers: async () => 1,
  displaySlots: async () => 1,
  storageBytes: async () => FREE_STORAGE_BYTES,
  features: async () => [],
};

/**
 * Droits issus de la projection locale (BILL-009) : offre de l’abonnement courant, ou offre
 * de repli du catalogue (Free intégrée à défaut). Lecture seule, aucun appel Stripe ; la
 * transaction est propre au calcul et ne prend aucun verrou.
 */
export function projectedEntitlements(
  db: Database,
  environment: BillingEnvironment,
  now: () => Date = () => new Date(),
): EntitlementsProvider {
  const effective = (organizationId: string) =>
    withTenant(db, organizationId, async (tx) =>
      organizationBilling(tx, organizationId, environment, now()),
    ).then((billing) => billing.effective);
  return {
    maxUsers: async (id) => (await effective(id)).maxUsers,
    displaySlots: async (id) => (await effective(id)).displaySlots.total,
    storageBytes: async (id) => (await effective(id)).storageBytes,
    features: async (id) => (await effective(id)).features,
  };
}

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
 * autorise les quotas fixes `PIXLOVA_DEV_*` (scénarios sans Stripe).
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
 * projection de la facturation (ADR-017), ou quotas fixes `PIXLOVA_DEV_*` hors production.
 */
export function entitlementsFromEnv(
  env: NodeJS.ProcessEnv,
  deployment: Deployment,
  projection: { db: Database; environment: BillingEnvironment },
): EntitlementsProvider {
  const maxUsers = env.PIXLOVA_DEV_MAX_USERS;
  const displaySlots = env.PIXLOVA_DEV_DISPLAY_SLOTS;
  const storageBytes = env.PIXLOVA_DEV_STORAGE_BYTES;
  const features = env.PIXLOVA_DEV_FEATURES;
  if (!(maxUsers || displaySlots || storageBytes || features)) {
    return projectedEntitlements(projection.db, projection.environment);
  }
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
