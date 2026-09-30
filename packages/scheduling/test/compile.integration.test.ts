import { randomUUID } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeBase64url, verifyManifest, type PlayerCapabilities } from '@pixlova/contracts';
import { schema, withTenant } from '@pixlova/db';
import { createTestDatabase, skipDatabaseTests, type TestDatabase } from '@pixlova/db/testing';
import {
  COMPILE_DISPLAY,
  compileDisplay,
  manifestSignerFromSeed,
  requestRecompile,
  scheduleRenewals,
} from '../src/compiler/index.js';

const signer = manifestSignerFromSeed(
  'manifest-key-test',
  encodeBase64url(ed25519.utils.randomSecretKey()),
);
// Horloge de test postérieure au `now()` de la base (dates de création).
const NOW = new Date(Date.now() + 60_000);

const CAPABILITIES: PlayerCapabilities = {
  player_type: 'native',
  app_version: '0.1.0',
  os: { family: 'linux', version: '24.04' },
  architecture: 'x86_64',
  protocol_versions: [1],
  manifest_schemas: [1],
  render_schemas: [1],
  renderer: { engine: 'webkitgtk', version: '2.52' },
  image_types: ['image/png'],
  video_profiles: ['mp4-h264-aac'],
  max_canvas: null,
  max_concurrent_videos: 2,
  multi_output: 'supported',
  screenshot: 'supported',
  volume_control: 'supported',
  reboot_host: 'unsupported',
  persistent_storage: 'granted',
  storage_quota_bytes: null,
};

describe.skipIf(skipDatabaseTests)('compilation avec la base (DATA-010, ADR-011)', () => {
  let database: TestDatabase;
  const org = randomUUID();
  let displayId: string;
  let unassignedId: string;
  let playerId: string;
  let mediaId: string;
  let assetId: string;
  let programId: string;

  const tenant = <T>(work: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(database.app, org, work);

  async function revision(id = displayId): Promise<string> {
    const [row] = await tenant((tx) =>
      tx
        .select({ revision: schema.displays.configRevision })
        .from(schema.displays)
        .where(eq(schema.displays.id, id)),
    );
    return row!.revision.toString();
  }

  async function publishSchedule(version: number, mediaRef: string): Promise<void> {
    await tenant(async (tx) => {
      const [created] = await tx
        .insert(schema.programVersions)
        .values({
          organizationId: org,
          programId,
          version,
          schemaVersion: 1,
          document: {
            schema_version: 1,
            kind: 'schedule',
            timezone: null,
            targets: { include: [{ type: 'organization' }], exclude: [] },
            rules: [
              {
                id: randomUUID(),
                content: { type: 'media', id: mediaRef },
                priority: 10,
                weekdays: [1, 2, 3, 4, 5, 6, 7],
                start_time: '00:00',
                end_time: '24:00',
                start_date: null,
                end_date: null,
              },
            ],
            exceptions: [],
          },
        })
        .returning();
      await tx
        .update(schema.programs)
        .set({ publishedVersion: version, publishedVersionId: created!.id })
        .where(eq(schema.programs.id, programId));
      await requestRecompile(tx, org, 'all', 'test');
    });
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    await tenant(async (tx) => {
      await tx.insert(schema.organizations).values({
        id: org,
        name: 'Compilation',
        slug: `compil-${org.slice(0, 8)}`,
        country: 'FR',
        timezone: 'Europe/Paris',
      });
      const [site] = await tx
        .insert(schema.sites)
        .values({ organizationId: org, name: 'Siège' })
        .returning();
      const [display, unassigned] = await tx
        .insert(schema.displays)
        .values([
          { organizationId: org, siteId: site!.id, name: 'Vitrine', width: 1920, height: 1080 },
          { organizationId: org, siteId: site!.id, name: 'Réserve', width: 1920, height: 1080 },
        ])
        .returning();
      displayId = display!.id;
      unassignedId = unassigned!.id;
      const [player] = await tx
        .insert(schema.players)
        .values({
          organizationId: org,
          siteId: site!.id,
          name: 'Player',
          type: 'native',
          installationUuid: randomUUID(),
          capabilities: CAPABILITIES,
        })
        .returning();
      playerId = player!.id;
      const [output] = await tx
        .insert(schema.playerOutputs)
        .values({ organizationId: org, playerId, outputKey: 'HDMI-A-1' })
        .returning();
      await tx.insert(schema.displayAssignments).values({
        organizationId: org,
        displayId,
        playerOutputId: output!.id,
        generation: 1n,
      });
      await tx
        .update(schema.displays)
        .set({ assignmentGeneration: 1n })
        .where(eq(schema.displays.id, displayId));
      const [media] = await tx
        .insert(schema.media)
        .values({
          organizationId: org,
          name: 'Affiche',
          type: 'image',
          status: 'ready',
          declaredMimeType: 'image/png',
          mimeType: 'image/png',
          originalFilename: 'affiche.png',
          sizeBytes: 1234,
          checksumSha256: 'c'.repeat(64),
        })
        .returning();
      mediaId = media!.id;
      const [asset] = await tx
        .insert(schema.mediaAssets)
        .values({
          organizationId: org,
          mediaId,
          variant: 'playback',
          profile: 'passthrough',
          storageKey: `org/${org}/media/${mediaId}/playback`,
          mimeType: 'image/png',
          sizeBytes: 1234,
          checksumSha256: 'c'.repeat(64),
        })
        .returning();
      assetId = asset!.id;
      const [program] = await tx
        .insert(schema.programs)
        .values({ organizationId: org, kind: 'schedule', name: 'Semaine', draftDocument: {} })
        .returning();
      programId = program!.id;
    });
    await publishSchedule(1, mediaId);
  }, 60_000);

  afterAll(async () => {
    await database?.close();
  });

  it('publie un manifest signé, ses assets et une livraison désirée', async () => {
    const jobs = await database.system
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.kind, COMPILE_DISPLAY));
    expect(jobs.map((j) => j.payload)).toContainEqual(
      expect.objectContaining({ display_id: displayId, config_revision: '1' }),
    );
    const outcome = await compileDisplay({
      db: database.app,
      organizationId: org,
      displayId,
      configRevision: await revision(),
      signer,
      now: NOW,
    });
    expect(outcome.status).toBe('published');
    if (outcome.status !== 'published') return;
    expect(outcome.version).toBe('1');
    const [manifest] = await tenant((tx) =>
      tx.select().from(schema.manifests).where(eq(schema.manifests.id, outcome.manifestId)),
    );
    const verified = verifyManifest(manifest!.envelope, new Map([[signer.kid, signer.publicKey]]));
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.manifest.player_id).toBe(playerId);
      expect(verified.manifest.assignment_generation).toBe('1');
      expect(verified.manifest.assets.map((a) => a.id)).toEqual([assetId]);
      expect(verified.manifestHash).toBe(manifest!.payloadHash);
    }
    const assets = await tenant((tx) =>
      tx
        .select()
        .from(schema.manifestAssets)
        .where(eq(schema.manifestAssets.manifestId, outcome.manifestId)),
    );
    expect(assets.map((a) => a.mediaAssetId)).toEqual([assetId]);
    const deliveries = await tenant((tx) =>
      tx
        .select()
        .from(schema.manifestDeliveries)
        .where(eq(schema.manifestDeliveries.displayId, displayId)),
    );
    expect(deliveries.map((d) => d.state)).toEqual(['desired']);
  });

  it('est idempotent : mêmes entrées, aucun nouveau manifest', async () => {
    await tenant((tx) => requestRecompile(tx, org, [displayId], 'test'));
    const outcome = await compileDisplay({
      db: database.app,
      organizationId: org,
      displayId,
      configRevision: await revision(),
      signer,
      now: NOW,
    });
    expect(outcome.status).toBe('unchanged');
    const count = await tenant((tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(schema.manifests),
    );
    expect(count[0]!.n).toBe(1);
  });

  it('une tâche d’une révision dépassée ne produit rien ; une révision concurrente l’emporte', async () => {
    const old = await revision();
    await publishSchedule(2, mediaId);
    expect(
      await compileDisplay({
        db: database.app,
        organizationId: org,
        displayId,
        configRevision: old,
        signer,
        now: NOW,
      }),
    ).toEqual({ status: 'stale' });
    const concurrent = await compileDisplay({
      db: database.app,
      organizationId: org,
      displayId,
      configRevision: await revision(),
      signer,
      now: NOW,
      beforeCommit: () => tenant((tx) => requestRecompile(tx, org, [displayId], 'concurrent')),
    });
    expect(concurrent.status).toBe('superseded');
    const next = await compileDisplay({
      db: database.app,
      organizationId: org,
      displayId,
      configRevision: await revision(),
      signer,
      now: NOW,
    });
    expect(next).toMatchObject({ status: 'published', version: '2' });
    const deliveries = await tenant((tx) =>
      tx
        .select({ state: schema.manifestDeliveries.state })
        .from(schema.manifestDeliveries)
        .where(eq(schema.manifestDeliveries.displayId, displayId))
        .orderBy(schema.manifestDeliveries.createdAt),
    );
    expect(deliveries.map((d) => d.state)).toEqual(['superseded', 'desired']);
  });

  it('refuse au préflight sans distribuer ; le manifest précédent reste désiré', async () => {
    await tenant(async (tx) => {
      await tx
        .update(schema.players)
        .set({ capabilities: { ...CAPABILITIES, image_types: ['image/webp'] } })
        .where(eq(schema.players.id, playerId));
      await requestRecompile(tx, org, [displayId], 'capabilities');
    });
    const outcome = await compileDisplay({
      db: database.app,
      organizationId: org,
      displayId,
      configRevision: await revision(),
      signer,
      now: NOW,
    });
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.issues.map((i) => i.code)).toContain('UNSUPPORTED_IMAGE_TYPE');
    }
    const [latest] = await tenant((tx) =>
      tx
        .select({ version: schema.manifests.version })
        .from(schema.manifests)
        .where(eq(schema.manifests.displayId, displayId))
        .orderBy(sql`${schema.manifests.version} desc`)
        .limit(1),
    );
    expect(latest!.version).toBe(2n);
    await tenant((tx) =>
      tx
        .update(schema.players)
        .set({ capabilities: CAPABILITIES })
        .where(eq(schema.players.id, playerId)),
    );
  });

  it('un Display non affecté est journalisé sans manifest', async () => {
    const outcome = await compileDisplay({
      db: database.app,
      organizationId: org,
      displayId: unassignedId,
      signer,
      now: NOW,
    });
    expect(outcome.status).toBe('unassigned');
  });

  it('renouvelle l’horizon avant épuisement, sans doublon de tâche', async () => {
    await database.system
      .update(schema.jobs)
      .set({ state: 'succeeded' })
      .where(eq(schema.jobs.kind, COMPILE_DISPLAY));
    // Horizon de 7 jours encore suffisant : rien à renouveler.
    expect(await scheduleRenewals(database.system, NOW)).toBe(0);
    // Trois jours plus tard, il reste moins de 5 jours : une seule tâche, même rappelé.
    const later = new Date(NOW.getTime() + 3 * 86_400_000);
    expect(await scheduleRenewals(database.system, later)).toBe(1);
    expect(await scheduleRenewals(database.system, later)).toBe(0);
    const outcome = await compileDisplay({
      db: database.app,
      organizationId: org,
      displayId,
      configRevision: await revision(),
      signer,
      now: later,
    });
    expect(outcome).toMatchObject({ status: 'published', version: '3' });
  });
});
