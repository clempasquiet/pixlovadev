import { describe, expect, it } from 'vitest';
import { lintCompositionDocument, type CompositionDocument } from '@pixlova/contracts';
import {
  addElement,
  createElement,
  duplicateElements,
  editorReducer,
  initialState,
  moveInStack,
  percent,
  removeElements,
  renameElement,
  snapPosition,
  updateElement,
  updateProps,
} from '../../src/compositions/state.js';

function canvas(width: number, height: number): CompositionDocument {
  return {
    schema_version: 1,
    canvas: { width, height, background: '#000000' },
    elements: [],
    settings: { audio_policy: 'muted' },
  };
}

describe('état du créateur (CMP-002)', () => {
  it('annuler, rétablir ; un glissé continu ne crée qu’une entrée d’historique', () => {
    const start = canvas(1920, 1080);
    let state = initialState(start);
    const text = createElement(start, 'text');
    const withText = addElement(start, text);
    state = editorReducer(state, { type: 'change', doc: withText });
    state = editorReducer(state, {
      type: 'change',
      doc: updateElement(withText, text.id, { x: 10 }),
      mode: 'push',
    });
    state = editorReducer(state, {
      type: 'change',
      doc: updateElement(withText, text.id, { x: 20 }),
      mode: 'replace',
    });
    state = editorReducer(state, {
      type: 'change',
      doc: updateElement(withText, text.id, { x: 30 }),
      mode: 'replace',
    });
    expect(state.past).toHaveLength(2);
    state = editorReducer(state, { type: 'undo' });
    expect(state.doc.elements[0]!.x).toBe(text.x);
    state = editorReducer(state, { type: 'redo' });
    expect(state.doc.elements[0]!.x).toBe(30);
    state = editorReducer(state, { type: 'undo' });
    state = editorReducer(state, { type: 'undo' });
    expect(state.doc.elements).toEqual([]);
  });

  it('copier-coller et dupliquer : nouveaux identifiants, décalage, sélection', () => {
    const start = canvas(1920, 1080);
    const shape = createElement(start, 'rectangle');
    let state = initialState(addElement(start, shape));
    state = editorReducer(state, { type: 'select', ids: [shape.id] });
    state = editorReducer(state, { type: 'copy' });
    state = editorReducer(state, { type: 'paste' });
    expect(state.doc.elements).toHaveLength(2);
    expect(state.selected).toHaveLength(1);
    expect(state.selected[0]).not.toBe(shape.id);
    const { doc, ids } = duplicateElements(state.doc, state.doc.elements);
    expect(new Set(doc.elements.map((e) => e.id)).size).toBe(4);
    expect(ids).toHaveLength(2);
    expect(lintCompositionDocument(doc).filter((i) => i.code === 'DUPLICATE_ELEMENT_ID')).toEqual(
      [],
    );
  });

  it('éléments créés dans les formats LED atypiques : dans le canvas, document valide', () => {
    for (const [w, h] of [
      [3840, 480],
      [768, 2304],
      [2688, 672],
    ] as const) {
      let doc = canvas(w, h);
      for (const kind of ['text', 'rectangle', 'ellipse', 'qr', 'clock'] as const)
        doc = addElement(doc, createElement(doc, kind));
      for (const element of doc.elements) {
        expect(element.x).toBeGreaterThanOrEqual(0);
        expect(element.y).toBeGreaterThanOrEqual(0);
        expect(element.x + element.width).toBeLessThanOrEqual(w);
        expect(element.y + element.height).toBeLessThanOrEqual(h);
      }
      expect(lintCompositionDocument(doc)).toEqual([]);
    }
  });

  it('profondeur : monter, descendre, premier plan ; z_index renumérotés', () => {
    let doc = canvas(1000, 1000);
    const a = createElement(doc, 'rectangle');
    doc = addElement(doc, a);
    const b = createElement(doc, 'ellipse');
    doc = addElement(doc, b);
    const c = createElement(doc, 'text');
    doc = addElement(doc, c);
    const order = (d: CompositionDocument) =>
      [...d.elements].sort((x, y) => x.z_index - y.z_index).map((e) => e.id);
    expect(order(doc)).toEqual([a.id, b.id, c.id]);
    expect(order(moveInStack(doc, a.id, 'up'))).toEqual([b.id, a.id, c.id]);
    expect(order(moveInStack(doc, c.id, 'bottom'))).toEqual([c.id, a.id, b.id]);
    expect(order(moveInStack(doc, a.id, 'top'))).toEqual([b.id, c.id, a.id]);
  });

  it('propriétés facultatives effacées, nom de calque retiré, suppression', () => {
    let doc = canvas(1000, 1000);
    const video = createElement(doc, 'video', '00000000-0000-4000-8000-000000000001');
    doc = addElement(doc, video);
    doc = updateProps(doc, video.id, { start_ms: 1000 });
    doc = updateProps(doc, video.id, { start_ms: undefined });
    expect('start_ms' in doc.elements[0]!.props).toBe(false);
    doc = renameElement(doc, video.id, 'Fond');
    expect(doc.elements[0]!.name).toBe('Fond');
    doc = renameElement(doc, video.id, '');
    expect('name' in doc.elements[0]!).toBe(false);
    expect(removeElements(doc, [video.id]).elements).toEqual([]);
  });

  it('aimantation : centre du canvas, bord d’un autre élément, puis grille', () => {
    let doc = canvas(2688, 672);
    const other = { ...createElement(doc, 'rectangle'), x: 100, y: 100, width: 200, height: 200 };
    doc = addElement(doc, other);
    const centered = snapPosition(
      doc,
      { id: 'm', x: 1245, y: 10, width: 200, height: 100 },
      { grid: null, threshold: 6 },
    );
    expect(centered.x).toBe(1244);
    expect(centered.guides.vertical).toEqual([1344]);
    const edge = snapPosition(
      doc,
      { id: 'm', x: 303, y: 400, width: 50, height: 50 },
      { grid: null, threshold: 6 },
    );
    expect(edge.x).toBe(300);
    const grid = snapPosition(
      doc,
      { id: 'm', x: 1000, y: 413, width: 50, height: 51 },
      { grid: 16, threshold: 0 },
    );
    expect(grid).toMatchObject({ x: 1008, y: 416, guides: { vertical: [], horizontal: [] } });
  });

  it('pourcentages affichés : pixels × 100 / dimension, au centième', () => {
    expect(percent(1344, 2688)).toBe('50 %');
    expect(percent(100, 3840)).toBe('2,6 %');
    expect(percent(1, 3)).toBe('33,33 %');
  });
});
