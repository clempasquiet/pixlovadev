/**
 * Entrées normalisées du moteur. Les documents publiés (contrats partagés) sont convertis
 * vers ces formes par le compilateur ; les instants sont en millisecondes UTC.
 */

export type ContentType = 'media' | 'composition' | 'playlist';

export interface ContentRef {
  type: ContentType;
  id: string;
}

export type SourceKind = 'schedule' | 'campaign' | 'override' | 'emergency';

/** Règle récurrente d’un planning, en dates et heures locales (PLN-003). */
export interface ScheduleRule {
  id: string;
  content: ContentRef;
  priority: number;
  /** Jours ISO (1 = lundi … 7 = dimanche) du **début** de l’occurrence. */
  weekdays: readonly number[];
  /** `HH:MM`. */
  start_time: string;
  /** `HH:MM` ou `24:00` ; une fin inférieure ou égale au début traverse minuit. */
  end_time: string;
  /** Bornes incluses sur la date locale de début ; `null` : sans borne. */
  start_date: string | null;
  end_date: string | null;
}

/** Dérogation datée (date locale de début d’occurrence). */
export interface ScheduleException {
  id: string;
  date: string;
  /** `null` : toutes les règles du planning ; une exception ciblée prime. */
  rule_id: string | null;
  action: 'skip' | 'replace';
  content: ContentRef | null;
}

export interface ScheduleSource {
  kind: 'schedule';
  program_id: string;
  version: number;
  /** `null` : fuseau effectif du Display. */
  timezone: string | null;
  rules: readonly ScheduleRule[];
  exceptions: readonly ScheduleException[];
}

/** Campagne, override ou urgence : une fenêtre absolue `[starts_at, ends_at)`. */
export interface WindowSource {
  kind: 'campaign' | 'override' | 'emergency';
  program_id: string;
  version: number;
  priority: number;
  starts_at: number;
  ends_at: number;
  content: ContentRef;
}

export type ProgramSource = ScheduleSource | WindowSource;

/** Occurrence concrète d’une règle, intervalle semi-ouvert `[start, end)`. */
export interface Occurrence {
  kind: SourceKind;
  program_id: string;
  version: number;
  /** Identifiant départageant les égalités : règle d’un planning ou programme. */
  rule_id: string;
  priority: number;
  start: number;
  end: number;
  content: ContentRef;
  /** Exception appliquée (remplacement de contenu). */
  exception_id: string | null;
  /** Date et heures locales d’origine, pour l’explication. */
  local: { date: string; start_time: string; end_time: string; timezone: string } | null;
}

/**
 * Catalogue des contenus publiés vu par le moteur. Un contenu peut changer de forme au
 * cours du temps (éléments de playlist avec période de validité) ; `variantAt` rend une
 * clé déterministe de la forme jouable à l’instant `t`, ou `null` si rien n’est jouable.
 */
export interface ContentCatalog {
  boundaries(ref: ContentRef, from: number, until: number): readonly number[];
  variantAt(ref: ContentRef, t: number): string | null;
}

export type MaskReason =
  'lower_priority' | 'older_start' | 'identifier_order' | 'content_unavailable';

export interface Candidate {
  occurrence: Occurrence;
  /** Clé de variante retenue ; `null` : contenu injouable sur ce segment. */
  variant: string | null;
}

/** Segment élémentaire `[start, end)` : gagnant et règles masquées (PLN-005). */
export interface Segment {
  start: number;
  end: number;
  winner: Candidate | null;
  masked: { occurrence: Occurrence; reason: MaskReason }[];
}

/** Entrée de timeline compilée, fusionnée quand contenu et source sont identiques. */
export interface TimelineSlot {
  start: number;
  end: number;
  variant: string;
  kind: SourceKind;
  program_id: string;
  version: number;
  priority: number;
  rule_id: string;
}
