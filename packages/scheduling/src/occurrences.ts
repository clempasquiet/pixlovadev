/**
 * Génération des occurrences d’une fenêtre de compilation (PROTO-018 étape 3).
 *
 * Changements d’heure (PLN-004, ADR-011) :
 * - un début dont l’heure locale n’existe pas omet l’occurrence ;
 * - une heure répétée retient sa première occurrence (début comme fin) ;
 * - une fin dont l’heure locale n’existe pas devient le premier instant existant après
 *   le saut ;
 * - chaque occurrence logique (règle, date locale de début) est produite une seule fois.
 */
import {
  DAY,
  formatLocalDate,
  isoWeekday,
  localDateOf,
  parseLocalDate,
  parseLocalTime,
  resolveLocal,
} from './time.js';
import type { Occurrence, ProgramSource, ScheduleSource } from './types.js';

function localStart(days: number, minutes: number, timezone: string): number | null {
  const resolved = resolveLocal(days, minutes, timezone);
  if (resolved.kind === 'skipped') return null;
  return resolved.kind === 'exact' ? resolved.instant : resolved.first;
}

function localEnd(days: number, minutes: number, timezone: string): number {
  const resolved = resolveLocal(days, minutes, timezone);
  if (resolved.kind === 'skipped') return resolved.next;
  return resolved.kind === 'exact' ? resolved.instant : resolved.first;
}

export class InvalidRuleError extends Error {
  constructor(
    readonly ruleId: string,
    detail: string,
  ) {
    super(`Règle ${ruleId} invalide : ${detail}`);
    this.name = 'InvalidRuleError';
  }
}

function expandSchedule(
  source: ScheduleSource,
  displayTimezone: string,
  from: number,
  until: number,
): Occurrence[] {
  const timezone = source.timezone ?? displayTimezone;
  const occurrences: Occurrence[] = [];
  // Une occurrence commencée la veille peut traverser le début de fenêtre.
  const firstDay = localDateOf(from, timezone) - 1;
  const lastDay = localDateOf(until, timezone);
  const exceptions = new Map<string, (typeof source.exceptions)[number]>();
  for (const exception of source.exceptions) {
    exceptions.set(`${exception.date}|${exception.rule_id ?? '*'}`, exception);
  }
  for (const rule of source.rules) {
    const startMinutes = parseLocalTime(rule.start_time);
    const endMinutes = parseLocalTime(rule.end_time);
    if (startMinutes === null || startMinutes === 24 * 60) {
      throw new InvalidRuleError(rule.id, 'heure de début');
    }
    if (endMinutes === null) throw new InvalidRuleError(rule.id, 'heure de fin');
    if (rule.weekdays.length === 0) throw new InvalidRuleError(rule.id, 'aucun jour');
    const startDate = rule.start_date === null ? null : parseLocalDate(rule.start_date);
    const endDate = rule.end_date === null ? null : parseLocalDate(rule.end_date);
    if (rule.start_date !== null && startDate === null) {
      throw new InvalidRuleError(rule.id, 'date de début');
    }
    if (rule.end_date !== null && endDate === null) {
      throw new InvalidRuleError(rule.id, 'date de fin');
    }
    const crossesMidnight = endMinutes <= startMinutes;
    for (let day = firstDay; day <= lastDay; day++) {
      if (startDate !== null && day < startDate) continue;
      if (endDate !== null && day > endDate) continue;
      if (!rule.weekdays.includes(isoWeekday(day))) continue;
      const date = formatLocalDate(day);
      const exception = exceptions.get(`${date}|${rule.id}`) ?? exceptions.get(`${date}|*`) ?? null;
      if (exception?.action === 'skip') continue;
      const start = localStart(day, startMinutes, timezone);
      if (start === null) continue;
      const end = localEnd(crossesMidnight ? day + 1 : day, endMinutes, timezone);
      if (end <= start || end <= from || start >= until) continue;
      occurrences.push({
        kind: 'schedule',
        program_id: source.program_id,
        version: source.version,
        rule_id: rule.id,
        priority: rule.priority,
        start,
        end,
        content:
          exception?.action === 'replace' && exception.content ? exception.content : rule.content,
        exception_id: exception?.id ?? null,
        local: { date, start_time: rule.start_time, end_time: rule.end_time, timezone },
      });
    }
  }
  return occurrences;
}

/** Occurrences des sources touchant `[from, until)`, débuts d’origine conservés. */
export function expandSources(
  sources: readonly ProgramSource[],
  displayTimezone: string,
  from: number,
  until: number,
): Occurrence[] {
  if (!(from < until)) throw new RangeError('Fenêtre de compilation vide.');
  if (until - from > 400 * DAY) throw new RangeError('Fenêtre de compilation trop longue.');
  const occurrences: Occurrence[] = [];
  for (const source of sources) {
    if (source.kind === 'schedule') {
      occurrences.push(...expandSchedule(source, displayTimezone, from, until));
    } else if (
      source.starts_at < until &&
      source.ends_at > from &&
      source.starts_at < source.ends_at
    ) {
      occurrences.push({
        kind: source.kind,
        program_id: source.program_id,
        version: source.version,
        rule_id: source.program_id,
        priority: source.priority,
        start: source.starts_at,
        end: source.ends_at,
        content: source.content,
        exception_id: null,
        local: null,
      });
    }
  }
  return occurrences;
}
