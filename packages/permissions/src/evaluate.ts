/**
 * Évaluation des autorisations (PROD-005, IAM-005, IAM-006). Fonctions pures, appelées
 * par le serveur pour chaque action ; l’interface les utilise seulement pour l’affichage.
 */
import { PERMISSIONS, ROLES, roleHas, type Permission, type Role } from './catalog.js';

export type Scope = { type: 'organization' } | { type: 'sites'; siteIds: readonly string[] };

export interface Grant {
  role: Role;
  scope: Scope;
}

/** Ressource ciblée : rattachée à un site, ou de niveau organisation (`siteId: null`). */
export interface Target {
  siteId: string | null;
}

function covers(grant: Grant, permission: Permission, target: Target): boolean {
  if (!roleHas(grant.role, permission)) return false;
  if (grant.scope.type === 'organization') return true;
  // Un grant de site ne donne jamais une permission réservée à l’organisation,
  // ni un accès à une ressource de niveau organisation (IAM-005).
  if (PERMISSIONS[permission].orgScopeOnly || target.siteId === null) return false;
  return grant.scope.siteIds.includes(target.siteId);
}

export function can(grants: readonly Grant[], permission: Permission, target: Target): boolean {
  return grants.some((grant) => covers(grant, permission, target));
}

/**
 * Sites visibles pour une permission, pour filtrer une liste côté serveur.
 * `all` : grant organisation ; sinon l’union des sites des grants concernés.
 */
export function siteFilter(grants: readonly Grant[], permission: Permission): 'all' | string[] {
  const sites = new Set<string>();
  for (const grant of grants) {
    if (!roleHas(grant.role, permission)) continue;
    if (grant.scope.type === 'organization') return 'all';
    if (!PERMISSIONS[permission].orgScopeOnly) grant.scope.siteIds.forEach((id) => sites.add(id));
  }
  return [...sites];
}

/** Opération atomique sur plusieurs cibles : refus global si une seule est hors périmètre (IAM-005). */
export function canAll(
  grants: readonly Grant[],
  permission: Permission,
  targets: readonly Target[],
): boolean {
  return targets.every((target) => can(grants, permission, target));
}

export type GrantValidation = 'ok' | 'ROLE_REQUIRES_ORGANIZATION_SCOPE' | 'EMPTY_SITE_SCOPE';

export function validateGrant(grant: Grant): GrantValidation {
  if (grant.scope.type === 'sites') {
    if (ROLES[grant.role].orgScopeOnly) return 'ROLE_REQUIRES_ORGANIZATION_SCOPE';
    if (grant.scope.siteIds.length === 0) return 'EMPTY_SITE_SCOPE';
  }
  return 'ok';
}

/**
 * Un acteur ne délègue pas plus que ce qu’il détient (IAM-006) : il doit posséder
 * `members.manage`, chaque permission du rôle délégué sur tout le scope délégué,
 * et seul un Owner attribue le rôle Owner.
 */
export function canDelegate(actor: readonly Grant[], grant: Grant): boolean {
  if (validateGrant(grant) !== 'ok') return false;
  if (!can(actor, 'members.manage', { siteId: null })) return false;
  if (grant.role === 'Owner' && !actor.some((g) => g.role === 'Owner')) return false;
  const targets: Target[] =
    grant.scope.type === 'organization'
      ? [{ siteId: null }]
      : grant.scope.siteIds.map((siteId) => ({ siteId }));
  return (ROLES[grant.role].permissions as readonly Permission[]).every((permission) =>
    canAll(actor, permission, targets),
  );
}

export function effectivePermissions(grants: readonly Grant[]): Permission[] {
  const result = new Set<Permission>();
  for (const grant of grants)
    (ROLES[grant.role].permissions as readonly Permission[]).forEach((p) => result.add(p));
  return [...result].sort();
}
