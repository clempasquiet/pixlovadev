import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adjustUsage,
  claimJob,
  completeJob,
  enqueueJob,
  failJob,
  lockUsage,
  renewJobLease,
  schema,
  withTenant,
  type Database,
} from '../src/index.js';
import { createTestDatabase, skipDatabaseTests, type TestDatabase } from '../src/testing.js';

const KINDS = ['test.work'];
// Horloge de test postérieure au `now()` de la base (échéance par défaut des tâches).
const at = (seconds: number) => new Date(Date.UTC(2030, 0, 1, 12, 0, seconds));

async function organization(db: Database, slug: string): Promise<string> {
  const id = randomUUID();
  await withTenant(db, id, (tx) =>
    tx.insert(schema.organizations).values({
      id,
      name: slug,
      slug: `${slug}-${id.slice(0, 8)}`,
      country: 'FR',
      timezone: 'Europe/Paris',
    }),
  );
  return id;
}

describe.skipIf(skipDatabaseTests)('file de tâches PostgreSQL (ADR-009)', () => {
  let db: TestDatabase;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    orgA = await organization(db.app, 'a');
    orgB = await organization(db.app, 'b');
  }, 60_000);
  afterAll(async () => {
    await db?.close();
  });

  it('une seule tâche active par clé métier, même en création concurrente', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        withTenant(db.app, orgA, (tx) =>
          enqueueJob(tx, { organizationId: orgA, kind: 'test.dedupe', dedupeKey: 'media-1' }),
        ).catch((error: unknown) => error),
      ),
    );
    const ids = new Set(
      results
        .filter((r): r is { id: string; created: boolean } => !(r instanceof Error))
        .map((r) => r.id),
    );
    expect(ids.size).toBe(1);
    const rows = await db.system
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.kind, 'test.dedupe'));
    expect(rows).toHaveLength(1);
  });

  it('deux workers ne réclament jamais la même tâche', async () => {
    for (let i = 0; i < 4; i += 1) {
      await withTenant(db.app, orgA, (tx) =>
        enqueueJob(tx, { organizationId: orgA, kind: 'test.parallel', dedupeKey: `p-${i}` }),
      );
    }
    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        claimJob(db.system, {
          workerId: `w${i}`,
          kinds: ['test.parallel'],
          leaseSeconds: 60,
          now: at(0),
        }),
      ),
    );
    const claimed = claims.filter((c) => c !== null);
    expect(claimed).toHaveLength(4);
    expect(new Set(claimed.map((c) => c.id)).size).toBe(4);
  });

  it('bail expiré : reprise par un autre worker ; l’ancien ne peut plus conclure', async () => {
    const { id } = await withTenant(db.app, orgB, (tx) =>
      enqueueJob(tx, {
        organizationId: orgB,
        kind: 'test.work',
        dedupeKey: 'crash',
        payload: { n: 1 },
      }),
    );
    const first = await claimJob(db.system, {
      workerId: 'w1',
      kinds: KINDS,
      leaseSeconds: 30,
      now: at(0),
    });
    expect(first).toMatchObject({ id, attempts: 1, organizationId: orgB, payload: { n: 1 } });
    expect(
      await claimJob(db.system, { workerId: 'w2', kinds: KINDS, leaseSeconds: 30, now: at(10) }),
    ).toBeNull();
    expect(await renewJobLease(db.system, id, 'w1', 30, at(20))).toBe(true);
    // Le worker 1 s’arrête ; son bail expire à 50 s.
    expect(
      await claimJob(db.system, { workerId: 'w2', kinds: KINDS, leaseSeconds: 30, now: at(45) }),
    ).toBeNull();
    const second = await claimJob(db.system, {
      workerId: 'w2',
      kinds: KINDS,
      leaseSeconds: 30,
      now: at(51),
    });
    expect(second).toMatchObject({ id, attempts: 2 });
    expect(await completeJob(db.system, id, 'w1', at(52))).toBe(false);
    expect(await renewJobLease(db.system, id, 'w1', 30, at(52))).toBe(false);
    expect(await completeJob(db.system, id, 'w2', at(53))).toBe(true);
    // Terminée, la clé redevient disponible pour une nouvelle tâche.
    const again = await withTenant(db.app, orgB, (tx) =>
      enqueueJob(tx, { organizationId: orgB, kind: 'test.work', dedupeKey: 'crash' }),
    );
    expect(again.created).toBe(true);
    await db.system.delete(schema.jobs).where(eq(schema.jobs.id, again.id));
  });

  it('échec transitoire repris à échéance, échec définitif conservé', async () => {
    const { id } = await withTenant(db.app, orgA, (tx) =>
      enqueueJob(tx, { organizationId: orgA, kind: 'test.work', dedupeKey: 'retry' }),
    );
    await claimJob(db.system, { workerId: 'w', kinds: KINDS, leaseSeconds: 30, now: at(0) });
    expect(await failJob(db.system, id, 'w', { error: 'stockage', retryAt: at(20) }, at(1))).toBe(
      true,
    );
    expect(
      await claimJob(db.system, { workerId: 'w', kinds: KINDS, leaseSeconds: 30, now: at(10) }),
    ).toBeNull();
    const retried = await claimJob(db.system, {
      workerId: 'w',
      kinds: KINDS,
      leaseSeconds: 30,
      now: at(21),
    });
    expect(retried).toMatchObject({ id, attempts: 2 });
    expect(await failJob(db.system, id, 'w', { error: 'format', retryAt: null }, at(22))).toBe(
      true,
    );
    const [row] = await db.system.select().from(schema.jobs).where(eq(schema.jobs.id, id));
    expect(row).toMatchObject({ state: 'failed', lastError: 'format', leaseOwner: null });
  });

  it('le rôle applicatif ne voit ni les tâches système ni celles d’un autre tenant', async () => {
    await enqueueJob(db.system, { organizationId: null, kind: 'test.system', dedupeKey: 'sweep' });
    await withTenant(db.app, orgB, (tx) =>
      enqueueJob(tx, { organizationId: orgB, kind: 'test.visible', dedupeKey: 'b' }),
    );
    const seen = await withTenant(db.app, orgA, (tx) => tx.select().from(schema.jobs));
    expect(seen.every((job) => job.organizationId === orgA)).toBe(true);
    await expect(
      withTenant(db.app, orgA, (tx) =>
        enqueueJob(tx, { organizationId: orgB, kind: 'test.forged', dedupeKey: 'x' }),
      ),
    ).rejects.toThrow();
  });

  it('compteurs d’usage : réservations concurrentes sérialisées, jamais négatifs', async () => {
    const limit = 100;
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        withTenant(db.app, orgA, async (tx) => {
          const usage = await lockUsage(tx, orgA, 'storage_bytes');
          if (usage.observed + usage.reserved + 30 > limit) return false;
          await adjustUsage(tx, orgA, 'storage_bytes', { reserved: 30 }, at(0));
          return true;
        }),
      ),
    );
    expect(attempts.filter(Boolean)).toHaveLength(3);
    await withTenant(db.app, orgA, (tx) =>
      adjustUsage(tx, orgA, 'storage_bytes', { reserved: -500, observed: 20 }, at(1)),
    );
    const usage = await withTenant(db.app, orgA, (tx) => lockUsage(tx, orgA, 'storage_bytes'));
    expect(usage).toEqual({ observed: 20, reserved: 0 });
  });
});
