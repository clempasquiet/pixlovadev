import { describe, expect, it } from 'vitest';
import { QUOTA_MARGIN_RATIO, planEviction, usableBytes } from '../src/storage-policy.js';

const entry = (sha256: string, size: number, lastUsed: number) => ({ sha256, size, lastUsed });

describe('politique de stockage du Player Web (PLY-007, ADR-013)', () => {
  it('calcule l’espace utilisable avec la marge, inconnu sans estimation', () => {
    expect(usableBytes({ quota: 1000, usage: 100 })).toBe(1000 * (1 - QUOTA_MARGIN_RATIO) - 100);
    expect(usableBytes({ quota: 1000, usage: 990 })).toBe(0);
    expect(usableBytes(null)).toBeNull();
    expect(usableBytes({ quota: 1000 })).toBeNull();
  });

  it('évince les assets non épinglés du plus ancien usage au plus récent', () => {
    const entries = [entry('actif', 500, 1), entry('ancien', 300, 2), entry('recent', 300, 9)];
    expect(planEviction(entries, new Set(['actif']), 350, 100)).toEqual({
      evict: ['ancien'],
      enough: true,
    });
    expect(planEviction(entries, new Set(['actif']), 650, 100)).toEqual({
      evict: ['ancien', 'recent'],
      enough: true,
    });
  });

  it('ne touche jamais au contenu épinglé, même si l’espace reste insuffisant', () => {
    const entries = [entry('courant', 900, 1), entry('precedent', 900, 2)];
    const plan = planEviction(entries, new Set(['courant', 'precedent']), 500, 100);
    expect(plan).toEqual({ evict: [], enough: false });
  });

  it('n’évince rien si l’espace suffit ou si le quota est inconnu', () => {
    const entries = [entry('a', 10, 1)];
    expect(planEviction(entries, new Set(), 50, 100)).toEqual({ evict: [], enough: true });
    expect(planEviction(entries, new Set(), 10_000, null)).toEqual({ evict: [], enough: true });
  });
});
