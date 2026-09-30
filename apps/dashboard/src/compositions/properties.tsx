import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api.js';
import {
  QUALIFIED_FONT_NAMES,
  QUALIFIED_FONTS,
  type CompositionDocument,
  type DocumentElement,
} from '@pixlova/contracts';
import type { MediaInfo } from './media.js';
import { percent } from './state.js';

type Change = (doc: CompositionDocument) => void;

function NumberInput(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  hint?: string;
  onChange(value: number): void;
}) {
  const id = `prop-${props.label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="prop">
      <label htmlFor={id}>{props.label}</label>
      <input
        id={id}
        type="number"
        value={Number.isFinite(props.value) ? props.value : 0}
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        disabled={props.disabled}
        onChange={(event) => {
          const value = event.target.valueAsNumber;
          if (Number.isFinite(value)) props.onChange(value);
        }}
      />
      {props.hint && <span className="hint">{props.hint}</span>}
    </div>
  );
}

function ColorInput(props: {
  label: string;
  value: string | null;
  allowNone?: boolean;
  onChange(value: string | null): void;
}) {
  const id = `prop-${props.label.replace(/\W+/g, '-').toLowerCase()}`;
  const hex = (props.value ?? '#000000').slice(0, 7);
  return (
    <div className="prop">
      <label htmlFor={id}>{props.label}</label>
      <span className="inline-controls">
        <input
          id={id}
          type="color"
          value={hex}
          disabled={props.value === null}
          onChange={(e) => props.onChange(e.target.value.toUpperCase())}
        />
        {props.allowNone && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={props.value === null}
              onChange={(e) => props.onChange(e.target.checked ? null : '#FFFFFF')}
            />
            Aucune
          </label>
        )}
      </span>
    </div>
  );
}

function Select<T extends string>(props: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange(value: T): void;
}) {
  const id = `prop-${props.label.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <div className="prop">
      <label htmlFor={id}>{props.label}</label>
      <select id={id} value={props.value} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

const ALIGN = [
  ['left', 'Gauche'],
  ['center', 'Centre'],
  ['right', 'Droite'],
] as const;
const FIT = [
  ['contain', 'Contenir'],
  ['cover', 'Couvrir (recadrer)'],
  ['stretch', 'Étirer'],
] as const;
const FONTS = QUALIFIED_FONT_NAMES.map((name) => [name, name] as const);

/** Propriétés du canvas (aucun élément sélectionné). */
export function CanvasProperties(props: {
  doc: CompositionDocument;
  onChange: Change;
  disabled: boolean;
}) {
  const { doc } = props;
  const set = (patch: Partial<CompositionDocument>) => props.onChange({ ...doc, ...patch });
  return (
    <fieldset disabled={props.disabled}>
      <legend>Canvas</legend>
      <div className="prop-grid">
        <NumberInput
          label="Largeur (px)"
          value={doc.canvas.width}
          min={1}
          max={32767}
          onChange={(width) => set({ canvas: { ...doc.canvas, width } })}
        />
        <NumberInput
          label="Hauteur (px)"
          value={doc.canvas.height}
          min={1}
          max={32767}
          onChange={(height) => set({ canvas: { ...doc.canvas, height } })}
        />
      </div>
      <ColorInput
        label="Fond"
        value={doc.canvas.background}
        onChange={(background) =>
          set({ canvas: { ...doc.canvas, background: background ?? '#000000' } })
        }
      />
      <NumberInput
        label="Durée (s)"
        value={(doc.settings.duration_ms ?? 0) / 1000}
        min={0}
        max={86400}
        step={0.5}
        hint="0 : durée donnée par la playlist"
        onChange={(seconds) => {
          const { duration_ms: _previous, ...rest } = doc.settings;
          void _previous;
          set({
            settings: seconds > 0 ? { ...rest, duration_ms: Math.round(seconds * 1000) } : rest,
          });
        }}
      />
      <Select
        label="Son"
        value={doc.settings.audio_policy}
        options={[
          ['muted', 'Composition muette'],
          ['single_source', 'Une vidéo sonore au plus'],
        ]}
        onChange={(audio_policy) => set({ settings: { ...doc.settings, audio_policy } })}
      />
    </fieldset>
  );
}

/** Propriétés communes et propres au type de l’élément sélectionné (CMP-001, CMP-002). */
export function ElementProperties(props: {
  doc: CompositionDocument;
  element: DocumentElement;
  media: ReadonlyMap<string, MediaInfo | null>;
  disabled: boolean;
  onChange(patch: Partial<DocumentElement>): void;
  onProps(patch: Record<string, unknown>): void;
  onPickMedia(): void;
}) {
  const { element, doc } = props;
  const locked = props.disabled || element.locked;
  let specific: ReactNode = null;
  switch (element.type) {
    case 'text': {
      const font = QUALIFIED_FONTS[element.props.font_family];
      specific = (
        <>
          <div className="prop">
            <label htmlFor="prop-texte">Texte</label>
            <textarea
              id="prop-texte"
              rows={4}
              value={element.props.text}
              maxLength={2000}
              onChange={(e) => props.onProps({ text: e.target.value })}
            />
          </div>
          <Select
            label="Police"
            value={element.props.font_family}
            options={FONTS}
            onChange={(font_family) => {
              const next = QUALIFIED_FONTS[font_family];
              const weight = Math.min(
                next.maxWeight,
                Math.max(next.minWeight, element.props.font_weight),
              );
              props.onProps({ font_family, font_weight: Math.round(weight / 100) * 100 });
            }}
          />
          <div className="prop-grid">
            <NumberInput
              label="Taille (px)"
              value={element.props.font_size_px}
              min={1}
              max={4000}
              onChange={(font_size_px) => props.onProps({ font_size_px })}
            />
            <NumberInput
              label="Graisse"
              value={element.props.font_weight}
              min={font.minWeight}
              max={font.maxWeight}
              step={100}
              onChange={(font_weight) => props.onProps({ font_weight })}
            />
            <NumberInput
              label="Interligne"
              value={element.props.line_height ?? 1.2}
              min={0.5}
              max={4}
              step={0.05}
              onChange={(line_height) => props.onProps({ line_height })}
            />
            <NumberInput
              label="Espacement (px)"
              value={element.props.letter_spacing_px ?? 0}
              min={-100}
              max={1000}
              step={0.5}
              onChange={(letter_spacing_px) => props.onProps({ letter_spacing_px })}
            />
          </div>
          <ColorInput
            label="Couleur"
            value={element.props.color}
            onChange={(color) => props.onProps({ color })}
          />
          <Select
            label="Alignement"
            value={element.props.alignment}
            options={ALIGN}
            onChange={(alignment) => props.onProps({ alignment })}
          />
          <Select
            label="Alignement vertical"
            value={element.props.vertical_alignment ?? 'top'}
            options={[
              ['top', 'Haut'],
              ['middle', 'Milieu'],
              ['bottom', 'Bas'],
            ]}
            onChange={(vertical_alignment) => props.onProps({ vertical_alignment })}
          />
        </>
      );
      break;
    }
    case 'shape':
      specific = (
        <>
          <Select
            label="Forme"
            value={element.props.shape}
            options={[
              ['rectangle', 'Rectangle'],
              ['ellipse', 'Ellipse'],
            ]}
            onChange={(shape) => props.onProps({ shape })}
          />
          <ColorInput
            label="Remplissage"
            value={element.props.fill}
            allowNone
            onChange={(fill) => props.onProps({ fill })}
          />
          <ColorInput
            label="Bordure"
            value={element.props.stroke}
            allowNone
            onChange={(stroke) => props.onProps({ stroke })}
          />
          <div className="prop-grid">
            <NumberInput
              label="Épaisseur (px)"
              value={element.props.stroke_width_px}
              min={0}
              max={1000}
              onChange={(stroke_width_px) => props.onProps({ stroke_width_px })}
            />
            {element.props.shape === 'rectangle' && (
              <NumberInput
                label="Arrondi (px)"
                value={element.props.corner_radius_px ?? 0}
                min={0}
                max={16383}
                onChange={(corner_radius_px) => props.onProps({ corner_radius_px })}
              />
            )}
          </div>
        </>
      );
      break;
    case 'image':
    case 'video': {
      const info = element.props.media_id ? props.media.get(element.props.media_id) : null;
      specific = (
        <>
          <div className="prop">
            <span className="prop-label">Média</span>
            <span>
              {element.props.media_id === null
                ? 'Aucun média choisi'
                : info
                  ? `${info.name}${info.status !== 'ready' ? ' (non prêt)' : ''}`
                  : 'Média introuvable'}
            </span>
            <button type="button" onClick={props.onPickMedia}>
              {element.props.media_id ? 'Remplacer' : 'Choisir'}
            </button>
          </div>
          <Select
            label="Ajustement"
            value={element.props.fit}
            options={FIT}
            onChange={(fit) => props.onProps({ fit })}
          />
          {element.type === 'video' && (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={element.props.muted}
                  onChange={(e) => props.onProps({ muted: e.target.checked })}
                />
                Muette
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={element.props.loop}
                  onChange={(e) => props.onProps({ loop: e.target.checked })}
                />
                En boucle
              </label>
              <div className="prop-grid">
                <NumberInput
                  label="Volume (%)"
                  value={Math.round(element.props.volume * 100)}
                  min={0}
                  max={100}
                  onChange={(v) => props.onProps({ volume: v / 100 })}
                />
                <NumberInput
                  label="Début (s)"
                  value={(element.props.start_ms ?? 0) / 1000}
                  min={0}
                  step={0.1}
                  onChange={(s) =>
                    props.onProps({ start_ms: s > 0 ? Math.round(s * 1000) : undefined })
                  }
                />
                <NumberInput
                  label="Fin (s)"
                  value={(element.props.end_ms ?? 0) / 1000}
                  min={0}
                  step={0.1}
                  hint="0 : jusqu’à la fin"
                  onChange={(s) =>
                    props.onProps({ end_ms: s > 0 ? Math.round(s * 1000) : undefined })
                  }
                />
              </div>
            </>
          )}
        </>
      );
      break;
    }
    case 'qr':
      specific = (
        <>
          <div className="prop">
            <label htmlFor="prop-contenu">Contenu (URL, texte, mailto:, WIFI:)</label>
            <textarea
              id="prop-contenu"
              rows={2}
              value={element.props.data}
              maxLength={1000}
              onChange={(e) => props.onProps({ data: e.target.value || ' ' })}
            />
          </div>
          <ColorInput
            label="Modules"
            value={element.props.foreground}
            onChange={(foreground) => props.onProps({ foreground })}
          />
          <ColorInput
            label="Fond du QR"
            value={element.props.background}
            onChange={(background) => props.onProps({ background })}
          />
          <Select
            label="Correction d’erreur"
            value={element.props.error_correction}
            options={[
              ['L', 'L (7 %)'],
              ['M', 'M (15 %)'],
              ['Q', 'Q (25 %)'],
              ['H', 'H (30 %)'],
            ]}
            onChange={(error_correction) => props.onProps({ error_correction })}
          />
        </>
      );
      break;
    case 'playlist_zone':
      specific = (
        <PlaylistSelect
          value={element.props.playlist_id}
          disabled={locked}
          onChange={(playlist_id) => props.onProps({ playlist_id })}
        />
      );
      break;
    case 'clock':
      specific = (
        <>
          <Select
            label="Format"
            value={element.props.format}
            options={[
              ['time_24h', '14:05'],
              ['time_24h_seconds', '14:05:09'],
              ['time_12h', '2:05 PM'],
              ['date_short', '15/01/2026'],
              ['date_long', 'jeudi 15 janvier 2026'],
              ['date_time_24h', 'jeu. 15 janv. 14:05'],
            ]}
            onChange={(format) => props.onProps({ format })}
          />
          <div className="prop">
            <label htmlFor="prop-fuseau">Fuseau (vide : celui de l’écran)</label>
            <input
              id="prop-fuseau"
              value={element.props.timezone ?? ''}
              placeholder="Europe/Paris"
              onChange={(e) => props.onProps({ timezone: e.target.value.trim() || null })}
            />
          </div>
          <Select
            label="Police"
            value={element.props.font_family}
            options={FONTS}
            onChange={(font_family) => props.onProps({ font_family })}
          />
          <NumberInput
            label="Taille (px)"
            value={element.props.font_size_px}
            min={1}
            max={4000}
            onChange={(font_size_px) => props.onProps({ font_size_px })}
          />
          <ColorInput
            label="Couleur"
            value={element.props.color}
            onChange={(color) => props.onProps({ color })}
          />
          <Select
            label="Alignement"
            value={element.props.alignment}
            options={ALIGN}
            onChange={(alignment) => props.onProps({ alignment })}
          />
        </>
      );
      break;
  }
  return (
    <>
      <fieldset disabled={props.disabled}>
        <legend>Position et taille</legend>
        <div className="prop-grid">
          <NumberInput
            label="X (px)"
            value={element.x}
            min={-32767}
            max={32767}
            disabled={locked}
            hint={percent(element.x, doc.canvas.width)}
            onChange={(x) => props.onChange({ x })}
          />
          <NumberInput
            label="Y (px)"
            value={element.y}
            min={-32767}
            max={32767}
            disabled={locked}
            hint={percent(element.y, doc.canvas.height)}
            onChange={(y) => props.onChange({ y })}
          />
          <NumberInput
            label="Largeur"
            value={element.width}
            min={1}
            max={32767}
            disabled={locked}
            hint={percent(element.width, doc.canvas.width)}
            onChange={(width) => props.onChange({ width })}
          />
          <NumberInput
            label="Hauteur"
            value={element.height}
            min={1}
            max={32767}
            disabled={locked}
            hint={percent(element.height, doc.canvas.height)}
            onChange={(height) => props.onChange({ height })}
          />
          <NumberInput
            label="Rotation (°)"
            value={element.rotation}
            min={-360}
            max={360}
            disabled={locked}
            onChange={(rotation) => props.onChange({ rotation })}
          />
          <NumberInput
            label="Opacité (%)"
            value={Math.round(element.opacity * 100)}
            min={0}
            max={100}
            onChange={(v) => props.onChange({ opacity: v / 100 })}
          />
        </div>
      </fieldset>
      <fieldset disabled={props.disabled}>
        <legend>Contenu</legend>
        {specific}
      </fieldset>
    </>
  );
}

/** Playlist d’une zone : seules les playlists publiées sont proposées (ADR-011). */
function PlaylistSelect(props: {
  value: string | null;
  disabled: boolean;
  onChange(id: string | null): void;
}) {
  const [items, setItems] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<{ items: { id: string; name: string }[] }>('GET', '/playlists?published=true')
      .then((page) => {
        if (!cancelled) setItems(page.items);
      })
      .catch(() => setItems([]));
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <div className="prop">
      <label htmlFor="prop-playlist">Playlist</label>
      <select
        id="prop-playlist"
        value={props.value ?? ''}
        disabled={props.disabled || items === null}
        onChange={(e) => props.onChange(e.target.value || null)}
      >
        <option value="">Aucune playlist choisie</option>
        {items?.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
      <span className="hint">
        La zone joue la dernière version publiée ; elle est vide dans l’aperçu.
      </span>
    </div>
  );
}
