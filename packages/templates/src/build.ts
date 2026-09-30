import type { DocumentElement } from '@pixlova/contracts';

type Base = Omit<DocumentElement, 'type' | 'props'>;

let counter = 0;
function base(
  x: number,
  y: number,
  width: number,
  height: number,
  extra: Partial<Base> = {},
): Base {
  counter += 1;
  return {
    id: extra.id ?? `el-${counter}`,
    x,
    y,
    width,
    height,
    rotation: 0,
    z_index: 0,
    opacity: 1,
    visible: true,
    locked: false,
    ...extra,
  };
}

export function resetIds(): void {
  counter = 0;
}

export function text(
  box: [number, number, number, number],
  value: string,
  style: {
    font?: Extract<DocumentElement, { type: 'text' }>['props']['font_family'];
    size: number;
    weight?: number;
    color: string;
    align?: 'left' | 'center' | 'right';
    valign?: 'top' | 'middle' | 'bottom';
    lineHeight?: number;
  },
  extra: Partial<Base> = {},
): DocumentElement {
  return {
    ...base(...box, { z_index: 10, ...extra }),
    type: 'text',
    props: {
      text: value,
      font_family: style.font ?? 'Inter',
      font_size_px: style.size,
      font_weight: style.weight ?? 400,
      color: style.color,
      alignment: style.align ?? 'left',
      vertical_alignment: style.valign ?? 'top',
      ...(style.lineHeight ? { line_height: style.lineHeight } : {}),
    },
  };
}

export function rect(
  box: [number, number, number, number],
  fill: string | null,
  extra: Partial<Base> & {
    radius?: number;
    stroke?: string;
    strokeWidth?: number;
    ellipse?: boolean;
  } = {},
): DocumentElement {
  const { radius, stroke, strokeWidth, ellipse, ...rest } = extra;
  return {
    ...base(...box, rest),
    type: 'shape',
    props: {
      shape: ellipse ? 'ellipse' : 'rectangle',
      fill,
      stroke: stroke ?? null,
      stroke_width_px: strokeWidth ?? 0,
      ...(radius ? { corner_radius_px: radius } : {}),
    },
  };
}

export function image(
  box: [number, number, number, number],
  fit: 'contain' | 'cover',
  extra: Partial<Base> = {},
): DocumentElement {
  return {
    ...base(...box, { z_index: 5, ...extra }),
    type: 'image',
    props: { media_id: null, fit },
  };
}

export function qr(
  box: [number, number, number, number],
  data: string,
  extra: Partial<Base> = {},
): DocumentElement {
  return {
    ...base(...box, { z_index: 10, ...extra }),
    type: 'qr',
    props: { data, foreground: '#101820', background: '#FFFFFF', error_correction: 'M' },
  };
}

export function clock(
  box: [number, number, number, number],
  format: Extract<DocumentElement, { type: 'clock' }>['props']['format'],
  style: {
    size: number;
    color: string;
    align?: 'left' | 'center' | 'right';
    font?: 'Inter' | 'Montserrat' | 'Roboto Mono';
  },
  extra: Partial<Base> = {},
): DocumentElement {
  return {
    ...base(...box, { z_index: 10, ...extra }),
    type: 'clock',
    props: {
      format,
      timezone: null,
      locale: 'fr-FR',
      font_family: style.font ?? 'Inter',
      font_size_px: style.size,
      color: style.color,
      alignment: style.align ?? 'right',
    },
  };
}
