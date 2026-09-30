/**
 * Calculs de mise en page déterministes (REN-001, REN-002), identiques pour la preview,
 * le Player Web et le renderer natif.
 *
 * Règle d’arrondi unique : les dimensions sont arrondies au pixel le plus proche
 * (demi-pixel vers le haut, `Math.round`), puis le centrage utilise la partie entière
 * inférieure de l’espace restant. Aucune hypothèse 16:9 (PROD-002).
 */
import type { CompositionElement } from '@pixlova/contracts';

export type Fit = 'contain' | 'cover' | 'stretch';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Place un contenu de taille intrinsèque dans une boîte ; `cover` peut déborder (rogné par la boîte). */
export function fitRect(
  contentWidth: number,
  contentHeight: number,
  boxWidth: number,
  boxHeight: number,
  fit: Fit,
): Rect {
  if (fit === 'stretch' || contentWidth <= 0 || contentHeight <= 0) {
    return { x: 0, y: 0, width: boxWidth, height: boxHeight };
  }
  const scaleX = boxWidth / contentWidth;
  const scaleY = boxHeight / contentHeight;
  const scale = fit === 'contain' ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY);
  const width = Math.max(1, Math.round(contentWidth * scale));
  const height = Math.max(1, Math.round(contentHeight * scale));
  return {
    x: Math.floor((boxWidth - width) / 2),
    y: Math.floor((boxHeight - height) / 2),
    width,
    height,
  };
}

export type Orientation = 0 | 90 | 180 | 270;

export interface StageTransform {
  /** Facteur d’échelle appliqué au canvas logique. */
  scale: number;
  /** Rotation horaire en degrés, autour du centre du canvas. */
  rotation: Orientation;
  /** Centre du canvas dans la surface de sortie, en pixels (origine de la rotation). */
  centerX: number;
  centerY: number;
  /** Emprise du canvas tourné et mis à l’échelle dans la surface de sortie. */
  box: Rect;
}

/**
 * Projette le canvas logique d’un Display (largeur × hauteur vues par le public) sur la
 * surface de sortie réelle (mode natif de l’output ou fenêtre du navigateur).
 * `orientation` est la rotation horaire à appliquer pour une dalle montée tournée :
 * à 90° ou 270°, un canvas 1080×1920 occupe une sortie 1920×1080.
 */
export function stageTransform(
  canvasWidth: number,
  canvasHeight: number,
  surfaceWidth: number,
  surfaceHeight: number,
  orientation: Orientation,
  fit: Fit,
): StageTransform {
  const quarter = orientation === 90 || orientation === 270;
  const rotatedWidth = quarter ? canvasHeight : canvasWidth;
  const rotatedHeight = quarter ? canvasWidth : canvasHeight;
  const box = fitRect(
    rotatedWidth,
    rotatedHeight,
    surfaceWidth,
    surfaceHeight,
    fit === 'stretch' ? 'contain' : fit,
  );
  const scale = box.width / rotatedWidth;
  // Le canvas est centré sur son emprise, puis mis à l’échelle et tourné autour de son centre.
  return {
    scale,
    rotation: orientation,
    centerX: box.x + box.width / 2,
    centerY: box.y + box.height / 2,
    box,
  };
}

/**
 * Ordre de rendu : `z_index` croissant, puis ordre du document pour les égalités
 * (tri stable). Les éléments invisibles sont exclus ; `locked` n’a aucun effet.
 */
export function renderOrder<T extends Pick<CompositionElement, 'z_index' | 'visible'>>(
  elements: readonly T[],
): T[] {
  return elements
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => element.visible)
    .sort((a, b) => a.element.z_index - b.element.z_index || a.index - b.index)
    .map(({ element }) => element);
}

/**
 * Emprise d’un élément dans le canvas après rotation autour de son centre (REN-002) :
 * boîte englobante axée, en pixels non arrondis. Sert aux comparaisons entre moteurs et
 * aux poignées de sélection du créateur.
 */
export function elementBounds(
  element: Pick<CompositionElement, 'x' | 'y' | 'width' | 'height' | 'rotation'>,
): Rect {
  const radians = (element.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const width = element.width * cos + element.height * sin;
  const height = element.width * sin + element.height * cos;
  const centerX = element.x + element.width / 2;
  const centerY = element.y + element.height / 2;
  return { x: centerX - width / 2, y: centerY - height / 2, width, height };
}
