import type { MediaLimits } from '@pixlova/contracts';
import { PermanentMediaError } from '../errors.js';
import { ProcessFailedError, run } from './process.js';

export type Demuxer = 'mov' | 'matroska';

export interface VideoInfo {
  formatName: string;
  majorBrand: string | null;
  durationMs: number;
  /** Dimensions codées. */
  width: number;
  height: number;
  /** Dimensions affichées, rotation appliquée. */
  displayWidth: number;
  displayHeight: number;
  rotation: 0 | 90 | 180 | 270;
  fps: number;
  video: { codec: string; profile: string | null; pixFmt: string | null; level: number | null };
  audio: { codec: string; channels: number | null }[];
}

export interface VideoTools {
  ffmpeg: string;
  ffprobe: string;
  /** Multiplicateurs de durée pour les délais de décodage et de transcodage. */
  decodeTimeFactor: number;
  transcodeTimeFactor: number;
}

export const DEFAULT_VIDEO_TOOLS: VideoTools = {
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  decodeTimeFactor: 1,
  transcodeTimeFactor: 10,
};

/** Profils H.264 acceptés tels quels par les Players (profil de référence MED-004). */
const H264_PROFILES = new Set(['Constrained Baseline', 'Baseline', 'Main', 'High']);

/** Options d’entrée communes : pas d’entrée standard, fichiers locaux uniquement, démuxeur imposé. */
function inputArgs(path: string, demuxer: Demuxer): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-v',
    'error',
    '-protocol_whitelist',
    'file',
    '-f',
    demuxer,
    '-i',
    path,
  ];
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  pix_fmt?: string;
  level?: number;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
  channels?: number;
  disposition?: { attached_pic?: number };
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
}

function rate(value: string | undefined): number {
  const [num, den] = (value ?? '').split('/').map(Number);
  if (!num || !den || !Number.isFinite(num / den)) return 0;
  return num / den;
}

function normalizeRotation(value: number): 0 | 90 | 180 | 270 {
  const r = (((Math.round(value / 90) * 90) % 360) + 360) % 360;
  return r as 0 | 90 | 180 | 270;
}

export async function probeVideo(
  path: string,
  demuxer: Demuxer,
  limits: MediaLimits,
  tools: VideoTools,
  signal?: AbortSignal,
): Promise<VideoInfo> {
  let output: string;
  try {
    ({ stdout: output } = await run(
      tools.ffprobe,
      [
        '-hide_banner',
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-f',
        demuxer,
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        '-i',
        path,
      ],
      { timeoutMs: 30_000, ...(signal ? { signal } : {}) },
    ));
  } catch (error) {
    if (error instanceof ProcessFailedError) {
      throw new PermanentMediaError('CORRUPTED_FILE', 'Vidéo illisible (analyse FFprobe).');
    }
    throw error;
  }
  const probe = JSON.parse(output) as {
    format?: { format_name?: string; duration?: string; tags?: Record<string, string> };
    streams?: ProbeStream[];
  };
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  if (!video?.codec_name || !video.width || !video.height) {
    throw new PermanentMediaError('CORRUPTED_FILE', 'Aucune piste vidéo exploitable.');
  }
  const seconds = Number(probe.format?.duration ?? video.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new PermanentMediaError('CORRUPTED_FILE', 'Durée de la vidéo inconnue.');
  }
  const durationMs = Math.round(seconds * 1000);
  const rotationSource =
    video.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ??
    Number(video.tags?.rotate ?? 0);
  const rotation = normalizeRotation(-rotationSource || 0);
  const swap = rotation === 90 || rotation === 270;
  const info: VideoInfo = {
    formatName: probe.format?.format_name ?? demuxer,
    majorBrand: probe.format?.tags?.major_brand?.trim() ?? null,
    durationMs,
    width: video.width,
    height: video.height,
    displayWidth: swap ? video.height : video.width,
    displayHeight: swap ? video.width : video.height,
    rotation,
    fps: rate(video.avg_frame_rate) || rate(video.r_frame_rate),
    video: {
      codec: video.codec_name,
      profile: video.profile ?? null,
      pixFmt: video.pix_fmt ?? null,
      level: typeof video.level === 'number' && video.level > 0 ? video.level : null,
    },
    audio: streams
      .filter((s) => s.codec_type === 'audio' && s.codec_name)
      .map((s) => ({ codec: s.codec_name!, channels: s.channels ?? null })),
  };
  if (info.durationMs > limits.videoMaxDurationMs) {
    throw new PermanentMediaError('LIMIT_EXCEEDED', 'Vidéo trop longue.');
  }
  if (info.width > limits.videoInputMaxSide || info.height > limits.videoInputMaxSide) {
    throw new PermanentMediaError('LIMIT_EXCEEDED', `Vidéo de ${info.width}×${info.height} px.`);
  }
  return info;
}

/**
 * Écarts au profil de lecture de référence (MP4, H.264, yuv420p, AAC ou sans audio).
 * Liste vide : l’original est diffusé tel quel, sans transcodage inutile (MED-004).
 */
export function playbackIncompatibilities(info: VideoInfo, limits: MediaLimits): string[] {
  const reasons: string[] = [];
  if (!info.formatName.includes('mp4') || info.majorBrand === 'qt') reasons.push('container');
  if (info.video.codec !== 'h264') reasons.push('video_codec');
  if (!H264_PROFILES.has(info.video.profile ?? '')) reasons.push('video_profile');
  if (info.video.pixFmt !== 'yuv420p' && info.video.pixFmt !== 'yuvj420p')
    reasons.push('pixel_format');
  if (info.video.level !== null && info.video.level > 52) reasons.push('video_level');
  if (info.rotation !== 0) reasons.push('rotation');
  if (
    info.width > limits.outputMaxSide ||
    info.height > limits.outputMaxSide ||
    info.width * info.height > limits.outputMaxPixels
  ) {
    reasons.push('dimensions');
  }
  if (info.fps > limits.outputMaxFps + 0.01) reasons.push('frame_rate');
  if (info.audio.length > 1) reasons.push('audio_tracks');
  if (info.audio.some((a) => a.codec !== 'aac')) reasons.push('audio_codec');
  return reasons;
}

/** Dimensions de sortie : rotation appliquée, bornées, paires (yuv420p). */
export function outputDimensions(
  info: VideoInfo,
  limits: MediaLimits,
): { width: number; height: number } {
  let scale = Math.min(
    1,
    limits.outputMaxSide / info.displayWidth,
    limits.outputMaxSide / info.displayHeight,
    Math.sqrt(limits.outputMaxPixels / (info.displayWidth * info.displayHeight)),
  );
  const even = (value: number) => Math.max(2, Math.floor((value * scale) / 2) * 2);
  let width = even(info.displayWidth);
  let height = even(info.displayHeight);
  while (width * height > limits.outputMaxPixels) {
    scale *= 0.99;
    width = even(info.displayWidth);
    height = even(info.displayHeight);
  }
  return { width, height };
}

function failure(error: unknown, detail: string): unknown {
  if (error instanceof ProcessFailedError) {
    return new PermanentMediaError(error.timedOut ? 'LIMIT_EXCEEDED' : 'CORRUPTED_FILE', detail);
  }
  return error;
}

/** Décodage complet de la piste vidéo : un fichier tronqué ou altéré échoue. */
export async function verifyVideoDecode(
  path: string,
  demuxer: Demuxer,
  info: VideoInfo,
  tools: VideoTools,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await run(
      tools.ffmpeg,
      [...inputArgs(path, demuxer), '-xerror', '-map', '0:v:0', '-threads', '2', '-f', 'null', '-'],
      {
        timeoutMs: 60_000 + info.durationMs * tools.decodeTimeFactor,
        ...(signal ? { signal } : {}),
      },
    );
  } catch (error) {
    throw failure(error, 'Vidéo incomplète ou altérée (décodage).');
  }
}

/** Transcodage vers le profil `h264-aac-mp4-v1`. */
export async function transcodeVideo(
  path: string,
  demuxer: Demuxer,
  info: VideoInfo,
  destination: string,
  limits: MediaLimits,
  tools: VideoTools,
  signal?: AbortSignal,
): Promise<void> {
  const { width, height } = outputDimensions(info, limits);
  const audio = info.audio.length > 0;
  try {
    await run(
      tools.ffmpeg,
      [
        ...inputArgs(path, demuxer),
        '-xerror',
        '-map',
        '0:v:0',
        ...(audio ? ['-map', '0:a:0'] : []),
        '-vf',
        `scale=${width}:${height}:flags=lanczos,format=yuv420p`,
        '-fpsmax',
        String(limits.outputMaxFps),
        '-c:v',
        'libx264',
        '-preset',
        'medium',
        '-crf',
        '20',
        '-profile:v',
        'high',
        ...(audio ? ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'] : ['-an']),
        '-sn',
        '-dn',
        '-map_metadata',
        '-1',
        '-map_chapters',
        '-1',
        '-movflags',
        '+faststart',
        '-threads',
        '2',
        '-f',
        'mp4',
        destination,
      ],
      {
        timeoutMs: 120_000 + info.durationMs * tools.transcodeTimeFactor,
        ...(signal ? { signal } : {}),
      },
    );
  } catch (error) {
    throw failure(error, 'Transcodage impossible : vidéo altérée ou trop lourde.');
  }
}

/** Image PNG extraite à `atMs` (rotation appliquée), pour la vignette. */
export async function extractFrame(
  path: string,
  demuxer: Demuxer,
  atMs: number,
  destination: string,
  tools: VideoTools,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await run(
      tools.ffmpeg,
      [
        '-nostdin',
        '-hide_banner',
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-ss',
        (atMs / 1000).toFixed(3),
        '-f',
        demuxer,
        '-i',
        path,
        '-frames:v',
        '1',
        '-an',
        '-f',
        'image2',
        '-c:v',
        'png',
        destination,
      ],
      { timeoutMs: 60_000, ...(signal ? { signal } : {}) },
    );
  } catch (error) {
    throw failure(error, 'Image de la vidéo impossible à extraire.');
  }
}

let cachedVersion: string | null = null;

export async function ffmpegVersion(tools: VideoTools): Promise<string> {
  if (cachedVersion) return cachedVersion;
  const { stdout } = await run(tools.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 10_000 });
  cachedVersion = stdout.split('\n')[0]?.trim() ?? 'ffmpeg';
  return cachedVersion;
}
