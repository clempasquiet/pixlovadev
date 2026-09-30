import { useEffect, useRef } from 'react';
import { resolveCompositionDocument, type CompositionDocument } from '@pixlova/contracts';
import { renderComposition } from '@pixlova/render-engine/dom';
import type { MediaInfo } from './media.js';

/**
 * Rendu d’un document d’édition par le moteur partagé (REN-001) : la preview du créateur
 * utilise exactement le code des Players. Un média non prêt, supprimé ou non choisi est
 * rendu en rectangle neutre (placeholder), jamais par une URL arbitraire.
 */
export function RenderedDocument(props: {
  document: CompositionDocument;
  media: ReadonlyMap<string, MediaInfo | null>;
  timezone?: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const { document: doc, media, timezone } = props;
  useEffect(() => {
    const target = host.current;
    if (!target) return;
    const resolved = resolveCompositionDocument(
      doc,
      (id) => {
        const info = media.get(id);
        return info?.playbackUrl ? { asset_id: id, kind: info.type } : null;
      },
      { missing: 'placeholder' },
    );
    const rendered = renderComposition(resolved, doc.canvas.width, doc.canvas.height, {
      resolveAsset: (assetId) => media.get(assetId)?.playbackUrl ?? '',
      contents: new Map(),
      timezone: timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      now: () => Date.now(),
    });
    target.replaceChildren(rendered.element);
    return () => rendered.destroy();
  }, [doc, media, timezone]);
  return (
    <div
      ref={host}
      className={props.className}
      // Contexte d’empilement isolé : les z-index du rendu ne passent pas au-dessus de l’éditeur.
      style={{
        width: doc.canvas.width,
        height: doc.canvas.height,
        position: 'relative',
        isolation: 'isolate',
      }}
    />
  );
}

/** Aperçu mis à l’échelle d’un conteneur, sans hypothèse de ratio (vignettes, galerie). */
export function ScaledDocument(props: {
  document: CompositionDocument;
  media: ReadonlyMap<string, MediaInfo | null>;
  maxWidth: number;
  maxHeight: number;
  label: string;
}) {
  const { width, height } = props.document.canvas;
  const scale = Math.min(props.maxWidth / width, props.maxHeight / height);
  return (
    <div
      className="scaled-preview"
      role="img"
      aria-label={props.label}
      style={{ width: Math.round(width * scale), height: Math.round(height * scale) }}
    >
      <div style={{ transform: `scale(${scale})`, transformOrigin: '0 0', width, height }}>
        <RenderedDocument document={props.document} media={props.media} />
      </div>
    </div>
  );
}
