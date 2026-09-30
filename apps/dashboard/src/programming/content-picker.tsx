import { useEffect, useState } from 'react';
import type { ContentRef } from '@pixlova/contracts';
import { api } from '../api.js';
import { MediaPicker } from '../compositions/media-picker.js';
import { ErrorMessage, Loading } from '../ui.js';

export interface PickedContent {
  ref: ContentRef;
  name: string;
  /** Durée connue (vidéo, composition) ; `null` pour une image. */
  duration_ms: number | null;
  media_type?: 'image' | 'video';
}

type Tab = 'image' | 'video' | 'composition' | 'playlist';

const TABS: [Tab, string][] = [
  ['image', 'Images'],
  ['video', 'Vidéos'],
  ['composition', 'Compositions'],
  ['playlist', 'Playlists'],
];

/**
 * Choix d’un contenu publiable (ADR-011) : média prêt, composition ou playlist publiée.
 * `types` restreint les onglets (une playlist ne contient pas de playlist).
 */
export function ContentPicker(props: {
  title: string;
  types?: readonly Tab[];
  onPick(content: PickedContent): void;
  onClose(): void;
}) {
  const tabs = TABS.filter(([tab]) => !props.types || props.types.includes(tab));
  const [tab, setTab] = useState<Tab>(tabs[0]![0]);
  const [items, setItems] = useState<
    { id: string; name: string; published_version: number | null }[] | null
  >(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (tab === 'image' || tab === 'video') return;
    let cancelled = false;
    setItems(null);
    const path = tab === 'composition' ? '/compositions' : '/playlists?published=true';
    api<{ items: { id: string; name: string; published_version: number | null }[] }>('GET', path)
      .then((page) => {
        if (!cancelled) setItems(page.items.filter((item) => item.published_version !== null));
      })
      .catch((caught: unknown) => setError(caught));
    return () => {
      cancelled = true;
    };
  }, [tab]);

  const tabBar = (
    <div className="inline-controls" role="tablist" aria-label="Type de contenu">
      {tabs.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={tab === value}
          className={tab === value ? '' : 'link'}
          onClick={() => setTab(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (tab === 'image' || tab === 'video') {
    return (
      <MediaPicker
        type={tab}
        header={tabs.length > 1 ? tabBar : null}
        onClose={props.onClose}
        onPick={(media) =>
          props.onPick({
            ref: { type: 'media', id: media.id },
            name: media.name,
            duration_ms: media.duration_ms ?? null,
            media_type: tab,
          })
        }
      />
    );
  }

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="page-header">
          <h2>{props.title}</h2>
          <button type="button" className="link" onClick={props.onClose}>
            Fermer
          </button>
        </div>
        {tabBar}
        <ErrorMessage error={error} />
        {items === null && !error && <Loading />}
        {items?.length === 0 && (
          <p className="state state-empty">
            Aucun contenu publié de ce type. Seules les versions publiées sont diffusables.
          </p>
        )}
        <ul className="plain-list">
          {items?.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="link"
                onClick={async () => {
                  let duration: number | null = null;
                  if (tab === 'composition') {
                    const detail = await api<{ document: { settings: { duration_ms?: number } } }>(
                      'GET',
                      `/compositions/${item.id}`,
                    ).catch(() => null);
                    duration = detail?.document.settings.duration_ms ?? null;
                  }
                  props.onPick({
                    ref: { type: tab, id: item.id },
                    name: item.name,
                    duration_ms: duration,
                  });
                }}
              >
                {item.name}
              </button>{' '}
              <span className="muted">version {item.published_version}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
