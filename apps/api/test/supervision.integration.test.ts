import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  evaluateCommand,
  formatInstant,
  publicKeyFromSecret,
  verifyCommand,
  type CommandPayload,
} from '@pixlova/contracts';
import { schema } from '@pixlova/db';
import { skipDatabaseTests } from '@pixlova/db/testing';
import type { Client } from './support/harness.js';
import { createHarness, createOrganization, signUp, type Harness } from './support/harness.js';
import { SimulatedPlayer, capabilities } from './support/player.js';

function key(): Record<string, string> {
  return { 'idempotency-key': `test-${randomUUID()}` };
}

/** PNG minimal valide (1×1) : signature, IHDR, IDAT, IEND. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe.skipIf(skipDatabaseTests)('Supervision, commandes et captures (L07)', () => {
  let h: Harness;
  let owner: Client;
  let org: { id: string; siteId: string };
  let rival: Client;
  let rivalOrg: { id: string; siteId: string };
  let player: SimulatedPlayer;
  let other: SimulatedPlayer;
  let webPlayer: SimulatedPlayer;
  let rivalPlayer: SimulatedPlayer;
  let display: string;
  let webDisplay: string;
  let viewer: Client;

  const trust = () =>
    new Map([
      [
        h.services.supervision.commandKey!.kid,
        publicKeyFromSecret(h.services.supervision.commandKey!.secretKey),
      ],
    ]);

  async function pairPlayer(client: Client, siteId: string, p: SimulatedPlayer, name: string) {
    const code = await p.register();
    const response = await client.request(
      'POST',
      '/players/pair',
      { code, name, site_id: siteId },
      key(),
    );
    if (response.statusCode !== 201) throw new Error(`pair: ${response.body}`);
    await p.poll();
    await p.authenticate();
  }

  async function createDisplay(client: Client, siteId: string, name: string) {
    return (
      await client.post('/displays', { site_id: siteId, name, width: 1920, height: 1080 })
    ).json().id as string;
  }

  async function assign(client: Client, displayId: string, p: SimulatedPlayer, index = 0) {
    const outputs = (await client.get('/players'))
      .json()
      .items.find((x: { id: string }) => x.id === p.playerId).outputs as { id: string }[];
    const response = await client.request(
      'PUT',
      `/displays/${displayId}/assignment`,
      { player_output_id: outputs[index]!.id },
      key(),
    );
    if (response.statusCode >= 300) throw new Error(`assign: ${response.body}`);
  }

  const command = (
    client: Client,
    playerId: string,
    body: Record<string, unknown>,
    headers = key(),
  ) => client.request('POST', `/players/${playerId}/commands`, body, headers);

  async function fetchCommands(p: SimulatedPlayer): Promise<CommandPayload[]> {
    const response = await p.call('GET', '/commands');
    expect(response.statusCode).toBe(200);
    return (response.json().commands as string[]).map((raw) => {
      const verified = verifyCommand(raw, trust());
      if (!verified.ok) throw new Error(`commande invalide : ${verified.detail}`);
      return verified.command;
    });
  }

  const result = (p: SimulatedPlayer, id: string, status = 'success', code: string | null = null) =>
    p.call('POST', `/commands/${id}/result`, {
      command_id: id,
      status,
      finished_at: formatInstant(h.clock.now),
      code,
      detail: null,
    });

  beforeAll(async () => {
    h = await createHarness();
    h.setMaxUsers(10);
    h.setDisplaySlots(10);
    owner = await signUp(h, 'owner@supervision.test');
    org = await createOrganization(owner, 'Supervision A');
    rival = await signUp(h, 'owner@rival-supervision.test');
    rivalOrg = await createOrganization(rival, 'Supervision B');
    h.setDisplaySlots(10);
    player = new SimulatedPlayer(h);
    other = new SimulatedPlayer(h);
    webPlayer = new SimulatedPlayer(
      h,
      undefined,
      capabilities({ player_type: 'web', screenshot: 'unsupported' }),
    );
    rivalPlayer = new SimulatedPlayer(h);
    await pairPlayer(owner, org.siteId, player, 'Natif');
    await pairPlayer(owner, org.siteId, other, 'Autre');
    await pairPlayer(owner, org.siteId, webPlayer, 'Web');
    await pairPlayer(rival, rivalOrg.siteId, rivalPlayer, 'Rival');
    display = await createDisplay(owner, org.siteId, 'Vitrine');
    webDisplay = await createDisplay(owner, org.siteId, 'Accueil Web');
    await assign(owner, display, player);
    await assign(owner, webDisplay, webPlayer);
    await owner.post('/invitations', {
      email: 'viewer@supervision.test',
      role: 'Viewer',
      scope: { type: 'organization' },
    });
    await h.flushEmails();
    const token = new URL(
      h.mailer.linkFor('viewer@supervision.test', '/invitations/accept')!,
    ).searchParams.get('token');
    viewer = await signUp(h, 'viewer@supervision.test');
    await viewer.post('/invitations/accept', { token });
    viewer.organizationId = org.id;
  });
  afterAll(async () => {
    await h?.close();
  });

  describe('commandes signées (SUP-005, PROTO-007, PROTO-008)', () => {
    it('exige une clé d’idempotence et rejoue la même commande', async () => {
      expect((await command(owner, player.playerId!, { type: 'FORCE_SYNC' }, {})).statusCode).toBe(
        400,
      );
      const headers = key();
      const first = await command(owner, player.playerId!, { type: 'FORCE_SYNC' }, headers);
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({
        type: 'FORCE_SYNC',
        status: 'pending',
        display_id: null,
      });
      const replay = await command(owner, player.playerId!, { type: 'FORCE_SYNC' }, headers);
      expect(replay.json().id).toBe(first.json().id);
      const heartbeat = await player.heartbeat();
      expect(heartbeat.json().pending_commands).toBe(1);
    });

    it('livre une enveloppe signée que le Player vérifie, puis ACK et résultat', async () => {
      const [cmd] = await fetchCommands(player);
      expect(cmd).toMatchObject({
        type: 'FORCE_SYNC',
        organization_id: org.id,
        player_id: player.playerId,
      });
      const decision = evaluateCommand(
        cmd!,
        'x',
        {
          organization_id: org.id,
          player_id: player.playerId!,
          assignments: new Map(),
          seen: new Map(),
          capabilities: { reboot_host: 'unsupported', screenshot: 'supported' },
        },
        formatInstant(h.clock.now),
      );
      expect(decision).toEqual({ decision: 'execute' });
      // Toujours distribuée tant qu’elle n’est pas accusée (reprise après crash du Player).
      expect((await fetchCommands(player)).map((c) => c.command_id)).toEqual([cmd!.command_id]);
      const ack = () =>
        player.call('POST', `/commands/${cmd!.command_id}/ack`, {
          acknowledged_at: formatInstant(h.clock.now),
        });
      expect((await ack()).json()).toEqual({ status: 'acknowledged' });
      expect((await ack()).json()).toEqual({ status: 'acknowledged' });
      expect(await fetchCommands(player)).toEqual([]);
      expect((await result(player, cmd!.command_id)).json()).toEqual({ status: 'success' });
      expect((await result(player, cmd!.command_id)).statusCode).toBe(200);
      const conflict = await result(player, cmd!.command_id, 'failed', 'BOOM');
      expect(conflict.statusCode).toBe(409);
      const listed = (await owner.get(`/players/${player.playerId}/commands`)).json();
      expect(listed.commands_available).toBe(true);
      expect(listed.items[0]).toMatchObject({
        id: cmd!.command_id,
        status: 'success',
        sent_at: expect.any(String),
        acknowledged_at: expect.any(String),
        completed_at: expect.any(String),
      });
    });

    it('lie RELOAD_CONTENT à la génération courante du Display', async () => {
      expect((await command(owner, player.playerId!, { type: 'RELOAD_CONTENT' })).statusCode).toBe(
        422,
      );
      expect(
        (
          await command(owner, player.playerId!, {
            type: 'RELOAD_CONTENT',
            display_id: webDisplay,
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (await command(owner, player.playerId!, { type: 'GET_STATUS', display_id: display }))
          .statusCode,
      ).toBe(422);
      const created = await command(owner, player.playerId!, {
        type: 'RELOAD_CONTENT',
        display_id: display,
      });
      expect(created.json()).toMatchObject({ display_id: display, assignment_generation: '1' });
      const [cmd] = await fetchCommands(player);
      expect(cmd).toMatchObject({ display_id: display, assignment_generation: '1' });
      await result(player, cmd!.command_id, 'rejected', 'STALE_ASSIGNMENT');
    });

    it('refuse les commandes indisponibles, non déclarées ou hors permission', async () => {
      const update = await command(owner, player.playerId!, { type: 'UPDATE_PLAYER' });
      expect(update.json().error.code).toBe('COMMAND_NOT_AVAILABLE');
      const reboot = await command(owner, player.playerId!, { type: 'REBOOT_HOST' });
      expect(reboot.json().error.code).toBe('CAPABILITY_UNSUPPORTED');
      const screenshot = await command(owner, player.playerId!, {
        type: 'TAKE_SCREENSHOT',
        display_id: display,
      });
      expect(screenshot.statusCode).toBe(422);
      expect((await command(viewer, player.playerId!, { type: 'FORCE_SYNC' })).statusCode).toBe(
        403,
      );
      expect((await viewer.get(`/players/${player.playerId}/commands`)).statusCode).toBe(200);
    });

    it('expire une commande non récupérée et ne la distribue jamais', async () => {
      const created = await command(owner, player.playerId!, {
        type: 'GET_STATUS',
        ttl_seconds: 30,
      });
      h.clock.advance(31_000);
      expect(await fetchCommands(player)).toEqual([]);
      const listed = (await owner.get(`/players/${player.playerId}/commands`)).json();
      expect(listed.items.find((c: { id: string }) => c.id === created.json().id).status).toBe(
        'expired',
      );
      expect((await player.heartbeat()).json().pending_commands).toBe(0);
    });

    it('annule seulement avant distribution', async () => {
      const pending = (
        await command(owner, player.playerId!, { type: 'CLEAR_UNUSED_CACHE' })
      ).json();
      const cancelled = await owner.post(`/commands/${pending.id}/cancel`);
      expect(cancelled.json().status).toBe('cancelled');
      expect(await fetchCommands(player)).toEqual([]);
      expect(
        (
          await player.call('POST', `/commands/${pending.id}/ack`, {
            acknowledged_at: formatInstant(h.clock.now),
          })
        ).statusCode,
      ).toBe(409);
      const sent = (await command(owner, player.playerId!, { type: 'RESTART_RENDERER' })).json();
      await fetchCommands(player);
      const late = await owner.post(`/commands/${sent.id}/cancel`);
      expect(late.statusCode).toBe(409);
      expect(late.json().error.code).toBe('COMMAND_NOT_CANCELLABLE');
      await result(player, sent.id);
    });

    it('n’accepte un résultat que du Player destinataire, dans son organisation', async () => {
      const cmd = (await command(owner, player.playerId!, { type: 'GET_STATUS' })).json();
      await fetchCommands(player);
      expect((await result(other, cmd.id)).statusCode).toBe(404);
      expect((await result(rivalPlayer, cmd.id)).statusCode).toBe(404);
      expect((await command(rival, player.playerId!, { type: 'GET_STATUS' })).statusCode).toBe(404);
      expect((await rival.post(`/commands/${cmd.id}/cancel`)).statusCode).toBe(404);
      expect((await fetchCommands(other)).length).toBe(0);
      const mismatch = await player.call('POST', `/commands/${cmd.id}/result`, {
        command_id: randomUUID(),
        status: 'success',
        finished_at: formatInstant(h.clock.now),
        code: null,
        detail: null,
      });
      expect(mismatch.statusCode).toBe(422);
      expect((await result(player, cmd.id)).statusCode).toBe(200);
    });

    it('répond 503 sans clé de commande configurée', async () => {
      const saved = h.services.supervision.commandKey;
      h.services.supervision.commandKey = null;
      try {
        const response = await command(owner, player.playerId!, { type: 'FORCE_SYNC' });
        expect(response.statusCode).toBe(503);
        expect(response.json().error.code).toBe('COMMANDS_UNAVAILABLE');
      } finally {
        h.services.supervision.commandKey = saved;
      }
    });
  });

  describe('captures (SUP-004)', () => {
    const request = (client: Client, displayId: string) =>
      client.request('POST', `/displays/${displayId}/screenshots`, {}, key());

    async function takeScreenshot(bytes: Buffer, declared = bytes) {
      const created = await request(owner, display);
      expect(created.statusCode).toBe(201);
      const cmd = (await fetchCommands(player)).find(
        (c) => c.command_id === created.json().command.id,
      );
      expect(cmd!.params).toEqual({ screenshot_id: created.json().screenshot.id });
      const session = await player.call('POST', '/screenshots/upload-session', {
        command_id: cmd!.command_id,
        screenshot_id: created.json().screenshot.id,
        mime_type: 'image/png',
        size_bytes: declared.length,
        sha256: createHash('sha256').update(declared).digest('hex'),
        captured_at: formatInstant(h.clock.now),
      });
      expect(session.statusCode).toBe(200);
      const put = await h.app.inject({
        method: 'PUT',
        url: session.json().upload.url,
        headers: session.json().upload.headers,
        payload: bytes,
      });
      expect(put.statusCode).toBeLessThan(300);
      const complete = await player.call(
        'POST',
        `/screenshots/${created.json().screenshot.id}/complete`,
      );
      return { id: created.json().screenshot.id as string, cmd: cmd!, complete };
    }

    it('refuse un Player sans capacité de capture et un rôle sans permission', async () => {
      const web = await request(owner, webDisplay);
      expect(web.statusCode).toBe(422);
      expect(web.json().error.code).toBe('CAPABILITY_UNSUPPORTED');
      expect((await request(viewer, display)).statusCode).toBe(403);
      expect((await viewer.get(`/displays/${display}/screenshots`)).statusCode).toBe(403);
    });

    it('respecte la désactivation par organisation', async () => {
      expect(
        (await viewer.put('/supervision/settings', { screenshots_enabled: false })).statusCode,
      ).toBe(403);
      expect(
        (await owner.put('/supervision/settings', { screenshots_enabled: false })).statusCode,
      ).toBe(200);
      const refused = await request(owner, display);
      expect(refused.json().error.code).toBe('SCREENSHOTS_DISABLED');
      await owner.put('/supervision/settings', { screenshots_enabled: true });
      expect((await owner.get('/supervision/settings')).json()).toMatchObject({
        screenshots_enabled: true,
        screenshot_retention_hours: 24,
        commands_available: true,
      });
    });

    it('reçoit une capture vérifiée, consultable par URL courte auditée', async () => {
      const { id, cmd, complete } = await takeScreenshot(PNG);
      expect(complete.json()).toEqual({ status: 'available' });
      await result(player, cmd.command_id);
      const listed = (await owner.get(`/displays/${display}/screenshots`)).json();
      expect(listed.items[0]).toMatchObject({
        id,
        status: 'available',
        command_status: 'success',
        captured_at: expect.any(String),
        notice: expect.stringContaining('ne prouve pas'),
      });
      const url = await owner.get(`/screenshots/${id}/url`);
      expect(url.statusCode).toBe(200);
      const image = await h.app.inject({ method: 'GET', url: url.json().url });
      expect(image.rawPayload.equals(PNG)).toBe(true);
      const audits = await h.database.system
        .select()
        .from(schema.auditLogs)
        .where(
          and(eq(schema.auditLogs.targetId, id), eq(schema.auditLogs.action, 'screenshot.viewed')),
        );
      expect(audits).toHaveLength(1);
      const [row] = await h.database.system
        .select()
        .from(schema.screenshots)
        .where(eq(schema.screenshots.id, id));
      expect(row!.objectKey).toMatch(
        new RegExp(`^org/${org.id}/screenshots/${id}-[0-9a-f]{16}\\.png$`),
      );
      // Rétention : plus consultable après expiration.
      await h.database.system
        .update(schema.screenshots)
        .set({ expiresAt: new Date(h.clock.now.getTime() - 1000) })
        .where(eq(schema.screenshots.id, id));
      expect((await owner.get(`/screenshots/${id}/url`)).statusCode).toBe(404);
    });

    it('rejette une capture altérée ou non PNG et supprime l’objet', async () => {
      const fake = Buffer.from('not a png, but the declared bytes');
      const altered = await takeScreenshot(Buffer.from(fake).fill(0x41, 0, 4), fake);
      expect(altered.complete.statusCode).toBe(422);
      expect(altered.complete.json().error.code).toBe('CHECKSUM_MISMATCH');
      const [row] = await h.database.system
        .select()
        .from(schema.screenshots)
        .where(eq(schema.screenshots.id, altered.id));
      expect(row!.status).toBe('uploading');
      expect(await h.storage.head(row!.objectKey)).toBeNull();
      const notPng = await takeScreenshot(fake);
      expect(notPng.complete.json().error.code).toBe('CHECKSUM_MISMATCH');
    });

    it('refuse un envoi non demandé, d’un autre Player ou trop grand', async () => {
      const created = (await request(owner, display)).json();
      const [cmd] = (await fetchCommands(player)).filter(
        (c) => c.type === 'TAKE_SCREENSHOT' && c.command_id === created.command.id,
      );
      const body = {
        command_id: cmd!.command_id,
        screenshot_id: created.screenshot.id,
        mime_type: 'image/png',
        size_bytes: PNG.length,
        sha256: createHash('sha256').update(PNG).digest('hex'),
        captured_at: formatInstant(h.clock.now),
      };
      expect(
        (
          await player.call('POST', '/screenshots/upload-session', {
            ...body,
            screenshot_id: randomUUID(),
          })
        ).statusCode,
      ).toBe(404);
      expect((await other.call('POST', '/screenshots/upload-session', body)).statusCode).toBe(404);
      expect((await rivalPlayer.call('POST', '/screenshots/upload-session', body)).statusCode).toBe(
        404,
      );
      expect(
        (
          await player.call('POST', '/screenshots/upload-session', {
            ...body,
            size_bytes: 5 * 1024 * 1024 + 1,
          })
        ).statusCode,
      ).toBe(400);
      await result(player, cmd!.command_id, 'failed', 'CAPTURE_FAILED');
      expect((await player.call('POST', '/screenshots/upload-session', body)).statusCode).toBe(409);
    });
  });

  describe('événements, statut et timeline (PROTO-019, SUP-001, SUP-003)', () => {
    it('déduplique les événements et ne rattache que les Displays du Player', async () => {
      const bootId = randomUUID();
      const foreignDisplay = await createDisplay(rival, rivalOrg.siteId, 'Rival');
      const observed = new Date(h.clock.now.getTime() - 3600_000);
      const events = [
        {
          event_id: randomUUID(),
          boot_id: bootId,
          seq: 1,
          observed_at: formatInstant(observed),
          type: 'PLAYBACK_ERROR',
          severity: 'error',
          display_id: display,
          assignment_generation: '1',
          payload: { reason: 'DECODE_FAILED' },
        },
        {
          event_id: randomUUID(),
          boot_id: bootId,
          seq: 2,
          observed_at: formatInstant(new Date(observed.getTime() + 1000)),
          type: 'PLAYBACK_ERROR',
          severity: 'error',
          display_id: foreignDisplay,
          assignment_generation: '1',
          payload: {},
        },
      ];
      const post = () => player.call('POST', '/events', { events, dropped_count: 3 });
      const first = await post();
      expect(first.json()).toEqual({ accepted: events.map((e) => e.event_id) });
      expect((await post()).json()).toEqual(first.json());
      const rows = await h.database.system
        .select()
        .from(schema.timelineEvents)
        .where(eq(schema.timelineEvents.playerId, player.playerId!));
      const stored = rows.filter((r) => r.source === 'player');
      expect(stored).toHaveLength(2);
      expect(stored.find((r) => r.eventId === events[1]!.event_id)!.displayId).toBeNull();
      expect(rows.filter((r) => r.type === 'EVENTS_DROPPED')).toHaveLength(1);
    });

    it('enregistre le statut sans remplacer un statut plus récent', async () => {
      const status = (observedAt: Date, free: number | null) => ({
        observed_at: formatInstant(observedAt),
        renderer: 'ok',
        renderer_restarts: 0,
        storage_persistent: null,
        metrics: {
          cpu_percent: null,
          memory_used_bytes: null,
          memory_total_bytes: null,
          disk_free_bytes: free,
          disk_total_bytes: 1000,
          temperature_c: null,
        },
        cache: null,
        outputs: [
          {
            output_key: 'HDMI-A-1',
            connected: false,
            width: null,
            height: null,
            refresh_hz: null,
          },
        ],
      });
      expect((await player.call('POST', '/status', status(h.clock.now, 500))).statusCode).toBe(204);
      await player.call('POST', '/status', status(new Date(h.clock.now.getTime() - 60_000), 900));
      await player.heartbeat([{ display_id: display, assignment_generation: '1' }]);
      const view = (await owner.get(`/displays/${display}/supervision`)).json();
      expect(view.presence.state).toBe('online');
      expect(view.health).toMatchObject({
        current: true,
        renderer: 'ok',
        metrics: { disk_free_bytes: 500, cpu_percent: null, temperature_c: null },
      });
      expect(view.rendering).toMatchObject({ playback: 'standby', manifest_applied_version: null });
      expect(view.output).toMatchObject({ output_key: 'HDMI-A-1', connected: false });
      expect(view.capture).toMatchObject({ supported: 'supported', enabled: true });
      expect((await rival.get(`/displays/${display}/supervision`)).statusCode).toBe(404);
    });

    it('trace la présence retrouvée et fusionne la timeline par instant observé', async () => {
      h.clock.advance(10 * 60_000);
      await player.authenticate();
      await player.heartbeat([{ display_id: display, assignment_generation: '1' }]);
      const response = await owner.get(`/displays/${display}/timeline?limit=200`);
      expect(response.statusCode, response.body).toBe(200);
      const timeline = response.json();
      const types = timeline.items.map((i: { type: string }) => i.type);
      expect(types).toEqual(
        expect.arrayContaining([
          'PRESENCE_RESTORED',
          'PLAYBACK_ERROR',
          'COMMAND_REQUESTED',
          'COMMAND_COMPLETED',
          'SCREENSHOT_RECEIVED',
          'ASSIGNMENT_STARTED',
          'EVENTS_DROPPED',
        ]),
      );
      const observed = timeline.items.map((i: { observed_at: string }) => i.observed_at);
      expect([...observed].sort().reverse()).toEqual(observed);
      const late = timeline.items.find((i: { type: string }) => i.type === 'PLAYBACK_ERROR');
      expect(late.received_at > late.observed_at).toBe(true);
      // Aucun événement d’un autre Player ni d’un Display étranger.
      expect(
        timeline.items.every(
          (i: { player_id: string | null }) =>
            i.player_id === null || i.player_id === player.playerId,
        ),
      ).toBe(true);
      const page = (await owner.get(`/displays/${display}/timeline?limit=2`)).json();
      expect(page.items).toHaveLength(2);
      const next = (
        await owner.get(
          `/displays/${display}/timeline?limit=2&before=${encodeURIComponent(page.next_before)}`,
        )
      ).json();
      expect(next.items[0].observed_at < page.items[1].observed_at).toBe(true);
    });

    it('présente le parc par signal, filtrable et isolé', async () => {
      h.clock.advance(5 * 60_000);
      const overview = (await owner.get('/fleet/overview')).json();
      // Un Player qui n’a jamais émis de heartbeat reste « inconnu », jamais « hors ligne ».
      expect(overview.counts).toMatchObject({ displays: 2, offline: 1, unknown: 1 });
      const row = overview.items.find((i: { display_id: string }) => i.display_id === display);
      expect(row).toMatchObject({
        presence: 'offline',
        renderer: 'ok',
        output_connected: false,
        player: { id: player.playerId },
      });
      await player.authenticate();
      await player.heartbeat([{ display_id: display, assignment_generation: '1' }]);
      const online = (await owner.get('/fleet/overview?presence=online')).json();
      expect(online.items.map((i: { display_id: string }) => i.display_id)).toEqual([display]);
      expect((await owner.get('/fleet/overview?attention=true')).json().items).toEqual([]);
      expect((await owner.get('/fleet/overview?attention=1')).statusCode).toBe(400);
      const rivalView = (await rival.get('/fleet/overview')).json();
      expect(
        rivalView.items.every(
          (i: { display_id: string }) => ![display, webDisplay].includes(i.display_id),
        ),
      ).toBe(true);
    });
  });

  describe('incidents, notifications et maintenance (SUP-006 à SUP-008)', () => {
    /** Incident tel que l’écrit le worker : ligne `alerts` et notification en outbox. */
    async function workerIncident(targetId: string, kind = 'opened') {
      const [alert] = await h.database.system
        .insert(schema.alerts)
        .values({
          organizationId: org.id,
          rule: 'delivery_failed',
          severity: 'error',
          targetType: 'display',
          targetId,
          siteId: org.siteId,
          openedAt: h.clock.now,
          notifiedOpenAt: h.clock.now,
          details: { name: 'Vitrine' },
        })
        .onConflictDoNothing()
        .returning();
      const row =
        alert ??
        (
          await h.database.system
            .select()
            .from(schema.alerts)
            .where(and(eq(schema.alerts.targetId, targetId), eq(schema.alerts.status, 'open')))
        )[0]!;
      await h.database.system.insert(schema.outboxEvents).values({
        organizationId: org.id,
        aggregateType: 'alert',
        aggregateId: row.id,
        eventType: 'alert.notification',
        payload: { alert_id: row.id, kind },
      });
      return row;
    }

    it('notifie les seuls membres autorisés et abonnés, une fois par notification', async () => {
      const before = h.mailer.sent.length;
      const alert = await workerIncident(display);
      await h.flushEmails();
      const sent = h.mailer.sent.slice(before);
      expect(sent.map((m) => m.to)).toEqual(['owner@supervision.test']);
      expect(sent[0]!.subject).toContain('Incident ouvert');
      expect(sent[0]!.text).toContain(`/displays/${display}`);
      await h.flushEmails();
      expect(h.mailer.sent.length).toBe(before + 1);
      // Désabonnement individuel : l’incident reste visible, aucun email.
      const prefs = await owner.put('/supervision/preferences', { alert_emails: false });
      expect(prefs.json()).toEqual({ alert_emails: false });
      await h.database.system.insert(schema.outboxEvents).values({
        organizationId: org.id,
        aggregateType: 'alert',
        aggregateId: alert.id,
        eventType: 'alert.notification',
        payload: { alert_id: alert.id, kind: 'reminder' },
      });
      await h.flushEmails();
      expect(h.mailer.sent.length).toBe(before + 1);
      await owner.put('/supervision/preferences', { alert_emails: true });
      const listed = (await owner.get('/alerts')).json();
      expect(listed.items[0]).toMatchObject({
        id: alert.id,
        rule: 'delivery_failed',
        target_name: 'Vitrine',
        status: 'open',
      });
      expect((await viewer.get('/alerts')).json().items).toHaveLength(1);
      expect((await rival.get('/alerts')).json().items).toEqual([]);
      const view = (await owner.get(`/displays/${display}/supervision`)).json();
      expect(view.alerts[0]).toMatchObject({ rule: 'delivery_failed' });
    });

    it('fenêtres de maintenance bornées, autorisées et auditées', async () => {
      const window = {
        scope_type: 'display',
        scope_id: display,
        starts_at: h.clock.now.toISOString(),
        ends_at: new Date(h.clock.now.getTime() + 3600_000).toISOString(),
        reason: 'Remplacement de la dalle',
      };
      expect((await viewer.post('/maintenance-windows', window)).statusCode).toBe(403);
      expect(
        (
          await owner.post('/maintenance-windows', {
            ...window,
            ends_at: new Date(h.clock.now.getTime() + 30 * 86_400_000).toISOString(),
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (await owner.post('/maintenance-windows', { ...window, scope_type: 'organization' }))
          .statusCode,
      ).toBe(422);
      expect((await rival.post('/maintenance-windows', { ...window })).statusCode).toBe(404);
      const created = await owner.post('/maintenance-windows', window);
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ active: true, scope_type: 'display' });
      expect((await viewer.get('/maintenance-windows')).json().items).toHaveLength(1);
      const cancelled = await owner.post(`/maintenance-windows/${created.json().id}/cancel`);
      expect(cancelled.json()).toMatchObject({ active: false });
      expect((await owner.get('/maintenance-windows')).json().items).toEqual([]);
      const audits = await h.database.system
        .select()
        .from(schema.auditLogs)
        .where(eq(schema.auditLogs.action, 'maintenance.cancelled'));
      expect(audits).toHaveLength(1);
    });
  });
});
