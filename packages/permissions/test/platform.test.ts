import { describe, expect, it } from 'vitest';
import {
  PERMISSION_KEYS,
  PLATFORM_PERMISSION_KEYS,
  PLATFORM_ROLE_KEYS,
  PLATFORM_ROLES,
  ROLE_KEYS,
  platformCan,
  platformPermissions,
} from '../src/index.js';

describe('permissions plateforme (ADM-002)', () => {
  it('sont disjointes des rôles et permissions des organisations', () => {
    for (const role of ROLE_KEYS)
      expect(PLATFORM_ROLE_KEYS as readonly string[]).not.toContain(role);
    for (const permission of PLATFORM_PERMISSION_KEYS) {
      expect(PERMISSION_KEYS as readonly string[]).not.toContain(permission);
    }
  });

  it('un rôle d’organisation, même Owner, n’accorde aucun droit plateforme', () => {
    expect(platformPermissions(['Owner', 'Admin', 'BillingManager'])).toEqual([]);
    expect(platformCan(['Owner'], 'platform.team.manage')).toBe(false);
    // `Operator` est un rôle d’organisation : il ne vaut pas le rôle plateforme `operations`.
    expect(platformPermissions(['Operator'])).toEqual([]);
  });

  it('SuperAdmin porte tout ; chaque permission appartient au moins à un rôle', () => {
    expect(platformPermissions(['super_admin'])).toEqual(PLATFORM_PERMISSION_KEYS);
    for (const permission of PLATFORM_PERMISSION_KEYS) {
      expect(
        PLATFORM_ROLE_KEYS.some((role) => PLATFORM_ROLES[role].permissions.includes(permission)),
      ).toBe(true);
    }
  });

  it('le support consulte sans actions dangereuses implicites', () => {
    expect(platformCan(['support'], 'platform.organizations.diagnostics')).toBe(true);
    expect(platformCan(['support'], 'platform.customers.revoke_sessions')).toBe(true);
    expect(platformCan(['support'], 'platform.customers.reset_mfa')).toBe(false);
    expect(platformCan(['support'], 'platform.customers.set_status')).toBe(false);
    expect(platformCan(['support'], 'platform.team.manage')).toBe(false);
    expect(platformCan(['billing_admin'], 'platform.organizations.diagnostics')).toBe(false);
    expect(platformCan(['content_admin'], 'platform.organizations.read')).toBe(false);
  });

  it('les rôles se cumulent', () => {
    expect(platformCan(['content_admin', 'operations'], 'platform.jobs.retry')).toBe(true);
  });
});
