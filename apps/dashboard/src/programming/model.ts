/**
 * Fonctions pures de l’interface de programmation (ADR-011) : manipulation des éléments de
 * playlist, instants affichés dans un fuseau explicite et libellés. Testées sans DOM.
 */
import type { ContentRef, PlaylistItem, ScheduleRuleDocument, Target } from '@pixlova/contracts';

export function moveItem<T>(items: readonly T[], index: number, direction: -1 | 1): T[] {
  const target = index + direction;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) {
    return [...items];
  }
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/** Copie insérée juste après l’original, avec un nouvel identifiant. */
export function duplicateItem(
  items: readonly PlaylistItem[],
  index: number,
  id: string,
): PlaylistItem[] {
  const source = items[index];
  if (!source) return [...items];
  const next = [...items];
  next.splice(index + 1, 0, { ...structuredClone(source), id });
  return next;
}

export function removeAt<T>(items: readonly T[], index: number): T[] {
  return items.filter((_, i) => i !== index);
}

/** Durée d’un tour de playlist ; `null` si un élément actif n’a pas de durée connue. */
export function loopDurationMs(
  items: readonly PlaylistItem[],
  knownDurations: ReadonlyMap<string, number | null>,
): number | null {
  let total = 0;
  for (const item of items) {
    if (!item.enabled) continue;
    const duration =
      item.duration_ms ?? knownDurations.get(`${item.content.type}:${item.content.id}`) ?? null;
    if (duration === null) return null;
    total += duration;
  }
  return total;
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes} min ${String(rest).padStart(2, '0')} s` : `${rest} s`;
}

/** Instant affiché dans le fuseau donné, jamais dans celui du navigateur par défaut. */
export function formatInstantIn(iso: string, timezone: string, withDate = true): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: timezone,
    ...(withDate ? { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
}

/** Fuseau du navigateur, affiché à côté de toute saisie d’instant. */
export function browserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Valeur d’un champ `datetime-local` (heure du navigateur) → instant UTC à la seconde. */
export function localInputToInstant(value: string): string | null {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$/.test(value)) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.[0-9]{3}Z$/, 'Z');
}

/** Instant UTC → valeur de champ `datetime-local` dans l’heure du navigateur. */
export function instantToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const WEEKDAYS: readonly [number, string][] = [
  [1, 'Lun'],
  [2, 'Mar'],
  [3, 'Mer'],
  [4, 'Jeu'],
  [5, 'Ven'],
  [6, 'Sam'],
  [7, 'Dim'],
];

export function newRule(content: ContentRef, id: string): ScheduleRuleDocument {
  return {
    id,
    content,
    priority: 10,
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    start_time: '08:00',
    end_time: '20:00',
    start_date: null,
    end_date: null,
  };
}

/** Résumé lisible d’une règle : jours, heures, traversée de minuit. */
export function describeRule(rule: ScheduleRuleDocument): string {
  const days =
    rule.weekdays.length === 7
      ? 'Tous les jours'
      : WEEKDAYS.filter(([day]) => rule.weekdays.includes(day))
          .map(([, label]) => label)
          .join(', ');
  const crosses = rule.end_time !== '24:00' && rule.end_time <= rule.start_time;
  return `${days}, ${rule.start_time}–${rule.end_time}${crosses ? ' (lendemain)' : ''}`;
}

export const KIND_LABEL: Record<string, string> = {
  schedule: 'Planning',
  campaign: 'Campagne',
  override: 'Diffusion immédiate',
  emergency: 'Urgence',
};

export const MASK_LABEL: Record<string, string> = {
  lower_priority: 'priorité inférieure',
  older_start: 'même priorité, début plus ancien',
  identifier_order: 'même priorité et début, départage stable',
  content_unavailable: 'contenu indisponible sur cette période',
};

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Brouillon',
  published: 'Publié',
  scheduled: 'Programmée',
  active: 'En cours',
  ended: 'Terminée',
  cancelled: 'Arrêtée',
};

export const DELIVERY_LABEL: Record<string, string> = {
  desired: 'En attente du Player',
  received: 'Reçu par le Player',
  downloading: 'Téléchargement',
  ready: 'Préparé',
  applied: 'Appliqué',
  failed: 'Échec de préparation',
  superseded: 'Remplacé',
};

export const COMPILATION_LABEL: Record<string, string> = {
  published: 'Nouveau manifest',
  unchanged: 'Inchangé',
  superseded: 'Remplacé par une révision plus récente',
  rejected: 'Refusé au préflight',
  unassigned: 'Display non affecté',
};

export function targetKey(target: Target): string {
  return target.type === 'organization' ? 'organization' : `${target.type}:${target.id}`;
}
