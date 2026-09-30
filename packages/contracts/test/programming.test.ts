import { describe, expect, it } from 'vitest';
import {
  documentPlaylistIds,
  lintCompositionDocument,
  resolveCompositionDocument,
  UnresolvedMediaError,
  validator,
  type CompositionDocument,
} from '../src/index.js';

const PLAYLIST = '00000000-0000-4000-8000-00000000c001';
const ITEM = '00000000-0000-4000-8000-00000000d001';
const MEDIA = '00000000-0000-4000-8000-00000000e001';

const zoneDoc = (playlistId: string | null): CompositionDocument => ({
  schema_version: 1,
  canvas: { width: 1920, height: 1080, background: '#000000' },
  elements: [
    {
      id: 'zone',
      type: 'playlist_zone',
      x: 0,
      y: 0,
      width: 960,
      height: 540,
      rotation: 0,
      z_index: 1,
      opacity: 1,
      visible: true,
      locked: false,
      props: { playlist_id: playlistId },
    },
  ],
  settings: { duration_ms: 15000, audio_policy: 'muted' },
});

describe('zone playlist (ADR-011)', () => {
  it('est acceptée par le document d’édition et exige une playlist à la publication', () => {
    expect(validator('composition-document.json')(zoneDoc(null))).toBe(true);
    expect(lintCompositionDocument(zoneDoc(null)).map((issue) => issue.code)).toEqual([
      'PLAYLIST_REQUIRED',
    ]);
    expect(lintCompositionDocument(zoneDoc(PLAYLIST))).toEqual([]);
    expect(documentPlaylistIds(zoneDoc(PLAYLIST))).toEqual([PLAYLIST]);
  });

  it('se résout en contenu du manifest, disparaît si vide, bloque si introuvable', () => {
    const noMedia = () => null;
    const resolved = resolveCompositionDocument(zoneDoc(PLAYLIST), noMedia, {
      missing: 'error',
      resolvePlaylist: () => ({ content_ref: 'p-123' }),
    });
    expect(resolved.elements[0]).toMatchObject({
      type: 'playlist_zone',
      props: { content_ref: 'p-123' },
    });
    expect(validator('composition.json')(resolved)).toBe(true);
    const omitted = resolveCompositionDocument(zoneDoc(PLAYLIST), noMedia, {
      missing: 'error',
      resolvePlaylist: () => 'omit',
    });
    expect(omitted.elements).toEqual([]);
    expect(() =>
      resolveCompositionDocument(zoneDoc(PLAYLIST), noMedia, {
        missing: 'error',
        resolvePlaylist: () => null,
      }),
    ).toThrow(UnresolvedMediaError);
    const preview = resolveCompositionDocument(zoneDoc(PLAYLIST), noMedia, {
      missing: 'placeholder',
    });
    expect(preview.elements[0]!.type).toBe('shape');
  });
});

describe('documents de programmation', () => {
  const playlist = validator('playlist-document.json');
  const program = validator('program-document.json');

  it('playlist : médias et compositions seulement, durée nulle ou positive', () => {
    const item = {
      id: ITEM,
      content: { type: 'media', id: MEDIA },
      duration_ms: 10000,
      enabled: true,
      valid_from: null,
      valid_until: '2026-12-31T23:00:00Z',
    };
    expect(playlist({ schema_version: 1, transition: 'fade', items: [item] })).toBe(true);
    for (const invalid of [
      { ...item, duration_ms: 0 },
      { ...item, duration_ms: -5 },
      { ...item, content: { type: 'playlist', id: PLAYLIST } },
      { ...item, extra: true },
    ]) {
      expect(playlist({ schema_version: 1, transition: 'cut', items: [invalid] })).toBe(false);
    }
  });

  it('programmes : bandes de priorité et formes locales contrôlées', () => {
    const targets = { include: [{ type: 'organization' }], exclude: [] };
    const rule = {
      id: ITEM,
      content: { type: 'playlist', id: PLAYLIST },
      priority: 10,
      weekdays: [1, 2, 3],
      start_time: '22:00',
      end_time: '02:00',
      start_date: '2026-10-01',
      end_date: null,
    };
    const schedule = {
      schema_version: 1,
      kind: 'schedule',
      timezone: 'Europe/Paris',
      targets,
      rules: [rule],
      exceptions: [],
    };
    expect(program(schedule)).toBe(true);
    expect(program({ ...schedule, rules: [{ ...rule, priority: 20 }] })).toBe(false);
    expect(program({ ...schedule, rules: [{ ...rule, start_time: '24:30' }] })).toBe(false);
    expect(program({ ...schedule, rules: [{ ...rule, weekdays: [] }] })).toBe(false);
    expect(program({ ...schedule, rules: [{ ...rule, weekdays: [1, 1] }] })).toBe(false);
    const campaign = {
      schema_version: 1,
      kind: 'campaign',
      content: null,
      starts_at: null,
      ends_at: null,
      priority: 50,
      targets,
    };
    expect(program(campaign)).toBe(true);
    expect(program({ ...campaign, priority: 80 })).toBe(false);
    const override = {
      schema_version: 1,
      kind: 'override',
      content: { type: 'media', id: MEDIA },
      starts_at: '2026-10-01T10:00:00Z',
      ends_at: '2026-10-01T11:00:00Z',
      priority: 100,
      targets: { include: [{ type: 'display', id: MEDIA }], exclude: [] },
    };
    expect(program(override)).toBe(true);
    expect(program({ ...override, priority: 79 })).toBe(false);
  });
});
