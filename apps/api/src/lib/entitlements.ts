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
