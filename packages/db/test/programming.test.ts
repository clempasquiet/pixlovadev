import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema, withTenant } from '../src/index.js';
import {
  createTestDatabase,
  skipDatabaseTests,
  sqlState,
  type TestDatabase,
} from '../src/testing.js';

async function expectSqlState(promise: Promise<unknown>, state: string): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, `SQLSTATE ${state} attendu`).toBeDefined();
  expect(sqlState(error)).toBe(state);
}

describe.skipIf(skipDatabaseTests)('programmation et manifests (ADR-011)', () => {
  let database: TestDatabase;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  let siteId: string;
  let displayId: string;
  let playerId: string;
  let playlistId: string;
  let playlistVersionId: string;
  let otherPlaylistId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    for (const [org, slug] of [
      [organizationId, 'prog-a'],
      [otherOrganizationId, 'prog-b'],
    ] as const) {
      await withTenant(database.app, org, async (tx) => {
        await tx.insert(schema.organizations).values({
          id: org,
          name: slug,
          slug: `${slug}-${org.slice(0, 8)}`,
          country: 'FR',
          timezone: 'Europe/Paris',
        });
        const [playlist] = await tx
          .insert(schema.playlists)
          .values({ organizationId: org, name: 'Accueil', draftDocument: {} })
          .returning();
        if (org === otherOrganizationId) {
          otherPlaylistId = playlist!.id;
          return;
        }
        playlistId = playlist!.id;
        const [version] = await tx
          .insert(schema.playlistVersions)
          .values({ organizationId: org, playlistId, version: 1, schemaVersion: 1, document: {} })
          .returning();
        playlistVersionId = version!.id;
        const [site] = await tx
          .insert(schema.sites)
          .values({ organizationId: org, name: 'Siège' })
          .returning();
        siteId = site!.id;
        const [display] = await tx
          .insert(schema.displays)
          .values({ organizationId: org, siteId, name: 'Vitrine', width: 1920, height: 1080 })
          .returning();
        displayId = display!.id;
        const [player] = await tx
          .insert(schema.players)
          .values({
            organizationId: org,
            siteId,
            name: 'Player',
            type: 'native',
            installationUuid: randomUUID(),
          })
          .returning();
        playerId = player!.id;
      });
    }
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  it('une dépendance a exactement une source et une cible, du même tenant', async () => {
    const [program] = await withTenant(database.app, organizationId, (tx) =>
      tx
        .insert(schema.programs)
        .values({ organizationId, kind: 'schedule', name: 'Semaine', draftDocument: {} })
        .returning(),
    );
    const [programVersion] = await withTenant(database.app, organizationId, (tx) =>
      tx
        .insert(schema.programVersions)
        .values({
          organizationId,
          programId: program!.id,
          version: 1,
          schemaVersion: 1,
          document: {},
        })
        .returning(),
    );
    await withTenant(database.app, organizationId, (tx) =>
      tx
        .insert(schema.contentDependencies)
        .values({ organizationId, programVersionId: programVersion!.id, playlistId }),
    );
    // Arête dupliquée.
    await expectSqlState(
      withTenant(database.app, organizationId, (tx) =>
        tx
          .insert(schema.contentDependencies)
          .values({ organizationId, programVersionId: programVersion!.id, playlistId }),
      ),
      '23505',
    );
    // Deux sources, puis aucune cible.
    await expectSqlState(
      withTenant(database.app, organizationId, (tx) =>
        tx.insert(schema.contentDependencies).values({
          organizationId,
          programVersionId: programVersion!.id,
          playlistVersionId,
          playlistId,
        }),
      ),
      '23514',
    );
    await expectSqlState(
      withTenant(database.app, organizationId, (tx) =>
        tx
          .insert(schema.contentDependencies)
          .values({ organizationId, programVersionId: programVersion!.id }),
      ),
      '23514',
    );
    // Cible d’un autre tenant : refusée même par le rôle système.
    await expectSqlState(
      database.system.insert(schema.contentDependencies).values({
        organizationId,
        programVersionId: programVersion!.id,
        playlistId: otherPlaylistId,
      }),
      '23503',
    );
  });

  it('le fallback désigne un seul contenu du même tenant', async () => {
    await expectSqlState(
      withTenant(database.app, organizationId, (tx) =>
        tx
          .update(schema.displays)
          .set({ fallbackMode: 'standby_screen', fallbackPlaylistId: playlistId })
          .where(eq(schema.displays.id, displayId)),
      ),
      '23514',
    );
    await expectSqlState(
      database.system
        .update(schema.displays)
        .set({ fallbackMode: 'content', fallbackPlaylistId: otherPlaylistId })
        .where(eq(schema.displays.id, displayId)),
      '23503',
    );
    await withTenant(database.app, organizationId, (tx) =>
      tx
        .update(schema.displays)
        .set({ fallbackMode: 'content', fallbackPlaylistId: playlistId })
        .where(eq(schema.displays.id, displayId)),
    );
  });

  it('manifests, versions et compilations sont en ajout seul ; numéros uniques par Display', async () => {
    const manifest = {
      organizationId,
      displayId,
      playerId,
      version: 1n,
      assignmentGeneration: 1n,
      configRevision: 1n,
      schemaVersion: 1,
      payloadHash: 'a'.repeat(64),
      inputHash: 'b'.repeat(64),
      keyId: 'manifest-key-test',
      envelope: '{}',
      generatedAt: new Date('2026-10-01T10:00:00Z'),
      validFrom: new Date('2026-10-01T10:00:00Z'),
      scheduleUntil: new Date('2026-10-08T10:00:00Z'),
    };
    const id = randomUUID();
    await withTenant(database.app, organizationId, (tx) =>
      tx.insert(schema.manifests).values({ ...manifest, id }),
    );
    await expectSqlState(
      withTenant(database.app, organizationId, (tx) =>
        tx.insert(schema.manifests).values({ ...manifest, id: randomUUID() }),
      ),
      '23505',
    );
    for (const attempt of [
      (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) =>
        tx.update(schema.manifests).set({ envelope: '[]' }).where(eq(schema.manifests.id, id)),
      (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) =>
        tx.delete(schema.manifests).where(eq(schema.manifests.id, id)),
      (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) =>
        tx
          .update(schema.playlistVersions)
          .set({ document: { altered: true } })
          .where(eq(schema.playlistVersions.id, playlistVersionId)),
      (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) =>
        tx.delete(schema.displayCompilations),
    ]) {
      await expectSqlState(withTenant(database.app, organizationId, attempt), '42501');
    }
    // Les livraisons évoluent (états déclarés par le Player) mais restent contrôlées.
    const [delivery] = await withTenant(database.app, organizationId, (tx) =>
      tx
        .insert(schema.manifestDeliveries)
        .values({ organizationId, manifestId: id, displayId, playerId, assignmentGeneration: 1n })
        .returning(),
    );
    await expectSqlState(
      withTenant(database.app, organizationId, (tx) =>
        tx
          .update(schema.manifestDeliveries)
          .set({ state: 'installed' as 'applied' })
          .where(eq(schema.manifestDeliveries.id, delivery!.id)),
      ),
      '23514',
    );
  });
});
