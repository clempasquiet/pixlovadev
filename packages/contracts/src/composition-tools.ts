/**
 * Outils purs sur les compositions (CMP-005, CMP-007, TPL-002, ADR-010), partagés par
 * l’API (validation avant publication), le créateur (anomalies affichées en direct) et la
 * compilation des manifests (L05). Aucun accès réseau ni base.
 */
import { QUALIFIED_FONTS, isQualifiedFont, type QualifiedFont } from './fonts.js';
import type { Composition, CompositionElement } from './schemas/composition.js';
import type {
  CompositionDocument,
  CompositionTemplate,
  DocumentElement,
} from './schemas/composition-document.js';

export interface CompositionLimits {
  maxElements: number;
  /** Vidéos visibles simultanées ; valeur de départ à qualifier par profil Player (REN-004). */
  maxVideos: number;
}

/** Limites proposées par l’ADR-010, à valider. */
export const DEFAULT_COMPOSITION_LIMITS: CompositionLimits = { maxElements: 200, maxVideos: 2 };

export interface CompositionIssue {
  severity: 'error' | 'warning';
  code: string;
  element_id: string | null;
  message: string;
}

function label(element: DocumentElement): string {
  return element.name ? `« ${element.name} »` : `${element.type} ${element.id}`;
}

/**
 * Anomalies structurelles d’un document d’édition. Les erreurs bloquent la publication ;
 * les avertissements sont affichés. Les contrôles liés à la bibliothèque (média existant,
 * prêt, du bon type, du tenant) sont faits par le serveur.
 */
export function lintCompositionDocument(
  document: CompositionDocument,
  limits: CompositionLimits = DEFAULT_COMPOSITION_LIMITS,
): CompositionIssue[] {
  const issues: CompositionIssue[] = [];
  const error = (code: string, element: DocumentElement | null, message: string) =>
    issues.push({ severity: 'error', code, element_id: element?.id ?? null, message });
  const warning = (code: string, element: DocumentElement | null, message: string) =>
    issues.push({ severity: 'warning', code, element_id: element?.id ?? null, message });

  if (document.elements.length > limits.maxElements) {
    error('TOO_MANY_ELEMENTS', null, `Au plus ${limits.maxElements} éléments par composition.`);
  }
  const seen = new Set<string>();
  for (const element of document.elements) {
    if (seen.has(element.id)) {
      error('DUPLICATE_ELEMENT_ID', element, `Identifiant d’élément en double : ${element.id}.`);
    }
    seen.add(element.id);
    const { canvas } = document;
    if (
      element.x + element.width <= 0 ||
      element.y + element.height <= 0 ||
      element.x >= canvas.width ||
      element.y >= canvas.height
    ) {
      warning(
        'ELEMENT_OUTSIDE_CANVAS',
        element,
        `${label(element)} est entièrement hors du canvas.`,
      );
    }
    switch (element.type) {
      case 'image':
      case 'video':
        if (element.props.media_id === null) {
          error('MEDIA_REQUIRED', element, `Choisissez un média pour ${label(element)}.`);
        }
        if (
          element.type === 'video' &&
          element.props.start_ms !== undefined &&
          element.props.end_ms !== undefined &&
          element.props.end_ms <= element.props.start_ms
        ) {
          error('VIDEO_RANGE_INVALID', element, `La fin de ${label(element)} précède son début.`);
        }
        break;
      case 'text': {
        // Le schéma restreint déjà la famille ; le contrôle protège aussi un document non validé.
        const font: QualifiedFont | undefined = (QUALIFIED_FONTS as Record<string, QualifiedFont>)[
          element.props.font_family
        ];
        if (!font) {
          error('FONT_NOT_QUALIFIED', element, `Police non disponible pour ${label(element)}.`);
        } else if (
          element.props.font_weight < font.minWeight ||
          element.props.font_weight > font.maxWeight
        ) {
          error(
            'FONT_WEIGHT_UNAVAILABLE',
            element,
            `${element.props.font_family} existe de ${font.minWeight} à ${font.maxWeight} ; graisse ${element.props.font_weight} indisponible.`,
          );
        }
        if (element.props.text.trim() === '')
          warning('TEXT_EMPTY', element, `${label(element)} est vide.`);
        break;
      }
      case 'clock':
        if (!isQualifiedFont(element.props.font_family)) {
          error('FONT_NOT_QUALIFIED', element, `Police non disponible pour ${label(element)}.`);
        }
        break;
      default:
        break;
    }
  }
  const videos = document.elements.filter(
    (element): element is Extract<DocumentElement, { type: 'video' }> =>
      element.type === 'video' && element.visible,
  );
  if (videos.length > limits.maxVideos) {
    error(
      'TOO_MANY_VIDEOS',
      null,
      `Au plus ${limits.maxVideos} vidéo(s) visible(s) simultanément ; ${videos.length} présentes.`,
    );
  }
  const audible = videos.filter((video) => !video.props.muted && video.props.volume > 0);
  if (document.settings.audio_policy === 'single_source' && audible.length > 1) {
    error('AUDIO_MULTIPLE_SOURCES', null, 'Une seule vidéo peut être sonore dans une composition.');
  }
  if (document.settings.audio_policy === 'muted' && audible.length > 0) {
    for (const video of audible) {
      warning(
        'AUDIO_MUTED_BY_POLICY',
        video,
        `${label(video)} sera muette (composition sans son).`,
      );
    }
  }
  return issues;
}

export type MediaResolution = { asset_id: string; kind: 'image' | 'video' } | null;

export class UnresolvedMediaError extends Error {
  constructor(readonly elementIds: string[]) {
    super(`Médias non résolus : ${elementIds.join(', ')}`);
    this.name = 'UnresolvedMediaError';
  }
}

/**
 * Convertit le document d’édition en document de rendu (`composition.json`). `resolveMedia`
 * désigne l’asset de la variante retenue. Un média absent devient, en preview, un
 * rectangle neutre ; en mode strict, une erreur (jamais de composition partielle publiée).
 */
export function resolveCompositionDocument(
  document: CompositionDocument,
  resolveMedia: (mediaId: string) => MediaResolution,
  options: { missing: 'placeholder' | 'error' } = { missing: 'error' },
): Composition {
  const unresolved: string[] = [];
  const elements = document.elements.map((element): CompositionElement => {
    const base = {
      id: element.id,
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
      rotation: element.rotation,
      z_index: element.z_index,
      opacity: element.opacity,
      visible: element.visible,
      locked: element.locked,
    };
    if (element.type === 'image' || element.type === 'video') {
      const resolved = element.props.media_id ? resolveMedia(element.props.media_id) : null;
      if (!resolved || resolved.kind !== element.type) {
        unresolved.push(element.id);
        return {
          ...base,
          type: 'shape',
          props: {
            shape: 'rectangle',
            fill: '#8A9BA859',
            stroke: '#5B6B78',
            stroke_width_px: Math.max(1, Math.round(Math.min(element.width, element.height) / 100)),
          },
        };
      }
      if (element.type === 'image') {
        return {
          ...base,
          type: 'image',
          props: { asset_id: resolved.asset_id, fit: element.props.fit },
        };
      }
      const { fit, muted, volume, loop, start_ms, end_ms } = element.props;
      return {
        ...base,
        type: 'video',
        props: {
          asset_id: resolved.asset_id,
          fit,
          muted,
          volume,
          loop,
          ...(start_ms !== undefined ? { start_ms } : {}),
          ...(end_ms !== undefined ? { end_ms } : {}),
        },
      };
    }
    return { ...base, type: element.type, props: element.props } as CompositionElement;
  });
  if (unresolved.length > 0 && options.missing === 'error')
    throw new UnresolvedMediaError(unresolved);
  return {
    schema_version: 1,
    canvas: { ...document.canvas },
    elements,
    settings: { ...document.settings },
  };
}

/** Identifiants des médias de bibliothèque référencés (dépendances, usages). */
export function documentMediaIds(document: CompositionDocument): string[] {
  const ids = new Set<string>();
  for (const element of document.elements) {
    if ((element.type === 'image' || element.type === 'video') && element.props.media_id) {
      ids.add(element.props.media_id);
    }
  }
  return [...ids];
}

/**
 * Crée le document d’une nouvelle composition à partir d’un template (TPL-002) : copie
 * indépendante où les placeholders reçoivent les valeurs fournies ou leur défaut.
 */
export function applyTemplate(
  template: CompositionTemplate,
  values: Readonly<Record<string, string>> = {},
): CompositionDocument {
  const document = structuredClone(template.document);
  const byKey = new Map(template.placeholders.map((placeholder) => [placeholder.key, placeholder]));
  for (const element of document.elements) {
    const placeholder = element.placeholder ? byKey.get(element.placeholder) : undefined;
    if (!placeholder) continue;
    const value = values[placeholder.key] ?? placeholder.default;
    if (value === undefined) continue;
    if (placeholder.type === 'text' && element.type === 'text') element.props.text = value;
    if (placeholder.type === 'text' && element.type === 'qr') element.props.data = value;
    if (placeholder.type === 'image' && (element.type === 'image' || element.type === 'video')) {
      element.props.media_id = value;
    }
    if (placeholder.type === 'color') {
      if (element.type === 'text' || element.type === 'clock') element.props.color = value;
      if (element.type === 'shape') element.props.fill = value;
      if (element.type === 'qr') element.props.foreground = value;
    }
  }
  return document;
}
