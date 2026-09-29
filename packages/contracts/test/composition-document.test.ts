import { describe, expect, it } from 'vitest';
import {
  applyTemplate,
  describeErrors,
  documentMediaIds,
  fontStack,
  lintCompositionDocument,
  resolveCompositionDocument,
  UnresolvedMediaError,
  validator,
  type CompositionDocument,
  type CompositionTemplate,
  type DocumentElement,
} from '../src/index.js';

const IMAGE = '00000000-0000-4000-8000-000000000001';
const VIDEO = '00000000-0000-4000-8000-000000000002';
const ASSET_IMAGE = '00000000-0000-4000-8000-00000000a001';
const ASSET_VIDEO = '00000000-0000-4000-8000-00000000b001';
const validateDocument = validator('composition-document.json');
const validateComposition = validator('composition.json');

const base = { rotation: 0, z_index: 0, opacity: 1, visible: true, locked: false } as const;

function doc(
  elements: DocumentElement[],
  audio: 'muted' | 'single_source' = 'muted',
): CompositionDocument {
  return {
    schema_version: 1,
    canvas: { width: 2688, height: 672, background: '#000000' },
    elements,
    settings: { duration_ms: 10000, audio_policy: audio },
  };
}

const image = (id: string, media: string | null): DocumentElement => ({
  ...base,
  id,
  type: 'image',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  props: { media_id: media, fit: 'cover' },
});
const video = (id: string, muted = true): DocumentElement => ({
  ...base,
  id,
  type: 'video',
  x: 500,
  y: 0,
  width: 400,
  height: 300,
  props: { media_id: VIDEO, fit: 'contain', muted, volume: 1, loop: true },
});
const text = (
  id: string,
  weight = 400,
  font: 'Inter' | 'Playfair Display' = 'Inter',
): DocumentElement => ({
  ...base,
  id,
  type: 'text',
  name: 'Titre',
  x: 1000,
  y: 100,
  width: 800,
  height: 200,
  props: {
    text: 'Soldes',
    font_family: font,
    font_size_px: 120,
    font_weight: weight,
    color: '#FFFFFF',
    alignment: 'center',
  },
});

describe('document d’édition (CMP-001, ADR-010)', () => {
  it('schéma : polices qualifiées seulement, médias nullables, propriétés inconnues refusées', () => {
    expect(
      validateDocument(doc([image('a', null), text('t')])),
      describeErrors(validateDocument.errors),
    ).toBe(true);
    const unknownFont = doc([text('t')]);
    (unknownFont.elements[0]!.props as { font_family: string }).font_family = 'Comic Sans MS';
    expect(validateDocument(unknownFont)).toBe(false);
    const extra = doc([image('a', IMAGE)]) as unknown as { elements: Record<string, unknown>[] };
    extra.elements[0]!.onclick = 'alert(1)';
    expect(validateDocument(extra)).toBe(false);
  });

  it('lint : erreurs bloquantes et avertissements', () => {
    const issues = lintCompositionDocument(
      doc(
        [
          image('a', null),
          image('a', IMAGE),
          text('t', 300, 'Playfair Display'),
          video('v1', false),
          video('v2', false),
          video('v3'),
          { ...text('far'), x: 5000 },
        ],
        'single_source',
      ),
    );
    const codes = issues
      .filter((i) => i.severity === 'error')
      .map((i) => i.code)
      .sort();
    expect(codes).toEqual(
      [
        'AUDIO_MULTIPLE_SOURCES',
        'DUPLICATE_ELEMENT_ID',
        'FONT_WEIGHT_UNAVAILABLE',
        'MEDIA_REQUIRED',
        'TOO_MANY_VIDEOS',
      ].sort(),
    );
    expect(issues.find((i) => i.code === 'ELEMENT_OUTSIDE_CANVAS')).toMatchObject({
      severity: 'warning',
      element_id: 'far',
    });
    expect(issues.find((i) => i.code === 'FONT_WEIGHT_UNAVAILABLE')?.message).toContain(
      '400 à 900',
    );
  });

  it('lint : politique muette signalée, intervalle vidéo contrôlé', () => {
    const range = video('v1');
    if (range.type === 'video') Object.assign(range.props, { start_ms: 5000, end_ms: 4000 });
    const issues = lintCompositionDocument(doc([video('v0', false), range]));
    expect(issues.map((i) => [i.severity, i.code])).toEqual([
      ['error', 'VIDEO_RANGE_INVALID'],
      ['warning', 'AUDIO_MUTED_BY_POLICY'],
    ]);
  });

  it('résolution : médias remplacés par les assets retenus, document de rendu valide', () => {
    const source = doc([image('a', IMAGE), video('v'), text('t')]);
    const resolved = resolveCompositionDocument(source, (id) =>
      id === IMAGE
        ? { asset_id: ASSET_IMAGE, kind: 'image' }
        : { asset_id: ASSET_VIDEO, kind: 'video' },
    );
    expect(validateComposition(resolved), describeErrors(validateComposition.errors)).toBe(true);
    expect(resolved.elements.map((e) => e.type)).toEqual(['image', 'video', 'text']);
    expect(resolved.elements[0]).toMatchObject({ props: { asset_id: ASSET_IMAGE, fit: 'cover' } });
    expect(resolved.elements[1]).toMatchObject({
      props: { asset_id: ASSET_VIDEO, muted: true, loop: true },
    });
    expect(JSON.stringify(resolved)).not.toContain('media_id');
    expect(JSON.stringify(resolved)).not.toContain('"name"');
    expect(documentMediaIds(source).sort()).toEqual([IMAGE, VIDEO].sort());
  });

  it('résolution stricte : média absent ou de mauvais type refusé ; preview : rectangle neutre', () => {
    const source = doc([image('a', null), image('b', IMAGE)]);
    const wrongKind = () => ({ asset_id: ASSET_VIDEO, kind: 'video' as const });
    expect(() => resolveCompositionDocument(source, wrongKind)).toThrow(UnresolvedMediaError);
    const preview = resolveCompositionDocument(source, wrongKind, { missing: 'placeholder' });
    expect(preview.elements.map((e) => e.type)).toEqual(['shape', 'shape']);
    expect(validateComposition(preview)).toBe(true);
  });

  it('template : copie indépendante, placeholders texte, image, couleur et QR remplis', () => {
    const template: CompositionTemplate = {
      key: 'demo',
      version: 1,
      name: 'Démo',
      category: 'retail',
      description: '',
      required_features: ['templates'],
      placeholders: [
        { key: 'title', type: 'text', label: 'Titre', default: 'Par défaut' },
        { key: 'logo', type: 'image', label: 'Logo' },
        { key: 'color', type: 'color', label: 'Couleur', default: '#112233' },
        { key: 'url', type: 'text', label: 'Lien' },
      ],
      document: doc([
        { ...image('logo', null), placeholder: 'logo' },
        { ...text('title'), placeholder: 'title' },
        {
          ...base,
          id: 'box',
          type: 'shape',
          placeholder: 'color',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          props: { shape: 'rectangle', fill: '#000000', stroke: null, stroke_width_px: 0 },
        },
        {
          ...base,
          id: 'qr',
          type: 'qr',
          placeholder: 'url',
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          props: {
            data: 'https://example.com',
            foreground: '#000000',
            background: '#FFFFFF',
            error_correction: 'M',
          },
        },
      ]),
    };
    const result = applyTemplate(template, { logo: IMAGE, url: 'https://pixlova.com' });
    expect(result.elements.map((e) => ('props' in e ? e.props : null))).toEqual([
      { media_id: IMAGE, fit: 'cover' },
      expect.objectContaining({ text: 'Par défaut' }),
      expect.objectContaining({ fill: '#112233' }),
      expect.objectContaining({ data: 'https://pixlova.com' }),
    ]);
    expect(template.document.elements[0]).toMatchObject({ props: { media_id: null } });
  });

  it('pile de polices : famille empaquetée puis repli générique', () => {
    expect(fontStack('Inter')).toBe('"Inter Variable", sans-serif');
    expect(fontStack('Playfair Display')).toBe('"Playfair Display Variable", sans-serif');
    expect(fontStack('Inconnue')).toBe('"Inconnue", sans-serif');
  });
});
