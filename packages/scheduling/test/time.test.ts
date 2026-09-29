import { describe, expect, it } from 'vitest';
import {
  civilFromDays,
  daysFromCivil,
  formatLocalDate,
  isoWeekday,
  isValidTimezone,
  localDateOf,
  offsetAt,
  parseLocalDate,
  parseLocalTime,
  resolveLocal,
  resolveTargets,
  targetsDisplay,
} from '../src/index.js';

const ms = (text: string) => Date.parse(text);

describe('dates et heures locales', () => {
  it('convertit les dates civiles dans les deux sens', () => {
    for (let days = -800_000; days < 800_000; days += 997) {
      const { year, month, day } = civilFromDays(days);
      expect(daysFromCivil(year, month, day)).toBe(days);
    }
    expect(formatLocalDate(parseLocalDate('2028-02-29')!)).toBe('2028-02-29');
    expect(parseLocalDate('2026-02-29')).toBeNull();
    expect(parseLocalDate('2026-13-01')).toBeNull();
    expect(isoWeekday(parseLocalDate('2026-06-15')!)).toBe(1);
    expect(isoWeekday(parseLocalDate('2026-06-21')!)).toBe(7);
  });

  it('valide les heures locales', () => {
    expect(parseLocalTime('00:00')).toBe(0);
    expect(parseLocalTime('23:59')).toBe(1439);
    expect(parseLocalTime('24:00')).toBe(1440);
    for (const invalid of ['24:01', '7:00', '12:60', '12h00', '']) {
      expect(parseLocalTime(invalid)).toBeNull();
    }
  });

  it('reconnaît les fuseaux IANA', () => {
    expect(isValidTimezone('Europe/Paris')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });

  it('calcule décalages et dates locales', () => {
    expect(offsetAt(ms('2026-01-15T12:00:00Z'), 'Europe/Paris')).toBe(3_600_000);
    expect(offsetAt(ms('2026-07-15T12:00:00Z'), 'Europe/Paris')).toBe(7_200_000);
    expect(offsetAt(ms('2026-07-15T12:00:00Z'), 'Asia/Kolkata')).toBe(19_800_000);
    expect(formatLocalDate(localDateOf(ms('2026-06-14T22:30:00Z'), 'Europe/Paris'))).toBe(
      '2026-06-15',
    );
  });

  it('distingue heure normale, absente et répétée', () => {
    const paris = 'Europe/Paris';
    expect(resolveLocal(parseLocalDate('2026-06-15')!, 9 * 60, paris)).toEqual({
      kind: 'exact',
      instant: ms('2026-06-15T07:00:00Z'),
    });
    expect(resolveLocal(parseLocalDate('2026-03-29')!, 150, paris)).toEqual({
      kind: 'skipped',
      next: ms('2026-03-29T01:00:00Z'),
    });
    expect(resolveLocal(parseLocalDate('2026-10-25')!, 150, paris)).toEqual({
      kind: 'repeated',
      first: ms('2026-10-25T00:30:00Z'),
      second: ms('2026-10-25T01:30:00Z'),
    });
    // Fuseau à demi-heure (Australie, retour à l’heure d’hiver de 30 min).
    expect(resolveLocal(parseLocalDate('2026-04-05')!, 90 + 15, 'Australia/Lord_Howe').kind).toBe(
      'repeated',
    );
  });
});

describe('ciblage', () => {
  const displays = [
    { id: 'd1', site_id: 's1', group_ids: ['g1', 'g2'] },
    { id: 'd2', site_id: 's1', group_ids: [] },
    { id: 'd3', site_id: 's2', group_ids: ['g1'] },
  ];

  it('fait primer les exclusions et ne compte qu’une fois un Display', () => {
    const targeting = {
      include: [
        { type: 'group' as const, id: 'g1' },
        { type: 'group' as const, id: 'g2' },
      ],
      exclude: [{ type: 'display' as const, id: 'd3' }],
    };
    expect(resolveTargets(targeting, displays, null).map((d) => d.id)).toEqual(['d1']);
  });

  it('borne « organisation entière » au site du programme', () => {
    const targeting = { include: [{ type: 'organization' as const }], exclude: [] };
    expect(resolveTargets(targeting, displays, null).map((d) => d.id)).toEqual(['d1', 'd2', 'd3']);
    expect(resolveTargets(targeting, displays, 's1').map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(
      targetsDisplay(
        { include: [{ type: 'site', id: 's1' }], exclude: [{ type: 'group', id: 'g2' }] },
        displays[0]!,
        null,
      ),
    ).toBe(false);
  });
});
