/**
 * Sélection du contenu à diffuser à un instant donné à partir d’un manifest déjà vérifié
 * (NAT-011, PLN-010, PLN-013). Le Player n’interprète pas les règles métier : il exécute
 * les intervalles UTC compilés, puis le fallback après `schedule_until`.
 */
import { parseInstantMicros, type ManifestPayload, type TimelineEntry } from '@pixlova/contracts';

export type Selection =
  | { kind: 'timeline'; entry: TimelineEntry; contentRef: string; startsAt: number; endsAt: number }
  | { kind: 'fallback'; contentRef: string; until: number | null }
  | { kind: 'standby'; until: number | null };

function micros(value: string): number {
  const parsed = parseInstantMicros(value);
  if (parsed === null) throw new Error(`Instant invalide dans un manifest vérifié : ${value}`);
  return parsed;
}

/**
 * Retourne la sélection active à `nowMicros` et l’instant du prochain changement.
 * Intervalles semi-ouverts `[début, fin)` ; recherche dichotomique sur une timeline triée.
 */
export function selectAt(manifest: ManifestPayload, nowMicros: number): Selection {
  const timeline = manifest.timeline;
  let low = 0;
  let high = timeline.length - 1;
  let nextStart: number | null = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const entry = timeline[middle]!;
    const start = micros(entry.starts_at);
    const end = micros(entry.ends_at);
    if (nowMicros < start) {
      nextStart = start;
      high = middle - 1;
    } else if (nowMicros >= end) {
      low = middle + 1;
    } else {
      return {
        kind: 'timeline',
        entry,
        contentRef: entry.content_ref,
        startsAt: start,
        endsAt: end,
      };
    }
  }
  const until = micros(manifest.schedule_until);
  const validFrom = micros(manifest.valid_from);
  // Trou dans la fenêtre, ou après la fin d’horizon avec politique de fallback.
  const inWindow = nowMicros >= validFrom && nowMicros < until;
  const fallbackAllowed = inWindow || manifest.fallback.after_schedule === 'play_fallback';
  const nextChange = inWindow ? (nextStart ?? until) : null;
  if (manifest.fallback.content_ref !== null && fallbackAllowed) {
    return { kind: 'fallback', contentRef: manifest.fallback.content_ref, until: nextChange };
  }
  return { kind: 'standby', until: nextChange };
}

export interface PlaylistPosition {
  index: number;
  /** Décalage dans l’élément courant, en millisecondes. */
  offsetMs: number;
  /** Temps restant avant l’élément suivant, en millisecondes. */
  remainingMs: number;
}

/**
 * Position dans une playlist bouclée, démarrée au début de la sélection (PLN-002 :
 * redémarrage au premier élément à chaque changement de source). Déterministe :
 * deux Players partageant l’instant de début calculent la même position.
 */
export function playlistPosition(
  durationsMs: readonly number[],
  elapsedMs: number,
): PlaylistPosition {
  const total = durationsMs.reduce((sum, value) => sum + value, 0);
  if (durationsMs.length === 0 || total <= 0) throw new Error('Playlist vide ou sans durée.');
  let offset = ((elapsedMs % total) + total) % total;
  for (let index = 0; index < durationsMs.length; index++) {
    const duration = durationsMs[index]!;
    if (offset < duration) return { index, offsetMs: offset, remainingMs: duration - offset };
    offset -= duration;
  }
  // Inatteignable : offset < total.
  return { index: 0, offsetMs: 0, remainingMs: durationsMs[0]! };
}
