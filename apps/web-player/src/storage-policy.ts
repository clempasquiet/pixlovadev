/**
 * Politique de stockage du Player Web (ADR-013, PLY-007), sans API navigateur pour être
 * testée isolément : les assets épinglés (manifests courant, précédent et candidat) ne
 * sont jamais évincés ; les autres le sont du plus ancien usage au plus récent.
 */

/** Marge laissée libre sur le quota annoncé par le navigateur [à valider]. */
export const QUOTA_MARGIN_RATIO = 0.1;

export interface BlobEntry {
  sha256: string;
  size: number;
  lastUsed: number;
}

export interface StorageEstimateLike {
  quota?: number;
  usage?: number;
}

/** Octets encore utilisables, marge déduite ; `null` si le navigateur ne le dit pas. */
export function usableBytes(estimate: StorageEstimateLike | null): number | null {
  if (!estimate || estimate.quota === undefined || estimate.usage === undefined) return null;
  const limit = estimate.quota * (1 - QUOTA_MARGIN_RATIO);
  return Math.max(0, Math.floor(limit - estimate.usage));
}

export interface EvictionPlan {
  evict: string[];
  /** Vrai si l’espace sera suffisant après éviction. */
  enough: boolean;
}

export function planEviction(
  entries: readonly BlobEntry[],
  pinned: ReadonlySet<string>,
  needed: number,
  usable: number | null,
): EvictionPlan {
  // Quota inconnu : on tente l’écriture, une QuotaExceededError reste traitée.
  if (usable === null || usable >= needed) return { evict: [], enough: true };
  let free = usable;
  const evict: string[] = [];
  const candidates = entries
    .filter((entry) => !pinned.has(entry.sha256))
    .sort((a, b) => a.lastUsed - b.lastUsed || a.sha256.localeCompare(b.sha256));
  for (const entry of candidates) {
    if (free >= needed) break;
    evict.push(entry.sha256);
    free += entry.size;
  }
  return { evict, enough: free >= needed };
}
