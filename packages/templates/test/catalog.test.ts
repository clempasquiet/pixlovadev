import { describe, expect, it } from 'vitest';
import {
  applyTemplate,
  describeErrors,
  lintCompositionDocument,
  TEMPLATE_CATEGORIES,
  validator,
} from '@pixlova/contracts';
import { TEMPLATES } from '../src/index.js';

const validateTemplate = validator('composition-template.json');
const validateDocument = validator('composition-document.json');
const MEDIA = '00000000-0000-4000-8000-0000000000aa';

describe('catalogue de templates V1 (TPL-001)', () => {
  it('clés uniques, catégories initiales couvertes, droits requis déclarés', () => {
    expect(new Set(TEMPLATES.map((t) => t.key)).size).toBe(TEMPLATES.length);
    expect(new Set(TEMPLATES.map((t) => t.category))).toEqual(new Set(TEMPLATE_CATEGORIES));
    for (const template of TEMPLATES) expect(template.required_features).toContain('templates');
  });

  it('formats variés sans hypothèse 16:9 : paysage, portrait, bandeau LED', () => {
    const formats = TEMPLATES.map((t) => `${t.document.canvas.width}x${t.document.canvas.height}`);
    expect(formats).toEqual(expect.arrayContaining(['1920x1080', '1080x1920', '2688x672']));
  });

  it.each(TEMPLATES.map((t) => [t.key, t] as const))(
    '%s : schéma valide, placeholders cohérents',
    (_key, template) => {
      expect(validateTemplate(template), describeErrors(validateTemplate.errors)).toBe(true);
      const keys = new Set(template.placeholders.map((p) => p.key));
      for (const element of template.document.elements) {
        if (element.placeholder) expect(keys.has(element.placeholder), element.id).toBe(true);
      }
      // Aucun asset plateforme : les seules erreurs avant remplissage sont les images à choisir.
      const before = lintCompositionDocument(template.document).filter(
        (i) => i.severity === 'error',
      );
      expect(before.every((issue) => issue.code === 'MEDIA_REQUIRED')).toBe(true);

      const values = Object.fromEntries(
        template.placeholders.filter((p) => p.type === 'image').map((p) => [p.key, MEDIA]),
      );
      const filled = applyTemplate(template, values);
      expect(validateDocument(filled), describeErrors(validateDocument.errors)).toBe(true);
      expect(lintCompositionDocument(filled).filter((i) => i.severity === 'error')).toEqual([]);
      // Copie indépendante : le template source n’est pas modifié.
      expect(
        template.document.elements.some(
          (e) => (e.type === 'image' || e.type === 'video') && e.props.media_id,
        ),
      ).toBe(false);
    },
  );
});
