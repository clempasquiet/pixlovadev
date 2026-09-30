import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';
import * as schema from './schema/index.js';

export { schema };
export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Dossier des migrations SQL versionnées (relues avant intégration). */
export const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema });
}

/** Applique les migrations ; à exécuter avec le rôle propriétaire (`pixlova_owner`). */
export async function runMigrations(pool: Pool): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Exécute `work` dans une transaction dont le contexte tenant est fixé (SEC-003, SEC-004).
 * `set_config(…, true)` limite le réglage à la transaction : une connexion rendue au pool
 * ne conserve aucun tenant. Avec le rôle `pixlova_app`, les policies RLS masquent et
 * refusent toute ligne d’une autre organisation.
 */
export async function withTenant<T>(
  db: Database,
  organizationId: string,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (!UUID.test(organizationId)) throw new Error('Identifiant d’organisation invalide.');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('pixlova.organization_id', ${organizationId}, true)`);
    return work(tx);
  });
}
