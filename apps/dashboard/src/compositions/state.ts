/**
 * État du créateur (CMP-002) : document d’édition, historique d’annulation, sélection et
 * presse-papiers. Fonctions pures, testées sans DOM.
 */
import type { CompositionDocument, DocumentElement } from '@pixlova/contracts';
import { renderOrder } from '@pixlova/render-engine';

export interface EditorState {
  doc: CompositionDocument;
  past: CompositionDocument[];
  future: CompositionDocument[];
  selected: string[];
  clipboard: DocumentElement[];
}

export type EditorAction =
  | { type: 'load'; doc: CompositionDocument }
  /** `replace` : modification continue (glisser) sans nouvelle entrée d’historique. */
  | { type: 'change'; doc: CompositionDocument; mode?: 'push' | 'replace' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'select'; ids: string[] }
  | { type: 'copy' }
  | { type: 'paste' };

const HISTORY = 100;

export function initialState(doc: CompositionDocument): EditorState {
  return { doc, past: [], future: [], selected: [], clipboard: [] };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'load':
      return { ...initialState(action.doc), clipboard: state.clipboard };
    case 'change':
      if (action.doc === state.doc) return state;
      if (action.mode === 'replace') return { ...state, doc: action.doc };
      return {
        ...state,
        doc: action.doc,
        past: [...state.past, state.doc].slice(-HISTORY),
        future: [],
      };
    case 'undo': {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        ...state,
        doc: previous,
        past: state.past.slice(0, -1),
        future: [state.doc, ...state.future],
      };
    }
    case 'redo': {
      const next = state.future[0];
      if (!next) return state;
      return {
        ...state,
        doc: next,
        past: [...state.past, state.doc],
        future: state.future.slice(1),
      };
    }
    case 'select':
      return {
        ...state,
        selected: action.ids.filter((id) => state.doc.elements.some((e) => e.id === id)),
      };
    case 'copy':
      return {
        ...state,
        clipboard: state.doc.elements.filter((e) => state.selected.includes(e.id)),
      };
    case 'paste': {
      if (state.clipboard.length === 0) return state;
      const { doc, ids } = duplicateElements(state.doc, state.clipboard);
      return {
        ...state,
        doc,
        past: [...state.past, state.doc].slice(-HISTORY),
        future: [],
        selected: ids,
      };
    }
  }
}

export function nextElementId(doc: CompositionDocument, prefix = 'el'): string {
  const used = new Set(doc.elements.map((e) => e.id));
  let n = doc.elements.length + 1;
  while (used.has(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

function topZ(doc: CompositionDocument): number {
  return doc.elements.reduce((max, element) => Math.max(max, element.z_index), 0);
}

export type NewElementKind =
  'text' | 'rectangle' | 'ellipse' | 'image' | 'video' | 'qr' | 'clock' | 'playlist_zone';

/** Nouvel élément centré, dimensionné relativement au canvas (formats LED compris). */
export function createElement(
  doc: CompositionDocument,
  kind: NewElementKind,
  mediaId: string | null = null,
): DocumentElement {
  const { width, height } = doc.canvas;
  const short = Math.min(width, height);
  // Taille bornée au canvas : un élément créé reste entièrement visible (totems, bandeaux).
  const box = (w: number, h: number) => {
    const boxWidth = Math.max(1, Math.round(Math.min(w, width)));
    const boxHeight = Math.max(1, Math.round(Math.min(h, height)));
    return {
      x: Math.round((width - boxWidth) / 2),
      y: Math.round((height - boxHeight) / 2),
      width: boxWidth,
      height: boxHeight,
    };
  };
  const base = { rotation: 0, z_index: topZ(doc) + 1, opacity: 1, visible: true, locked: false };
  switch (kind) {
    case 'text':
      return {
        ...base,
        ...box(Math.min(width * 0.6, short * 2), short * 0.25),
        id: nextElementId(doc, 'texte'),
        type: 'text',
        props: {
          text: 'Votre texte',
          font_family: 'Inter',
          font_size_px: Math.max(12, Math.round(short * 0.12)),
          font_weight: 700,
          color: '#FFFFFF',
          alignment: 'left',
          vertical_alignment: 'middle',
        },
      };
    case 'rectangle':
    case 'ellipse':
      return {
        ...base,
        ...box(short * 0.4, short * 0.4),
        id: nextElementId(doc, 'forme'),
        type: 'shape',
        props: { shape: kind, fill: '#1B7F79', stroke: null, stroke_width_px: 0 },
      };
    case 'image':
      return {
        ...base,
        ...box(width * 0.5, height * 0.5),
        id: nextElementId(doc, 'image'),
        type: 'image',
        props: { media_id: mediaId, fit: 'cover' },
      };
    case 'video':
      return {
        ...base,
        ...box(width * 0.5, height * 0.5),
        id: nextElementId(doc, 'video'),
        type: 'video',
        props: { media_id: mediaId, fit: 'contain', muted: true, volume: 1, loop: true },
      };
    case 'qr':
      return {
        ...base,
        ...box(short * 0.35, short * 0.35),
        id: nextElementId(doc, 'qr'),
        type: 'qr',
        props: {
          data: 'https://example.com',
          foreground: '#101820',
          background: '#FFFFFF',
          error_correction: 'M',
        },
      };
    case 'playlist_zone':
      return {
        ...base,
        ...box(width * 0.5, height * 0.5),
        id: nextElementId(doc, 'zone'),
        type: 'playlist_zone',
        props: { playlist_id: null },
      };
    case 'clock':
      return {
        ...base,
        ...box(short * 1.2, short * 0.2),
        id: nextElementId(doc, 'horloge'),
        type: 'clock',
        props: {
          format: 'time_24h',
          timezone: null,
          locale: 'fr-FR',
          font_family: 'Inter',
          font_size_px: Math.max(12, Math.round(short * 0.12)),
          color: '#FFFFFF',
          alignment: 'center',
        },
      };
  }
}

export function addElement(
  doc: CompositionDocument,
  element: DocumentElement,
): CompositionDocument {
  return { ...doc, elements: [...doc.elements, element] };
}

export function updateElement(
  doc: CompositionDocument,
  id: string,
  patch: Partial<Omit<DocumentElement, 'type' | 'props'>>,
): CompositionDocument {
  return {
    ...doc,
    elements: doc.elements.map((e) => (e.id === id ? ({ ...e, ...patch } as DocumentElement) : e)),
  };
}

export function updateProps(
  doc: CompositionDocument,
  id: string,
  patch: Record<string, unknown>,
): CompositionDocument {
  return {
    ...doc,
    elements: doc.elements.map((e) => {
      if (e.id !== id) return e;
      const props: Record<string, unknown> = { ...e.props, ...patch };
      // Propriété facultative effacée : retirée du document plutôt que `undefined`.
      for (const [key, value] of Object.entries(props)) if (value === undefined) delete props[key];
      return { ...e, props } as DocumentElement;
    }),
  };
}

/** Nom de calque ; une chaîne vide retire le nom (retour au libellé automatique). */
export function renameElement(
  doc: CompositionDocument,
  id: string,
  name: string,
): CompositionDocument {
  return {
    ...doc,
    elements: doc.elements.map((e) => {
      if (e.id !== id) return e;
      const { name: _previous, ...rest } = e;
      void _previous;
      return (name ? { ...rest, name } : rest) as DocumentElement;
    }),
  };
}

export function removeElements(
  doc: CompositionDocument,
  ids: readonly string[],
): CompositionDocument {
  return { ...doc, elements: doc.elements.filter((e) => !ids.includes(e.id)) };
}

/** Copie décalée avec de nouveaux identifiants (dupliquer, coller). */
export function duplicateElements(
  doc: CompositionDocument,
  elements: readonly DocumentElement[],
): { doc: CompositionDocument; ids: string[] } {
  let next = doc;
  const ids: string[] = [];
  const offset = Math.max(8, Math.round(Math.min(doc.canvas.width, doc.canvas.height) * 0.02));
  for (const element of elements) {
    const id = nextElementId(next, element.type);
    next = addElement(next, {
      ...structuredClone(element),
      id,
      x: element.x + offset,
      y: element.y + offset,
      z_index: topZ(next) + 1,
      locked: false,
    });
    ids.push(id);
  }
  return { doc: next, ids };
}

/**
 * Change la profondeur d’un élément d’un cran (ou jusqu’au bout) dans l’ordre de rendu ;
 * les `z_index` sont renumérotés de façon stable.
 */
export function moveInStack(
  doc: CompositionDocument,
  id: string,
  direction: 'up' | 'down' | 'top' | 'bottom',
): CompositionDocument {
  const ordered = renderOrder(doc.elements.map((e) => ({ ...e, visible: true }))).map((e) => e.id);
  const index = ordered.indexOf(id);
  if (index < 0) return doc;
  ordered.splice(index, 1);
  const target =
    direction === 'top'
      ? ordered.length
      : direction === 'bottom'
        ? 0
        : direction === 'up'
          ? Math.min(ordered.length, index + 1)
          : Math.max(0, index - 1);
  ordered.splice(target, 0, id);
  const z = new Map(ordered.map((elementId, position) => [elementId, position + 1]));
  return { ...doc, elements: doc.elements.map((e) => ({ ...e, z_index: z.get(e.id)! })) };
}

/** Pourcentage affiché : pixels × 100 / dimension du canvas, arrondi au centième (ADR-010). */
export function percent(pixels: number, dimension: number): string {
  return `${(Math.round((pixels * 10000) / dimension) / 100).toLocaleString('fr-FR')} %`;
}

export interface SnapResult {
  x: number;
  y: number;
  guides: { vertical: number[]; horizontal: number[] };
}

/**
 * Aimantation d’un déplacement (CMP-002) : bords et centre du canvas, bords et centres des
 * autres éléments, puis grille. `threshold` est en pixels du canvas.
 */
export function snapPosition(
  doc: CompositionDocument,
  moving: { id: string; x: number; y: number; width: number; height: number },
  options: { grid: number | null; threshold: number },
): SnapResult {
  const verticalLines = [0, doc.canvas.width / 2, doc.canvas.width];
  const horizontalLines = [0, doc.canvas.height / 2, doc.canvas.height];
  for (const element of doc.elements) {
    if (element.id === moving.id || !element.visible) continue;
    verticalLines.push(element.x, element.x + element.width / 2, element.x + element.width);
    horizontalLines.push(element.y, element.y + element.height / 2, element.y + element.height);
  }
  const axis = (start: number, size: number, lines: number[], grid: number | null) => {
    let best: { value: number; distance: number; line: number } | null = null;
    for (const anchor of [0, size / 2, size]) {
      for (const line of lines) {
        const distance = Math.abs(start + anchor - line);
        if (distance <= options.threshold && (!best || distance < best.distance)) {
          best = { value: Math.round(line - anchor), distance, line };
        }
      }
    }
    if (best) return { value: best.value, line: best.line as number | null };
    return { value: grid ? Math.round(start / grid) * grid : Math.round(start), line: null };
  };
  const x = axis(moving.x, moving.width, verticalLines, options.grid);
  const y = axis(moving.y, moving.height, horizontalLines, options.grid);
  return {
    x: x.value,
    y: y.value,
    guides: {
      vertical: x.line === null ? [] : [x.line],
      horizontal: y.line === null ? [] : [y.line],
    },
  };
}
