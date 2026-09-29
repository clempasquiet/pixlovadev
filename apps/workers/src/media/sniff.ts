import { open } from 'node:fs/promises';

export type DetectedFormat =
  | { category: 'image'; format: 'jpeg' | 'png' | 'webp'; mimeType: string }
  | {
      category: 'video';
      format: 'mp4' | 'mov' | 'matroska';
      mimeType: string;
      demuxer: 'mov' | 'matroska';
    }
  | { category: null; format: string };

const IMAGE_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'heim',
  'heis',
  'mif1',
  'msf1',
  'avif',
  'avis',
]);

/**
 * Identifie le format par ses octets (SEC-014), jamais par l’extension ou le MIME déclaré.
 * Seuls les formats acceptés par l’ADR-009 reçoivent une catégorie.
 */
export async function sniffFile(path: string): Promise<DetectedFormat> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(64);
    const { bytesRead } = await handle.read(buffer, 0, 64, 0);
    return sniffBytes(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export function sniffBytes(bytes: Buffer): DetectedFormat {
  const ascii = (start: number, end: number) => bytes.subarray(start, end).toString('latin1');
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { category: 'image', format: 'jpeg', mimeType: 'image/jpeg' };
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { category: 'image', format: 'png', mimeType: 'image/png' };
  }
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return { category: 'image', format: 'webp', mimeType: 'image/webp' };
  }
  if (bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) {
    return { category: null, format: 'gif' };
  }
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (IMAGE_BRANDS.has(brand)) return { category: null, format: 'heif' };
    if (brand === 'qt  ') {
      return { category: 'video', format: 'mov', mimeType: 'video/quicktime', demuxer: 'mov' };
    }
    return { category: 'video', format: 'mp4', mimeType: 'video/mp4', demuxer: 'mov' };
  }
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    // Le DocType EBML (« webm » ou « matroska ») figure dans l’en-tête.
    const mimeType = bytes.includes(Buffer.from('webm')) ? 'video/webm' : 'video/x-matroska';
    return { category: 'video', format: 'matroska', mimeType, demuxer: 'matroska' };
  }
  return { category: null, format: 'unknown' };
}
