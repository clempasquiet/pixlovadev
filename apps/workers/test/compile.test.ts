import { randomUUID } from 'node:crypto';
import { claimJob, schema, withTenant } from '@pixlova/db';
import { skipDatabaseTests } from '@pixlova/db/testing';
import { COMPILE_DISPLAY, requestRecompile } from '@pixlova/scheduling/compiler';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from './support.js';

describe.skipIf(skipDatabaseTests)('compilation des manifests par le worker (ADR-011)', () => {
  let h: Harness;
  let displayId: string;

  const tenant = <T>(work: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(h.db.app, h.organizationId, work);

  const compilations = () =>
    tenant((tx) =>
      tx
        .select({
          status: schema.displayCompilations.status,
          revision: schema.displayCompilations.configRevision,
        })
        .from(schema.displayCompilations)
        .where(eq(schema.displayCompilations.displayId, displayId))
        .orderBy(schema.displayCompilations.createdAt),
    );
  const manifests = () =>
    tenant((tx) =>
      tx
        .select({ version: schema.manifests.version })
        .from(schema.manifests)
        .where(eq(schema.manifests.displayId, displayId)),
    );

  beforeAll(async () => {
    h = await createHarness();
    await tenant(async (tx) => {
      const org = h.organizationId;
      const [site] = await tx
        .insert(schema.sites)
        .values({ organizationId: org, name: 'Siège' })
        .returning();
      const [display] = await tx
        .insert(schema.displays)
        .values({
          organizationId: org,
          siteId: site!.id,
          name: 'Vitrine',
          width: 1920,
          height: 1080,
        })
        .returning();
      displayId = display!.id;
      const [player] = await tx
        .insert(schema.players)
        .values({
          organizationId: org,
          name: 'Player',
          type: 'native',
          installationUuid: randomUUID(),
          capabilities: {
            player_type: 'native',
            app_version: '0.1.0',
            os: { family: 'linux', version: null },
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
          },
        })
        .returning();
      const [output] = await tx
        .insert(schema.playerOutputs)
        .values({ organizationId: org, playerId: player!.id, outputKey: 'HDMI-A-1' })
        .returning();
      await tx.insert(schema.displayAssignments).values({
        organizationId: org,
        displayId,
        playerOutputId: output!.id,
        generation: 1n,
      });
    });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('bail perdu en cours de compilation : reprise par un autre worker, un seul manifest', async () => {
    await tenant((tx) => requestRecompile(tx, h.organizationId, [displayId], 'test'));
    const lost = await claimJob(h.db.system, {
      workerId: 'worker-mort',
      kinds: [COMPILE_DISPLAY],
      leaseSeconds: 60,
      now: h.clock.now,
    });
    expect(lost).not.toBeNull();
    expect(await h.worker.drain()).toBe(0);
    h.clock.advance(61_000);
    expect(await h.worker.drain()).toBe(1);
    expect(await manifests()).toEqual([{ version: 1n }]);
    expect((await compilations()).map((c) => c.status)).toEqual(['published']);
  });

  it('tâche rejouée ou révisions en rafale : aucun manifest en double ni écrasement', async () => {
    // Rejeu de la même révision (tâche terminée, nouvelle tâche identique).
    const [display] = await tenant((tx) =>
      tx.select().from(schema.displays).where(eq(schema.displays.id, displayId)),
    );
    await h.db.system.insert(schema.jobs).values({
      organizationId: h.organizationId,
      kind: COMPILE_DISPLAY,
      dedupeKey: `${displayId}:${display!.configRevision.toString()}`,
      payload: { display_id: displayId, config_revision: display!.configRevision.toString() },
    });
    // Deux révisions successives : la plus ancienne devient caduque.
    await tenant((tx) => requestRecompile(tx, h.organizationId, [displayId], 'a'));
    await tenant((tx) => requestRecompile(tx, h.organizationId, [displayId], 'b'));
    expect(await h.worker.drain()).toBe(3);
    expect(await manifests()).toEqual([{ version: 1n }]);
    const statuses = await compilations();
    // Les deux tâches de révisions dépassées sont caduques et n’écrivent rien ; seule la
    // dernière révision est compilée, sans nouveau manifest puisque rien n’a changé.
    expect(statuses.map((c) => c.status)).toEqual(['published', 'unchanged']);
    expect(statuses.at(-1)!.revision).toBe(display!.configRevision + 2n);
  });
});
