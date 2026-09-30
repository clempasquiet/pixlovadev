import { randomInt, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  HeartbeatPayload,
  ManifestStatusRequest,
  OutputsReportRequest,
  PAIRING_CODE_ALPHABET,
  PLAYER_AUTH_AUDIENCE,
  PLAYER_AUTH_TYPE,
  PlayerChallengeRequest,
  PlayerPairRequest,
  PlayerRegisterRequest,
  PlayerTokenRequest,
  formatInstant,
  verifyPlayerChallenge,
  type OutputReport,
  type PlayerAuthChallenge,
} from '@pixlova/contracts';
import Type from 'typebox';
import { schema, withTenant, type Transaction } from '@pixlova/db';
import { ApiError } from '../errors.js';
import { Strict, Uuid } from './schemas.js';
import { rateLimit } from '../http/context.js';
import type { Services } from '../http/services.js';
import { randomToken, safeEqual, tokenHash } from '../lib/crypto.js';

export interface PlayerContext {
  playerId: string;
  organizationId: string;
  installationUuid: string;
}

export function generatePairingCode(): string {
  const chars = Array.from(
    { length: 8 },
    () => PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)],
  );
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/** Empreinte du code normalisé ; le code lisible n’est jamais stocké. */
export function pairingCodeHash(code: string): string {
  return tokenHash(`pairing:${code}`);
}

/**
 * Authentifie un Player par son jeton d’accès (PROTO-002, PROTO-003). La résolution
 * précède le tenant : opération système nommée. État du Player et credential sont
 * revérifiés à chaque requête ; un jeton encore valide d’un Player révoqué est refusé.
 */
export async function authenticatePlayer(
  request: FastifyRequest,
  services: Services,
): Promise<PlayerContext> {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new ApiError(401, 'UNAUTHORIZED', 'Jeton Player requis.');
  const [row] = await services.system
    .select({
      playerId: schema.players.id,
      organizationId: schema.players.organizationId,
      installationUuid: schema.players.installationUuid,
      lifecycle: schema.players.lifecycleStatus,
      credentialRevokedAt: schema.playerCredentials.revokedAt,
      tokenRevokedAt: schema.playerAccessTokens.revokedAt,
      expiresAt: schema.playerAccessTokens.expiresAt,
    })
    .from(schema.playerAccessTokens)
    .innerJoin(schema.players, eq(schema.players.id, schema.playerAccessTokens.playerId))
    .innerJoin(
      schema.playerCredentials,
      eq(schema.playerCredentials.id, schema.playerAccessTokens.credentialId),
    )
    .where(eq(schema.playerAccessTokens.tokenHash, tokenHash(token)));
  if (!row) throw new ApiError(401, 'UNAUTHORIZED', 'Jeton Player invalide ou expiré.');
  // La révocation est signalée explicitement au Player qui la reçoit (SEC-007), avant
  // l’expiration de son jeton : elle se distingue d’une simple perte de contact.
  if (row.lifecycle !== 'paired' || row.credentialRevokedAt) {
    throw new ApiError(403, 'PLAYER_REVOKED', 'Ce Player a été révoqué ou désactivé.');
  }
  if (row.tokenRevokedAt || row.expiresAt <= services.now()) {
    throw new ApiError(401, 'UNAUTHORIZED', 'Jeton Player invalide ou expiré.');
  }
  return {
    playerId: row.playerId,
    organizationId: row.organizationId,
    installationUuid: row.installationUuid,
  };
}

/** Met à jour les sorties déclarées ; une sortie connue garde son identité (DSP-005). */
export async function upsertOutputs(
  tx: Transaction,
  organizationId: string,
  playerId: string,
  outputs: OutputReport[],
  now: Date,
): Promise<void> {
  for (const output of outputs) {
    await tx
      .insert(schema.playerOutputs)
      .values({
        organizationId,
        playerId,
        outputKey: output.output_key,
        connectorType: output.connector_type,
        width: output.width,
        height: output.height,
        refreshRate: output.refresh_hz,
        connected: output.connected,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.playerOutputs.playerId, schema.playerOutputs.outputKey],
        set: {
          connectorType: output.connector_type,
          width: output.width,
          height: output.height,
          refreshRate: output.refresh_hz,
          connected: output.connected,
          lastSeenAt: now,
        },
      });
  }
}

export function playerApiRoutes(app: FastifyInstance, services: Services): void {
  /** Enregistrement d’une installation (PROTO-001 étape 2) : aucun tenant, aucun droit. */
  app.post('/register', { schema: { body: PlayerRegisterRequest } }, async (request, reply) => {
    await rateLimit(services, `player-register:ip:${request.ip}`, 30, 3600);
    const body = request.body as PlayerRegisterRequest;
    const now = services.now();
    const expiresAt = new Date(now.getTime() + services.security.pairingCodeMinutes * 60_000);
    const pollSecret = randomToken();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generatePairingCode();
      try {
        const [session] = await services.system
          .insert(schema.pairingSessions)
          .values({
            installationUuid: body.installation_id,
            playerType: body.capabilities.player_type,
            publicKey: body.public_key,
            capabilities: body.capabilities,
            outputs: body.outputs,
            appVersion: body.capabilities.app_version,
            machineFingerprintHash: body.machine_fingerprint,
            codeHash: pairingCodeHash(code),
            pollSecretHash: tokenHash(pollSecret),
            expiresAt,
            ip: request.ip ?? null,
          })
          .returning({ id: schema.pairingSessions.id });
        return reply.status(201).send({
          registration_id: session!.id,
          pairing_code: code,
          expires_at: formatInstant(expiresAt),
          poll_secret: pollSecret,
          poll_interval_s: 5,
        });
      } catch (error) {
        // Collision improbable avec un code encore en attente : nouveau tirage.
        if ((error as { cause?: { code?: string } }).cause?.code !== '23505') throw error;
      }
    }
    throw new ApiError(
      503,
      'SERVICE_UNAVAILABLE',
      'Impossible de générer un code, réessayez.',
      true,
    );
  });

  /**
   * Suivi par le Player (PROTO-001 étape 4) : seule l’installation qui détient le secret
   * de suivi récupère l’association validée par un utilisateur. Reprises idempotentes.
   */
  app.post('/pair', { schema: { body: PlayerPairRequest } }, async (request, reply) => {
    const body = request.body as PlayerPairRequest;
    await rateLimit(services, `player-pair:${body.registration_id}`, 120, 900);
    const [session] = await services.system
      .select()
      .from(schema.pairingSessions)
      .where(eq(schema.pairingSessions.id, body.registration_id));
    if (!session || !safeEqual(session.pollSecretHash, tokenHash(body.poll_secret))) {
      throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Enregistrement introuvable.');
    }
    if (session.claimedAt && session.playerId && session.organizationId) {
      if (!session.deliveredAt) {
        await services.system
          .update(schema.pairingSessions)
          .set({ deliveredAt: services.now() })
          .where(eq(schema.pairingSessions.id, session.id));
      }
      return {
        status: 'paired',
        player_id: session.playerId,
        organization_id: session.organizationId,
      };
    }
    if (session.expiresAt <= services.now()) {
      throw new ApiError(
        409,
        'PAIRING_EXPIRED',
        'Code d’appairage expiré ; relancez l’enregistrement.',
      );
    }
    reply.header('retry-after', '5');
    return { status: 'pending', expires_at: formatInstant(session.expiresAt) };
  });

  /** Challenge à usage unique (PROTO-002), signé ensuite par la clé privée de l’appareil. */
  app.post('/token/challenge', { schema: { body: PlayerChallengeRequest } }, async (request) => {
    const { player_id: playerId } = request.body as { player_id: string };
    await rateLimit(services, `player-challenge:${playerId}`, 30, 900);
    await rateLimit(services, `player-challenge:ip:${request.ip}`, 300, 900);
    const [player] = await services.system
      .select()
      .from(schema.players)
      .where(eq(schema.players.id, playerId));
    if (!player) throw new ApiError(404, 'PLAYER_NOT_PAIRED', 'Player inconnu.');
    if (player.lifecycleStatus !== 'paired')
      throw new ApiError(403, 'PLAYER_REVOKED', 'Ce Player a été révoqué ou désactivé.');
    const now = services.now();
    const challenge: PlayerAuthChallenge = {
      type: PLAYER_AUTH_TYPE,
      audience: PLAYER_AUTH_AUDIENCE,
      challenge_id: randomUUID(),
      nonce: randomToken(),
      player_id: player.id,
      installation_id: player.installationUuid,
      issued_at: formatInstant(now),
      expires_at: formatInstant(
        new Date(now.getTime() + services.security.playerChallengeSeconds * 1000),
      ),
    };
    await services.system.insert(schema.playerAuthChallenges).values({
      id: challenge.challenge_id,
      organizationId: player.organizationId,
      playerId: player.id,
      document: challenge,
      expiresAt: new Date(challenge.expires_at),
    });
    return { challenge };
  });

  /** Échange d’un challenge signé contre un jeton court (PROTO-002). */
  app.post('/token/refresh', { schema: { body: PlayerTokenRequest } }, async (request) => {
    const body = request.body as PlayerTokenRequest;
    const now = services.now();
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + services.security.playerTokenMinutes * 60_000);
    return services.system.transaction(async (tx) => {
      const [challenge] = await tx
        .select()
        .from(schema.playerAuthChallenges)
        .where(eq(schema.playerAuthChallenges.id, body.challenge_id))
        .for('update');
      if (!challenge || challenge.usedAt || challenge.expiresAt <= now) {
        throw new ApiError(401, 'UNAUTHORIZED', 'Challenge invalide, expiré ou déjà utilisé.');
      }
      await tx
        .update(schema.playerAuthChallenges)
        .set({ usedAt: now })
        .where(eq(schema.playerAuthChallenges.id, challenge.id));
      const [row] = await tx
        .select({ player: schema.players, credential: schema.playerCredentials })
        .from(schema.players)
        .innerJoin(
          schema.playerCredentials,
          and(
            eq(schema.playerCredentials.playerId, schema.players.id),
            isNull(schema.playerCredentials.revokedAt),
          ),
        )
        .where(eq(schema.players.id, challenge.playerId));
      if (!row || row.player.lifecycleStatus !== 'paired')
        throw new ApiError(403, 'PLAYER_REVOKED', 'Ce Player a été révoqué ou désactivé.');
      if (
        !verifyPlayerChallenge(
          challenge.document as PlayerAuthChallenge,
          body.signature,
          row.credential.publicKey,
        )
      ) {
        throw new ApiError(401, 'UNAUTHORIZED', 'Signature invalide.');
      }
      await tx.insert(schema.playerAccessTokens).values({
        organizationId: row.player.organizationId,
        playerId: row.player.id,
        credentialId: row.credential.id,
        tokenHash: tokenHash(token),
        expiresAt,
      });
      return {
        access_token: token,
        token_type: 'Bearer',
        expires_at: formatInstant(expiresAt),
        credential_generation: String(row.credential.generation),
      };
    });
  });

  /** Affectations courantes de ce Player uniquement (SEC-007). */
  app.get('/config', async (request) => {
    const player = await authenticatePlayer(request, services);
    const rows = await withTenant(services.db, player.organizationId, (tx) =>
      tx
        .select({
          displayId: schema.displays.id,
          generation: schema.displayAssignments.generation,
          outputKey: schema.playerOutputs.outputKey,
          name: schema.displays.name,
          width: schema.displays.width,
          height: schema.displays.height,
          orientation: schema.displays.orientation,
          timezone: sql<string>`coalesce(${schema.displays.timezone}, ${schema.sites.timezone}, ${schema.organizations.timezone})`,
        })
        .from(schema.displayAssignments)
        .innerJoin(
          schema.playerOutputs,
          eq(schema.playerOutputs.id, schema.displayAssignments.playerOutputId),
        )
        .innerJoin(schema.displays, eq(schema.displays.id, schema.displayAssignments.displayId))
        .innerJoin(schema.sites, eq(schema.sites.id, schema.displays.siteId))
        .innerJoin(
          schema.organizations,
          eq(schema.organizations.id, schema.displays.organizationId),
        )
        .where(
          and(
            eq(schema.playerOutputs.playerId, player.playerId),
            isNull(schema.displayAssignments.endedAt),
            eq(schema.displays.lifecycleStatus, 'active'),
          ),
        ),
    );
    const versions = await withTenant(services.db, player.organizationId, (tx) =>
      authorizedManifests(tx, player).then((rows) =>
        rows.length === 0
          ? []
          : tx
              .select({
                displayId: schema.manifests.displayId,
                version: sql<string>`max(${schema.manifests.version})::text`,
              })
              .from(schema.manifests)
              .where(inArray(schema.manifests.id, rows))
              .groupBy(schema.manifests.displayId),
      ),
    );
    const desired = new Map(versions.map((v) => [v.displayId, v.version]));
    return {
      player_id: player.playerId,
      organization_id: player.organizationId,
      heartbeat_interval_s: services.security.heartbeatIntervalSeconds,
      presence_timeout_s: services.security.presenceTimeoutSeconds,
      assignments: rows.map((row) => ({
        display_id: row.displayId,
        assignment_generation: String(row.generation),
        output_key: row.outputKey,
        manifest_version: desired.get(row.displayId) ?? null,
        display: {
          name: row.name,
          width: row.width,
          height: row.height,
          orientation: row.orientation as 0 | 90 | 180 | 270,
          timezone: row.timezone,
        },
      })),
    };
  });

  app.post('/outputs', { schema: { body: OutputsReportRequest } }, async (request, reply) => {
    const player = await authenticatePlayer(request, services);
    const { outputs } = request.body as { outputs: OutputReport[] };
    await withTenant(services.db, player.organizationId, (tx) =>
      upsertOutputs(tx, player.organizationId, player.playerId, outputs, services.now()),
    );
    return reply.status(204).send();
  });

  /**
   * Heartbeat HTTP (SUP-002). L’heure serveur de réception fait foi pour la présence.
   * Un Display annoncé avec une génération périmée n’est jamais réactivé (DSP-003) :
   * il est signalé pour que le Player rafraîchisse sa configuration.
   */
  app.post('/heartbeat', { schema: { body: HeartbeatPayload } }, async (request) => {
    const player = await authenticatePlayer(request, services);
    const body = request.body as HeartbeatPayload;
    const now = services.now();
    const stale = await withTenant(services.db, player.organizationId, async (tx) => {
      await tx
        .update(schema.players)
        .set({ lastSeenAt: now })
        .where(eq(schema.players.id, player.playerId));
      const announced = body.displays.map((d) => d.display_id);
      if (announced.length === 0) return [];
      const current = await tx
        .select({
          displayId: schema.displayAssignments.displayId,
          generation: schema.displayAssignments.generation,
        })
        .from(schema.displayAssignments)
        .innerJoin(
          schema.playerOutputs,
          eq(schema.playerOutputs.id, schema.displayAssignments.playerOutputId),
        )
        .where(
          and(
            eq(schema.playerOutputs.playerId, player.playerId),
            isNull(schema.displayAssignments.endedAt),
            inArray(schema.displayAssignments.displayId, announced),
          ),
        );
      const valid = new Map(current.map((c) => [c.displayId, String(c.generation)]));
      return body.displays
        .filter((d) => valid.get(d.display_id) !== d.assignment_generation)
        .map((d) => d.display_id);
    });
    return { server_time: formatInstant(now), stale_displays: stale };
  });

  /** Dernier manifest désiré d’une affectation active de ce Player (ADR-011). */
  app.get(
    '/manifest',
    { schema: { querystring: Type.Object({ display_id: Uuid }, Strict) } },
    async (request, reply) => {
      const player = await authenticatePlayer(request, services);
      const { display_id: displayId } = request.query as { display_id: string };
      const manifest = await withTenant(services.db, player.organizationId, async (tx) => {
        const ids = await authorizedManifests(tx, player, displayId);
        if (ids.length === 0) return null;
        const [latest] = await tx
          .select()
          .from(schema.manifests)
          .where(inArray(schema.manifests.id, ids))
          .orderBy(desc(schema.manifests.version))
          .limit(1);
        if (latest) await markReceived(tx, latest.id, player.playerId, services.now());
        return latest ?? null;
      });
      if (!manifest) {
        throw new ApiError(404, 'MANIFEST_NOT_FOUND', 'Aucun manifest pour cette affectation.');
      }
      return sendManifest(request, reply, manifest);
    },
  );

  app.get(
    '/manifests/:id',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request, reply) => {
      const player = await authenticatePlayer(request, services);
      const { id } = request.params as { id: string };
      const manifest = await withTenant(services.db, player.organizationId, async (tx) => {
        const ids = await authorizedManifests(tx, player);
        if (!ids.includes(id)) return null;
        const [row] = await tx.select().from(schema.manifests).where(eq(schema.manifests.id, id));
        if (row) await markReceived(tx, row.id, player.playerId, services.now());
        return row ?? null;
      });
      if (!manifest) throw new ApiError(404, 'MANIFEST_NOT_FOUND', 'Manifest introuvable.');
      return sendManifest(request, reply, manifest);
    },
  );

  /**
   * URL temporaire d’un asset (PROTO-004) : l’asset doit figurer dans un manifest de
   * l’affectation active et de la génération courante. L’URL n’est pas journalisée ; une
   * fuite reste utilisable jusqu’à son expiration courte.
   */
  app.get(
    '/assets/:id/url',
    {
      schema: {
        params: Type.Object({ id: Uuid }, Strict),
        querystring: Type.Object({ manifest_id: Uuid }, Strict),
      },
    },
    async (request) => {
      const player = await authenticatePlayer(request, services);
      const { id } = request.params as { id: string };
      const { manifest_id: manifestId } = request.query as { manifest_id: string };
      const asset = await withTenant(services.db, player.organizationId, async (tx) => {
        const ids = await authorizedManifests(tx, player);
        if (!ids.includes(manifestId)) return null;
        const [row] = await tx
          .select({ asset: schema.mediaAssets })
          .from(schema.manifestAssets)
          .innerJoin(
            schema.mediaAssets,
            eq(schema.mediaAssets.id, schema.manifestAssets.mediaAssetId),
          )
          .where(
            and(
              eq(schema.manifestAssets.manifestId, manifestId),
              eq(schema.manifestAssets.mediaAssetId, id),
            ),
          );
        return row?.asset ?? null;
      });
      if (!asset)
        throw new ApiError(404, 'ASSET_NOT_FOUND', 'Asset non autorisé pour ce manifest.');
      let signed;
      try {
        signed = await services.storage.presignGet(asset.storageKey, {
          expiresInSeconds: services.media.previewUrlSeconds,
        });
      } catch {
        throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Stockage indisponible.', true);
      }
      return {
        asset_id: asset.id,
        url: signed.url,
        expires_at: formatInstant(signed.expiresAt),
        size_bytes: asset.sizeBytes,
        sha256: asset.checksumSha256,
        range_supported: true,
      };
    },
  );

  /**
   * États déclarés par le Player (FON-002) : transitions monotones et idempotentes.
   * « Appliqué » n’est enregistré qu’à la déclaration du Player, jamais déduit.
   */
  app.post(
    '/manifests/:id/status',
    {
      schema: { params: Type.Object({ id: Uuid }, Strict), body: ManifestStatusRequest },
    },
    async (request) => {
      const player = await authenticatePlayer(request, services);
      const { id } = request.params as { id: string };
      const body = request.body as ManifestStatusRequest;
      const now = services.now();
      return withTenant(services.db, player.organizationId, async (tx) => {
        const ids = await authorizedManifests(tx, player);
        const [delivery] = ids.includes(id)
          ? await tx
              .select()
              .from(schema.manifestDeliveries)
              .where(
                and(
                  eq(schema.manifestDeliveries.manifestId, id),
                  eq(schema.manifestDeliveries.playerId, player.playerId),
                ),
              )
              .for('update')
          : [];
        if (!delivery) throw new ApiError(404, 'MANIFEST_NOT_FOUND', 'Manifest introuvable.');
        const next = nextDeliveryState(delivery.state, body.state);
        if (next === delivery.state) return { state: delivery.state };
        await tx
          .update(schema.manifestDeliveries)
          .set({
            state: next,
            updatedAt: now,
            ...(next === 'ready' ? { readyAt: now } : {}),
            ...(next === 'applied' ? { appliedAt: now, errorCode: null, detail: null } : {}),
            ...(next === 'failed'
              ? {
                  failedAt: now,
                  errorCode: body.error_code ?? 'PREPARATION_FAILED',
                  detail: body.detail,
                }
              : {}),
          })
          .where(eq(schema.manifestDeliveries.id, delivery.id));
        return { state: next };
      });
    },
  );
}

const STATE_RANK: Record<string, number> = {
  desired: 0,
  received: 1,
  downloading: 2,
  ready: 3,
  applied: 4,
};

/**
 * Transition d’une livraison. Un état appliqué est final ; un recul est ignoré (message
 * rejoué ou désordonné) ; un échec peut être suivi d’une nouvelle préparation. Un manifest
 * remplacé côté cloud peut encore être déclaré appliqué : c’est ce qui joue réellement.
 */
type DeliveryState = (typeof schema.manifestDeliveries.$inferSelect)['state'];

export function nextDeliveryState(
  current: DeliveryState,
  reported: ManifestStatusRequest['state'],
): DeliveryState {
  if (current === 'applied') return current;
  if (reported === 'applied' || reported === 'failed') return reported;
  if (current === 'failed' || current === 'superseded') return reported;
  return (STATE_RANK[reported] ?? 0) > (STATE_RANK[current] ?? 0) ? reported : current;
}

/**
 * Manifests autorisés pour ce Player (PROTO-004, PROTO-013) : Display affecté à l’une de ses
 * sorties, affectation active et même génération. Une ancienne affectation ne redevient
 * jamais légitime.
 */
async function authorizedManifests(
  tx: Transaction,
  player: PlayerContext,
  displayId?: string,
): Promise<string[]> {
  const rows = await tx
    .select({ id: schema.manifests.id })
    .from(schema.manifests)
    .innerJoin(
      schema.displayAssignments,
      and(
        eq(schema.displayAssignments.displayId, schema.manifests.displayId),
        isNull(schema.displayAssignments.endedAt),
        eq(schema.displayAssignments.generation, schema.manifests.assignmentGeneration),
      ),
    )
    .innerJoin(
      schema.playerOutputs,
      eq(schema.playerOutputs.id, schema.displayAssignments.playerOutputId),
    )
    .where(
      and(
        eq(schema.playerOutputs.playerId, player.playerId),
        eq(schema.manifests.playerId, player.playerId),
        ...(displayId ? [eq(schema.manifests.displayId, displayId)] : []),
      ),
    );
  return rows.map((row) => row.id);
}

async function markReceived(
  tx: Transaction,
  manifestId: string,
  playerId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(schema.manifestDeliveries)
    .set({ state: 'received', receivedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.manifestDeliveries.manifestId, manifestId),
        eq(schema.manifestDeliveries.playerId, playerId),
        eq(schema.manifestDeliveries.state, 'desired'),
      ),
    );
}

/** Octets signés tels qu’enregistrés ; ETag = empreinte du payload (304 si inchangé). */
function sendManifest(
  request: FastifyRequest,
  reply: FastifyReply,
  manifest: typeof schema.manifests.$inferSelect,
) {
  const etag = `"${manifest.payloadHash}"`;
  reply.header('etag', etag).header('cache-control', 'private, no-cache');
  if (request.headers['if-none-match'] === etag) return reply.status(304).send();
  return reply.header('content-type', 'application/json; charset=utf-8').send(manifest.envelope);
}
