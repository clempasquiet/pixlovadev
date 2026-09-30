/**
 * Rendu DOM d’un contenu de manifest (média, composition, playlist) — prototype L00.
 * Utilisé par la preview, le Player Web et le renderer natif fondé sur une WebView.
 * Aucun script ni HTML issu du document n’est interprété : seules des propriétés
 * typées sont appliquées (SEC-012, SEC-013).
 */
import type { Composition, CompositionElement, ManifestContent } from '@pixlova/contracts';
import { encode } from 'uqr';
import { fitRect, renderOrder, stageTransform, type Fit, type Orientation } from '../layout.js';
import { playlistPosition } from '../timeline.js';

export interface RenderContext {
  /** URL locale d’un asset vérifié (cache du Player, blob, protocole local). Jamais d’URL cloud. */
  resolveAsset(assetId: string): string;
  /** Contenus du manifest, pour les zones média et playlist. */
  contents: ReadonlyMap<string, ManifestContent>;
  /** Fuseau du Display pour les horloges sans fuseau explicite. */
  timezone: string;
  /** Horloge murale en millisecondes Unix (injectable pour les tests). */
  now(): number;
  /** Signalement d’erreur de lecture (fallback et événement côté Player). */
  onError?(error: { contentRef: string | null; reason: string; detail: string }): void;
}

export interface Rendered {
  element: HTMLElement;
  destroy(): void;
}

const px = (value: number) => `${value}px`;

function box(element: HTMLElement, x: number, y: number, width: number, height: number): void {
  Object.assign(element.style, {
    position: 'absolute',
    left: px(x),
    top: px(y),
    width: px(width),
    height: px(height),
    overflow: 'hidden',
  });
}

function objectFit(fit: Fit): string {
  return fit === 'stretch' ? 'fill' : fit;
}

/** Monte `root` (dimension logique du Display) dans `surface`, mis à l’échelle et tourné. */
export function mountStage(
  surface: HTMLElement,
  canvasWidth: number,
  canvasHeight: number,
  orientation: Orientation,
  fit: Fit,
): HTMLElement {
  const stage = document.createElement('div');
  stage.dataset.pixlovaStage = '';
  const apply = () => {
    const t = stageTransform(
      canvasWidth,
      canvasHeight,
      surface.clientWidth,
      surface.clientHeight,
      orientation,
      fit,
    );
    Object.assign(stage.style, {
      position: 'absolute',
      width: px(canvasWidth),
      height: px(canvasHeight),
      left: px(t.centerX - canvasWidth / 2),
      top: px(t.centerY - canvasHeight / 2),
      transformOrigin: '50% 50%',
      transform: `rotate(${t.rotation}deg) scale(${t.scale})`,
      overflow: 'hidden',
    });
  };
  // La surface doit être un conteneur positionné ; on conserve un positionnement existant (fixed, absolute…).
  if (getComputedStyle(surface).position === 'static') surface.style.position = 'relative';
  surface.style.overflow = 'hidden';
  surface.replaceChildren(stage);
  apply();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(apply).observe(surface);
  return stage;
}

function renderMedia(
  content: Extract<ManifestContent, { type: 'media' }>,
  width: number,
  height: number,
  context: RenderContext,
): Rendered {
  const url = context.resolveAsset(content.asset_id);
  if (content.media_kind === 'image') {
    const image = document.createElement('img');
    image.src = url;
    image.alt = '';
    image.decoding = 'async';
    Object.assign(image.style, {
      width: px(width),
      height: px(height),
      objectFit: objectFit(content.fit),
      display: 'block',
    });
    image.addEventListener('error', () =>
      context.onError?.({
        contentRef: content.id,
        reason: 'IMAGE_DECODE_FAILED',
        detail: content.asset_id,
      }),
    );
    return { element: image, destroy: () => image.removeAttribute('src') };
  }
  const video = createVideo(url, content.fit, content.muted, 1, true, width, height);
  video.addEventListener('error', () =>
    context.onError?.({
      contentRef: content.id,
      reason: 'VIDEO_DECODE_FAILED',
      detail: content.asset_id,
    }),
  );
  return { element: video, destroy: () => stopVideo(video) };
}

function createVideo(
  url: string,
  fit: Fit,
  muted: boolean,
  volume: number,
  loop: boolean,
  width: number,
  height: number,
): HTMLVideoElement {
  const video = document.createElement('video');
  // Politique V1 : vidéo muette par défaut (REN-003) ; l’autoplay sonore peut être bloqué (WEBPLY-003).
  video.muted = muted;
  video.defaultMuted = muted;
  video.volume = volume;
  video.loop = loop;
  video.autoplay = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  Object.assign(video.style, {
    width: px(width),
    height: px(height),
    objectFit: objectFit(fit),
    display: 'block',
    background: '#000',
  });
  void video.play().catch(() => undefined);
  return video;
}

function stopVideo(video: HTMLVideoElement): void {
  video.pause();
  video.removeAttribute('src');
  video.load();
}

function renderQr(element: Extract<CompositionElement, { type: 'qr' }>): SVGSVGElement {
  const qr = encode(element.props.data, { ecc: element.props.error_correction, border: 2 });
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${qr.size} ${qr.size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const background = document.createElementNS(ns, 'rect');
  background.setAttribute('width', String(qr.size));
  background.setAttribute('height', String(qr.size));
  background.setAttribute('fill', element.props.background);
  svg.append(background);
  let path = '';
  qr.data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  const modules = document.createElementNS(ns, 'path');
  modules.setAttribute('d', path);
  modules.setAttribute('fill', element.props.foreground);
  svg.append(modules);
  return svg;
}

const CLOCK_FORMATS: Record<
  Extract<CompositionElement, { type: 'clock' }>['props']['format'],
  Intl.DateTimeFormatOptions
> = {
  time_24h: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  time_24h_seconds: { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' },
  time_12h: { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' },
  date_short: { day: '2-digit', month: '2-digit', year: 'numeric' },
  date_long: { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
  date_time_24h: {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  },
};

function textStyle(
  target: HTMLElement,
  props: {
    font_family: string;
    font_size_px: number;
    color: string;
    alignment: 'left' | 'center' | 'right';
  },
): void {
  Object.assign(target.style, {
    fontFamily: `"${props.font_family}", sans-serif`,
    fontSize: px(props.font_size_px),
    color: props.color,
    textAlign: props.alignment,
    display: 'flex',
    flexDirection: 'column',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  });
}

function renderElement(element: CompositionElement, context: RenderContext): Rendered {
  const node = document.createElement('div');
  node.dataset.elementId = element.id;
  node.dataset.elementType = element.type;
  box(node, element.x, element.y, element.width, element.height);
  Object.assign(node.style, {
    transform: element.rotation ? `rotate(${element.rotation}deg)` : '',
    transformOrigin: '50% 50%',
    opacity: String(element.opacity),
  });
  const cleanups: (() => void)[] = [];
  switch (element.type) {
    case 'image':
    case 'video': {
      const media: Extract<ManifestContent, { type: 'media' }> = {
        id: element.id,
        type: 'media',
        media_kind: element.type,
        asset_id: element.props.asset_id,
        duration_ms: 1,
        fit: element.props.fit,
        muted: element.type === 'video' ? element.props.muted : true,
      };
      if (element.type === 'video') {
        const video = createVideo(
          context.resolveAsset(element.props.asset_id),
          element.props.fit,
          element.props.muted,
          element.props.volume,
          element.props.loop,
          element.width,
          element.height,
        );
        if (element.props.start_ms) video.currentTime = element.props.start_ms / 1000;
        node.append(video);
        cleanups.push(() => stopVideo(video));
      } else {
        const rendered = renderMedia(media, element.width, element.height, context);
        node.append(rendered.element);
        cleanups.push(rendered.destroy);
      }
      break;
    }
    case 'text': {
      const props = element.props;
      textStyle(node, props);
      Object.assign(node.style, {
        fontWeight: String(props.font_weight),
        lineHeight: props.line_height ? String(props.line_height) : 'normal',
        letterSpacing:
          props.letter_spacing_px !== undefined ? px(props.letter_spacing_px) : 'normal',
        // « safe » : un texte trop long déborde vers le bas au lieu d’être rogné en haut.
        justifyContent: { top: 'flex-start', middle: 'safe center', bottom: 'safe flex-end' }[
          props.vertical_alignment ?? 'top'
        ],
      });
      // textContent : le texte n’est jamais interprété comme du HTML.
      node.textContent = props.text;
      break;
    }
    case 'shape': {
      const props = element.props;
      Object.assign(node.style, {
        background: props.fill ?? 'transparent',
        border:
          props.stroke && props.stroke_width_px > 0
            ? `${props.stroke_width_px}px solid ${props.stroke}`
            : 'none',
        borderRadius: props.shape === 'ellipse' ? '50%' : px(props.corner_radius_px ?? 0),
        boxSizing: 'border-box',
      });
      break;
    }
    case 'qr':
      node.append(renderQr(element));
      break;
    case 'clock': {
      const props = element.props;
      textStyle(node, props);
      node.style.justifyContent = 'center';
      const format = new Intl.DateTimeFormat(props.locale, {
        ...CLOCK_FORMATS[props.format],
        timeZone: props.timezone ?? context.timezone,
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = () => {
        const now = context.now();
        node.textContent = format.format(now);
        // Réaligné sur la seconde : pas de dérive cumulée ; horloge locale, fonctionne hors ligne.
        timer = setTimeout(tick, 1000 - (now % 1000));
      };
      tick();
      cleanups.push(() => clearTimeout(timer));
      break;
    }
    case 'media_zone':
    case 'playlist_zone': {
      const content = context.contents.get(element.props.content_ref);
      if (!content) {
        context.onError?.({
          contentRef: element.props.content_ref,
          reason: 'CONTENT_MISSING',
          detail: element.id,
        });
        break;
      }
      const rendered = renderContent(content, element.width, element.height, context);
      node.append(rendered.element);
      cleanups.push(rendered.destroy);
      break;
    }
  }
  return { element: node, destroy: () => cleanups.forEach((cleanup) => cleanup()) };
}

export function renderComposition(
  document_: Composition,
  width: number,
  height: number,
  context: RenderContext,
): Rendered {
  const root = document.createElement('div');
  root.dataset.composition = '';
  Object.assign(root.style, {
    position: 'relative',
    width: px(width),
    height: px(height),
    overflow: 'hidden',
    background: document_.canvas.background,
  });
  // Le canvas de la composition est ajusté à la boîte qui l’accueille (contain, sans hypothèse de ratio).
  const inner = document.createElement('div');
  const fit = fitRect(document_.canvas.width, document_.canvas.height, width, height, 'contain');
  const scale = fit.width / document_.canvas.width;
  Object.assign(inner.style, {
    position: 'absolute',
    left: px(fit.x),
    top: px(fit.y),
    width: px(document_.canvas.width),
    height: px(document_.canvas.height),
    transformOrigin: '0 0',
    transform: scale === 1 ? '' : `scale(${scale})`,
  });
  root.append(inner);
  const children = renderOrder(document_.elements).map((element, index) => {
    const rendered = renderElement(element, context);
    // L’ordre calculé est matérialisé par z-index croissant.
    rendered.element.style.zIndex = String(index + 1);
    inner.append(rendered.element);
    return rendered;
  });
  return { element: root, destroy: () => children.forEach((child) => child.destroy()) };
}

function renderPlaylist(
  content: Extract<ManifestContent, { type: 'playlist' }>,
  width: number,
  height: number,
  context: RenderContext,
): Rendered {
  const root = document.createElement('div');
  root.dataset.playlist = content.id;
  Object.assign(root.style, {
    position: 'relative',
    width: px(width),
    height: px(height),
    overflow: 'hidden',
  });
  const durations = content.items.map((item) => item.duration_ms);
  const startedAt = context.now();
  let current: Rendered | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const show = () => {
    if (stopped) return;
    const position = playlistPosition(durations, context.now() - startedAt);
    const item = content.items[position.index]!;
    const target = context.contents.get(item.content_ref);
    const next = target
      ? renderContent(target, width, height, context)
      : { element: document.createElement('div'), destroy: () => undefined };
    if (!target)
      context.onError?.({
        contentRef: item.content_ref,
        reason: 'CONTENT_MISSING',
        detail: content.id,
      });
    next.element.dataset.playlistIndex = String(position.index);
    Object.assign(next.element.style, { position: 'absolute', left: '0', top: '0' });
    if (content.transition === 'fade' && current) {
      next.element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, fill: 'forwards' });
    }
    root.append(next.element);
    const previous = current;
    current = next;
    // L’élément précédent reste affiché pendant le fondu : pas d’image noire entre deux items.
    setTimeout(
      () => {
        previous?.destroy();
        previous?.element.remove();
      },
      content.transition === 'fade' ? 500 : 0,
    );
    timer = setTimeout(show, position.remainingMs);
  };
  show();
  return {
    element: root,
    destroy: () => {
      stopped = true;
      clearTimeout(timer);
      current?.destroy();
    },
  };
}

/** Rend un contenu du manifest dans une boîte de `width` × `height` pixels logiques. */
export function renderContent(
  content: ManifestContent,
  width: number,
  height: number,
  context: RenderContext,
): Rendered {
  switch (content.type) {
    case 'media': {
      const rendered = renderMedia(content, width, height, context);
      rendered.element.dataset.contentRef = content.id;
      return rendered;
    }
    case 'composition': {
      const rendered = renderComposition(content.document, width, height, context);
      rendered.element.dataset.contentRef = content.id;
      return rendered;
    }
    case 'playlist':
      return renderPlaylist(content, width, height, context);
  }
}
