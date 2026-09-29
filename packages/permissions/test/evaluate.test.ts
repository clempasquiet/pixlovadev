import { describe, expect, it } from 'vitest';
import {
  PERMISSION_KEYS,
  ROLES,
  can,
  canDelegate,
  roleHas,
  siteFilter,
  validateGrant,
  type Grant,
} from '../src/index.js';

const SITE_A = 'a0000000-0000-4000-8000-000000000001';
const SITE_B = 'b0000000-0000-4000-8000-000000000002';
const org = (role: Grant['role']): Grant => ({ role, scope: { type: 'organization' } });
const sites = (role: Grant['role'], ...siteIds: string[]): Grant => ({
  role,
  scope: { type: 'sites', siteIds },
});

describe('matrice des rôles V1 (§10.2)', () => {
  const expectations: [Grant['role'], string, boolean][] = [
    ['Viewer', 'organization.read', true],
    ['Viewer', 'content.manage', false],
    ['ContentManager', 'content.publish', true],
    ['ContentManager', 'player.pair', false],
    ['Operator', 'override.create', true],
    ['Operator', 'content.manage', false],
    ['Operator', 'player.command', false],
    ['Technician', 'player.pair', true],
    ['Technician', 'player.command', true],
    ['Technician', 'override.create', false],
    ['Admin', 'members.manage', true],
    ['Admin', 'billing.manage', false],
    ['Admin', 'organization.delete', false],
    ['Owner', 'organization.transfer_ownership', true],
    ['BillingManager', 'billing.manage', true],
  ];
  it.each(expectations)('%s → %s : %s', (role, permission, expected) => {
    expect(roleHas(role, permission as never)).toBe(expected);
  });

  it('Owner détient toutes les permissions', () => {
    expect(ROLES.Owner.permissions).toEqual(PERMISSION_KEYS);
  });
});

describe('scopes (IAM-005)', () => {
  it('un grant de site ne couvre que ses sites', () => {
    const grants = [sites('ContentManager', SITE_A)];
    expect(can(grants, 'content.manage', { siteId: SITE_A })).toBe(true);
    expect(can(grants, 'content.manage', { siteId: SITE_B })).toBe(false);
  });

  it('un grant de site ne couvre pas une ressource de niveau organisation', () => {
    expect(can([sites('ContentManager', SITE_A)], 'content.manage', { siteId: null })).toBe(false);
  });

  it('une permission réservée à l’organisation n’est jamais obtenue par un grant de site', () => {
    expect(can([sites('Technician', SITE_A)], 'audit.read', { siteId: SITE_A })).toBe(false);
  });

  it('filtre les listes par sites autorisés', () => {
    expect(
      siteFilter([sites('Viewer', SITE_A), sites('Technician', SITE_B)], 'player.pair'),
    ).toEqual([SITE_B]);
    expect(siteFilter([sites('Viewer', SITE_A), org('Viewer')], 'organization.read')).toBe('all');
  });

  it('refuse un rôle d’organisation limité à des sites', () => {
    expect(validateGrant(sites('Admin', SITE_A))).toBe('ROLE_REQUIRES_ORGANIZATION_SCOPE');
    expect(validateGrant(sites('Viewer'))).toBe('EMPTY_SITE_SCOPE');
  });
});

describe('délégation (IAM-006)', () => {
  it('un Admin ne peut pas nommer un Owner ni un BillingManager', () => {
    expect(canDelegate([org('Admin')], org('Owner'))).toBe(false);
    expect(canDelegate([org('Admin')], org('BillingManager'))).toBe(false);
  });

  it('un Admin délègue les rôles qu’il couvre', () => {
    expect(canDelegate([org('Admin')], org('ContentManager'))).toBe(true);
    expect(canDelegate([org('Admin')], sites('Technician', SITE_A))).toBe(true);
  });

  it('un Owner délègue tout, y compris Owner', () => {
    expect(canDelegate([org('Owner')], org('Owner'))).toBe(true);
    expect(canDelegate([org('Owner')], org('BillingManager'))).toBe(true);
  });

  it('sans members.manage, aucune délégation', () => {
    expect(canDelegate([org('ContentManager')], sites('Viewer', SITE_A))).toBe(false);
  });
});
