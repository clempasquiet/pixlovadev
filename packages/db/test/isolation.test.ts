import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withTenant, type Database } from '../src/index.js';
import {
  createTestDatabase,
  skipDatabaseTests,
  sqlState,
  type TestDatabase,
} from '../src/testing.js';

const { auditLogs, displayAssignments, displays, organizations, playerOutputs, players, sites } =
  schema;

interface Tenant {
  organizationId: string;
  siteId: string;
  displayId: string;
  outputIds: [string, string];
  playerId: string;
}

/** Deux organisations aux identifiants connus des tests (TST-002). */
async function seedTenant(db: Database, slug: string): Promise<Tenant> {
  const organizationId = randomUUID();
  return withTenant(db, organizationId, async (tx) => {
    await tx.insert(organizations).values({
      id: organizationId,
      name: slug,
      slug,
      country: 'FR',
      timezone: 'Europe/Paris',
    });
    const [site] = await tx
      .insert(sites)
      .values({ organizationId, name: 'Siège' })
      .returning({ id: sites.id });
    const [player] = await tx
      .insert(players)
      .values({
        organizationId,
        siteId: site!.id,
        name: 'Player vitrine',
        type: 'native',
        installationUuid: randomUUID(),
      })
      .returning({ id: players.id });
    const outputs = await tx
      .insert(playerOutputs)
      .values([
        { organizationId, playerId: player!.id, outputKey: 'HDMI-A-1' },
        { organizationId, playerId: player!.id, outputKey: 'HDMI-A-2' },
      ])
      .returning({ id: playerOutputs.id });
    const [display] = await tx
      .insert(displays)
      .values({ organizationId, siteId: site!.id, name: 'Bandeau LED', width: 2688, height: 672 })
      .returning({ id: displays.id });
    return {
      organizationId,
      siteId: site!.id,
      displayId: display!.id,
      outputIds: [outputs[0]!.id, outputs[1]!.id],
      playerId: player!.id,
    };
  });
}

async function expectSqlState(promise: Promise<unknown>, state: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `SQLSTATE ${state} attendu`).toBeDefined();
  expect(sqlState(error)).toBe(state);
}

describe.skipIf(skipDatabaseTests)(
  'isolation tenant et intégrité (DATA-002, SEC-004, DATA-011)',
  () => {
    let database: TestDatabase;
    let a: Tenant;
    let b: Tenant;

    beforeAll(async () => {
      database = await createTestDatabase();
      a = await seedTenant(database.app, `org-a-${randomUUID().slice(0, 8)}`);
      b = await seedTenant(database.app, `org-b-${randomUUID().slice(0, 8)}`);
    }, 60_000);

    afterAll(async () => {
      await database?.close();
    });

    describe('RLS : rôle applicatif sous contexte tenant', () => {
      it('ne voit que les lignes de son organisation, y compris par accès direct à un ID', async () => {
        const rows = await withTenant(database.app, a.organizationId, (tx) =>
          tx.select({ id: displays.id }).from(displays),
        );
        expect(rows.map((r) => r.id)).toEqual([a.displayId]);
        const direct = await withTenant(database.app, a.organizationId, (tx) =>
          tx.select().from(displays).where(eq(displays.id, b.displayId)),
        );
        expect(direct).toEqual([]);
      });

      it('sans contexte tenant, ne voit aucune ligne (fail closed)', async () => {
        const rows = await database.app.select().from(displays);
        expect(rows).toEqual([]);
        const orgs = await database.app.select().from(organizations);
        expect(orgs).toEqual([]);
      });

      it('refuse l’écriture d’une ligne pour une autre organisation', async () => {
        await expectSqlState(
          withTenant(database.app, a.organizationId, (tx) =>
            tx.insert(sites).values({ organizationId: b.organizationId, name: 'Intrus' }),
          ),
          '42501',
        );
      });

      it('ne modifie pas une ligne d’une autre organisation', async () => {
        const updated = await withTenant(database.app, a.organizationId, (tx) =>
          tx
            .update(displays)
            .set({ name: 'Piraté' })
            .where(eq(displays.id, b.displayId))
            .returning({ id: displays.id }),
        );
        expect(updated).toEqual([]);
      });

      it('ne réutilise pas le contexte tenant d’une transaction précédente sur la même connexion', async () => {
        const client = await database.appPool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`select set_config('pixlova.organization_id', $1, true)`, [
            a.organizationId,
          ]);
          await client.query('COMMIT');
          const { rows } = await client.query('select count(*)::int as n from displays');
          expect(rows[0].n).toBe(0);
        } finally {
          client.release();
        }
      });

      it('toute table portant organization_id a RLS et une policy (garde-fou des migrations)', async () => {
        const { rows } = await database.owner.query<{
          table: string;
          rls: boolean;
          policies: number;
        }>(`
        select c.relname as table, c.relrowsecurity as rls,
               (select count(*)::int from pg_policies p where p.tablename = c.relname) as policies
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        where c.relkind = 'r'
          and exists (select 1 from information_schema.columns col
                      where col.table_schema = 'public' and col.table_name = c.relname
                        and col.column_name in ('organization_id'))
        order by 1`);
        expect(rows.length).toBeGreaterThanOrEqual(10);
        for (const row of rows) {
          expect(row, row.table).toMatchObject({ rls: true });
          expect(row.policies, row.table).toBeGreaterThan(0);
        }
      });
    });

    describe('clés étrangères composites : aucune association inter-tenant, même en rôle système', () => {
      it('refuse un Display rattaché au site d’une autre organisation', async () => {
        await expectSqlState(
          database.system.insert(displays).values({
            organizationId: a.organizationId,
            siteId: b.siteId,
            name: 'Croisé',
            width: 1920,
            height: 1080,
          }),
          '23503',
        );
      });

      it('refuse une affectation vers la sortie d’un Player d’une autre organisation', async () => {
        await expectSqlState(
          database.system.insert(displayAssignments).values({
            organizationId: a.organizationId,
            displayId: a.displayId,
            playerOutputId: b.outputIds[0],
            generation: 1n,
          }),
          '23503',
        );
      });
    });

    describe('contraintes métier', () => {
      it('accepte les formats LED atypiques et refuse dimensions ou orientation invalides (PROD-002)', async () => {
        await withTenant(database.app, a.organizationId, async (tx) => {
          for (const [width, height] of [
            [3840, 480],
            [768, 2304],
            [1080, 1920],
          ] as const) {
            await tx.insert(displays).values({
              organizationId: a.organizationId,
              siteId: a.siteId,
              name: `${width}x${height}`,
              width,
              height,
            });
          }
        });
        await expectSqlState(
          withTenant(database.app, a.organizationId, (tx) =>
            tx.insert(displays).values({
              organizationId: a.organizationId,
              siteId: a.siteId,
              name: 'Nul',
              width: 0,
              height: 10,
            }),
          ),
          '23514',
        );
        await expectSqlState(
          withTenant(database.app, a.organizationId, (tx) =>
            tx.insert(displays).values({
              organizationId: a.organizationId,
              siteId: a.siteId,
              name: 'Penché',
              width: 10,
              height: 10,
              orientation: 45,
            }),
          ),
          '23514',
        );
      });

      it('le journal d’audit est en ajout seul pour le rôle applicatif (SEC-016)', async () => {
        const [entry] = await withTenant(database.app, a.organizationId, (tx) =>
          tx
            .insert(auditLogs)
            .values({
              organizationId: a.organizationId,
              actorType: 'system',
              action: 'test.audit',
              result: 'success',
            })
            .returning({ id: auditLogs.id }),
        );
        await expectSqlState(
          withTenant(database.app, a.organizationId, (tx) =>
            tx.update(auditLogs).set({ action: 'effacé' }).where(eq(auditLogs.id, entry!.id)),
          ),
          '42501',
        );
        await expectSqlState(
          withTenant(database.app, a.organizationId, (tx) =>
            tx.delete(auditLogs).where(eq(auditLogs.id, entry!.id)),
          ),
          '42501',
        );
      });
    });

    describe('affectations (DSP-002, DSP-003, DATA-006, §16.9)', () => {
      async function assign(db: Database, tenant: Tenant, outputId: string, generation: bigint) {
        return withTenant(db, tenant.organizationId, (tx) =>
          tx.insert(displayAssignments).values({
            organizationId: tenant.organizationId,
            displayId: tenant.displayId,
            playerOutputId: outputId,
            generation,
          }),
        );
      }

      it('deux affectations concurrentes du même Display : une seule réussit', async () => {
        const results = await Promise.allSettled([
          assign(database.app, a, a.outputIds[0], 1n),
          assign(database.app, a, a.outputIds[1], 1n),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect(sqlState(rejected.reason)).toBe('23505');
      });

      it('une sortie ne peut porter qu’un Display actif', async () => {
        const second = await withTenant(database.app, b.organizationId, async (tx) => {
          const [display] = await tx
            .insert(displays)
            .values({
              organizationId: b.organizationId,
              siteId: b.siteId,
              name: 'Second',
              width: 1920,
              height: 1080,
            })
            .returning({ id: displays.id });
          return display!.id;
        });
        await assign(database.app, b, b.outputIds[0], 1n);
        await expectSqlState(
          withTenant(database.app, b.organizationId, (tx) =>
            tx.insert(displayAssignments).values({
              organizationId: b.organizationId,
              displayId: second,
              playerOutputId: b.outputIds[0],
              generation: 1n,
            }),
          ),
          '23505',
        );
      });

      it('le remplacement clôt l’ancienne affectation, incrémente la génération et conserve l’historique', async () => {
        // État initial : Display A affecté à une sortie (test concurrent précédent).
        const replacement = await withTenant(database.app, a.organizationId, async (tx) => {
          const [display] = await tx
            .select({ generation: displays.assignmentGeneration })
            .from(displays)
            .where(eq(displays.id, a.displayId))
            .for('update');
          const [current] = await tx
            .select()
            .from(displayAssignments)
            .where(
              and(
                eq(displayAssignments.displayId, a.displayId),
                isNull(displayAssignments.endedAt),
              ),
            )
            .for('update');
          const target =
            current!.playerOutputId === a.outputIds[0] ? a.outputIds[1] : a.outputIds[0];
          const next =
            (display!.generation > current!.generation
              ? display!.generation
              : current!.generation) + 1n;
          await tx
            .update(displayAssignments)
            .set({ endedAt: sql`now()` })
            .where(eq(displayAssignments.id, current!.id));
          await tx.insert(displayAssignments).values({
            organizationId: a.organizationId,
            displayId: a.displayId,
            playerOutputId: target,
            generation: next,
          });
          await tx
            .update(displays)
            .set({ assignmentGeneration: next })
            .where(eq(displays.id, a.displayId));
          return { previous: current!, next, target };
        });

        const history = await withTenant(database.app, a.organizationId, (tx) =>
          tx.select().from(displayAssignments).where(eq(displayAssignments.displayId, a.displayId)),
        );
        expect(history).toHaveLength(2);
        expect(history.filter((h) => h.endedAt === null)).toEqual([
          expect.objectContaining({
            playerOutputId: replacement.target,
            generation: replacement.next,
          }),
        ]);
        // Une ancienne génération ne peut pas être rouverte pour ce Display.
        await expectSqlState(
          withTenant(database.app, a.organizationId, (tx) =>
            tx.insert(displayAssignments).values({
              organizationId: a.organizationId,
              displayId: a.displayId,
              playerOutputId: replacement.previous.playerOutputId,
              generation: replacement.previous.generation,
            }),
          ),
          '23505',
        );
      });
    });
  },
);
