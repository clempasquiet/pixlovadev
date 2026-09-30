import { describe, expect, it } from 'vitest';
import { elementBounds, fitRect, renderOrder, stageTransform } from '../src/index.js';

describe('fitRect (REN-002)', () => {
  it('contain centre une image 16:9 dans un bandeau LED 2688×672', () => {
    expect(fitRect(1920, 1080, 2688, 672, 'contain')).toEqual({
      x: 746,
      y: 0,
      width: 1195,
      height: 672,
    });
  });

  it('cover remplit et déborde symétriquement (rognage par la boîte)', () => {
    expect(fitRect(1920, 1080, 2688, 672, 'cover')).toEqual({
      x: 0,
      y: -420,
      width: 2688,
      height: 1512,
    });
  });

  it('stretch occupe toute la boîte', () => {
    expect(fitRect(1920, 1080, 768, 2304, 'stretch')).toEqual({
      x: 0,
      y: 0,
      width: 768,
      height: 2304,
    });
  });

  it('arrondit au pixel le plus proche et centre par partie entière inférieure', () => {
    // 1000×333 dans 400×400 : 400×133.2 → 133 ; (400−133)/2 = 133.5 → 133.
    expect(fitRect(1000, 333, 400, 400, 'contain')).toEqual({
      x: 0,
      y: 133,
      width: 400,
      height: 133,
    });
  });

  it('ne produit jamais une dimension nulle pour un format extrême', () => {
    const rect = fitRect(3840, 1, 100, 100, 'contain');
    expect(rect.height).toBe(1);
  });
});

describe('stageTransform', () => {
  it('occupe exactement une sortie de même ratio', () => {
    const t = stageTransform(3840, 480, 1920, 240, 0, 'contain');
    expect(t.scale).toBe(0.5);
    expect(t.box).toEqual({ x: 0, y: 0, width: 1920, height: 240 });
  });

  it('tourne un Display portrait 1080×1920 sur une sortie paysage 1920×1080', () => {
    const t = stageTransform(1080, 1920, 1920, 1080, 90, 'contain');
    expect(t).toMatchObject({ scale: 1, rotation: 90, centerX: 960, centerY: 540 });
    expect(t.box).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  it('met en boîte sans hypothèse 16:9 (768×2304 dans 1920×1080)', () => {
    const t = stageTransform(768, 2304, 1920, 1080, 0, 'contain');
    expect(t.box).toEqual({ x: 780, y: 0, width: 360, height: 1080 });
    expect(t.scale).toBeCloseTo(0.46875, 10);
  });
});

describe('renderOrder', () => {
  it('trie par z_index puis ordre du document et ignore les éléments masqués', () => {
    const elements = [
      { id: 'a', z_index: 2, visible: true },
      { id: 'b', z_index: 1, visible: true },
      { id: 'c', z_index: 2, visible: true },
      { id: 'd', z_index: 0, visible: false },
    ];
    expect(renderOrder(elements).map((e) => e.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('emprise après rotation', () => {
  it('sans rotation : la boîte de l’élément', () => {
    expect(elementBounds({ x: 10, y: 20, width: 300, height: 100, rotation: 0 })).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 100,
    });
  });
  it('à 90° : largeur et hauteur échangées autour du centre', () => {
    const box = elementBounds({ x: 0, y: 0, width: 300, height: 100, rotation: 90 });
    expect(box.width).toBeCloseTo(100);
    expect(box.height).toBeCloseTo(300);
    expect(box.x).toBeCloseTo(100);
    expect(box.y).toBeCloseTo(-100);
  });
  it('à -8° : boîte englobante agrandie, même centre', () => {
    const box = elementBounds({ x: 740, y: 60, width: 280, height: 280, rotation: -8 });
    expect(box.x + box.width / 2).toBeCloseTo(880);
    const angle = (8 * Math.PI) / 180;
    expect(box.width).toBeCloseTo(280 * (Math.cos(angle) + Math.sin(angle)));
  });
});
