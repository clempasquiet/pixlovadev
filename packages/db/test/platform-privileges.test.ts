/**
 * Séparation des rôles de l’administration plateforme (ADR-016, ADM-002) : le rôle
 * `pixlova_platform` lit le diagnostic sans jamais lire un secret client, et les rôles
 * applicatifs n’accèdent à aucune table des opérateurs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  skipDatabaseTests,
  sqlState,
  type TestDatabase,
} from '../src/testing.js';

const INSUFFICIENT_PRIVILEGE = '42501';

describe.skipIf(skipDatabaseTests)('privilèges de l’administration plateforme', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase();
    await db.systemPool.query(
      `INSERT INTO users (email_normalized, password_hash, status) VALUES ('client@example.test', 'argon2-empreinte', 'active')`,
    );
  });
  afterAll(async () => {
    await db?.close();
  });

  async function refused(pool: TestDatabase['appPool'], query: string): Promise<void> {
    const error = await pool.query(query).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(sqlState(error), query).toBe(INSUFFICIENT_PRIVILEGE);
  }

  it('lit les colonnes de diagnostic des comptes clients, jamais l’empreinte du mot de passe', async () => {
    const { rows } = await db.platformPool.query(
      `SELECT id, email_normalized, status, mfa_enabled FROM users`,
    );
    expect(rows).toHaveLength(1);
    await refused(db.platformPool, 'SELECT password_hash FROM users');
    await refused(db.platformPool, 'SELECT * FROM users');
    await refused(db.platformPool, 'SELECT token_hash FROM user_sessions');
    await refused(db.platformPool, 'SELECT encrypted_secret FROM mfa_credentials');
    await refused(db.platformPool, 'SELECT code_hash FROM mfa_recovery_codes');
    await refused(db.platformPool, 'SELECT payload_encrypted, recipient FROM email_outbox');
    await refused(db.platformPool, 'SELECT payload FROM jobs');
    await refused(db.platformPool, 'SELECT * FROM player_credentials');
    await refused(db.platformPool, 'SELECT * FROM media');
  });

  it('ne modifie que les colonnes des actions de support prévues', async () => {
    await db.platformPool.query(`UPDATE users SET status = 'disabled', updated_at = now()`);
    await refused(db.platformPool, `UPDATE users SET email_normalized = 'x@example.test'`);
    await refused(db.platformPool, `UPDATE users SET password_hash = NULL`);
    await refused(db.platformPool, `DELETE FROM users`);
    await refused(db.platformPool, `UPDATE organizations SET name = 'x'`);
    await refused(db.platformPool, `DELETE FROM audit_logs`);
    await refused(db.platformPool, `UPDATE audit_logs SET reason = 'x'`);
  });

  it('les rôles applicatifs n’accèdent à aucune table des opérateurs', async () => {
    for (const pool of [db.appPool, db.systemPool]) {
      for (const table of [
        'platform_users',
        'platform_user_roles',
        'platform_sessions',
        'platform_mfa_credentials',
        'platform_activation_tokens',
      ]) {
        await refused(pool, `SELECT 1 FROM ${table}`);
      }
    }
  });
});
