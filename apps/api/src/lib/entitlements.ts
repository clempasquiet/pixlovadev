/**
 * Source des droits effectifs d’une organisation (BILL-005). L01 n’en utilise que la
 * limite d’utilisateurs ; la projection réelle issue du catalogue et de Stripe arrive
 * avec L08. Aucune condition ne porte sur le nom commercial d’une offre.
 */
export interface EntitlementsProvider {
  maxUsers(organizationId: string): Promise<number>;
}

/** Offre gratuite (BILL-003) : un utilisateur. Seule source disponible avant L08. */
export const FREE_ENTITLEMENTS: EntitlementsProvider = {
  maxUsers: async () => 1,
};

export function fixedEntitlements(maxUsers: number): EntitlementsProvider {
  return { maxUsers: async () => maxUsers };
}
