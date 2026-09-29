/**
 * Dates et heures locales d’un fuseau IANA (PLN-003, PLN-004). Les instants sont des
 * millisecondes depuis l’époque Unix ; les dates locales des jours depuis l’époque
 * (1970-01-01 = 0). Seule la base tz de `Intl` est utilisée : aucune règle de fuseau
 * n’est codée ici.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$|^24:00$/;

export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month, day };
}

/** `YYYY-MM-DD` → jours depuis l’époque ; `null` si la date n’existe pas. */
export function parseLocalDate(text: string): number | null {
  const match = DATE.exec(text);
  if (!match) return null;
  const [year, month, day] = match.slice(1, 4).map(Number) as [number, number, number];
  if (month < 1 || month > 12 || day < 1) return null;
  const days = daysFromCivil(year, month, day);
  const back = civilFromDays(days);
  return back.month === month && back.day === day ? days : null;
}

export function formatLocalDate(days: number): string {
  const { year, month, day } = civilFromDays(days);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** `HH:MM` (ou `24:00`) → minutes depuis minuit ; `null` si invalide. */
export function parseLocalTime(text: string): number | null {
  if (!TIME.test(text)) return null;
  return Number(text.slice(0, 2)) * 60 + Number(text.slice(3, 5));
}

/** Jour ISO de la semaine : 1 = lundi … 7 = dimanche. */
export function isoWeekday(days: number): number {
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timezone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      era: 'short',
    });
    formatters.set(timezone, cached);
  }
  return cached;
}

/** Fuseau reconnu par la base tz embarquée (validation avant publication). */
export function isValidTimezone(timezone: string): boolean {
  if (timezone.length === 0 || timezone.length > 64) return false;
  try {
    formatter(timezone);
    return true;
  } catch {
    return false;
  }
}

/** Décalage (ms) de l’heure murale sur UTC à l’instant donné. */
export function offsetAt(instant: number, timezone: string): number {
  const seconds = Math.floor(instant / 1000) * 1000;
  const parts: Record<string, string> = {};
  for (const part of formatter(timezone).formatToParts(new Date(seconds))) {
    parts[part.type] = part.value;
  }
  let year = Number(parts.year);
  if (parts.era === 'BC' || parts.era === 'B') year = 1 - year;
  const wall =
    daysFromCivil(year, Number(parts.month), Number(parts.day)) * DAY +
    Number(parts.hour) * HOUR +
    Number(parts.minute) * MINUTE +
    Number(parts.second) * 1000;
  return wall - seconds;
}

/** Date locale (jours depuis l’époque) d’un instant dans le fuseau. */
export function localDateOf(instant: number, timezone: string): number {
  return Math.floor((instant + offsetAt(instant, timezone)) / DAY);
}

export type LocalResolution =
  | { kind: 'exact'; instant: number }
  /** Heure répétée (retour à l’heure d’hiver) : deux instants, dans l’ordre. */
  | { kind: 'repeated'; first: number; second: number }
  /** Heure absente (passage à l’heure d’été) : `next` est le premier instant existant après. */
  | { kind: 'skipped'; next: number };

/**
 * Instants UTC correspondant à une heure murale locale. On suppose au plus un changement
 * de décalage par période de 48 h, ce qui vaut pour la base tz actuelle.
 */
export function resolveLocal(days: number, minutes: number, timezone: string): LocalResolution {
  const wall = days * DAY + minutes * MINUTE;
  const before = offsetAt(wall - DAY, timezone);
  const after = offsetAt(wall + DAY, timezone);
  const candidates = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((instant) => instant + offsetAt(instant, timezone) === wall)
    .sort((a, b) => a - b);
  if (candidates.length === 1) return { kind: 'exact', instant: candidates[0]! };
  if (candidates.length === 2) {
    return { kind: 'repeated', first: candidates[0]!, second: candidates[1]! };
  }
  // Heure absente : recherche du changement de décalage à la minute près entre les deux
  // lectures possibles (les transitions de la base tz tombent sur des minutes entières).
  let low = Math.min(wall - before, wall - after);
  let high = Math.max(wall - before, wall - after);
  const lowOffset = offsetAt(low, timezone);
  while (high - low > MINUTE) {
    const middle = low + Math.floor((high - low) / MINUTE / 2) * MINUTE;
    if (offsetAt(middle, timezone) === lowOffset) low = middle;
    else high = middle;
  }
  return { kind: 'skipped', next: high };
}
