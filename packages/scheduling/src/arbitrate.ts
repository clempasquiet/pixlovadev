/**
 * Arbitrage unique des sources (PLN-008, PROTO-018 étapes 4 et 6), partagé par la
 * compilation des manifests et la simulation du dashboard.
 *
 * Sur chaque segment élémentaire, les occurrences actives sont classées par priorité
 * décroissante, puis début d’occurrence le plus récent, puis identifiant de règle en ordre
 * lexical croissant. La première dont le contenu est jouable gagne ; une règle dont tous
 * les éléments sont inéligibles cède la place au niveau inférieur, puis au fallback.
 */
import type {
  Candidate,
  ContentCatalog,
  MaskReason,
  Occurrence,
  Segment,
  TimelineSlot,
} from './types.js';

export function compareOccurrences(a: Occurrence, b: Occurrence): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.start !== b.start) return b.start - a.start;
  return a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0;
}

function maskReason(winner: Occurrence, other: Occurrence): MaskReason {
  if (winner.priority !== other.priority) return 'lower_priority';
  if (winner.start !== other.start) return 'older_start';
  return 'identifier_order';
}

function contentKey(occurrence: Occurrence): string {
  return `${occurrence.content.type}:${occurrence.content.id}`;
}

/** Segments élémentaires couvrant exactement `[from, until)`. */
export function arbitrate(
  occurrences: readonly Occurrence[],
  catalog: ContentCatalog,
  from: number,
  until: number,
): Segment[] {
  const edges = new Set<number>([from, until]);
  const contents = new Map<string, Occurrence['content']>();
  for (const occurrence of occurrences) {
    if (occurrence.start > from && occurrence.start < until) edges.add(occurrence.start);
    if (occurrence.end > from && occurrence.end < until) edges.add(occurrence.end);
    contents.set(contentKey(occurrence), occurrence.content);
  }
  for (const content of contents.values()) {
    for (const edge of catalog.boundaries(content, from, until)) {
      if (edge > from && edge < until) edges.add(edge);
    }
  }
  const sortedEdges = [...edges].sort((a, b) => a - b);
  const ordered = [...occurrences].sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  for (let i = 0; i + 1 < sortedEdges.length; i++) {
    const start = sortedEdges[i]!;
    const end = sortedEdges[i + 1]!;
    const active: Occurrence[] = [];
    for (const occurrence of ordered) {
      if (occurrence.start > start) break;
      if (occurrence.end > start) active.push(occurrence);
    }
    active.sort(compareOccurrences);
    let winner: Candidate | null = null;
    const masked: Segment['masked'] = [];
    const variants = new Map<string, string | null>();
    for (const occurrence of active) {
      if (winner) {
        masked.push({ occurrence, reason: maskReason(winner.occurrence, occurrence) });
        continue;
      }
      const key = contentKey(occurrence);
      if (!variants.has(key)) variants.set(key, catalog.variantAt(occurrence.content, start));
      const variant = variants.get(key)!;
      if (variant === null) masked.push({ occurrence, reason: 'content_unavailable' });
      else winner = { occurrence, variant };
    }
    segments.push({ start, end, winner, masked });
  }
  return segments;
}

/**
 * Timeline non chevauchante : les segments contigus de même contenu et même source
 * (programme, version, priorité, règle) sont fusionnés ; un changement de source ou de
 * variante ouvre une nouvelle entrée (redémarrage de playlist, PLN-002). Les trous
 * correspondent au fallback.
 */
export function toTimeline(segments: readonly Segment[]): TimelineSlot[] {
  const slots: TimelineSlot[] = [];
  for (const segment of segments) {
    if (!segment.winner) continue;
    const { occurrence, variant } = segment.winner;
    const previous = slots.at(-1);
    if (
      previous &&
      previous.end === segment.start &&
      previous.variant === variant &&
      previous.kind === occurrence.kind &&
      previous.program_id === occurrence.program_id &&
      previous.version === occurrence.version &&
      previous.priority === occurrence.priority &&
      previous.rule_id === occurrence.rule_id
    ) {
      previous.end = segment.end;
      continue;
    }
    slots.push({
      start: segment.start,
      end: segment.end,
      variant: variant!,
      kind: occurrence.kind,
      program_id: occurrence.program_id,
      version: occurrence.version,
      priority: occurrence.priority,
      rule_id: occurrence.rule_id,
    });
  }
  return slots;
}

/** Gagnant à un instant, pour la question « pourquoi ce contenu ? » (PLN-005). */
export function explainAt(segments: readonly Segment[], t: number): Segment | null {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const segment = segments[middle]!;
    if (t < segment.start) high = middle - 1;
    else if (t >= segment.end) low = middle + 1;
    else return segment;
  }
  return null;
}
