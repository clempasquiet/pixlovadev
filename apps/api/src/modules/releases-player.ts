import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import Type from 'typebox';
import {
  ReleaseVersion,
  UpdateStatusRequest,
  formatInstant,
  type DesiredReleaseResponse,
} from '@pixlova/contracts';
import { schema, withTenant } from '@pixlova/db';
import { ApiError } from '../errors.js';
import { rateLimit } from '../http/context.js';
import type { Services } from '../http/services.js';
import { desiredRelease, isBlockedVersion, releasePlatform } from '../lib/releases.js';
import { cloudEvent } from '../lib/supervision.js';
import { authenticatePlayer } from './player-api.js';
import { Strict, Uuid } from './schemas.js';

/** Durée de validité de l’URL signée d’un paquet (téléchargement de plusieurs Mio). */
const PACKAGE_URL_SECONDS = 15 * 60;

const UPDATE_EVENTS = {
  installed: { type: 'UPDATE_INSTALLED', severity: 'info' },
  promoted: { type: 'UPDATE_PROMOTED', severity: 'info' },
  rolled_back: { type: 'UPDATE_ROLLED_BACK', severity: 'warning' },
  failed: { type: 'UPDATE_FAILED', severity: 'error' },
} as const;

/**
 * Distribution des releases du Player natif (PLY-005, NAT-013, ADR-019). Le cloud indique
 * la release souhaitée et une URL signée de son paquet ; le Player vérifie la signature,
 * la plateforme, l’empreinte et la taille avant toute installation. Les états déclarés
 * rendent visibles version installée et résultat du déploiement.
 */
export function releasePlayerRoutes(app: FastifyInstance, services: Services): void {
  app.get(
    '/releases/desired',
    {
      schema: {
        querystring: Type.Object({ current_version: Type.Optional(ReleaseVersion) }, Strict),
      },
    },
    async (request): Promise<DesiredReleaseResponse> => {
      const player = await authenticatePlayer(request, services);
      await rateLimit(services, `player-releases:${player.playerId}`, 30, 600);
      const { current_version: currentVersion } = request.query as { current_version?: string };
      const found = await withTenant(services.db, player.organizationId, async (tx) => {
        const [row] = await tx
          .select({
            type: schema.players.type,
            os: schema.players.os,
            architecture: schema.players.architecture,
            appVersion: schema.players.appVersion,
          })
          .from(schema.players)
          .where(eq(schema.players.id, player.playerId));
        const platform = row ? releasePlatform(row) : null;
        if (!row || !platform) return null;
        // Version en service déclarée par le Player lui-même : seule source après une mise à jour.
        if (currentVersion && currentVersion !== row.appVersion) {
          await tx
            .update(schema.players)
            .set({ appVersion: currentVersion, updatedAt: services.now() })
            .where(eq(schema.players.id, player.playerId));
        }
        return {
          release: await desiredRelease(tx, platform),
          rollback: currentVersion ? await isBlockedVersion(tx, platform, currentVersion) : false,
        };
      });
      if (!found) return { release: null, package: null, rollback: false };
      const { release, rollback } = found;
      if (!release) return { release: null, package: null, rollback };
      let signed;
      try {
        signed = await services.storage.presignGet(release.artifactKey, {
          expiresInSeconds: PACKAGE_URL_SECONDS,
        });
      } catch {
        throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Stockage indisponible.', true);
      }
      return {
        release: release.envelope,
        package: {
          url: signed.url,
          expires_at: formatInstant(signed.expiresAt),
          size_bytes: release.sizeBytes,
          sha256: release.sha256,
        },
        rollback,
      };
    },
  );

  /** Dernier état connu d’une mise à jour ; une déclaration plus ancienne est ignorée. */
  app.post(
    '/updates/:release_id/status',
    {
      schema: {
        params: Type.Object({ release_id: Uuid }, Strict),
        body: UpdateStatusRequest,
      },
    },
    async (request, reply) => {
      const player = await authenticatePlayer(request, services);
      await rateLimit(services, `player-updates:${player.playerId}`, 60, 600);
      const { release_id: releaseId } = request.params as { release_id: string };
      const body = request.body as UpdateStatusRequest;
      const observedAt = new Date(body.observed_at);
      const now = services.now();
      if (observedAt.getTime() > now.getTime() + 24 * 3600_000) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Date d’observation incohérente.', false, {
          field: 'observed_at',
        });
      }
      await withTenant(services.db, player.organizationId, async (tx) => {
        const t = schema.playerUpdateReports;
        const values = {
          version: body.version,
          state: body.state,
          code: body.code,
          detail: body.detail,
          observedAt,
          receivedAt: now,
          updatedAt: now,
        };
        const changed = await tx
          .insert(t)
          .values({
            organizationId: player.organizationId,
            playerId: player.playerId,
            releaseId,
            ...values,
          })
          .onConflictDoUpdate({
            target: [t.playerId, t.releaseId],
            set: values,
            // Rejouée ou plus ancienne : rien ne change, aucun événement en double.
            setWhere: sql`${t.observedAt} < ${observedAt}
              or (${t.observedAt} = ${observedAt} and ${t.state} <> ${body.state})`,
          })
          .returning({ id: t.id });
        if (changed.length > 0) {
          const event = UPDATE_EVENTS[body.state];
          await cloudEvent(tx, {
            organizationId: player.organizationId,
            playerId: player.playerId,
            type: event.type,
            severity: event.severity,
            at: observedAt,
            payload: {
              release_id: releaseId,
              version: body.version,
              ...(body.code ? { code: body.code } : {}),
            },
          });
        }
      });
      return reply.status(204).send();
    },
  );
}
