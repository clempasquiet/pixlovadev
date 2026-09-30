import { describe, expect, it } from 'vitest';
import { DEFAULT_MEDIA_LIMITS, mediaLimitsFromEnv } from '../src/index.js';

describe('mediaLimitsFromEnv', () => {
  it('garde les limites par défaut sans variable', () => {
    expect(mediaLimitsFromEnv({})).toEqual(DEFAULT_MEDIA_LIMITS);
  });

  it('abaisse les limites pour un transport borné', () => {
    const limits = mediaLimitsFromEnv({
      PIXLOVA_MEDIA_IMAGE_MAX_BYTES: '20000000',
      PIXLOVA_MEDIA_VIDEO_MAX_BYTES: '95000000',
    });
    expect(limits.imageMaxBytes).toBe(20_000_000);
    expect(limits.videoMaxBytes).toBe(95_000_000);
    expect(limits.imageMaxPixels).toBe(DEFAULT_MEDIA_LIMITS.imageMaxPixels);
  });

  it('refuse de relever une limite ou une valeur invalide', () => {
    const above = String(DEFAULT_MEDIA_LIMITS.videoMaxBytes + 1);
    expect(() => mediaLimitsFromEnv({ PIXLOVA_MEDIA_VIDEO_MAX_BYTES: above })).toThrow();
    expect(() => mediaLimitsFromEnv({ PIXLOVA_MEDIA_IMAGE_MAX_BYTES: '12.5' })).toThrow();
    expect(() => mediaLimitsFromEnv({ PIXLOVA_MEDIA_IMAGE_MAX_BYTES: '10' })).toThrow();
  });
});
