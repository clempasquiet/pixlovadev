import { describe, expect, it } from 'vitest';
import { AUDIO_PROBES, CODEC_PROBES } from '../src/metrics.js';

describe('sondes de codecs', () => {
  it('ne déclarent qu’un seul codec par configuration MediaCapabilities', () => {
    for (const probe of [...CODEC_PROBES, ...AUDIO_PROBES]) {
      const codecs = /codecs="([^"]+)"/.exec(probe.type)?.[1] ?? '';
      expect(codecs.split(',').length, probe.id).toBe(1);
    }
  });
});
