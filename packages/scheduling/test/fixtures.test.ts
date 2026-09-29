import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  arbitrate,
  explainAt,
  expandSources,
  toTimeline,
  type ContentCatalog,
  type ProgramSource,
} from '../src/index.js';

interface RawSource {
  kind: ProgramSource['kind'];
  [key: string]: unknown;
}
interface Case {
  window: { from: string; until: string };
  sources: RawSource[];
  expected: Record<string, unknown>[];
  explanations?: {
    at: string;
    winner: string | null;
    masked: { rule_id: string; reason: string }[];
  }[];
}
interface Fixture extends Case {
  description: string;
  display_timezone: string;
  playlists?: Record<
    string,
    { id: string; valid_from: string | null; valid_until: string | null }[]
  >;
  variants?: Case[];
}

const directory = join(import.meta.dirname, '..', 'fixtures');
const ms = (text: string) => Date.parse(text);
const iso = (value: number) => new Date(value).toISOString().replace('.000Z', 'Z');

function normalize(source: RawSource): ProgramSource {
  if (source.kind === 'schedule') return source as unknown as ProgramSource;
  return {
    ...(source as unknown as ProgramSource),
    starts_at: ms(source.starts_at as string),
    ends_at: ms(source.ends_at as string),
  } as ProgramSource;
}

/** Catalogue de test : médias et compositions toujours jouables, playlists selon validités. */
function catalog(playlists: Fixture['playlists'] = {}): ContentCatalog {
  return {
    boundaries(ref) {
      if (ref.type !== 'playlist') return [];
      return (playlists[ref.id] ?? []).flatMap((item) =>
        [item.valid_from, item.valid_until].filter((v): v is string => v !== null).map(ms),
      );
    },
    variantAt(ref, t) {
      if (ref.type !== 'playlist') return `${ref.type}:${ref.id}`;
      const eligible = (playlists[ref.id] ?? []).filter(
        (item) =>
          (item.valid_from === null || ms(item.valid_from) <= t) &&
          (item.valid_until === null || t < ms(item.valid_until)),
      );
      if (eligible.length === 0) return null;
      return `playlist:${ref.id}[${eligible.map((item) => item.id).join(',')}]`;
    },
  };
}

function run(fixture: Fixture, scenario: Case) {
  const from = ms(scenario.window.from);
  const until = ms(scenario.window.until);
  const occurrences = expandSources(
    scenario.sources.map(normalize),
    fixture.display_timezone,
    from,
    until,
  );
  const segments = arbitrate(occurrences, catalog(fixture.playlists), from, until);
  return { segments, timeline: toTimeline(segments) };
}

const files = readdirSync(directory).filter((name) => name.endsWith('.json'));

describe('fixtures de programmation', () => {
  it('couvre les cas exigés par la recette L05', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Fixture;
    const scenarios = [fixture, ...(fixture.variants ?? [])];
    it(`${file} — ${fixture.description}`, () => {
      for (const scenario of scenarios) {
        const { segments, timeline } = run(fixture, scenario);
        expect(
          timeline.map((slot) => ({
            starts_at: iso(slot.start),
            ends_at: iso(slot.end),
            content: slot.variant,
            kind: slot.kind,
            rule_id: slot.rule_id,
            priority: slot.priority,
          })),
        ).toEqual(scenario.expected);
        // Intervalles triés, non chevauchants, dans la fenêtre (PROTO-009).
        for (let i = 0; i < timeline.length; i++) {
          expect(timeline[i]!.start).toBeLessThan(timeline[i]!.end);
          if (i > 0) expect(timeline[i - 1]!.end).toBeLessThanOrEqual(timeline[i]!.start);
        }
        // Segments contigus couvrant exactement la fenêtre.
        expect(segments[0]!.start).toBe(ms(scenario.window.from));
        expect(segments.at(-1)!.end).toBe(ms(scenario.window.until));
        for (let i = 1; i < segments.length; i++) {
          expect(segments[i]!.start).toBe(segments[i - 1]!.end);
        }
        for (const explanation of scenario.explanations ?? []) {
          const segment = explainAt(segments, ms(explanation.at))!;
          expect(segment.winner?.occurrence.rule_id ?? null).toBe(explanation.winner);
          expect(
            segment.masked.map((m) => ({ rule_id: m.occurrence.rule_id, reason: m.reason })),
          ).toEqual(explanation.masked);
        }
      }
    });
  }

  it('est déterministe : l’ordre des sources ne change pas le résultat', () => {
    for (const file of files) {
      const fixture = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Fixture;
      const forward = run(fixture, fixture).timeline;
      const reversed = run(fixture, {
        ...fixture,
        sources: [...fixture.sources].reverse(),
      }).timeline;
      expect(reversed).toEqual(forward);
    }
  });
});
