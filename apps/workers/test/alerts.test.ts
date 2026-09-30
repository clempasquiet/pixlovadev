import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { schema, withTenant } from '@pixlova/db';
import { skipDatabaseTests } from '@pixlova/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALERT_NOTIFICATION,
  evaluateAlerts,
  purgeScreenshots,
  recordPresenceLost,
} from '../src/index.js';
import { createHarness, type Harness } from './support.js';

const MIN = 60_000;

describe.skipIf(skipDatabaseTests)('alertes et incidents (ADR-014, SUP-006 à SUP-008)', () => {
  let h: Harness;
  let siteId: string;

  const tenant = <T>(work: Parameters<typeof withTenant<T>>[2], org = h.organizationId) =>
    withTenant(h.db.app, org, work);

  async function createPlayer(org = h.organizationId, site: string | null = siteId) {
    return tenant(async (tx) => {
      const [player] = await tx
        .insert(schema.players)
        .values({
          organizationId: org,
          siteId: site,
          name: `Player ${randomUUID().slice(0, 4)}`,
          type: 'native',
          installationUuid: randomUUID(),
          capabilities: {},
          lastSeenAt: h.clock.now,
        })
        .returning();
      const [output] = await tx
        .insert(schema.playerOutputs)
        .values({ organizationId: org, playerId: player!.id, outputKey: 'HDMI-A-1' })
        .returning();
      return { id: player!.id, outputId: output!.id };
    }, org);
  }

  async function createDisplay(outputId: string) {
    return tenant(async (tx) => {
      const [display] = await tx
        .insert(schema.displays)
        .values({
          organizationId: h.organizationId,
          siteId,
          name: 'Vitrine',
          width: 1920,
          height: 1080,
        })
        .returning();
      await tx.insert(schema.displayAssignments).values({
        organizationId: h.organizationId,
        displayId: display!.id,
        playerOutputId: outputId,
        generation: 1n,
        startedAt: h.clock.now,
      });
      return display!.id;
    });
  }

  const seen = (playerId: string, at: Date, org = h.organizationId) =>
    tenant(
      (tx) =>
        tx.update(schema.players).set({ lastSeenAt: at }).where(eq(schema.players.id, playerId)),
      org,
    );

  const alerts = (targetId: string) =>
    h.db.system
      .select()
      .from(schema.alerts)
      .where(eq(schema.alerts.targetId, targetId))
      .orderBy(schema.alerts.openedAt);

  const notifications = async (alertId: string) =>
    (
      await h.db.system
        .select()
        .from(schema.outboxEvents)
        .where(
          and(
            eq(schema.outboxEvents.aggregateId, alertId),
            eq(schema.outboxEvents.eventType, ALERT_NOTIFICATION),
          ),
        )
        .orderBy(schema.outboxEvents.id)
    ).map((e) => (e.payload as { kind: string }).kind);

  const events = async (type: string, column: 'playerId' | 'displayId', id: string) =>
    h.db.system
      .select()
      .from(schema.timelineEvents)
      .where(and(eq(schema.timelineEvents.type, type), eq(schema.timelineEvents[column], id)));

  beforeAll(async () => {
    h = await createHarness();
    siteId = await tenant(async (tx) => {
      const [site] = await tx
        .insert(schema.sites)
        .values({ organizationId: h.organizationId, name: 'Siège' })
        .returning();
      return site!.id;
    });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  });

  it('ouvre un seul incident hors ligne, notifié une fois, résolu après contact stable', async () => {
    const player = await createPlayer();
    await seen(player.id, new Date(h.clock.now.getTime() - 6 * MIN));
    // Évaluations concurrentes : verrou consultatif et index unique, un seul incident.
    await Promise.all([evaluateAlerts(h.ctx), evaluateAlerts(h.ctx), evaluateAlerts(h.ctx)]);
    await evaluateAlerts(h.ctx);
    const [alert, ...others] = await alerts(player.id);
    expect(others).toHaveLength(0);
    expect(alert).toMatchObject({ rule: 'player_offline', status: 'open', severity: 'warning' });
    expect(await notifications(alert!.id)).toEqual(['opened']);
    expect(await events('INCIDENT_OPENED', 'playerId', player.id)).toHaveLength(1);
    // Présence perdue tracée une fois, à l’échéance de présence.
    await recordPresenceLost(h.ctx);
    await recordPresenceLost(h.ctx);
    const lost = await events('PRESENCE_LOST', 'playerId', player.id);
    expect(lost).toHaveLength(1);

    // Contact rétabli : résolution seulement après 2 min de stabilité.
    await seen(player.id, h.clock.now);
    await evaluateAlerts(h.ctx);
    expect((await alerts(player.id))[0]).toMatchObject({ status: 'open' });
    expect((await alerts(player.id))[0]!.clearingSince).not.toBeNull();
    h.clock.advance(3 * MIN);
    await seen(player.id, h.clock.now);
    await evaluateAlerts(h.ctx);
    expect((await alerts(player.id))[0]).toMatchObject({ status: 'resolved' });
    expect(await notifications(alert!.id)).toEqual(['opened', 'resolved']);
    expect(await events('INCIDENT_RESOLVED', 'playerId', player.id)).toHaveLength(1);
  });

  it('rappelle un incident toujours ouvert au plus une fois par période', async () => {
    const player = await createPlayer();
    await seen(player.id, new Date(h.clock.now.getTime() - 10 * MIN));
    await evaluateAlerts(h.ctx);
    const [alert] = await alerts(player.id);
    h.clock.advance(60 * MIN);
    await evaluateAlerts(h.ctx);
    expect(await notifications(alert!.id)).toEqual(['opened']);
    h.clock.advance(24 * 60 * MIN);
    await evaluateAlerts(h.ctx);
    await evaluateAlerts(h.ctx);
    expect(await notifications(alert!.id)).toEqual(['opened', 'reminder']);
    // Player révoqué : la cible disparaît, l’incident est clos et sa fin annoncée.
    await tenant((tx) =>
      tx
        .update(schema.players)
        .set({ lifecycleStatus: 'revoked' })
        .where(eq(schema.players.id, player.id)),
    );
    await evaluateAlerts(h.ctx);
    expect((await alerts(player.id))[0]).toMatchObject({ status: 'resolved' });
    expect(await notifications(alert!.id)).toEqual(['opened', 'reminder', 'resolved']);
  });

  it('la maintenance retient les notifications, jamais l’incident', async () => {
    const player = await createPlayer();
    const display = await createDisplay(player.outputId);
    const [owner] = await h.db.system
      .insert(schema.users)
      .values({ emailNormalized: `${randomUUID()}@m.test` })
      .returning();
    await tenant((tx) =>
      tx.insert(schema.maintenanceWindows).values({
        organizationId: h.organizationId,
        scopeType: 'display',
        scopeId: display,
        startsAt: new Date(h.clock.now.getTime() - MIN),
        endsAt: new Date(h.clock.now.getTime() + 30 * MIN),
        reason: 'Remplacement de la dalle',
        createdBy: owner!.id,
      }),
    );
    await seen(player.id, new Date(h.clock.now.getTime() - 6 * MIN));
    await evaluateAlerts(h.ctx);
    const [alert] = await alerts(player.id);
    expect(alert).toMatchObject({ status: 'open', notifiedOpenAt: null });
    expect(await notifications(alert!.id)).toEqual([]);
    // Fin de la maintenance : les règles reprennent, l’incident toujours ouvert est notifié.
    h.clock.advance(31 * MIN);
    await evaluateAlerts(h.ctx);
    expect(await notifications(alert!.id)).toEqual(['opened']);
    await seen(player.id, h.clock.now);
  });

  it('disque faible avec hystérésis ; mesure absente : aucune alerte', async () => {
    const player = await createPlayer();
    const disk = (free: number | null) =>
      tenant((tx) =>
        tx
          .insert(schema.playerStatus)
          .values({
            playerId: player.id,
            organizationId: h.organizationId,
            diskFreeBytes: free,
            diskTotalBytes: free === null ? null : 1000,
          })
          .onConflictDoUpdate({
            target: schema.playerStatus.playerId,
            set: { diskFreeBytes: free, diskTotalBytes: free === null ? null : 1000 },
          }),
      );
    await disk(null);
    await evaluateAlerts(h.ctx);
    expect(await alerts(player.id)).toEqual([]);
    await disk(50);
    await evaluateAlerts(h.ctx);
    expect((await alerts(player.id))[0]).toMatchObject({ rule: 'disk_low', status: 'open' });
    await disk(120);
    await evaluateAlerts(h.ctx);
    expect((await alerts(player.id))[0]).toMatchObject({ status: 'open' });
    await disk(200);
    await evaluateAlerts(h.ctx);
    expect((await alerts(player.id))[0]).toMatchObject({ status: 'resolved' });
  });

  it('échec de livraison et erreurs de lecture répétées sur un Display', async () => {
    const player = await createPlayer();
    const display = await createDisplay(player.outputId);
    const manifestId = randomUUID();
    await tenant(async (tx) => {
      await tx.insert(schema.manifests).values({
        id: manifestId,
        organizationId: h.organizationId,
        displayId: display,
        playerId: player.id,
        version: 1n,
        assignmentGeneration: 1n,
        configRevision: 1n,
        schemaVersion: 1,
        payloadHash: 'a'.repeat(64),
        inputHash: 'b'.repeat(64),
        keyId: 'manifest-key-test',
        envelope: '{}',
        generatedAt: h.clock.now,
        validFrom: h.clock.now,
        scheduleUntil: new Date(h.clock.now.getTime() + 86_400_000),
      });
      await tx.insert(schema.manifestDeliveries).values({
        organizationId: h.organizationId,
        manifestId,
        displayId: display,
        playerId: player.id,
        assignmentGeneration: 1n,
        state: 'failed',
        errorCode: 'CHECKSUM_MISMATCH',
      });
      for (let i = 0; i < 3; i++) {
        await tx.insert(schema.timelineEvents).values({
          organizationId: h.organizationId,
          source: 'player',
          playerId: player.id,
          displayId: display,
          eventId: randomUUID(),
          type: 'PLAYBACK_ERROR',
          severity: 'error',
          observedAt: new Date(h.clock.now.getTime() - i * MIN),
          receivedAt: h.clock.now,
        });
      }
    });
    await evaluateAlerts(h.ctx);
    const opened = await alerts(display);
    expect(opened.map((a) => [a.rule, a.severity, a.status]).sort()).toEqual([
      ['delivery_failed', 'error', 'open'],
      ['playback_errors', 'warning', 'open'],
    ]);
    await tenant((tx) =>
      tx
        .update(schema.manifestDeliveries)
        .set({ state: 'applied' })
        .where(eq(schema.manifestDeliveries.manifestId, manifestId)),
    );
    h.clock.advance(16 * MIN);
    await seen(player.id, h.clock.now);
    await evaluateAlerts(h.ctx);
    expect((await alerts(display)).every((a) => a.status === 'resolved')).toBe(true);
  });

  it('panne commune probable : incidents marqués plateforme, emails retenus', async () => {
    // Une autre organisation : la corrélation porte sur toute la plateforme.
    const other = randomUUID();
    await withTenant(h.db.app, other, (tx) =>
      tx.insert(schema.organizations).values({
        id: other,
        name: 'Autre',
        slug: `autre-${other.slice(0, 8)}`,
        country: 'FR',
        timezone: 'Europe/Paris',
      }),
    );
    const lost = [];
    for (let i = 0; i < 12; i++) lost.push(await createPlayer(other, null));
    const mine = await createPlayer();
    for (const player of lost)
      await seen(player.id, new Date(h.clock.now.getTime() - 6 * MIN), other);
    await seen(mine.id, new Date(h.clock.now.getTime() - 6 * MIN));
    const report = await evaluateAlerts(h.ctx);
    expect(report?.suspectedPlatform).toBe(true);
    const [alert] = await alerts(mine.id);
    expect(alert).toMatchObject({ suspectedPlatform: true, status: 'open' });
    expect(await notifications(alert!.id)).toEqual([]);
    for (const player of [
      ...lost.map((p) => ({ ...p, org: other })),
      { ...mine, org: h.organizationId },
    ]) {
      await seen(player.id, h.clock.now, player.org);
    }
  });

  it('purge les captures expirées, objet puis ligne', async () => {
    const player = await createPlayer();
    const display = await createDisplay(player.outputId);
    const commandId = randomUUID();
    const screenshotId = randomUUID();
    const objectKey = `org/${h.organizationId}/screenshots/${screenshotId}-0123456789abcdef.png`;
    const file = join(h.ctx.tmpRoot, 'capture.png');
    await writeFile(file, 'png');
    await h.local.writeFile(objectKey, file, 'image/png');
    await tenant(async (tx) => {
      await tx.insert(schema.playerCommands).values({
        id: commandId,
        organizationId: h.organizationId,
        playerId: player.id,
        displayId: display,
        assignmentGeneration: '1',
        type: 'TAKE_SCREENSHOT',
        envelope: '{}',
        payloadHash: 'c'.repeat(64),
        status: 'success',
        issuedAt: new Date(h.clock.now.getTime() - 3 * MIN),
        expiresAt: new Date(h.clock.now.getTime() - 2 * MIN),
      });
      await tx.insert(schema.screenshots).values({
        id: screenshotId,
        organizationId: h.organizationId,
        playerId: player.id,
        displayId: display,
        commandId,
        objectKey,
        status: 'available',
        expiresAt: new Date(h.clock.now.getTime() - MIN),
      });
    });
    expect(await h.local.head(objectKey)).not.toBeNull();
    expect(await purgeScreenshots(h.ctx)).toBe(1);
    expect(await h.local.head(objectKey)).toBeNull();
    expect(
      await h.db.system
        .select()
        .from(schema.screenshots)
        .where(eq(schema.screenshots.id, screenshotId)),
    ).toEqual([]);
  });
});
