/**
 * Décisions temporelles de la page, sans DOM : quelle sélection afficher et quand la
 * réévaluer. La sélection elle-même est celle du moteur partagé (`selectAt`).
 */
import type { ManifestPayload } from '@pixlova/contracts';
import { selectAt, type Selection } from '@pixlova/render-engine';
import type { Playback } from './bridge.js';

/** Réévaluation au plus tard toutes les 30 s (sauts d’horloge, reprise après veille). */
export const MAX_WAIT_MS = 30_000;

export function selectionKey(selection: Selection): string {
  switch (selection.kind) {
    case 'timeline':
      return `timeline:${selection.contentRef}:${selection.startsAt}`;
    case 'fallback':
      return `fallback:${selection.contentRef}`;
    case 'standby':
      return 'standby';
  }
}

export function playbackOf(selection: Selection): Playback {
  return selection.kind === 'timeline'
    ? 'playing'
    : selection.kind === 'fallback'
      ? 'fallback'
      : 'standby';
}

/** Délai avant le prochain changement de sélection, borné. */
export function nextWakeMs(selection: Selection, nowMicros: number): number {
  const until =
    selection.kind === 'timeline'
      ? selection.endsAt
      : (selection.until ?? Number.POSITIVE_INFINITY);
  const wait = Math.ceil((until - nowMicros) / 1000);
  return Math.max(0, Math.min(MAX_WAIT_MS, wait));
}

export function selectNow(manifest: ManifestPayload, nowMillis: number): Selection {
  return selectAt(manifest, nowMillis * 1000);
}

/** Assets qu’un manifest utilise réellement (préparation, NAT-008 étape 6). */
export function referencedAssets(manifest: ManifestPayload): Set<string> {
  const ids = new Set<string>();
  for (const content of manifest.contents) {
    if (content.type === 'media') ids.add(content.asset_id);
    if (content.type === 'composition') {
      for (const element of content.document.elements) {
        if (element.type === 'image' || element.type === 'video') ids.add(element.props.asset_id);
      }
    }
  }
  return ids;
}
