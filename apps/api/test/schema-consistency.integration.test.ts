import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLE_KEYS } from '@pixlova/permissions';
import { createTestDatabase, skipDatabaseTests, type TestDatabase } from '@pixlova/db/testing';

/** La contrainte SQL des rôles et le catalogue `@pixlova/permissions` ne doivent pas diverger. */
describe.skipIf(skipDatabaseTests)('cohérence rôles SQL / catalogue', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    await database?.close();
  });

  it.each(['membership_grants_role_check', 'invitations_role_check'])(
    '%s liste exactement les rôles du catalogue',
    async (name) => {
      const { rows } = await database.owner.query<{ definition: string }>(
        'select pg_get_constraintdef(oid) as definition from pg_constraint where conname = $1',
        [name],
      );
      const roles = [...rows[0]!.definition.matchAll(/'([A-Za-z]+)'::text/g)]
        .map((m) => m[1])
        .sort();
      expect(roles).toEqual([...ROLE_KEYS].sort());
    },
  );
});
