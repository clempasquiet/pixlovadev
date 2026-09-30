/**
 * Amorçage et secours de l’administration plateforme (ADR-016), exécuté par l’exploitant
 * sur le serveur, jamais exposé en HTTP :
 *
 *   node apps/api/dist/admin-cli.js create-operator --email a@b.fr --name "Nom" --role super_admin
 *   node apps/api/dist/admin-cli.js reset-operator --email a@b.fr
 *
 * Le code d’activation s’affiche une seule fois ; il se saisit dans la console avec un
 * nouveau mot de passe, puis le TOTP est enrôlé. Chaque usage est audité.
 */
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { createDatabase, schema } from '@pixlova/db';
import { isPlatformRole, type PlatformRole } from '@pixlova/permissions';
import { createOperator, issueActivation } from './admin/operators.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const command = process.argv[2];
const url = process.env.DATABASE_PLATFORM_URL ?? fail('DATABASE_PLATFORM_URL est requis.');
const hours = Number(process.env.PIXLOVA_ADMIN_ACTIVATION_HOURS ?? 24);
const email = (option('--email') ?? fail('--email est requis.')).trim().toLowerCase();
const pool = new pg.Pool({ connectionString: url, max: 1 });
const db = createDatabase(pool);

try {
  const issued = await db.transaction(async (tx) => {
    let result;
    if (command === 'create-operator') {
      const name = option('--name') ?? fail('--name est requis.');
      const roles = process.argv
        .flatMap((arg, index) => (process.argv[index - 1] === '--role' ? [arg] : []))
        .filter(
          (role): role is PlatformRole => isPlatformRole(role) || fail(`Rôle inconnu : ${role}`),
        );
      if (roles.length === 0) fail('Au moins un --role est requis.');
      result = await createOperator(
        tx,
        { email, displayName: name, roles },
        null,
        new Date(),
        hours,
      );
    } else if (command === 'reset-operator') {
      const [operator] = await tx
        .select({ id: schema.platformUsers.id })
        .from(schema.platformUsers)
        .where(eq(schema.platformUsers.emailNormalized, email));
      if (!operator) fail('Opérateur introuvable.');
      result = await issueActivation(tx, operator.id, null, new Date(), hours);
    } else {
      fail('Commandes : create-operator, reset-operator.');
    }
    await tx.insert(schema.auditLogs).values({
      organizationId: null,
      actorType: 'system',
      action:
        command === 'create-operator'
          ? 'platform.operator.created'
          : 'platform.operator.activation_issued',
      targetType: 'platform_user',
      targetId: result.operatorId,
      result: 'success',
      reason: 'admin-cli (accès serveur)',
      metadata: {},
    });
    return result;
  });
  console.log(
    `Code d’activation (affiché une seule fois, valable jusqu’au ${issued.expiresAt.toISOString()}) :`,
  );
  console.log(issued.activationCode);
} catch (error) {
  const code = (error as { code?: string; cause?: { code?: string } }).cause?.code;
  if (code === '23505') fail('Cette adresse est déjà un opérateur (utiliser reset-operator).');
  throw error;
} finally {
  await pool.end();
}
