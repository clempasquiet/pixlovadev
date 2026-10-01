/**
 * Permissions de l’administration plateforme (ADM-002, ADR-016). Catalogue et types
 * distincts de ceux des organisations : aucun rôle tenant ne peut s’y convertir, et un
 * contrôle plateforme n’accepte que des rôles plateforme. Les clés (snake_case) ne
 * reprennent jamais une clé de rôle d’organisation (`Operator` existe côté tenant) ;
 * les libellés suivent le cahier des charges.
 *
 * La matrice est une configuration initiale **[à valider]** par le responsable produit.
 */

export const PLATFORM_ROLE_KEYS = [
  'super_admin',
  'support',
  'billing_admin',
  'operations',
  'content_admin',
] as const;
export type PlatformRole = (typeof PLATFORM_ROLE_KEYS)[number];

export const PLATFORM_PERMISSIONS = {
  'platform.health.read': 'Consulter la santé de la plateforme (files, emails, schéma, parc)',
  'platform.organizations.read': 'Rechercher les organisations et consulter leur fiche',
  'platform.organizations.diagnostics':
    'Consulter Players, Displays et incidents d’une organisation',
  'platform.entitlements.read': 'Consulter droits appliqués et usages',
  'platform.billing.read':
    'Consulter abonnements, demandes, codes promotionnels et événements Stripe (sans paiement)',
  'platform.customers.lookup': 'Rechercher un compte client par adresse exacte',
  'platform.customers.revoke_sessions': 'Révoquer les sessions d’un compte client',
  'platform.customers.reset_mfa': 'Réinitialiser le second facteur d’un compte client',
  'platform.customers.set_status': 'Désactiver ou réactiver un compte client',
  'platform.jobs.read': 'Consulter les tâches en échec',
  'platform.jobs.retry': 'Relancer une tâche en échec',
  'platform.incidents.read': 'Consulter les incidents de toutes les organisations',
  'platform.templates.read': 'Consulter le catalogue de templates',
  'platform.releases.read':
    'Consulter les releases du Player natif, leur périmètre et le résultat des déploiements',
  'platform.releases.manage':
    'Déposer, publier ou bloquer une release du Player natif (retour arrière du parc)',
  'platform.audit.read': 'Consulter le journal d’audit de la plateforme',
  'platform.team.manage': 'Gérer les opérateurs, leurs rôles et leurs accès',
} as const;
export type PlatformPermission = keyof typeof PLATFORM_PERMISSIONS;
export const PLATFORM_PERMISSION_KEYS = Object.keys(PLATFORM_PERMISSIONS) as PlatformPermission[];

export const PLATFORM_ROLES: Record<
  PlatformRole,
  { label: string; permissions: readonly PlatformPermission[] }
> = {
  super_admin: { label: 'SuperAdmin', permissions: PLATFORM_PERMISSION_KEYS },
  support: {
    label: 'Support',
    permissions: [
      'platform.organizations.read',
      'platform.organizations.diagnostics',
      'platform.entitlements.read',
      'platform.customers.lookup',
      'platform.customers.revoke_sessions',
      'platform.incidents.read',
      'platform.jobs.read',
      'platform.releases.read',
    ],
  },
  billing_admin: {
    label: 'BillingAdmin',
    permissions: [
      'platform.organizations.read',
      'platform.entitlements.read',
      'platform.billing.read',
    ],
  },
  operations: {
    label: 'Operator (exploitation)',
    permissions: [
      'platform.health.read',
      'platform.organizations.read',
      'platform.organizations.diagnostics',
      'platform.incidents.read',
      'platform.jobs.read',
      'platform.jobs.retry',
      'platform.releases.read',
      'platform.releases.manage',
    ],
  },
  content_admin: { label: 'ContentAdmin', permissions: ['platform.templates.read'] },
};

export function isPlatformRole(value: string): value is PlatformRole {
  return (PLATFORM_ROLE_KEYS as readonly string[]).includes(value);
}

/** Vrai si l’un des rôles plateforme porte la permission ; toute autre valeur est ignorée. */
export function platformCan(roles: readonly string[], permission: PlatformPermission): boolean {
  return roles.some(
    (role) => isPlatformRole(role) && PLATFORM_ROLES[role].permissions.includes(permission),
  );
}

/** Permissions effectives, pour que l’interface reflète les contrôles serveur. */
export function platformPermissions(roles: readonly string[]): PlatformPermission[] {
  return PLATFORM_PERMISSION_KEYS.filter((permission) => platformCan(roles, permission));
}
