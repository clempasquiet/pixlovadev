import { useEffect, useState } from 'react';
import { api } from '../api.js';

/** Informations de bibliothèque d’un média référencé par une composition. */
export interface MediaInfo {
  id: string;
  name: string;
  type: 'image' | 'video';
  status: 'uploading' | 'processing' | 'ready' | 'error';
  width: number | null;
  height: number | null;
  duration_ms?: number | null;
  thumbnail_url: string | null;
  deleted_at: string | null;
  /** URL temporaire de la variante de diffusion (aperçu fidèle) ; absente si non prête. */
  playbackUrl?: string;
}

const cache = new Map<string, Promise<MediaInfo | null>>();

async function fetchMedia(id: string): Promise<MediaInfo | null> {
  try {
    const media = await api<MediaInfo>('GET', `/media/${id}`);
    if (media.status === 'ready') {
      const url = await api<{ url: string }>('GET', `/media/${id}/assets/playback/url`).catch(
        () => null,
      );
      if (url) media.playbackUrl = url.url;
    }
    return media;
  } catch {
    // Média supprimé, d’un autre périmètre ou introuvable : rendu en placeholder.
    return null;
  }
}

/** Oublie un média (après expiration des URLs d’aperçu ou changement d’état). */
export function forgetMedia(id?: string): void {
  if (id) cache.delete(id);
  else cache.clear();
}

export function rememberMedia(media: MediaInfo): void {
  cache.set(media.id, fetchMedia(media.id));
}

/** Charge les médias référencés ; rafraîchit les URLs d’aperçu avant leur expiration. */
export function useMediaInfo(ids: readonly string[]): Map<string, MediaInfo | null> {
  const [known, setKnown] = useState<Map<string, MediaInfo | null>>(new Map());
  const key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    const wanted = key ? key.split(',') : [];
    let cancelled = false;
    const load = () =>
      Promise.all(
        wanted.map(async (id) => {
          if (!cache.has(id)) cache.set(id, fetchMedia(id));
          return [id, await cache.get(id)!] as const;
        }),
      ).then((entries) => {
        if (!cancelled) setKnown(new Map(entries));
      });
    void load();
    // Les URLs d’aperçu expirent (5 min par défaut) : renouvellement préventif.
    const timer = setInterval(() => {
      wanted.forEach((id) => cache.delete(id));
      void load();
    }, 240_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key]);
  return known;
}
