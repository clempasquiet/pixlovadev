/**
 * Contrôles partagés par les playlists, compositions et programmes (ADR-011) : contenus
 * référencés publiables et visibles, cycles du graphe publié, résolution des cibles et
 * demande de recompilation.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { ContentRef, Targeting } from '@pixlova/contracts';
import { schema, type Transaction } from '@pixlova/db';
import { siteFilter } from '@pixlova/permissions';
import { resolveTargets, type DisplayFacts } from '@pixlova/scheduling';
import { requestRecompile } from '@pixlova/scheduling/compiler';
import type { MemberContext } from '../http/context.js';

export interface GraphIssue {
  severity: 'error' | 'warning';
  code: string;
  ref: string | null;
  message: string;
}

export function canSeeSite(member: MemberContext, siteId: string | null): boolean {
  const visible = siteFilter(member.grants, 'organization.read');
  return visible === 'all' || (siteId !== null && visible.includes(siteId));
}

/** Recompilation après une décision métier, dans la même transaction (DATA-010). */
export function recompile(
  tx: Transaction,
  member: { organizationId: string },
  displays: readonly string[] | 'all',
  reason: string,
): Promise<number> {
  return requestRecompile(tx, member.organizationId, displays, reason);
}

export interface ContentInfo {
  type: ContentRef['type'];
  id: string;
  name: string;
  site_id: string | null;
  /** Média : type détecté ; composition et playlist : `null`. */
  media_type: 'image' | 'video' | null;
  /** Média prêt hors corbeille, composition ou playlist publiée. */
  publishable: boolean;
  status: string;
  duration_ms: number | null;
  published_version: number | null;
}

/** Informations des contenus référencés, visibles de l’utilisateur (sinon absents). */
export async function contentInfos(
  tx: Transaction,
  member: MemberContext,
  refs: readonly ContentRef[],
): Promise<Map<string, ContentInfo>> {
  const ids = (type: ContentRef['type']) => [
    ...new Set(refs.filter((ref) => ref.type === type).map((ref) => ref.id)),
  ];
  const infos = new Map<string, ContentInfo>();
  const mediaIds = ids('media');
  if (mediaIds.length > 0) {
    const rows = await tx.select().from(schema.media).where(inArray(schema.media.id, mediaIds));
    for (const row of rows) {
      if (!canSeeSite(member, row.siteId)) continue;
      const trashed = row.deletedAt !== null || row.purgeStartedAt !== null;
      infos.set(`media:${row.id}`, {
        type: 'media',
        id: row.id,
        name: row.name,
        site_id: row.siteId,
        media_type: row.type,
        publishable: row.status === 'ready' && !trashed,
        status: trashed ? 'trashed' : row.status,
        duration_ms: row.durationMs,
        published_version: null,
      });
    }
  }
  const compositionIds = ids('composition');
  if (compositionIds.length > 0) {
    const rows = await tx
      .select({
        composition: schema.compositions,
        document: schema.compositionVersions.document,
      })
      .from(schema.compositions)
      .leftJoin(
        schema.compositionVersions,
        eq(schema.compositionVersions.id, schema.compositions.publishedVersionId),
      )
      .where(inArray(schema.compositions.id, compositionIds));
    for (const { composition, document } of rows) {
      if (!canSeeSite(member, composition.siteId)) continue;
      const settings = (document as { settings?: { duration_ms?: number } } | null)?.settings;
      infos.set(`composition:${composition.id}`, {
        type: 'composition',
        id: composition.id,
        name: composition.name,
        site_id: composition.siteId,
        media_type: null,
        publishable: composition.deletedAt === null && composition.publishedVersionId !== null,
        status: composition.deletedAt
          ? 'deleted'
          : composition.publishedVersionId
            ? 'published'
            : 'draft',
        duration_ms: settings?.duration_ms ?? null,
        published_version: composition.publishedVersion,
      });
    }
  }
  const playlistIds = ids('playlist');
  if (playlistIds.length > 0) {
    const rows = await tx
      .select()
      .from(schema.playlists)
      .where(inArray(schema.playlists.id, playlistIds));
    for (const row of rows) {
      if (!canSeeSite(member, row.siteId)) continue;
      infos.set(`playlist:${row.id}`, {
        type: 'playlist',
        id: row.id,
        name: row.name,
        site_id: row.siteId,
        media_type: null,
        publishable: row.deletedAt === null && row.publishedVersionId !== null,
        status: row.deletedAt ? 'deleted' : row.publishedVersionId ? 'published' : 'draft',
        duration_ms: null,
        published_version: row.publishedVersion,
      });
    }
  }
  return infos;
}

const LABEL: Record<ContentRef['type'], string> = {
  media: 'Le média',
  composition: 'La composition',
  playlist: 'La playlist',
};

/**
 * Anomalies bloquantes des contenus référencés par un objet de périmètre `siteId` : contenu
 * visible, publiable, global ou du même site (même règle que les médias d’une composition).
 */
export function referenceIssues(
  refs: readonly ContentRef[],
  infos: Map<string, ContentInfo>,
  siteId: string | null,
): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const info = infos.get(key);
    const issue = (code: string, message: string) =>
      issues.push({ severity: 'error', code, ref: key, message });
    if (!info) issue('CONTENT_NOT_FOUND', `${LABEL[ref.type]} est introuvable.`);
    else if (info.site_id !== null && info.site_id !== siteId) {
      issue('CONTENT_SCOPE_MISMATCH', `« ${info.name} » appartient à un autre site.`);
    } else if (!info.publishable) {
      issue(
        info.type === 'media' ? 'MEDIA_NOT_READY' : 'CONTENT_NOT_PUBLISHED',
        info.type === 'media'
          ? `« ${info.name} » n’est pas prêt ou est dans la corbeille.`
          : `« ${info.name} » n’a pas de version publiée.`,
      );
    }
  }
  return issues;
}

/**
 * Contenus atteignables depuis `start` dans le graphe des versions publiées courantes
 * (playlist → médias et compositions, composition → médias et playlists).
 */
export async function reachablePublished(
  tx: Transaction,
  start: readonly ContentRef[],
): Promise<Set<string>> {
  const reached = new Set<string>();
  let frontier = [...start];
  while (frontier.length > 0) {
    const fresh = frontier.filter((ref) => !reached.has(`${ref.type}:${ref.id}`));
    for (const ref of fresh) reached.add(`${ref.type}:${ref.id}`);
    frontier = [];
    const playlistIds = fresh.filter((r) => r.type === 'playlist').map((r) => r.id);
    const compositionIds = fresh.filter((r) => r.type === 'composition').map((r) => r.id);
    if (playlistIds.length > 0) {
      const rows = await tx
        .select({ compositionId: schema.contentDependencies.compositionId })
        .from(schema.playlists)
        .innerJoin(
          schema.contentDependencies,
          eq(schema.contentDependencies.playlistVersionId, schema.playlists.publishedVersionId),
        )
        .where(and(inArray(schema.playlists.id, playlistIds), isNull(schema.playlists.deletedAt)));
      for (const row of rows) {
        if (row.compositionId) frontier.push({ type: 'composition', id: row.compositionId });
      }
    }
    if (compositionIds.length > 0) {
      const rows = await tx
        .select({ playlistId: schema.contentDependencies.playlistId })
        .from(schema.compositions)
        .innerJoin(
          schema.contentDependencies,
          eq(
            schema.contentDependencies.compositionVersionId,
            schema.compositions.publishedVersionId,
          ),
        )
        .where(
          and(
            inArray(schema.compositions.id, compositionIds),
            isNull(schema.compositions.deletedAt),
          ),
        );
      for (const row of rows) {
        if (row.playlistId) frontier.push({ type: 'playlist', id: row.playlistId });
      }
    }
  }
  return reached;
}

/** Cycle si `self` est atteignable depuis ses futures références (CMP-005, PROTO-016). */
export async function cycleIssues(
  tx: Transaction,
  self: ContentRef,
  refs: readonly ContentRef[],
): Promise<GraphIssue[]> {
  const candidates = refs.filter((ref) => ref.type !== 'media');
  if (candidates.some((ref) => ref.type === self.type && ref.id === self.id)) {
    return [
      {
        severity: 'error',
        code: 'CONTENT_CYCLE',
        ref: `${self.type}:${self.id}`,
        message: 'Un contenu ne peut pas s’inclure lui-même.',
      },
    ];
  }
  const reached = await reachablePublished(tx, candidates);
  if (!reached.has(`${self.type}:${self.id}`)) return [];
  return [
    {
      severity: 'error',
      code: 'CONTENT_CYCLE',
      ref: `${self.type}:${self.id}`,
      message:
        self.type === 'playlist'
          ? 'Une composition de cette playlist affiche déjà cette playlist : cycle interdit.'
          : 'Une playlist de cette composition contient déjà cette composition : cycle interdit.',
    },
  ];
}

/** Displays de l’organisation avec site et groupes, pour la résolution des cibles. */
export async function displayFacts(tx: Transaction): Promise<(DisplayFacts & { name: string })[]> {
  const displays = await tx
    .select({
      id: schema.displays.id,
      name: schema.displays.name,
      siteId: schema.displays.siteId,
    })
    .from(schema.displays)
    .where(isNull(schema.displays.deletedAt))
    .orderBy(schema.displays.name, schema.displays.id);
  const members = await tx
    .select({
      displayId: schema.displayGroupMembers.displayId,
      groupId: schema.displayGroupMembers.groupId,
    })
    .from(schema.displayGroupMembers);
  const groups = new Map<string, string[]>();
  for (const member of members) {
    groups.set(member.displayId, [...(groups.get(member.displayId) ?? []), member.groupId]);
  }
  return displays.map((display) => ({
    id: display.id,
    name: display.name,
    site_id: display.siteId,
    group_ids: groups.get(display.id) ?? [],
  }));
}

/**
 * Contrôle des cibles d’un programme (PLN-006) : chaque cible existe dans le tenant et,
 * pour un programme de site, appartient à ce site. Retourne les Displays résolus.
 */
export async function checkTargets(
  tx: Transaction,
  targeting: Targeting,
  siteId: string | null,
): Promise<{ issues: GraphIssue[]; displays: { id: string; name: string }[] }> {
  const issues: GraphIssue[] = [];
  const facts = await displayFacts(tx);
  const all = [...targeting.include, ...targeting.exclude];
  const ids = (type: 'site' | 'group' | 'display') =>
    all.flatMap((t) => (t.type === type ? [t.id] : []));
  const sites = ids('site').length
    ? await tx
        .select({ id: schema.sites.id })
        .from(schema.sites)
        .where(and(inArray(schema.sites.id, ids('site')), isNull(schema.sites.deletedAt)))
    : [];
  const groups = ids('group').length
    ? await tx
        .select({ id: schema.displayGroups.id })
        .from(schema.displayGroups)
        .where(inArray(schema.displayGroups.id, ids('group')))
    : [];
  for (const target of all) {
    const issue = (code: string, message: string) =>
      issues.push({
        severity: 'error',
        code,
        ref: `${target.type}:${'id' in target ? target.id : ''}`,
        message,
      });
    if (target.type === 'site') {
      if (!sites.some((s) => s.id === target.id)) issue('TARGET_NOT_FOUND', 'Site introuvable.');
      else if (siteId !== null && target.id !== siteId) {
        issue('TARGET_OUT_OF_SCOPE', 'Ce site est hors du périmètre du programme.');
      }
    } else if (target.type === 'group') {
      if (!groups.some((g) => g.id === target.id)) issue('TARGET_NOT_FOUND', 'Groupe introuvable.');
    } else if (target.type === 'display') {
      const display = facts.find((d) => d.id === target.id);
      if (!display) issue('TARGET_NOT_FOUND', 'Display introuvable.');
      else if (siteId !== null && display.site_id !== siteId) {
        issue('TARGET_OUT_OF_SCOPE', `« ${display.name} » est hors du périmètre du programme.`);
      }
    }
  }
  const displays = resolveTargets(targeting, facts, siteId).map((d) => ({
    id: d.id,
    name: (d as DisplayFacts & { name: string }).name,
  }));
  return { issues, displays };
}
