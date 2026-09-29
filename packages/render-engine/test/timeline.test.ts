import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseInstantMicros, type ManifestPayload } from '@pixlova/contracts';
import { describe, expect, it } from 'vitest';
import { playlistPosition, selectAt } from '../src/index.js';

const fixture = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../contracts/fixtures/manifests/valid-led-2688x672.json'),
    'utf8',
  ),
) as { payload: ManifestPayload };
const manifest = fixture.payload;
const at = (instant: string) => parseInstantMicros(instant)!;

describe('selectAt (NAT-011, PLN-010, PLN-013)', () => {
  it('sélectionne l’intervalle courant, bornes semi-ouvertes', () => {
    expect(selectAt(manifest, at('2026-09-29T18:00:00Z'))).toMatchObject({
      kind: 'timeline',
      contentRef: 'image-accueil',
    });
    expect(selectAt(manifest, at('2026-09-30T05:59:59.999999Z'))).toMatchObject({
      contentRef: 'image-accueil',
    });
    expect(selectAt(manifest, at('2026-09-30T06:00:00Z'))).toMatchObject({
      contentRef: 'bandeau-led',
      entry: { source: { type: 'campaign', priority: 50 } },
    });
  });

  it('joue le fallback dans un trou de la timeline jusqu’au prochain intervalle', () => {
    const gap = structuredClone(manifest);
    gap.timeline[1]!.starts_at = '2026-09-30T07:00:00Z';
    expect(selectAt(gap, at('2026-09-30T06:30:00Z'))).toEqual({
      kind: 'fallback',
      contentRef: 'image-accueil',
      until: at('2026-09-30T07:00:00Z'),
    });
  });

  it('après schedule_until, applique la politique de fin d’horizon sans prolonger la campagne', () => {
    const after = at('2026-10-07T00:00:00Z');
    expect(selectAt(manifest, after)).toEqual({
      kind: 'fallback',
      contentRef: 'image-accueil',
      until: null,
    });
    const standby = structuredClone(manifest);
    standby.fallback.after_schedule = 'standby_screen';
    expect(selectAt(standby, after)).toEqual({ kind: 'standby', until: null });
  });

  it('sans contenu de repli, affiche l’écran local d’attente', () => {
    const empty = structuredClone(manifest);
    empty.timeline = [];
    empty.fallback.content_ref = null;
    expect(selectAt(empty, at('2026-09-30T00:00:00Z'))).toEqual({
      kind: 'standby',
      until: at('2026-10-06T18:00:00Z'),
    });
  });
});

describe('playlistPosition (PLN-002)', () => {
  it('boucle de manière déterministe', () => {
    expect(playlistPosition([30000, 10000], 0)).toEqual({
      index: 0,
      offsetMs: 0,
      remainingMs: 30000,
    });
    expect(playlistPosition([30000, 10000], 35000)).toEqual({
      index: 1,
      offsetMs: 5000,
      remainingMs: 5000,
    });
    expect(playlistPosition([30000, 10000], 40000)).toEqual({
      index: 0,
      offsetMs: 0,
      remainingMs: 30000,
    });
  });

  it('refuse une playlist sans durée', () => {
    expect(() => playlistPosition([], 0)).toThrow();
  });
});
