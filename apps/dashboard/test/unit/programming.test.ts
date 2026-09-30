import { describe, expect, it } from 'vitest';
import type { PlaylistItem } from '@pixlova/contracts';
import {
  describeRule,
  duplicateItem,
  formatDuration,
  formatInstantIn,
  instantToLocalInput,
  localInputToInstant,
  loopDurationMs,
  moveItem,
  newRule,
  removeAt,
} from '../../src/programming/model.js';

const item = (id: string, duration: number | null, enabled = true): PlaylistItem => ({
  id,
  content: { type: 'media', id: `00000000-0000-4000-8000-00000000000${id}` },
  duration_ms: duration,
  enabled,
  valid_from: null,
  valid_until: null,
});

describe('éléments de playlist (PLN-001)', () => {
  it('réordonne, duplique et retire sans muter la liste d’origine', () => {
    const items = [item('1', 1000), item('2', 2000), item('3', 3000)];
    expect(moveItem(items, 0, 1).map((i) => i.id)).toEqual(['2', '1', '3']);
    expect(moveItem(items, 0, -1).map((i) => i.id)).toEqual(['1', '2', '3']);
    expect(moveItem(items, 2, 1).map((i) => i.id)).toEqual(['1', '2', '3']);
    const duplicated = duplicateItem(items, 1, 'x');
    expect(duplicated.map((i) => i.id)).toEqual(['1', '2', 'x', '3']);
    expect(duplicated[2]!.content).toEqual(items[1]!.content);
    expect(duplicated[2]!.content).not.toBe(items[1]!.content);
    expect(removeAt(items, 1).map((i) => i.id)).toEqual(['1', '3']);
    expect(items.map((i) => i.id)).toEqual(['1', '2', '3']);
  });

  it('calcule la durée d’un tour, incomplète si une durée manque', () => {
    const known = new Map([['media:00000000-0000-4000-8000-000000000003', 30_000]]);
    expect(loopDurationMs([item('1', 8000), item('3', null)], known)).toBe(38_000);
    expect(loopDurationMs([item('1', 8000), item('2', null)], known)).toBeNull();
    expect(loopDurationMs([item('1', 8000), item('2', null, false)], known)).toBe(8000);
    expect(formatDuration(38_000)).toBe('38 s');
    expect(formatDuration(125_000)).toBe('2 min 05 s');
  });
});

describe('horaires et fuseaux (PLN-003)', () => {
  it('affiche un instant dans le fuseau de l’écran, pas celui du navigateur', () => {
    expect(formatInstantIn('2026-06-15T07:00:00Z', 'Europe/Paris', false)).toBe('09:00');
    expect(formatInstantIn('2026-06-15T07:00:00Z', 'America/New_York', false)).toBe('03:00');
  });

  it('convertit la saisie locale en instant et inversement', () => {
    const instant = localInputToInstant('2026-10-05T14:30');
    expect(instant).toMatch(/^2026-10-05T[0-9]{2}:30:00Z$/);
    expect(instantToLocalInput(instant)).toBe('2026-10-05T14:30');
    expect(localInputToInstant('pas une date')).toBeNull();
    expect(instantToLocalInput(null)).toBe('');
  });

  it('résume une règle, y compris la traversée de minuit', () => {
    const rule = newRule({ type: 'media', id: '00000000-0000-4000-8000-000000000001' }, 'r');
    expect(describeRule(rule)).toBe('Tous les jours, 08:00–20:00');
    expect(
      describeRule({ ...rule, weekdays: [5, 6], start_time: '22:00', end_time: '02:00' }),
    ).toBe('Ven, Sam, 22:00–02:00 (lendemain)');
    expect(describeRule({ ...rule, start_time: '00:00', end_time: '24:00' })).toBe(
      'Tous les jours, 00:00–24:00',
    );
  });
});
