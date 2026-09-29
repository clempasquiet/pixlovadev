/**
 * Mesures collectées par le banc (REN-004) : environnement déclaré par le runtime,
 * support des codecs, temps jusqu’à la première image, régularité des images et
 * images vidéo perdues. Une valeur non mesurable est `null`, jamais zéro.
 */

export const CODEC_PROBES = [
  {
    id: 'h264-baseline-1080p',
    type: 'video/mp4; codecs="avc1.42E028"',
    width: 1920,
    height: 1080,
  },
  {
    id: 'h264-main-1080p',
    type: 'video/mp4; codecs="avc1.4D4028"',
    width: 1920,
    height: 1080,
  },
  {
    id: 'h264-high-1080p',
    type: 'video/mp4; codecs="avc1.640028"',
    width: 1920,
    height: 1080,
  },
  {
    id: 'h264-high-2160p',
    type: 'video/mp4; codecs="avc1.640033"',
    width: 3840,
    height: 2160,
  },
  {
    id: 'hevc-main-2160p',
    type: 'video/mp4; codecs="hvc1.1.6.L150.B0"',
    width: 3840,
    height: 2160,
  },
  { id: 'vp9-1080p', type: 'video/webm; codecs="vp09.00.40.08"', width: 1920, height: 1080 },
  { id: 'av1-1080p', type: 'video/mp4; codecs="av01.0.08M.08"', width: 1920, height: 1080 },
] as const;

/**
 * `MediaCapabilities` n’accepte qu’un seul codec par configuration : la piste audio
 * est sondée séparément (une chaîne « vidéo + audio » est déclarée non supportée).
 */
export const AUDIO_PROBES = [
  { id: 'aac-lc-stereo', type: 'audio/mp4; codecs="mp4a.40.2"' },
] as const;

export interface CodecResult {
  id: string;
  can_play_type: string;
  decoding: { supported: boolean; smooth: boolean; power_efficient: boolean } | null;
}

export async function probeCodecs(): Promise<CodecResult[]> {
  const media = document.createElement('video');
  const probe = async (
    id: string,
    type: string,
    configuration: MediaDecodingConfiguration,
  ): Promise<CodecResult> => {
    let decoding: CodecResult['decoding'] = null;
    try {
      const info = await navigator.mediaCapabilities?.decodingInfo(configuration);
      if (info) {
        decoding = {
          supported: info.supported,
          smooth: info.smooth,
          power_efficient: info.powerEfficient,
        };
      }
    } catch {
      decoding = null;
    }
    return { id, can_play_type: media.canPlayType(type), decoding };
  };
  return Promise.all([
    ...CODEC_PROBES.map((p) =>
      probe(p.id, p.type, {
        type: 'file',
        video: {
          contentType: p.type,
          width: p.width,
          height: p.height,
          bitrate: 8_000_000,
          framerate: 30,
        },
      }),
    ),
    ...AUDIO_PROBES.map((p) =>
      probe(p.id, p.type, {
        type: 'file',
        audio: { contentType: p.type, channels: '2', bitrate: 128_000, samplerate: 48_000 },
      }),
    ),
  ]);
}

function webglRenderer(): string | null {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return null;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info
      ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
  } catch {
    return null;
  }
}

export function environment() {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    user_agent: navigator.userAgent,
    hardware_concurrency: navigator.hardwareConcurrency ?? null,
    device_memory_gb: nav.deviceMemory ?? null,
    screen: { width: screen.width, height: screen.height },
    viewport: { width: innerWidth, height: innerHeight },
    device_pixel_ratio: devicePixelRatio,
    webgl_renderer: webglRenderer(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

export interface FrameStats {
  frames: number;
  fps: number | null;
  interval_ms_p50: number | null;
  interval_ms_p95: number | null;
  interval_ms_max: number | null;
  janks_over_50ms: number;
  long_tasks: number;
  video: { total_frames: number; dropped_frames: number } | null;
  js_heap_used_bytes: number | null;
}

/** Échantillonne `requestAnimationFrame` pendant `durationMs`, ainsi que les vidéos présentes. */
export async function sampleFrames(root: HTMLElement, durationMs: number): Promise<FrameStats> {
  const intervals: number[] = [];
  let longTasks = 0;
  let observer: PerformanceObserver | undefined;
  try {
    observer = new PerformanceObserver((list) => {
      longTasks += list.getEntries().length;
    });
    observer.observe({ type: 'longtask', buffered: false });
  } catch {
    observer = undefined;
  }
  const videos = () => [...root.querySelectorAll('video')];
  const baseline = new Map(videos().map((v) => [v, v.getVideoPlaybackQuality?.()]));
  await new Promise<void>((resolve) => {
    const start = performance.now();
    let last = start;
    const frame = (now: number) => {
      intervals.push(now - last);
      last = now;
      if (now - start < durationMs) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame((now) => {
      last = now;
      requestAnimationFrame(frame);
    });
  });
  observer?.disconnect();
  let video: FrameStats['video'] = null;
  for (const element of videos()) {
    const quality = element.getVideoPlaybackQuality?.();
    if (!quality) continue;
    const before = baseline.get(element);
    video ??= { total_frames: 0, dropped_frames: 0 };
    video.total_frames += quality.totalVideoFrames - (before?.totalVideoFrames ?? 0);
    video.dropped_frames += quality.droppedVideoFrames - (before?.droppedVideoFrames ?? 0);
  }
  const sorted = [...intervals].sort((a, b) => a - b);
  const total = intervals.reduce((sum, value) => sum + value, 0);
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  const round = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);
  return {
    frames: intervals.length,
    fps: total > 0 ? round((intervals.length * 1000) / total) : null,
    interval_ms_p50: round(percentile(sorted, 50)),
    interval_ms_p95: round(percentile(sorted, 95)),
    interval_ms_max: round(sorted.at(-1) ?? null),
    janks_over_50ms: intervals.filter((value) => value > 50).length,
    long_tasks: longTasks,
    video,
    js_heap_used_bytes: memory?.usedJSHeapSize ?? null,
  };
}

/** Attend le décodage des images et le démarrage des vidéos, puis une image présentée. */
export async function firstFrame(root: HTMLElement, timeoutMs = 10_000): Promise<number | null> {
  const start = performance.now();
  const images = [...root.querySelectorAll('img')].map((img) =>
    img.decode().catch(() => undefined),
  );
  const videos = [...root.querySelectorAll('video')].map(
    (video) =>
      new Promise<void>((resolve) => {
        if (video.readyState >= 3 && !video.paused) resolve();
        else video.addEventListener('playing', () => resolve(), { once: true });
      }),
  );
  const ready = Promise.all([...images, ...videos]).then(
    () => new Promise<void>((r) => requestAnimationFrame(() => r())),
  );
  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), timeoutMs),
  );
  const outcome = await Promise.race([ready, timeout]);
  return outcome === 'timeout' ? null : Math.round(performance.now() - start);
}
