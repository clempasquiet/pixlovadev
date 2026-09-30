import { checkManifestSemantics, type ManifestPayload } from '@pixlova/contracts';
import { describe, expect, it } from 'vitest';
import { ASSETS, scenarios } from '../src/scenarios.js';

/** Chaque scénario du banc doit être un contenu de manifest cohérent (mêmes règles que les Players). */
describe('scénarios du banc REN-004', () => {
  for (const hasVideo of [false, true]) {
    for (const scenario of scenarios(hasVideo)) {
      it(`${scenario.id} (vidéo fournie : ${hasVideo})`, () => {
        const manifest = {
          generated_at: '2026-09-29T00:00:00Z',
          valid_from: '2026-09-29T00:00:00Z',
          activate_before: '2026-09-30T00:00:00Z',
          schedule_until: '2026-09-30T00:00:00Z',
          assets: [
            { id: ASSETS.landscape, mime_type: 'image/png' },
            { id: ASSETS.portrait, mime_type: 'image/png' },
            { id: ASSETS.banner, mime_type: 'image/png' },
            { id: ASSETS.video, mime_type: 'video/mp4' },
          ],
          contents: scenario.contents,
          timeline: [],
          fallback: { content_ref: scenario.root, after_schedule: 'play_fallback' },
        } as unknown as ManifestPayload;
        expect(() => checkManifestSemantics(manifest)).not.toThrow();
      });
    }
  }

  it('couvre les formats exigés par REN-004 et PROD-002', () => {
    const formats = scenarios(true).map(
      (s) => `${s.display.width}x${s.display.height}@${s.display.orientation}`,
    );
    expect(formats).toEqual(
      expect.arrayContaining([
        '1920x1080@0',
        '1080x1920@90',
        '2688x672@0',
        '3840x480@0',
        '768x2304@0',
      ]),
    );
  });
});
