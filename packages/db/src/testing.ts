/**
 * Outils de test (entrée `@pixlova/db/testing`, jamais importée par du code de production).
 *
 * Base PostgreSQL éphémère pour les tests : rôles créés par `sql/bootstrap-roles.sql`,
 * base dédiée possédée par `pixlova_owner`, migrations appliquées par ce rôle.
 *
 * `PIXLOVA_TEST_DATABASE_URL` désigne un compte administrateur de test (jamais une base
 * réelle). Sans cette variable, les tests sont ignorés localement et échouent en CI.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createDatabase, runMigrations, type Database } from './index.js';

export const adminUrl = process.env.PIXLOVA_TEST_DATABASE_URL;
export const skipDatabaseTests = !adminUrl && !process.env.CI;

const TEST_PASSWORD = 'pixlova-test-only';
const bootstrapSql = resolve(dirname(fileURLToPath(import.meta.url)), '../sql/bootstrap-roles.sql');

export interface TestDatabase {
  owner: pg.Pool;
  app: Database;
  appPool: pg.Pool;
  system: Database;
  systemPool: pg.Pool;
  /** Rôle de l’administration plateforme (ADR-016). */
  platform: Database;
  platformPool: pg.Pool;
  close(): Promise<void>;
}

function urlFor(base: string, user: string, database: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = TEST_PASSWORD;
  url.pathname = `/${database}`;
  return url.toString();
}

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!adminUrl) throw new Error('PIXLOVA_TEST_DATABASE_URL est requis pour les tests de base.');
  const name = `pixlova_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Les rôles sont globaux au cluster : plusieurs suites (packages, fichiers) les
    // initialisent en parallèle. Un verrou consultatif sérialise cette étape.
    await admin.query('SELECT pg_advisory_lock(727601)');
    try {
      await admin.query(await readFile(bootstrapSql, 'utf8'));
      for (const role of ['pixlova_owner', 'pixlova_app', 'pixlova_system', 'pixlova_platform']) {
        await admin.query(`ALTER ROLE ${role} LOGIN PASSWORD '${TEST_PASSWORD}'`);
      }
    } finally {
      await admin.query('SELECT pg_advisory_unlock(727601)');
    }
    await admin.query(`CREATE DATABASE ${name} OWNER pixlova_owner`);
  } finally {
    await admin.end();
  }

  const owner = new pg.Pool({ connectionString: urlFor(adminUrl, 'pixlova_owner', name), max: 2 });
  await runMigrations(owner);
  const appPool = new pg.Pool({ connectionString: urlFor(adminUrl, 'pixlova_app', name), max: 6 });
  const systemPool = new pg.Pool({
    connectionString: urlFor(adminUrl, 'pixlova_system', name),
    max: 4,
  });

  const platformPool = new pg.Pool({
    connectionString: urlFor(adminUrl, 'pixlova_platform', name),
    max: 4,
  });

  return {
    owner,
    app: createDatabase(appPool),
    appPool,
    system: createDatabase(systemPool),
    systemPool,
    platform: createDatabase(platformPool),
    platformPool,
    async close() {
      const pools = [owner, appPool, systemPool, platformPool];
      // Une connexion encore en cours de fermeture peut être coupée par la suppression
      // forcée de la base : erreur attendue au démontage, sans rapport avec le test.
      for (const pool of pools) pool.on('error', () => undefined);
      await Promise.all(pools.map((pool) => pool.end()));
      const cleanup = new pg.Client({ connectionString: adminUrl });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

/** Code SQLSTATE d’une erreur PostgreSQL remontée par drizzle ou pg. */
export function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
