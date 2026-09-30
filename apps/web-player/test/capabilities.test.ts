import { validator } from '@pixlova/contracts';
import { describe, expect, it } from 'vitest';
import { browserName, browserOutput, capabilities, osFamily } from '../src/capabilities.js';

const chrome =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

describe('capacités du Player Web (WEBPLY-005)', () => {
  it('déclare des capacités valides, sans succès présumé', () => {
    const declared = capabilities(
      {
        userAgent: chrome,
        canPlay: () => '',
        persisted: null,
        quota: null,
        screen: { width: 1920, height: 1080 },
      },
      '0.1.0',
    );
    expect(validator('player-capabilities.json')(declared)).toBe(true);
    expect(declared).toMatchObject({
      player_type: 'web',
      video_profiles: [],
      persistent_storage: 'unknown',
      storage_quota_bytes: null,
      multi_output: 'unsupported',
      reboot_host: 'unsupported',
      os: { family: 'windows' },
      renderer: { engine: 'Chrome', version: '141.0.0.0' },
    });
  });

  it('reflète les mesures du navigateur', () => {
    const declared = capabilities(
      {
        userAgent: chrome,
        canPlay: () => 'probably',
        persisted: false,
        quota: 5e9,
        screen: { width: 3840, height: 2160 },
      },
      '0.1.0',
    );
    expect(declared).toMatchObject({
      video_profiles: ['mp4-h264-aac'],
      persistent_storage: 'denied',
      storage_quota_bytes: 5e9,
      max_canvas: { width: 3840, height: 2160 },
    });
  });

  it('reconnaît les familles d’OS et une sortie unique', () => {
    expect(osFamily('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)')).toBe('linux');
    expect(osFamily('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe('macos');
    expect(
      browserName('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0').engine,
    ).toBe('Firefox');
    expect(browserOutput({ width: 1920, height: 1080 }, 2)).toMatchObject({
      output_key: 'browser',
      width: 3840,
      height: 2160,
      connected: null,
    });
  });
});
