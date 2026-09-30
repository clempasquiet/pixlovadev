/**
 * Catalogue des permissions nommées (IAM-004) et rôles standards V1 (IAM-003).
 *
 * La matrice reprend la [PROPOSITION] du cahier des charges §10.2, retenue comme
 * configuration initiale (ADR-007) ; elle reste une donnée, modifiable sans toucher
 * aux contrôles métier. Les rôles personnalisés relèvent de V1.5.
 */

export const PERMISSIONS = {
  'organization.read': { orgScopeOnly: false, label: 'Consulter le périmètre autorisé' },
  'organization.manage': { orgScopeOnly: true, label: 'Modifier les paramètres de l’organisation' },
  'organization.delete': { orgScopeOnly: true, label: 'Supprimer l’organisation' },
  'organization.transfer_ownership': { orgScopeOnly: true, label: 'Transférer la propriété' },
  'members.read': { orgScopeOnly: true, label: 'Consulter les membres' },
  'members.manage': { orgScopeOnly: true, label: 'Gérer membres, rôles, scopes et invitations' },
  'sites.manage': { orgScopeOnly: true, label: 'Créer et modifier les sites' },
  'content.manage': { orgScopeOnly: false, label: 'Gérer médias, compositions et playlists' },
  'content.publish': { orgScopeOnly: false, label: 'Publier plannings et campagnes' },
  'content.force_delete': { orgScopeOnly: false, label: 'Supprimer un contenu encore diffusé' },
  'override.create': { orgScopeOnly: false, label: '« Diffuser maintenant »' },
  'override.emergency': { orgScopeOnly: false, label: 'Diffusion d’urgence (priorité 100)' },
  'player.pair': { orgScopeOnly: false, label: 'Appairer et affecter Players et sorties' },
  'player.configure': { orgScopeOnly: false, label: 'Gérer la configuration technique' },
  'player.command': { orgScopeOnly: false, label: 'Exécuter les commandes techniques' },
  'player.command.disruptive': {
    orgScopeOnly: false,
    label: 'Commandes perturbatrices (redémarrage système)',
  },
  'screenshots.request': { orgScopeOnly: false, label: 'Demander une capture' },
  'screenshots.read': { orgScopeOnly: false, label: 'Consulter les captures' },
  'audit.read': { orgScopeOnly: true, label: 'Consulter le journal d’audit' },
  'billing.read': { orgScopeOnly: true, label: 'Consulter l’abonnement et les factures' },
  'billing.manage': { orgScopeOnly: true, label: 'Modifier l’abonnement' },
} as const satisfies Record<string, { orgScopeOnly: boolean; label: string }>;

export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];

const READ: Permission[] = ['organization.read'];
const CONTENT: Permission[] = ['content.manage', 'content.publish', 'override.create'];
const TECHNICAL: Permission[] = [
  'player.pair',
  'player.configure',
  'player.command',
  'player.command.disruptive',
  'screenshots.request',
  'screenshots.read',
];

export const ROLES = {
  Owner: {
    label: 'Propriétaire',
    orgScopeOnly: true,
    permissions: PERMISSION_KEYS,
  },
  Admin: {
    label: 'Administrateur',
    orgScopeOnly: true,
    // `billing.manage` n’est pas implicite (IAM-004) : il s’obtient par le rôle BillingManager.
    permissions: PERMISSION_KEYS.filter(
      (p) =>
        !['billing.manage', 'organization.delete', 'organization.transfer_ownership'].includes(p),
    ),
  },
  ContentManager: {
    label: 'Gestionnaire de contenus',
    orgScopeOnly: false,
    permissions: [...READ, ...CONTENT],
  },
  Operator: {
    label: 'Opérateur',
    orgScopeOnly: false,
    permissions: [...READ, 'override.create', 'screenshots.request', 'screenshots.read'],
  },
  Technician: {
    label: 'Technicien',
    orgScopeOnly: false,
    permissions: [...READ, ...TECHNICAL],
  },
  Viewer: {
    label: 'Lecteur',
    orgScopeOnly: false,
    permissions: READ,
  },
  /** Rôle complémentaire : délégation explicite de la facturation (IAM-004). */
  BillingManager: {
    label: 'Responsable facturation',
    orgScopeOnly: true,
    permissions: [...READ, 'billing.read', 'billing.manage'],
  },
} as const satisfies Record<
  string,
  { label: string; orgScopeOnly: boolean; permissions: readonly Permission[] }
>;

export type Role = keyof typeof ROLES;
export const ROLE_KEYS = Object.keys(ROLES) as Role[];

export function isRole(value: string): value is Role {
  return Object.hasOwn(ROLES, value);
}

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(PERMISSIONS, value);
}

export function roleHas(role: Role, permission: Permission): boolean {
  return (ROLES[role].permissions as readonly Permission[]).includes(permission);
}
