/**
 * Amorçage et secours de l’administration plateforme (ADR-016), exécuté par l’exploitant
 * sur le serveur, jamais exposé en HTTP :
 *
 *   node apps/api/dist/admin-cli.js create-operator --email a@b.fr --name "Nom" --role super_admin
 *   node apps/api/dist/admin-cli.js reset-operator --email a@b.fr
 *   node apps/api/dist/admin-cli.js catalog-import --file catalogue.json|- [--dry-run]
 *
 * Le code d’activation s’affiche une seule fois ; il se saisit dans la console avec un
 * nouveau mot de passe, puis le TOTP est enrôlé. Chaque usage est audité.
 *
 * `catalog-import` publie le catalogue commercial (ADR-017, ADM-005) : seules les offres
 * modifiées deviennent de nouvelles versions ; `--dry-run` affiche l’effet sans l’appliquer.
 */
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { CatalogError, importCatalog, parseCatalogFile, type ImportResult } from '@pixlova/billing';
import { createDatabase, schema } from '@pixlova/db';
import { isPlatformRole, type PlatformRole } from '@pixlova/permissions';
import { createOperator, issueActivation } from './admin/operators.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const command = process.argv[2];
const url = process.env.DATABASE_PLATFORM_URL ?? fail('DATABASE_PLATFORM_URL est requis.');

if (command === 'catalog-import') {
  const path = option('--file') ?? fail('--file est requis.');
  const dryRun = process.argv.includes('--dry-run');
  let file;
  try {
    // `--file -` : lecture sur l’entrée standard (fichier hors du conteneur).
    const text = path === '-' ? await readStdin() : await readFile(path, 'utf8');
    file = parseCatalogFile(JSON.parse(text));
  } catch (error) {
    fail(
      error instanceof CatalogError || error instanceof SyntaxError ? error.message : String(error),
    );
  }
  const catalogPool = new pg.Pool({ connectionString: url, max: 1 });
  const catalogDb = createDatabase(catalogPool);
  class DryRun extends Error {}
  try {
    let report: ImportResult | undefined;
    try {
      await catalogDb.transaction(async (tx) => {
        const result = await importCatalog(tx, file, new Date());
        report = result;
        await tx.insert(schema.auditLogs).values({
          organizationId: null,
          actorType: 'system',
          action: 'billing.catalog.published',
          result: 'success',
          reason: 'admin-cli (accès serveur)',
          metadata: {
            published: result.published.map((p) => `${p.key}@${p.version}`),
            archived: result.archived,
          },
        });
        if (dryRun) throw new DryRun();
      });
    } catch (error) {
      if (!(error instanceof DryRun)) throw error;
    }
    console.log(JSON.stringify({ dry_run: dryRun, ...report }, null, 2));
  } finally {
    await catalogPool.end();
  }
  process.exit(0);
}

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
      fail('Commandes : create-operator, reset-operator, catalog-import.');
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
