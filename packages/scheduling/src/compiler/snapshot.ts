/**
 * Chargement du snapshot d’un Display (PROTO-018 étape 1). À appeler dans une transaction
 * `REPEATABLE READ` sous contexte tenant : toutes les lectures voient le même état.
 */
import { and, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import {
  validator,
  type CompositionDocument,
  type ContentRef,
  type PlayerCapabilities,
  type PlaylistDocument,
  type ProgramDocument,
} from '@pixlova/contracts';
import { schema, type Transaction } from '@pixlova/db';
import type { AssetEntry, DisplaySnapshot, MediaEntry } from './types.js';

const validateCapabilities = validator('player-capabilities.json');

function fallbackRef(display: typeof schema.displays.$inferSelect): ContentRef | null {
  if (display.fallbackMode !== 'content') return null;
  if (display.fallbackMediaId) return { type: 'media', id: display.fallbackMediaId };
  if (display.fallbackCompositionId) {
    return { type: 'composition', id: display.fallbackCompositionId };
  }
  if (display.fallbackPlaylistId) return { type: 'playlist', id: display.fallbackPlaylistId };
  return null;
}

/** `null` si le Display n’existe pas (ou plus) dans ce tenant. */
export async function loadSnapshot(
  tx: Transaction,
  displayId: string,
  now: Date,
): Promise<DisplaySnapshot | null> {
  const [row] = await tx
    .select({
      display: schema.displays,
      siteTimezone: schema.sites.timezone,
      organizationTimezone: schema.organizations.timezone,
    })
    .from(schema.displays)
    .innerJoin(schema.sites, eq(schema.sites.id, schema.displays.siteId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.displays.organizationId))
    .where(and(eq(schema.displays.id, displayId), isNull(schema.displays.deletedAt)));
  if (!row) return null;
  const { display } = row;

  const groups = await tx
    .select({ id: schema.displayGroupMembers.groupId })
    .from(schema.displayGroupMembers)
    .where(eq(schema.displayGroupMembers.displayId, displayId));

  const [assignment] = await tx
    .select({
      generation: schema.displayAssignments.generation,
      playerId: schema.players.id,
      capabilities: schema.players.capabilities,
    })
    .from(schema.displayAssignments)
    .innerJoin(
      schema.playerOutputs,
      eq(schema.playerOutputs.id, schema.displayAssignments.playerOutputId),
    )
    .innerJoin(schema.players, eq(schema.players.id, schema.playerOutputs.playerId))
    .where(
      and(
        eq(schema.displayAssignments.displayId, displayId),
        isNull(schema.displayAssignments.endedAt),
        eq(schema.players.lifecycleStatus, 'paired'),
        isNull(schema.players.deletedAt),
      ),
    );

  const programRows = await tx
    .select({ program: schema.programs, version: schema.programVersions })
    .from(schema.programs)
    .innerJoin(
      schema.programVersions,
      eq(schema.programVersions.id, schema.programs.publishedVersionId),
    )
    .where(
      and(
        isNotNull(schema.programs.publishedVersionId),
        isNull(schema.programs.cancelledAt),
        isNull(schema.programs.deletedAt),
        or(isNull(schema.programs.effectiveUntil), gt(schema.programs.effectiveUntil, now)),
      ),
    );

  const snapshot: DisplaySnapshot = {
    organization_id: display.organizationId,
    display_id: display.id,
    config_revision: display.configRevision.toString(),
    display: {
      width: display.width,
      height: display.height,
      orientation: display.orientation as 0 | 90 | 180 | 270,
      timezone: display.timezone ?? row.siteTimezone ?? row.organizationTimezone,
      site_id: display.siteId,
      group_ids: groups.map((g) => g.id).sort(),
      fallback: fallbackRef(display),
    },
    // Un Display inactif ou archivé n’est pas diffusé : aucun manifest (DSP-001).
    assignment:
      assignment && display.lifecycleStatus === 'active'
        ? {
            player_id: assignment.playerId,
            generation: assignment.generation.toString(),
            capabilities: validateCapabilities(assignment.capabilities)
              ? (assignment.capabilities as PlayerCapabilities)
              : null,
          }
        : null,
    programs: programRows
      .map(({ program, version }) => ({
        id: program.id,
        kind: program.kind,
        site_id: program.siteId,
        version: version.version,
        version_id: version.id,
        document: version.document as ProgramDocument,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    playlists: {},
    compositions: {},
    media: {},
  };

  // Fermeture des contenus référencés, niveau par niveau.
  const pending: ContentRef[] = snapshot.programs.flatMap(({ document }) =>
    document.kind === 'schedule'
      ? [
          ...document.rules.map((r) => r.content),
          ...document.exceptions.flatMap((e) => (e.content ? [e.content] : [])),
        ]
      : document.content
        ? [document.content]
        : [],
  );
  if (snapshot.display.fallback) pending.push(snapshot.display.fallback);
  const seen = new Set<string>();
  while (pending.length > 0) {
    const batch = pending.splice(0).filter((ref) => {
      const key = `${ref.type}:${ref.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const ids = (type: ContentRef['type']) => batch.filter((r) => r.type === type).map((r) => r.id);

    const playlistIds = ids('playlist');
    if (playlistIds.length > 0) {
      const rows = await tx
        .select({ playlist: schema.playlists, version: schema.playlistVersions })
        .from(schema.playlists)
        .innerJoin(
          schema.playlistVersions,
          eq(schema.playlistVersions.id, schema.playlists.publishedVersionId),
        )
        .where(and(inArray(schema.playlists.id, playlistIds), isNull(schema.playlists.deletedAt)));
      for (const { playlist, version } of rows) {
        const document = version.document as PlaylistDocument;
        snapshot.playlists[playlist.id] = {
          id: playlist.id,
          version_id: version.id,
          version: version.version,
          document,
        };
        pending.push(...document.items.map((item) => item.content));
      }
    }

    const compositionIds = ids('composition');
    if (compositionIds.length > 0) {
      const rows = await tx
        .select({ composition: schema.compositions, version: schema.compositionVersions })
        .from(schema.compositions)
        .innerJoin(
          schema.compositionVersions,
          eq(schema.compositionVersions.id, schema.compositions.publishedVersionId),
        )
        .where(
          and(
            inArray(schema.compositions.id, compositionIds),
            isNull(schema.compositions.deletedAt),
          ),
        );
      for (const { composition, version } of rows) {
        const document = version.document as CompositionDocument;
        snapshot.compositions[composition.id] = {
          id: composition.id,
          version_id: version.id,
          version: version.version,
          document,
        };
        for (const element of document.elements) {
          if ((element.type === 'image' || element.type === 'video') && element.props.media_id) {
            pending.push({ type: 'media', id: element.props.media_id });
          }
          if (element.type === 'playlist_zone' && element.props.playlist_id) {
            pending.push({ type: 'playlist', id: element.props.playlist_id });
          }
        }
      }
    }

    const mediaIds = ids('media');
    if (mediaIds.length > 0) {
      const rows = await tx
        .select()
        .from(schema.media)
        .where(
          and(
            inArray(schema.media.id, mediaIds),
            eq(schema.media.status, 'ready'),
            isNull(schema.media.deletedAt),
            isNull(schema.media.purgeStartedAt),
          ),
        );
      const assets = rows.length
        ? await tx
            .select()
            .from(schema.mediaAssets)
            .where(
              and(
                inArray(
                  schema.mediaAssets.mediaId,
                  rows.map((r) => r.id),
                ),
                inArray(schema.mediaAssets.variant, ['playback', 'original']),
              ),
            )
        : [];
      for (const media of rows) {
        const asset = (variant: 'playback' | 'original'): AssetEntry | null => {
          const found = assets.find((a) => a.mediaId === media.id && a.variant === variant);
          return found
            ? {
                id: found.id,
                variant,
                mime_type: found.mimeType,
                size_bytes: found.sizeBytes,
                sha256: found.checksumSha256,
                duration_ms: found.durationMs,
              }
            : null;
        };
        const entry: MediaEntry = {
          id: media.id,
          type: media.type,
          duration_ms: media.durationMs,
          playback: asset('playback'),
          original: asset('original'),
        };
        snapshot.media[media.id] = entry;
      }
    }
  }
  return snapshot;
}
