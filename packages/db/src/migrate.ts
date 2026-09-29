/**
 * Applique les migrations avec le rôle propriétaire (`DATABASE_OWNER_URL`).
 * Étape de déploiement distincte du démarrage de l’API (ARC-014).
 */
import pg from 'pg';
import { runMigrations } from './index.js';

const url = process.env.DATABASE_OWNER_URL;
if (!url) {
  console.error('DATABASE_OWNER_URL est requis (rôle pixlova_owner).');
  process.exit(2);
}
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await runMigrations(pool);
  console.log('Migrations appliquées.');
} finally {
  await pool.end();
}
