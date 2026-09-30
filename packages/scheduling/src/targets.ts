/**
 * Résolution des cibles (PLN-006, PLN-007) : les exclusions priment sur les inclusions ;
 * un Display membre de plusieurs groupes ciblés n’est retenu qu’une fois ; le périmètre de
 * site d’un programme borne toujours la résolution, même pour « organisation entière ».
 */

export type Target =
  | { type: 'organization' }
  | { type: 'site'; id: string }
  | { type: 'group'; id: string }
  | { type: 'display'; id: string };

export interface Targeting {
  include: readonly Target[];
  exclude: readonly Target[];
}

export interface DisplayFacts {
  id: string;
  site_id: string;
  group_ids: readonly string[];
}

function matches(target: Target, display: DisplayFacts): boolean {
  switch (target.type) {
    case 'organization':
      return true;
    case 'site':
      return display.site_id === target.id;
    case 'group':
      return display.group_ids.includes(target.id);
    case 'display':
      return display.id === target.id;
  }
}

/** Le programme vise-t-il ce Display ? `scopeSiteId` : site du programme, s’il en a un. */
export function targetsDisplay(
  targeting: Targeting,
  display: DisplayFacts,
  scopeSiteId: string | null,
): boolean {
  if (scopeSiteId !== null && display.site_id !== scopeSiteId) return false;
  if (targeting.exclude.some((target) => matches(target, display))) return false;
  return targeting.include.some((target) => matches(target, display));
}

/** Displays visés, sans doublon, dans l’ordre des entrées. */
export function resolveTargets(
  targeting: Targeting,
  displays: readonly DisplayFacts[],
  scopeSiteId: string | null,
): DisplayFacts[] {
  const seen = new Set<string>();
  return displays.filter((display) => {
    if (seen.has(display.id) || !targetsDisplay(targeting, display, scopeSiteId)) return false;
    seen.add(display.id);
    return true;
  });
}
