/**
 * Lecture d’un Display : préparation d’un manifest (décodage des images, métadonnées
 * vidéo, polices) sans toucher à l’affichage, puis bascule atomique. L’ancien contenu
 * reste à l’écran jusqu’à ce que le nouveau soit présenté : aucune image noire.
 */
import type { ManifestContent, ManifestPayload } from '@pixlova/contracts';
import {
  loadCompositionFonts,
  mountStage,
  renderContent,
  type Rendered,
} from '@pixlova/render-engine/dom';
import type { Selection } from '@pixlova/render-engine';
import type { Emit, Playback } from './messages.js';

export type AssetResolver = (sha256: string) => string;
import { nextWakeMs, playbackOf, referencedAssets, selectNow, selectionKey } from './schedule.js';

const PREPARE_TIMEOUT_MS = 60_000;
const STATUS_INTERVAL_MS = 5_000;

interface Prepared {
  manifest: ManifestPayload;
  assets: Record<string, string>;
}

class PrepareError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PrepareError('PREPARATION_TIMEOUT', what)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function preloadImage(url: string): Promise<void> {
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    throw new PrepareError('DECODE_FAILED', 'image illisible');
  }
}

async function preloadVideo(url: string): Promise<void> {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'metadata';
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new PrepareError('DECODE_FAILED', 'vidéo illisible'));
    video.src = url;
  });
  video.removeAttribute('src');
  video.load();
}

export class DisplayPlayer {
  private readonly prepared = new Map<string, Prepared>();
  private active: { id: string; manifest: ManifestPayload; assets: Record<string, string> } | null =
    null;
  private stage: HTMLElement | null = null;
  private current: { key: string; rendered: Rendered; layer: HTMLElement } | null = null;
  private selection: Selection | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private playback: Playback = 'standby';
  private lastError: string | null = null;
  private pendingFrame: string | null = null;

  private readonly interval: ReturnType<typeof setInterval>;

  /**
   * @param surface élément plein écran qui reçoit la scène
   * @param emit messages vers l’hôte (préparé, première image, statut)
   * @param resolveAsset URL locale d’un asset vérifié à partir de son SHA-256
   */
  constructor(
    private readonly surface: HTMLElement,
    private readonly emit: Emit,
    private resolveAsset: AssetResolver,
  ) {
    this.interval = setInterval(() => this.reportStatus(), STATUS_INTERVAL_MS);
  }

  /** Arrête la lecture et libère les timers (fermeture, remplacement du Display). */
  dispose(): void {
    clearInterval(this.interval);
    clearTimeout(this.timer);
    this.current?.rendered.destroy();
    this.surface.replaceChildren();
    this.active = null;
  }

  /** Manifest affiché, s’il y en a un. */
  get activeManifestId(): string | null {
    return this.active?.id ?? null;
  }

  /** Change la résolution des assets (préfixe local fourni par l’hôte). */
  setAssetResolver(resolveAsset: AssetResolver): void {
    this.resolveAsset = resolveAsset;
  }

  private assetUrl(assets: Record<string, string>, assetId: string): string {
    const sha = assets[assetId];
    if (!sha) throw new PrepareError('ASSET_MISSING', assetId);
    return this.resolveAsset(sha);
  }

  /** Prépare sans afficher ; rejette si un élément nécessaire n’est pas utilisable. */
  async prepare(id: string, manifest: ManifestPayload, assets: Record<string, string>) {
    try {
      const mimes = new Map(manifest.assets.map((asset) => [asset.id, asset.mime_type]));
      const work: Promise<unknown>[] = [];
      for (const assetId of referencedAssets(manifest)) {
        const url = this.assetUrl(assets, assetId);
        const mime = mimes.get(assetId) ?? '';
        work.push(mime.startsWith('video/') ? preloadVideo(url) : preloadImage(url));
      }
      for (const content of manifest.contents) {
        if (content.type !== 'composition') continue;
        work.push(
          loadCompositionFonts(content.document).then((fonts) => {
            const missing = fonts.find((font) => !font.loaded);
            if (missing) {
              throw new PrepareError('FONT_UNAVAILABLE', `${missing.family} ${missing.weight}`);
            }
          }),
        );
      }
      await withTimeout(Promise.all(work), PREPARE_TIMEOUT_MS, 'préparation trop longue');
      // Seuls le manifest actif et le dernier préparé sont conservés.
      for (const key of this.prepared.keys()) {
        if (key !== this.active?.id) this.prepared.delete(key);
      }
      this.prepared.set(id, { manifest, assets });
      this.emit({ type: 'prepared', manifest_id: id, error: null });
    } catch (error) {
      const code = error instanceof PrepareError ? error.code : 'PREPARATION_FAILED';
      this.emit({
        type: 'prepared',
        manifest_id: id,
        error: { code, detail: error instanceof Error ? error.message.slice(0, 300) : '' },
      });
    }
  }

  /** Bascule vers un manifest préparé ; `frame` est émis à sa première présentation. */
  activate(id: string): void {
    const prepared = this.prepared.get(id);
    if (!prepared) {
      this.emit({
        type: 'prepared',
        manifest_id: id,
        error: { code: 'NOT_PREPARED', detail: id },
      });
      return;
    }
    const { manifest, assets } = prepared;
    this.active = { id, manifest, assets };
    this.stage = mountStageKeeping(
      this.surface,
      this.stage,
      manifest.display.width,
      manifest.display.height,
      manifest.display.orientation,
      manifest.display.fit,
    );
    this.current = null;
    this.pendingFrame = id;
    this.tick();
  }

  private tick(): void {
    clearTimeout(this.timer);
    const active = this.active;
    if (!active || !this.stage) return;
    const now = Date.now();
    const selection = selectNow(active.manifest, now);
    const key = selectionKey(selection);
    if (key !== this.current?.key) this.show(selection, key);
    this.selection = selection;
    this.timer = setTimeout(() => this.tick(), Math.max(50, nextWakeMs(selection, now * 1000)));
  }

  private show(selection: Selection, key: string): void {
    const active = this.active!;
    const stage = this.stage!;
    const layer = document.createElement('div');
    Object.assign(layer.style, { position: 'absolute', inset: '0' });
    let rendered: Rendered | null = null;
    this.lastError = null;
    if (selection.kind !== 'standby') {
      const contents = new Map<string, ManifestContent>(
        active.manifest.contents.map((content) => [content.id, content]),
      );
      const content = contents.get(selection.contentRef);
      if (content) {
        rendered = renderContent(
          content,
          active.manifest.display.width,
          active.manifest.display.height,
          {
            resolveAsset: (assetId) => this.assetUrl(active.assets, assetId),
            contents,
            timezone: active.manifest.display.timezone,
            now: () => Date.now(),
            onError: (error) => {
              this.lastError = error.reason;
              this.reportStatus();
            },
          },
        );
        layer.append(rendered.element);
      }
    }
    stage.append(layer);
    this.playback = selection.kind === 'standby' || rendered ? playbackOf(selection) : 'error';
    const previous = this.current;
    this.current = {
      key,
      rendered: rendered ?? { element: layer, destroy: () => undefined },
      layer,
    };
    // Deux images d’animation : le nouveau calque est composé avant de retirer l’ancien.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        previous?.rendered.destroy();
        previous?.layer.remove();
        if (this.pendingFrame === active.id && this.active?.id === active.id) {
          this.pendingFrame = null;
          this.emit({ type: 'frame', manifest_id: active.id });
        }
        this.reportStatus();
      }),
    );
  }

  reportStatus(): void {
    const selection = this.selection;
    this.emit({
      type: 'status',
      manifest_id: this.active?.id ?? null,
      playback: this.lastError ? 'error' : this.active ? this.playback : 'standby',
      content_ref: selection && selection.kind !== 'standby' ? selection.contentRef : null,
    });
  }
}

/** Réutilise la scène si la géométrie est identique, sinon en monte une nouvelle. */
function mountStageKeeping(
  surface: HTMLElement,
  stage: HTMLElement | null,
  width: number,
  height: number,
  orientation: 0 | 90 | 180 | 270,
  fit: 'contain' | 'cover' | 'stretch',
): HTMLElement {
  const signature = `${width}x${height}@${orientation}:${fit}`;
  if (stage?.isConnected && stage.dataset.signature === signature) return stage;
  // La nouvelle scène est montée par-dessus l’ancienne, retirée après composition.
  const previous = stage;
  const holder = document.createElement('div');
  Object.assign(holder.style, { position: 'absolute', inset: '0' });
  surface.append(holder);
  const mounted = mountStage(holder, width, height, orientation, fit);
  mounted.dataset.signature = signature;
  if (previous) {
    requestAnimationFrame(() => requestAnimationFrame(() => previous.parentElement?.remove()));
  }
  return mounted;
}
