/**
 * Registre et distribution des releases du Player natif (L09-A, ADR-019) sur PostgreSQL
 * réel : dépôt signé en brouillon, paquet vérifié, périmètre avant publication, release
 * souhaitée et URL du paquet pour le Player, commandes de mise à jour, rapports, blocage
 * et retour arrière, contrôles de permission et audit.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RELEASE_ENVELOPE_TYPE,
  encodeBase64url,
  publicKeyFromSecret,
  signEnvelope,
  verifyCommand,
  verifyRelease,
  type ReleasePayload,
} from '@pixlova/contracts';
import { skipDatabaseTests } from '@pixlova/db/testing';
import type { PlatformRole } from '@pixlova/permissions';
import { buildAdminApp } from '../src/admin/app.js';
import { createOperator } from '../src/admin/operators.js';
import { releaseTrustFromEnv } from '../src/admin/releases.js';
import { DataCipher } from '../src/lib/crypto.js';
import { MemoryRateLimiter } from '../src/lib/rate-limit.js';
import {
  createHarness,
  createOrganization,
  signUp,
  type Client,
  type Harness,
} from './support/harness.js';
import { ADMIN_ORIGIN, Operator, REASON } from './support/operator.js';
import { SimulatedPlayer, capabilities } from './support/player.js';

const RELEASE_SECRET = randomBytes(32);
const RELEASE_KID = 'release-test-a';

function key(): Record<string, string> {
  return { 'idempotency-key': `test-${randomUUID()}` };
}

function release(
  version: string,
  bytes: Buffer,
  overrides: Partial<ReleasePayload> = {},
  secret: Uint8Array = RELEASE_SECRET,
) {
  const payload: ReleasePayload = {
    schema_version: 1,
    release_id: randomUUID(),
    version,
    os: 'linux',
    arch: 'x86_64',
    package: { sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length },
    protocol_min: 1,
    protocol_max: 1,
    sqlite_schema: 3,
    sqlite_reader_level: 1,
    renderer_build: version,
    published_at: '2026-10-01T00:00:00Z',
    ...overrides,
  };
  return {
    payload,
    envelope: JSON.stringify(signEnvelope(RELEASE_ENVELOPE_TYPE, RELEASE_KID, payload, secret)),
  };
}

describe.skipIf(skipDatabaseTests)('registre des releases du Player natif (ADR-019)', () => {
  let h: Harness;
  let admin: FastifyInstance;
  let ops: Operator;
  let support: Operator;
  let owner: Client;
  let player: SimulatedPlayer;
  let webPlayer: SimulatedPlayer;
  const v020 = randomBytes(4096);
  const v030 = randomBytes(2048);
  const first = release('0.2.0', v020);
  const second = release('0.3.0', v030);

  async function newOperator(email: string, roles: PlatformRole[]): Promise<Operator> {
    const issued = await createOperator(
      h.database.platform,
      { email, displayName: email.split('@')[0]!, roles },
      null,
      h.clock.now,
      24,
    );
    const operator = new Operator(admin, h, email);
    await operator.activate(issued.activationCode);
    return operator;
  }

  async function uploadPackage(operator: Operator, id: string, bytes: Buffer) {
    return admin.inject({
      method: 'PUT',
      url: `/admin-api/v1/releases/${id}/package`,
      payload: bytes,
      headers: {
        origin: ADMIN_ORIGIN,
        cookie: operator.cookie!,
        'content-type': 'application/octet-stream',
      },
    });
  }

  async function pair(p: SimulatedPlayer, siteId: string, name: string) {
    const code = await p.register();
    const response = await owner.request(
      'POST',
      '/players/pair',
      { code, name, site_id: siteId },
      key(),
    );
    if (response.statusCode !== 201) throw new Error(`pair: ${response.body}`);
    await p.poll();
    await p.authenticate();
  }

  async function audited(action: string) {
    const result = await h.database.system.execute(
      sql`SELECT organization_id, actor_id, target_id, result, reason, metadata
          FROM audit_logs WHERE action = ${action} ORDER BY created_at`,
    );
    return result.rows;
  }

  beforeAll(async () => {
    h = await createHarness();
    admin = buildAdminApp({
      services: {
        platform: h.database.platform,
        cipher: new DataCipher([{ kid: 'test', key: randomBytes(32) }]),
        limiter: new MemoryRateLimiter(() => h.clock.now.getTime()),
        entitlements: h.services.entitlements,
        config: {
          allowedOrigins: [ADMIN_ORIGIN],
          cookieSecure: true,
          sessionIdleMinutes: 30,
          sessionAbsoluteHours: 8,
          recentAuthMinutes: 5,
          activationHours: 24,
          presenceTimeoutSeconds: 90,
        },
        releaseTrust: releaseTrustFromEnv(
          `${RELEASE_KID}:${encodeBase64url(publicKeyFromSecret(RELEASE_SECRET))}`,
        ),
        storage: h.storage,
        now: () => h.clock.now,
      },
    });
    await admin.ready();
    ops = await newOperator('ops@pixlova.test', ['operations']);
    support = await newOperator('support@pixlova.test', ['support']);
    owner = await signUp(h, 'owner@client.test');
    const org = await createOrganization(owner, 'Boulangerie Martin');
    player = new SimulatedPlayer(h);
    webPlayer = new SimulatedPlayer(
      h,
      undefined,
      capabilities({ player_type: 'web', os: { family: 'other', version: null } }),
    );
    await pair(player, org.siteId, 'Vitrine');
    await pair(webPlayer, org.siteId, 'Navigateur');
  });

  afterAll(async () => {
    await admin?.close();
    await h?.close();
  });

  it('refuse des clés de release mal formées', () => {
    expect(() => releaseTrustFromEnv('sans-cle')).toThrow(/invalide/);
    expect(() => releaseTrustFromEnv(`k1:${encodeBase64url(randomBytes(16))}`)).toThrow();
    expect(releaseTrustFromEnv(undefined).size).toBe(0);
  });

  it('ne dépose que des métadonnées signées par une clé de release, compatibles', async () => {
    const forged = release('0.9.0', v020, {}, randomBytes(32));
    const rejected = await ops.post('/releases', { envelope: forged.envelope });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error).toMatchObject({ code: 'RELEASE_INVALID' });
    expect((await audited('platform.release.rejected'))[0]).toMatchObject({ result: 'failed' });

    const future = release('0.9.1', v020, { protocol_min: 2, protocol_max: 2 });
    expect((await ops.post('/releases', { envelope: future.envelope })).json().error.code).toBe(
      'RELEASE_INCOMPATIBLE',
    );

    // Support consulte, n’administre pas ; le refus est audité.
    const denied = await support.post('/releases', { envelope: first.envelope });
    expect(denied.statusCode).toBe(403);
    expect((await support.get('/releases')).statusCode).toBe(200);

    const created = await ops.post('/releases', { envelope: first.envelope, notes: 'Correctifs' });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      id: first.payload.release_id,
      version: '0.2.0',
      status: 'draft',
      package: { uploaded: false, size_bytes: v020.length },
    });
    expect((await ops.post('/releases', { envelope: first.envelope })).json().error.code).toBe(
      'RELEASE_EXISTS',
    );
    const sameVersion = release('0.2.0', v030);
    expect((await ops.post('/releases', { envelope: sameVersion.envelope })).statusCode).toBe(409);
  });

  it('vérifie le paquet en flux avant de le conserver', async () => {
    const id = first.payload.release_id;
    const wrong = Buffer.from(v020);
    wrong[0] = wrong[0]! ^ 0xff;
    const mismatch = await uploadPackage(ops, id, wrong);
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().error.code).toBe('PACKAGE_MISMATCH');
    const tooLong = await uploadPackage(ops, id, Buffer.concat([v020, Buffer.from('x')]));
    expect(tooLong.json().error.code).toBe('PACKAGE_MISMATCH');

    // Sans paquet, rien n’est publiable.
    await ops.post('/auth/reauthenticate', { code: ops.code() });
    const early = await ops.post(`/releases/${id}/publish`, {
      reason: REASON,
      confirm_version: '0.2.0',
    });
    expect(early.json().error.code).toBe('PACKAGE_MISSING');

    const uploaded = await uploadPackage(ops, id, v020);
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    expect(uploaded.json().package.uploaded).toBe(true);
    expect((await audited('platform.release.package_uploaded'))[0]).toMatchObject({
      organization_id: null,
      target_id: id,
    });
  });

  it('montre le périmètre, puis publie avec motif, version recopiée et second facteur récent', async () => {
    const id = first.payload.release_id;
    const scope = (await support.get(`/releases/${id}/impact`)).json().impact;
    expect(scope).toMatchObject({
      platform: { os: 'linux', architecture: 'x86_64' },
      native_players: 1,
      organizations: 1,
      publish: {
        current_desired: null,
        desired_after: '0.2.0',
        players_to_update: 1,
        players_up_to_date: 0,
      },
      block: { players_to_roll_back: 0 },
    });

    h.clock.advance(6 * 60_000);
    const stale = await ops.post(`/releases/${id}/publish`, {
      reason: REASON,
      confirm_version: '0.2.0',
    });
    expect(stale.json().error.code).toBe('RECENT_AUTH_REQUIRED');
    await ops.post('/auth/reauthenticate', { code: ops.code() });
    const mistyped = await ops.post(`/releases/${id}/publish`, {
      reason: REASON,
      confirm_version: '0.2.1',
    });
    expect(mistyped.json().error.code).toBe('CONFIRMATION_MISMATCH');
    const published = await ops.post(`/releases/${id}/publish`, {
      reason: REASON,
      confirm_version: '0.2.0',
    });
    expect(published.statusCode, published.body).toBe(200);
    expect(published.json().release.status).toBe('published');
    const [entry] = await audited('platform.release.published');
    expect(entry).toMatchObject({ organization_id: null, reason: REASON, result: 'success' });
    expect(entry!.metadata).toMatchObject({
      before: { status: 'draft', desired: null },
      after: { status: 'published', desired: '0.2.0' },
      players_to_update: 1,
    });
    expect((await ops.request('DELETE', `/releases/${id}`)).json().error.code).toBe(
      'RELEASE_NOT_DRAFT',
    );
  });

  it('indique au Player la release souhaitée et une URL signée de son paquet', async () => {
    const desired = await player.call('GET', '/releases/desired?current_version=0.1.0');
    expect(desired.statusCode, desired.body).toBe(200);
    const body = desired.json();
    expect(body).toMatchObject({
      rollback: false,
      package: { size_bytes: v020.length, sha256: first.payload.package.sha256 },
    });
    // Enveloppe transmise telle que signée : le Player la vérifie lui-même.
    const trust = new Map([[RELEASE_KID, publicKeyFromSecret(RELEASE_SECRET)]]);
    const verified = verifyRelease(body.release, trust);
    expect(verified.ok && verified.release.version).toBe('0.2.0');
    const download = await h.app.inject({ method: 'GET', url: body.package.url });
    expect(download.statusCode).toBe(200);
    expect(Buffer.from(download.rawPayload).equals(v020)).toBe(true);

    // Player Web : aucune release native.
    expect((await webPlayer.call('GET', '/releases/desired')).json()).toEqual({
      release: null,
      package: null,
      rollback: false,
    });
    // Sans jeton, rien.
    const anonymous = await h.app.inject({ method: 'GET', url: '/player/v1/releases/desired' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('commande une mise à jour vers la release souhaitée, Player natif seulement', async () => {
    const tenantView = (await owner.get(`/players/${player.playerId}/update`)).json();
    expect(tenantView).toMatchObject({
      supported: true,
      installed_version: '0.1.0',
      desired: { version: '0.2.0' },
      update_available: true,
      last_report: null,
    });
    const web = await owner.request(
      'POST',
      `/players/${webPlayer.playerId}/commands`,
      { type: 'UPDATE_PLAYER' },
      key(),
    );
    expect(web.json().error.code).toBe('CAPABILITY_UNSUPPORTED');
    const created = await owner.request(
      'POST',
      `/players/${player.playerId}/commands`,
      { type: 'UPDATE_PLAYER' },
      key(),
    );
    expect(created.statusCode, created.body).toBe(201);
    const commands = (await player.call('GET', '/commands')).json().commands as string[];
    const trust = new Map([
      [
        h.services.supervision.commandKey!.kid,
        publicKeyFromSecret(h.services.supervision.commandKey!.secretKey),
      ],
    ]);
    const update = commands
      .map((raw) => verifyCommand(raw, trust))
      .find((c) => c.ok && c.command.type === 'UPDATE_PLAYER');
    expect(update?.ok && update.command.params).toEqual({ release_id: first.payload.release_id });
  });

  it('enregistre les états déclarés, sans doublon ni retour en arrière dans le temps', async () => {
    const id = first.payload.release_id;
    const report = (state: string, at: string, code: string | null = null) =>
      player.call('POST', `/updates/${id}/status`, {
        version: '0.2.0',
        state,
        code,
        detail: null,
        observed_at: at,
      });
    expect((await report('installed', '2026-10-01T10:00:00Z')).statusCode).toBe(204);
    expect((await report('installed', '2026-10-01T10:00:00Z')).statusCode).toBe(204);
    expect((await report('promoted', '2026-10-01T10:05:00Z')).statusCode).toBe(204);
    // Plus ancien que l’état connu : ignoré.
    expect((await report('failed', '2026-10-01T09:00:00Z', 'NETWORK')).statusCode).toBe(204);
    // Le Player redémarré annonce sa version en service.
    await player.call('GET', '/releases/desired?current_version=0.2.0');

    const view = (await owner.get(`/players/${player.playerId}/update`)).json();
    expect(view).toMatchObject({
      installed_version: '0.2.0',
      update_available: false,
      last_report: { state: 'promoted', version: '0.2.0' },
    });
    const events = await h.database.system.execute(
      sql`SELECT type FROM timeline_events WHERE player_id = ${player.playerId}
          AND type LIKE 'UPDATE_%' ORDER BY observed_at`,
    );
    expect(events.rows.map((r) => r.type)).toEqual(['UPDATE_INSTALLED', 'UPDATE_PROMOTED']);

    const listed = (await support.get('/releases')).json();
    const row = listed.items.find((r: { id: string }) => r.id === id);
    expect(row).toMatchObject({
      desired: true,
      running_players: 1,
      deployment: { promoted: 1, installed: 0, failed: 0 },
    });
    expect(listed.fleet).toContainEqual({
      os: 'linux',
      architecture: 'x86_64',
      version: '0.2.0',
      players: 1,
    });
    expect(listed.configured).toEqual({ signature_keys: true, storage: true });

    const upToDate = await owner.request(
      'POST',
      `/players/${player.playerId}/commands`,
      { type: 'UPDATE_PLAYER' },
      key(),
    );
    expect(upToDate.json().error.code).toBe('PLAYER_UP_TO_DATE');
  });

  it('bloque une release : plus distribuée, retour arrière demandé à ses Players', async () => {
    // Une 0.3.0 publiée puis bloquée : la 0.2.0 redevient souhaitée.
    expect((await ops.post('/releases', { envelope: second.envelope })).statusCode).toBe(201);
    const id = second.payload.release_id;
    expect((await uploadPackage(ops, id, v030)).statusCode).toBe(200);
    await ops.post('/auth/reauthenticate', { code: ops.code() });
    expect(
      (await ops.post(`/releases/${id}/publish`, { reason: REASON, confirm_version: '0.3.0' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await player.call('GET', '/releases/desired?current_version=0.3.0')).json().package,
    ).toMatchObject({ sha256: second.payload.package.sha256 });

    const scope = (await ops.get(`/releases/${id}/impact`)).json().impact;
    expect(scope.block).toEqual({ players_to_roll_back: 1, desired_after: '0.2.0' });
    expect(
      (await support.post(`/releases/${id}/block`, { reason: REASON, confirm_version: '0.3.0' }))
        .statusCode,
    ).toBe(403);
    const blocked = await ops.post(`/releases/${id}/block`, {
      reason: REASON,
      confirm_version: '0.3.0',
    });
    expect(blocked.statusCode, blocked.body).toBe(200);
    expect(blocked.json().release).toMatchObject({ status: 'blocked', block_reason: REASON });
    expect((await audited('platform.release.blocked'))[0]!.metadata).toMatchObject({
      players_to_roll_back: 1,
      after: { status: 'blocked', desired: '0.2.0' },
    });

    const after = (await player.call('GET', '/releases/desired?current_version=0.3.0')).json();
    expect(after.rollback).toBe(true);
    expect(after.package.sha256).toBe(first.payload.package.sha256);
    // Une release bloquée ne se republie pas : une correction est une nouvelle version.
    expect(
      (
        await ops.post(`/releases/${id}/publish`, { reason: REASON, confirm_version: '0.3.0' })
      ).json().error.code,
    ).toBe('RELEASE_NOT_DRAFT');
  });

  it('supprime un brouillon et son paquet', async () => {
    const draft = release('0.4.0', v030);
    await ops.post('/releases', { envelope: draft.envelope });
    await uploadPackage(ops, draft.payload.release_id, v030);
    const deleted = await ops.request('DELETE', `/releases/${draft.payload.release_id}`);
    expect(deleted.statusCode).toBe(204);
    expect((await ops.get(`/releases/${draft.payload.release_id}/impact`)).statusCode).toBe(404);
  });
});
