import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import Type from 'typebox';
import {
  ReleaseVersion,
  compareReleaseVersions,
  decodeBase64url,
  parseReleaseVersion,
  verifyRelease,
  type TrustStore,
} from '@pixlova/contracts';
import { schema } from '@pixlova/db';
import { ApiError } from '../errors.js';
import { PLAYER_PROTOCOL_VERSION } from '../lib/releases.js';
import { Strict, Uuid } from '../modules/schemas.js';
import { platformAudit, requirePermission, requireRecentMfa, supportReason } from './context.js';
import type { AdminServices } from './services.js';

type ReleaseRow = typeof schema.playerReleases.$inferSelect;

const Reason = Type.String({ minLength: 5, maxLength: 500 });
const Confirm = Type.Object({ reason: Reason, confirm_version: ReleaseVersion }, Strict);

/**
 * Clés publiques de release acceptées par l’administration (`kid:clé,kid:clé`, clés
 * Ed25519 de 32 octets en base64url). Seules des clés publiques : la signature a lieu dans
 * l’environnement de release (ARC-018), jamais dans la plateforme.
 */
export function releaseTrustFromEnv(value: string | undefined): TrustStore {
  const trust = new Map<string, Uint8Array>();
  for (const entry of (value ?? '').split(',').map((part) => part.trim())) {
    if (!entry) continue;
    const [kid, encoded, extra] = entry.split(':');
    const key = encoded ? decodeBase64url(encoded) : null;
    if (!kid || !key || key.length !== 32 || extra !== undefined || trust.has(kid)) {
      throw new Error('PIXLOVA_RELEASE_PUBLIC_KEYS invalide (kid:clé publique base64url).');
    }
    trust.set(kid, key);
  }
  return trust;
}

function publicRelease(row: ReleaseRow) {
  return {
    id: row.id,
    version: row.version,
    channel: row.channel,
    os: row.os,
    architecture: row.architecture,
    status: row.status,
    package: {
      sha256: row.sha256,
      size_bytes: row.sizeBytes,
      uploaded: row.artifactKey !== null,
    },
    key_id: row.keyId,
    protocol: { min: row.protocolMin, max: row.protocolMax },
    sqlite_schema: row.sqliteSchema,
    sqlite_reader_level: row.sqliteReaderLevel,
    renderer_build: row.rendererBuild,
    notes: row.notes,
    created_at: row.createdAt.toISOString(),
    published_at: row.publishedAt?.toISOString() ?? null,
    blocked_at: row.blockedAt?.toISOString() ?? null,
    block_reason: row.blockReason,
  };
}

const num = (value: unknown): number => Number(value ?? 0);

/**
 * Registre des releases du Player natif (ADM-004, ADM-005, PLY-005, ADR-019). Une release
 * est déposée en brouillon (métadonnées signées vérifiées, puis paquet vérifié), publiée
 * après affichage de son périmètre, ou bloquée : les Players qui l’exécutent reviennent
 * alors à leur version précédente. Chaque étape est contrôlée côté serveur et auditée.
 */
export function adminReleaseRoutes(app: FastifyInstance, services: AdminServices): void {
  // Paquet téléversé brut : lu en flux, jamais chargé en mémoire.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  async function load(id: string, lock = false): Promise<ReleaseRow> {
    const query = services.platform
      .select()
      .from(schema.playerReleases)
      .where(eq(schema.playerReleases.id, id));
    const [row] = lock ? await query.for('update') : await query;
    if (!row) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Release introuvable.');
    return row;
  }

  /** Players natifs appairés de la plateforme, par version déclarée. */
  async function fleetVersions(os: string, architecture: string) {
    const result = await services.platform.execute(
      sql`SELECT app_version, count(*) AS players, count(DISTINCT organization_id) AS organizations
          FROM players
          WHERE type = 'native' AND lifecycle_status = 'paired' AND deleted_at IS NULL
            AND os = ${os} AND architecture = ${architecture}
          GROUP BY app_version`,
    );
    return result.rows.map((r) => ({
      version: r.app_version === null ? null : String(r.app_version),
      players: num(r.players),
      organizations: num(r.organizations),
    }));
  }

  async function currentDesired(os: string, architecture: string, excluding?: string) {
    const t = schema.playerReleases;
    const [row] = await services.platform
      .select({ id: t.id, version: t.version })
      .from(t)
      .where(
        and(
          eq(t.os, os as ReleaseRow['os']),
          eq(t.architecture, architecture as ReleaseRow['architecture']),
          eq(t.status, 'published'),
          ...(excluding ? [ne(t.id, excluding)] : []),
        ),
      )
      .orderBy(desc(t.versionMajor), desc(t.versionMinor), desc(t.versionPatch))
      .limit(1);
    return row ?? null;
  }

  /**
   * Périmètre et conséquences avant publication ou blocage (ADM-005) : calculés sur les
   * versions déclarées par les Players, jamais estimés.
   */
  async function impact(release: ReleaseRow) {
    const versions = await fleetVersions(release.os, release.architecture);
    const desired = await currentDesired(release.os, release.architecture);
    const after = await currentDesired(release.os, release.architecture, release.id);
    const sum = (filter: (version: string | null) => boolean) =>
      versions.filter((v) => filter(v.version)).reduce((total, v) => total + v.players, 0);
    const known = (version: string | null): version is string =>
      version !== null && parseReleaseVersion(version) !== null;
    const compare = (version: string) => compareReleaseVersions(version, release.version);
    // La release souhaitée après publication reste la plus récente publiée.
    const wouldBeDesired =
      !desired || compareReleaseVersions(release.version, desired.version) > 0
        ? release.version
        : desired.version;
    return {
      platform: { os: release.os, architecture: release.architecture },
      native_players: sum(() => true),
      organizations: versions.reduce((total, v) => total + v.organizations, 0),
      versions,
      publish: {
        current_desired: desired?.version ?? null,
        desired_after: wouldBeDesired,
        // Mis à jour automatiquement : version connue antérieure à la release souhaitée.
        players_to_update:
          wouldBeDesired === release.version ? sum((v) => known(v) && compare(v) < 0) : 0,
        players_up_to_date: sum((v) => known(v) && compare(v) === 0),
        players_newer: sum((v) => known(v) && compare(v) > 0),
        players_unknown_version: sum((v) => !known(v)),
      },
      block: {
        // Retour à la version précédente installée localement, propre à chaque Player.
        players_to_roll_back: sum((v) => v === release.version),
        desired_after: after?.version ?? null,
      },
    };
  }

  function requireStorage() {
    if (!services.storage) {
      throw new ApiError(
        503,
        'RELEASES_NOT_CONFIGURED',
        'Stockage des paquets non configuré pour l’administration.',
      );
    }
    return services.storage;
  }

  app.get('/releases', async (request) => {
    await requirePermission(request, services, 'platform.releases.read');
    const releases = await services.platform
      .select()
      .from(schema.playerReleases)
      .orderBy(
        schema.playerReleases.os,
        schema.playerReleases.architecture,
        desc(schema.playerReleases.versionMajor),
        desc(schema.playerReleases.versionMinor),
        desc(schema.playerReleases.versionPatch),
      )
      .limit(200);
    const reports = await services.platform.execute(
      sql`SELECT release_id, state, count(*) AS players
          FROM player_update_reports GROUP BY release_id, state`,
    );
    const running = await services.platform.execute(
      sql`SELECT os, architecture, app_version, count(*) AS players
          FROM players
          WHERE type = 'native' AND lifecycle_status = 'paired' AND deleted_at IS NULL
          GROUP BY os, architecture, app_version
          ORDER BY os, architecture, app_version`,
    );
    const desired = new Map<string, string>();
    for (const release of releases) {
      const key = `${release.os}/${release.architecture}`;
      if (release.status === 'published' && !desired.has(key)) desired.set(key, release.id);
    }
    return {
      configured: { signature_keys: services.releaseTrust.size > 0, storage: !!services.storage },
      items: releases.map((release) => {
        const deployment: Record<string, number> = {
          installed: 0,
          promoted: 0,
          rolled_back: 0,
          failed: 0,
        };
        for (const r of reports.rows) {
          if (r.release_id === release.id) deployment[String(r.state)] = num(r.players);
        }
        return {
          ...publicRelease(release),
          desired: desired.get(`${release.os}/${release.architecture}`) === release.id,
          running_players: running.rows
            .filter(
              (r) =>
                r.os === release.os &&
                r.architecture === release.architecture &&
                r.app_version === release.version,
            )
            .reduce((total, r) => total + num(r.players), 0),
          deployment,
        };
      }),
      fleet: running.rows.map((r) => ({
        os: r.os === null ? null : String(r.os),
        architecture: r.architecture === null ? null : String(r.architecture),
        version: r.app_version === null ? null : String(r.app_version),
        players: num(r.players),
      })),
    };
  });

  /** Dépôt d’un brouillon : métadonnées signées vérifiées avec les clés de release. */
  app.post(
    '/releases',
    {
      schema: {
        body: Type.Object(
          {
            envelope: Type.String({ minLength: 2, maxLength: 64 * 1024 }),
            notes: Type.Optional(Type.String({ maxLength: 2000 })),
          },
          Strict,
        ),
      },
    },
    async (request, reply) => {
      const context = await requirePermission(request, services, 'platform.releases.manage');
      const body = request.body as { envelope: string; notes?: string };
      if (services.releaseTrust.size === 0) {
        throw new ApiError(
          503,
          'RELEASES_NOT_CONFIGURED',
          'Aucune clé publique de release configurée (PIXLOVA_RELEASE_PUBLIC_KEYS).',
        );
      }
      const verified = verifyRelease(body.envelope, services.releaseTrust);
      if (!verified.ok) {
        await platformAudit(services.platform, request, context, {
          action: 'platform.release.rejected',
          permission: 'platform.releases.manage',
          targetType: 'player_release',
          result: 'failed',
          metadata: { code: verified.code },
        });
        throw new ApiError(422, 'RELEASE_INVALID', `Release refusée : ${verified.detail}.`, false, {
          code: verified.code,
        });
      }
      const release = verified.release;
      if (
        release.protocol_min > PLAYER_PROTOCOL_VERSION ||
        release.protocol_max < PLAYER_PROTOCOL_VERSION
      ) {
        throw new ApiError(
          422,
          'RELEASE_INCOMPATIBLE',
          `Release incompatible avec le protocole Player ${PLAYER_PROTOCOL_VERSION} servi par l’API.`,
        );
      }
      const [major, minor, patch] = parseReleaseVersion(release.version)!;
      const inserted = await services.platform
        .insert(schema.playerReleases)
        .values({
          id: release.release_id,
          version: release.version,
          versionMajor: major,
          versionMinor: minor,
          versionPatch: patch,
          os: release.os,
          architecture: release.arch,
          sha256: release.package.sha256,
          sizeBytes: release.package.size_bytes,
          keyId: verified.kid,
          payloadHash: verified.payloadHash,
          envelope: body.envelope,
          protocolMin: release.protocol_min,
          protocolMax: release.protocol_max,
          sqliteSchema: release.sqlite_schema,
          sqliteReaderLevel: release.sqlite_reader_level,
          rendererBuild: release.renderer_build,
          notes: body.notes?.trim() || null,
          createdBy: context.operator.id,
        })
        .onConflictDoNothing()
        .returning();
      const row = inserted[0];
      if (!row) {
        throw new ApiError(
          409,
          'RELEASE_EXISTS',
          'Cette release, ou cette version pour la même plateforme, est déjà enregistrée.',
        );
      }
      await platformAudit(services.platform, request, context, {
        action: 'platform.release.created',
        permission: 'platform.releases.manage',
        targetType: 'player_release',
        targetId: row.id,
        result: 'success',
        metadata: {
          version: row.version,
          os: row.os,
          architecture: row.architecture,
          key_id: row.keyId,
          sha256: row.sha256,
        },
      });
      return reply.status(201).send(publicRelease(row));
    },
  );

  /**
   * Paquet d’un brouillon, en flux : taille et SHA-256 comparés aux métadonnées signées
   * avant tout enregistrement. Un paquet différent est refusé sans rien conserver.
   */
  app.put(
    '/releases/:id/package',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request: FastifyRequest) => {
      const context = await requirePermission(request, services, 'platform.releases.manage');
      const storage = requireStorage();
      const { id } = request.params as { id: string };
      const release = await load(id);
      if (release.status !== 'draft') {
        throw new ApiError(409, 'RELEASE_NOT_DRAFT', 'Seul un brouillon reçoit un paquet.');
      }
      if (!request.headers['content-type']?.startsWith('application/octet-stream')) {
        throw new ApiError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'Paquet attendu en application/octet-stream.',
        );
      }
      const declared = Number(request.headers['content-length']);
      if (Number.isFinite(declared) && declared !== release.sizeBytes) {
        throw new ApiError(422, 'PACKAGE_MISMATCH', 'Taille différente des métadonnées signées.');
      }
      const dir = await mkdtemp(join(tmpdir(), 'pixlova-release-'));
      const file = join(dir, 'package.tar');
      try {
        const hash = createHash('sha256');
        let size = 0;
        await pipeline(
          request.body as Readable,
          async function* (source: AsyncIterable<Buffer>) {
            for await (const chunk of source) {
              size += chunk.length;
              if (size > release.sizeBytes) {
                throw new ApiError(
                  422,
                  'PACKAGE_MISMATCH',
                  'Paquet plus grand que les métadonnées signées.',
                );
              }
              hash.update(chunk);
              yield chunk;
            }
          },
          createWriteStream(file),
        );
        const digest = hash.digest('hex');
        if (size !== release.sizeBytes || digest !== release.sha256) {
          await platformAudit(services.platform, request, context, {
            action: 'platform.release.package_rejected',
            permission: 'platform.releases.manage',
            targetType: 'player_release',
            targetId: id,
            result: 'failed',
            metadata: { size_bytes: size, sha256: digest },
          });
          throw new ApiError(
            422,
            'PACKAGE_MISMATCH',
            'Paquet différent des métadonnées signées (taille ou empreinte).',
          );
        }
        const key = `releases/${release.os}-${release.architecture}/${release.version}-${randomBytes(8).toString('hex')}.tar`;
        await storage.writeFile(key, file, 'application/x-tar');
        const updated = await services.platform.transaction(async (tx) => {
          const [row] = await tx
            .update(schema.playerReleases)
            .set({ artifactKey: key, updatedAt: services.now() })
            .where(and(eq(schema.playerReleases.id, id), eq(schema.playerReleases.status, 'draft')))
            .returning();
          if (!row) {
            throw new ApiError(409, 'RELEASE_NOT_DRAFT', 'Seul un brouillon reçoit un paquet.');
          }
          await platformAudit(tx, request, context, {
            action: 'platform.release.package_uploaded',
            permission: 'platform.releases.manage',
            targetType: 'player_release',
            targetId: id,
            result: 'success',
            metadata: { version: row.version, sha256: digest, size_bytes: size },
          });
          return row;
        });
        // L’ancien paquet d’un brouillon remplacé n’est plus référencé.
        if (release.artifactKey && release.artifactKey !== key) {
          await storage.delete(release.artifactKey).catch(() => undefined);
        }
        return publicRelease(updated);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  app.get(
    '/releases/:id/impact',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request) => {
      await requirePermission(request, services, 'platform.releases.read');
      const { id } = request.params as { id: string };
      const release = await load(id);
      return { release: publicRelease(release), impact: await impact(release) };
    },
  );

  /** Publication (ADM-005) : brouillon complet, version recopiée, motif, TOTP récent. */
  app.post(
    '/releases/:id/publish',
    { schema: { params: Type.Object({ id: Uuid }, Strict), body: Confirm } },
    async (request) => {
      const context = await requirePermission(request, services, 'platform.releases.manage');
      requireRecentMfa(context, services);
      const { id } = request.params as { id: string };
      const body = request.body as { reason: string; confirm_version: string };
      const reason = supportReason(request, body.reason);
      const release = await load(id);
      if (body.confirm_version !== release.version) {
        throw new ApiError(409, 'CONFIRMATION_MISMATCH', 'La version recopiée ne correspond pas.');
      }
      if (release.status !== 'draft') {
        throw new ApiError(409, 'RELEASE_NOT_DRAFT', 'Seul un brouillon peut être publié.');
      }
      if (!release.artifactKey) {
        throw new ApiError(409, 'PACKAGE_MISSING', 'Téléversez et vérifiez le paquet avant.');
      }
      const scope = await impact(release);
      const now = services.now();
      const updated = await services.platform.transaction(async (tx) => {
        const [row] = await tx
          .update(schema.playerReleases)
          .set({
            status: 'published',
            publishedAt: now,
            publishedBy: context.operator.id,
            updatedAt: now,
          })
          .where(and(eq(schema.playerReleases.id, id), eq(schema.playerReleases.status, 'draft')))
          .returning();
        if (!row) {
          throw new ApiError(409, 'RELEASE_NOT_DRAFT', 'Seul un brouillon peut être publié.');
        }
        await platformAudit(tx, request, context, {
          action: 'platform.release.published',
          permission: 'platform.releases.manage',
          targetType: 'player_release',
          targetId: id,
          result: 'success',
          reason,
          metadata: {
            version: row.version,
            os: row.os,
            architecture: row.architecture,
            before: { status: 'draft', desired: scope.publish.current_desired },
            after: { status: 'published', desired: scope.publish.desired_after },
            players_to_update: scope.publish.players_to_update,
          },
        });
        return row;
      });
      return { release: publicRelease(updated), impact: await impact(updated) };
    },
  );

  /**
   * Blocage (retour arrière, ADM-005) : la release n’est plus distribuée et les Players
   * qui l’exécutent reviennent à leur version précédente. Sans retour : une correction
   * est une nouvelle version.
   */
  app.post(
    '/releases/:id/block',
    { schema: { params: Type.Object({ id: Uuid }, Strict), body: Confirm } },
    async (request) => {
      const context = await requirePermission(request, services, 'platform.releases.manage');
      requireRecentMfa(context, services);
      const { id } = request.params as { id: string };
      const body = request.body as { reason: string; confirm_version: string };
      const reason = supportReason(request, body.reason);
      const release = await load(id);
      if (body.confirm_version !== release.version) {
        throw new ApiError(409, 'CONFIRMATION_MISMATCH', 'La version recopiée ne correspond pas.');
      }
      if (release.status !== 'published') {
        throw new ApiError(409, 'RELEASE_NOT_PUBLISHED', 'Seule une release publiée est bloquée.');
      }
      const scope = await impact(release);
      const now = services.now();
      const updated = await services.platform.transaction(async (tx) => {
        const [row] = await tx
          .update(schema.playerReleases)
          .set({
            status: 'blocked',
            blockedAt: now,
            blockedBy: context.operator.id,
            blockReason: reason,
            updatedAt: now,
          })
          .where(
            and(eq(schema.playerReleases.id, id), eq(schema.playerReleases.status, 'published')),
          )
          .returning();
        if (!row) {
          throw new ApiError(
            409,
            'RELEASE_NOT_PUBLISHED',
            'Seule une release publiée est bloquée.',
          );
        }
        await platformAudit(tx, request, context, {
          action: 'platform.release.blocked',
          permission: 'platform.releases.manage',
          targetType: 'player_release',
          targetId: id,
          result: 'success',
          reason,
          metadata: {
            version: row.version,
            os: row.os,
            architecture: row.architecture,
            before: { status: 'published' },
            after: { status: 'blocked', desired: scope.block.desired_after },
            players_to_roll_back: scope.block.players_to_roll_back,
          },
        });
        return row;
      });
      return { release: publicRelease(updated), impact: await impact(updated) };
    },
  );

  /** Abandon d’un brouillon jamais distribué : métadonnées et paquet supprimés. */
  app.delete(
    '/releases/:id',
    { schema: { params: Type.Object({ id: Uuid }, Strict) } },
    async (request, reply) => {
      const context = await requirePermission(request, services, 'platform.releases.manage');
      const { id } = request.params as { id: string };
      const deleted = await services.platform.transaction(async (tx) => {
        const [row] = await tx
          .delete(schema.playerReleases)
          .where(and(eq(schema.playerReleases.id, id), eq(schema.playerReleases.status, 'draft')))
          .returning();
        if (!row) {
          throw new ApiError(409, 'RELEASE_NOT_DRAFT', 'Seul un brouillon peut être supprimé.');
        }
        await platformAudit(tx, request, context, {
          action: 'platform.release.deleted',
          permission: 'platform.releases.manage',
          targetType: 'player_release',
          targetId: id,
          result: 'success',
          metadata: { version: row.version, os: row.os, architecture: row.architecture },
        });
        return row;
      });
      if (deleted.artifactKey) {
        await services.storage?.delete(deleted.artifactKey).catch(() => undefined);
      }
      return reply.status(204).send();
    },
  );
}
