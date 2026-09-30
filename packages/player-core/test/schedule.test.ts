import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseInstantMicros, type ManifestPayload } from '@pixlova/contracts';
import { describe, expect, it } from 'vitest';
import {
  MAX_WAIT_MS,
  nextWakeMs,
  playbackOf,
  referencedAssets,
  selectNow,
  selectionKey,
} from '../src/schedule.js';

const manifest = (
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../../contracts/fixtures/manifests/valid-led-2688x672.json'),
      'utf8',
    ),
  ) as { payload: ManifestPayload }
).payload;
const ms = (instant: string) => parseInstantMicros(instant)! / 1000;

describe('planification locale de la page de lecture', () => {
  it('suit la timeline compilée et se réveille à la fin du créneau', () => {
    const now = ms('2026-09-30T07:59:00Z');
    const selection = selectNow(manifest, now);
    expect(selection).toMatchObject({ kind: 'timeline', contentRef: 'bandeau-led' });
    expect(playbackOf(selection)).toBe('playing');
    expect(nextWakeMs(selection, now * 1000)).toBe(Math.min(MAX_WAIT_MS, 60_000));
    expect(nextWakeMs(selection, ms('2026-09-30T07:59:59.500Z') * 1000)).toBe(500);
  });

  it('joue le fallback après l’horizon, sans réveil planifié au-delà de 30 s', () => {
    const now = ms('2026-10-07T00:00:00Z');
    const selection = selectNow(manifest, now);
    expect(selection).toEqual({ kind: 'fallback', contentRef: 'image-accueil', until: null });
    expect(playbackOf(selection)).toBe('fallback');
    expect(nextWakeMs(selection, now * 1000)).toBe(MAX_WAIT_MS);
  });

  it('distingue deux occurrences successives du même contenu', () => {
    const a = selectNow(manifest, ms('2026-09-29T19:00:00Z'));
    const b = selectNow(manifest, ms('2026-09-30T09:00:00Z'));
    expect(selectionKey(a)).not.toBe(selectionKey(b));
  });

  it('liste les assets réellement référencés', () => {
    expect([...referencedAssets(manifest)].sort()).toEqual(
      manifest.assets.map((asset) => asset.id).sort(),
    );
  });
});
