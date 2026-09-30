/**
 * Conversion d’un instant RFC 3339 UTC (forme imposée par le schéma `Instant`)
 * en microsecondes depuis l’époque Unix. Implémentation identique en Rust :
 * aucune dépendance au parseur de dates de la plateforme.
 */
const INSTANT =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?Z$/;

function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Retourne `null` si la chaîne n’est pas un instant valide (mois 13, 30 février, seconde 60…). */
export function parseInstantMicros(text: string): number | null {
  const match = INSTANT.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const fraction = Number((match[7] ?? '').padEnd(6, '0'));
  const seconds = daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second;
  return seconds * 1_000_000 + fraction;
}

export function formatInstant(date: Date): string {
  return date.toISOString().replace(/\.000Z$/, 'Z');
}
