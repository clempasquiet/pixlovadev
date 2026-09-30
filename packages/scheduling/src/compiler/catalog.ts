/**
 * Résolution des contenus publiés vers les contenus du manifest (PROTO-016, ADR-011).
 *
 * Un contenu est « matérialisé » à un instant : éléments de playlist éligibles, zones
 * playlist résolues, variantes d’assets retenues selon les capacités du Player. Son
 * identifiant local dérive de l’empreinte de sa forme : un contenu identique garde le même
 * identifiant d’une compilation à l’autre et deux formes différentes ne se confondent pas.
 */
import {
  canonicalSha256,
  resolveCompositionDocument,
  UnresolvedMediaError,
  type ContentRef,
  type ManifestAsset,
  type ManifestContent,
  type PlayerCapabilities,
} from '@pixlova/contracts';
import type { ContentCatalog } from '../types.js';
import type { AssetEntry, CompileIssue, DisplaySnapshot, MediaEntry } from './types.js';

/** Durée indicative d’un média fixe ou d’une composition programmés directement [à valider]. */
export const DEFAULT_STILL_DURATION_MS = 10_000;
/** Profondeur maximale d’imbrication playlist ↔ composition [à valider]. */
export const MAX_CONTENT_DEPTH = 4;
/** Profil vidéo produit par le pipeline média (ADR-009). */
export const VIDEO_PROFILE = 'mp4-h264-aac';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Body = DistributiveOmit<ManifestContent, 'id'>;

const PREFIX: Record<ManifestContent['type'], string> = {
  media: 'm',
  composition: 'c',
  playlist: 'p',
};

function ms(value: string | null): number | null {
  return value === null ? null : Date.parse(value);
}

export class ContentResolver implements ContentCatalog {
  /** Contenus matérialisés, par identifiant local. */
  readonly contents = new Map<string, ManifestContent>();
  /** Assets retenus, par identifiant. */
  readonly assets = new Map<string, ManifestAsset>();
  private readonly contentAssets = new Map<string, string[]>();
  private readonly issues = new Map<string, CompileIssue>();
  private readonly memo = new Map<string, string | null>();

  constructor(
    private readonly snapshot: DisplaySnapshot,
    private readonly capabilities: PlayerCapabilities | null,
  ) {}

  issueList(): CompileIssue[] {
    return [...this.issues.values()];
  }

  private issue(issue: CompileIssue): void {
    this.issues.set(`${issue.code}|${issue.ref ?? ''}`, issue);
  }

  /** Instants où la forme jouable d’un contenu change (validités des éléments). */
  boundaries(ref: ContentRef, from: number, until: number): number[] {
    const edges = new Set<number>();
    const visited = new Set<string>();
    const visit = (current: ContentRef) => {
      const key = `${current.type}:${current.id}`;
      if (visited.has(key)) return;
      visited.add(key);
      if (current.type === 'playlist') {
        const playlist = this.snapshot.playlists[current.id];
        for (const item of playlist?.document.items ?? []) {
          for (const edge of [ms(item.valid_from), ms(item.valid_until)]) {
            if (edge !== null && edge > from && edge < until) edges.add(edge);
          }
          visit(item.content);
        }
      } else if (current.type === 'composition') {
        const composition = this.snapshot.compositions[current.id];
        for (const element of composition?.document.elements ?? []) {
          if (element.type === 'playlist_zone' && element.props.playlist_id) {
            visit({ type: 'playlist', id: element.props.playlist_id });
          }
        }
      }
    };
    visit(ref);
    return [...edges];
  }

  variantAt(ref: ContentRef, t: number): string | null {
    return this.materialize(ref, t, false, []);
  }

  /** Contenu de repli : seuls les éléments sans fin de validité et déjà commencés (PLN-010). */
  fallback(ref: ContentRef, t: number): string | null {
    return this.materialize(ref, t, true, []);
  }

  /** Assets atteignables depuis des contenus racines. */
  reachable(roots: readonly string[]): { contents: ManifestContent[]; assets: ManifestAsset[] } {
    const contentIds = new Set<string>();
    const assetIds = new Set<string>();
    const stack = [...roots];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (contentIds.has(id)) continue;
      contentIds.add(id);
      for (const asset of this.contentAssets.get(id) ?? []) assetIds.add(asset);
      const content = this.contents.get(id)!;
      if (content.type === 'playlist') stack.push(...content.items.map((i) => i.content_ref));
      if (content.type === 'composition') {
        for (const element of content.document.elements) {
          if (element.type === 'playlist_zone' || element.type === 'media_zone') {
            stack.push(element.props.content_ref);
          }
        }
      }
    }
    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
    return {
      contents: [...contentIds].map((id) => this.contents.get(id)!).sort(byId),
      assets: [...assetIds].map((id) => this.assets.get(id)!).sort(byId),
    };
  }

  private register(body: Body, assets: string[]): string {
    const id = `${PREFIX[body.type]}-${canonicalSha256(body).slice(0, 32)}`;
    if (!this.contents.has(id)) {
      this.contents.set(id, { id, ...body } as ManifestContent);
      this.contentAssets.set(id, assets);
    }
    return id;
  }

  private addAsset(entry: AssetEntry): string {
    this.assets.set(entry.id, {
      id: entry.id,
      variant: entry.variant,
      mime_type: entry.mime_type,
      size_bytes: entry.size_bytes,
      sha256: entry.sha256,
    });
    return entry.id;
  }

  /** Variante lisible par le Player (PROTO-017) ; `null` et anomalie bloquante sinon. */
  chooseAsset(media: MediaEntry): AssetEntry | null {
    if (media.type === 'video') {
      if (!media.playback) {
        this.issue({
          severity: 'warning',
          code: 'CONTENT_UNAVAILABLE',
          ref: `media:${media.id}`,
          message: 'Vidéo sans variante de lecture.',
        });
        return null;
      }
      if (this.capabilities && !this.capabilities.video_profiles.includes(VIDEO_PROFILE)) {
        this.issue({
          severity: 'error',
          code: 'UNSUPPORTED_VIDEO_PROFILE',
          ref: `media:${media.id}`,
          message: `Le Player n’annonce pas le profil vidéo ${VIDEO_PROFILE}.`,
        });
        return null;
      }
      return media.playback;
    }
    const candidates = [media.playback, media.original].filter((a): a is AssetEntry => !!a);
    if (!this.capabilities) return candidates[0] ?? null;
    const supported = candidates.find((asset) =>
      this.capabilities!.image_types.includes(asset.mime_type),
    );
    if (!supported) {
      this.issue({
        severity: 'error',
        code: 'UNSUPPORTED_IMAGE_TYPE',
        ref: `media:${media.id}`,
        message: `Aucune variante de l’image n’est d’un type annoncé par le Player (${candidates.map((a) => a.mime_type).join(', ')}).`,
      });
      return null;
    }
    return supported;
  }

  private unavailable(ref: ContentRef, message: string): null {
    this.issue({
      severity: 'warning',
      code: 'CONTENT_UNAVAILABLE',
      ref: `${ref.type}:${ref.id}`,
      message,
    });
    return null;
  }

  private materialize(
    ref: ContentRef,
    t: number,
    permanent: boolean,
    stack: readonly string[],
  ): string | null {
    const key = `${ref.type}:${ref.id}`;
    if (stack.includes(key)) {
      this.issue({
        severity: 'error',
        code: 'CONTENT_CYCLE',
        ref: key,
        message: `Cycle de contenus : ${[...stack, key].join(' → ')}.`,
      });
      return null;
    }
    if (stack.length >= MAX_CONTENT_DEPTH) {
      this.issue({
        severity: 'error',
        code: 'DEPTH_EXCEEDED',
        ref: key,
        message: `Imbrication supérieure à ${MAX_CONTENT_DEPTH} niveaux.`,
      });
      return null;
    }
    const memoKey = `${key}|${t}|${permanent}|${stack.length}`;
    if (this.memo.has(memoKey)) return this.memo.get(memoKey)!;
    const result = this.compute(ref, t, permanent, [...stack, key]);
    this.memo.set(memoKey, result);
    return result;
  }

  private compute(
    ref: ContentRef,
    t: number,
    permanent: boolean,
    stack: readonly string[],
  ): string | null {
    switch (ref.type) {
      case 'media': {
        const media = this.snapshot.media[ref.id];
        if (!media) return this.unavailable(ref, 'Média absent, en corbeille ou non prêt.');
        const asset = this.chooseAsset(media);
        if (!asset) return null;
        const duration =
          media.type === 'video'
            ? (asset.duration_ms ?? media.duration_ms ?? DEFAULT_STILL_DURATION_MS)
            : DEFAULT_STILL_DURATION_MS;
        return this.register(
          {
            type: 'media',
            media_kind: media.type,
            asset_id: this.addAsset(asset),
            duration_ms: Math.max(1, Math.min(duration, 86_400_000)),
            fit: 'contain',
            muted: true,
          },
          [asset.id],
        );
      }
      case 'composition': {
        const composition = this.snapshot.compositions[ref.id];
        if (!composition) return this.unavailable(ref, 'Composition non publiée ou supprimée.');
        const assets: string[] = [];
        try {
          const document = resolveCompositionDocument(
            composition.document,
            (mediaId) => {
              const media = this.snapshot.media[mediaId];
              const asset = media ? this.chooseAsset(media) : null;
              if (!media || !asset) return null;
              assets.push(this.addAsset(asset));
              return { asset_id: asset.id, kind: media.type };
            },
            {
              missing: 'error',
              resolvePlaylist: (playlistId) => {
                const child = this.materialize(
                  { type: 'playlist', id: playlistId },
                  t,
                  permanent,
                  stack,
                );
                return child ? { content_ref: child } : 'omit';
              },
            },
          );
          return this.register(
            {
              type: 'composition',
              composition_version_id: composition.version_id,
              duration_ms: composition.document.settings.duration_ms ?? DEFAULT_STILL_DURATION_MS,
              document,
            },
            assets,
          );
        } catch (error) {
          if (error instanceof UnresolvedMediaError) {
            return this.unavailable(ref, 'Un média de la composition est indisponible.');
          }
          throw error;
        }
      }
      case 'playlist': {
        const playlist = this.snapshot.playlists[ref.id];
        if (!playlist) return this.unavailable(ref, 'Playlist non publiée ou supprimée.');
        const items: { content_ref: string; duration_ms: number }[] = [];
        for (const item of playlist.document.items) {
          if (!item.enabled) continue;
          const from = ms(item.valid_from);
          const until = ms(item.valid_until);
          if (from !== null && t < from) continue;
          if (permanent ? until !== null : until !== null && t >= until) continue;
          const child = this.materialize(item.content, t, permanent, stack);
          if (!child) continue;
          const content = this.contents.get(child)!;
          const duration =
            item.duration_ms ??
            (content.type === 'media' && content.media_kind === 'video'
              ? content.duration_ms
              : content.type === 'composition' &&
                  this.snapshot.compositions[item.content.id]?.document.settings.duration_ms
                ? content.duration_ms
                : null);
          if (duration === null) {
            this.issue({
              severity: 'warning',
              code: 'DURATION_MISSING',
              ref: `playlist:${ref.id}`,
              message: `Élément ${item.id} sans durée : ignoré.`,
            });
            continue;
          }
          items.push({ content_ref: child, duration_ms: duration });
        }
        if (items.length === 0) return null;
        return this.register(
          {
            type: 'playlist',
            playlist_version_id: playlist.version_id,
            transition: playlist.document.transition,
            items,
          },
          [],
        );
      }
    }
  }
}
