/**
 * Capacités déclarées par le Player Web (PROTO-017, WEBPLY-005) : mesurées quand le
 * navigateur le permet, `unsupported` ou `unknown` sinon, jamais un succès présumé.
 */
export interface BrowserProbe {
  userAgent: string;
  canPlay(type: string): string;
  persisted: boolean | null;
  quota: number | null;
  screen: { width: number; height: number };
}

export const H264_AAC = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';

export function osFamily(userAgent: string): 'linux' | 'windows' | 'macos' | 'android' | 'other' {
  if (/Android/i.test(userAgent)) return 'android';
  if (/Windows/i.test(userAgent)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(userAgent)) return 'macos';
  if (/Linux|CrOS/i.test(userAgent)) return 'linux';
  return 'other';
}

export function browserName(userAgent: string): { engine: string; version: string } {
  const match = /(Edg|Firefox|Chrome|Chromium|Version)\/([0-9.]+)/.exec(userAgent) ?? [];
  const brand = match[1] === 'Version' ? 'Safari' : match[1] === 'Edg' ? 'Edge' : match[1];
  return { engine: brand ?? 'navigateur', version: match[2] ?? 'inconnue' };
}

export function capabilities(probe: BrowserProbe, appVersion: string) {
  const video = probe.canPlay(H264_AAC);
  return {
    player_type: 'web' as const,
    app_version: appVersion,
    os: { family: osFamily(probe.userAgent), version: null },
    architecture: 'unknown' as const,
    protocol_versions: [1],
    manifest_schemas: [1],
    render_schemas: [1],
    renderer: browserName(probe.userAgent),
    image_types: ['image/jpeg', 'image/png', 'image/webp'],
    // « maybe » ou « probably » : le navigateur annonce savoir décoder ce profil.
    video_profiles: video === '' ? [] : ['mp4-h264-aac'],
    max_canvas: {
      width: Math.min(16384, Math.max(1, Math.round(probe.screen.width))),
      height: Math.min(16384, Math.max(1, Math.round(probe.screen.height))),
    },
    max_concurrent_videos: 1,
    multi_output: 'unsupported' as const,
    screenshot: 'unsupported' as const,
    volume_control: 'unsupported' as const,
    reboot_host: 'unsupported' as const,
    persistent_storage:
      probe.persisted === null
        ? ('unknown' as const)
        : probe.persisted
          ? ('granted' as const)
          : ('denied' as const),
    storage_quota_bytes: probe.quota === null ? null : Math.floor(probe.quota),
  };
}

/** Sortie unique : la fenêtre du navigateur, à la taille de l’écran en pixels physiques. */
export function browserOutput(screen: { width: number; height: number }, ratio: number) {
  return {
    output_key: 'browser',
    connector_type: 'browser',
    width: Math.max(1, Math.round(screen.width * ratio)),
    height: Math.max(1, Math.round(screen.height * ratio)),
    refresh_hz: null,
    connected: null,
  };
}
