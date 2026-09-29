import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ErrorMessage, Loading } from '../ui.js';
import type { MediaInfo } from './media.js';

/** Choix d’un média prêt de la bibliothèque (MED-007 : seuls les médias prêts sont proposés). */
export function MediaPicker(props: {
  type: 'image' | 'video';
  onPick(media: MediaInfo): void;
  onClose(): void;
}) {
  const [items, setItems] = useState<MediaInfo[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState('');
  useEffect(() => {
    const params = new URLSearchParams({ type: props.type, status: 'ready', limit: '60' });
    if (search.trim()) params.set('q', search.trim());
    let cancelled = false;
    api<{ items: MediaInfo[] }>('GET', `/media?${params}`)
      .then((page) => {
        if (!cancelled) setItems(page.items);
      })
      .catch((caught: unknown) => setError(caught));
    return () => {
      cancelled = true;
    };
  }, [props.type, search]);

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-label={props.type === 'image' ? 'Choisir une image' : 'Choisir une vidéo'}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="page-header">
          <h2>{props.type === 'image' ? 'Choisir une image' : 'Choisir une vidéo'}</h2>
          <button type="button" className="link" onClick={props.onClose}>
            Fermer
          </button>
        </div>
        <input
          type="search"
          aria-label="Rechercher dans la bibliothèque"
          placeholder="Rechercher par nom"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <ErrorMessage error={error} />
        {items === null && !error && <Loading />}
        {items?.length === 0 && (
          <p className="state state-empty">
            Aucun média prêt. Ajoutez-en dans la Bibliothèque : seuls les médias préparés sont
            utilisables.
          </p>
        )}
        <ul className="media-grid picker-grid">
          {items?.map((media) => (
            <li key={media.id} className="media-card">
              <button
                type="button"
                className="media-open"
                aria-label={`Utiliser ${media.name}`}
                onClick={() => props.onPick(media)}
              >
                {media.thumbnail_url ? <img src={media.thumbnail_url} alt="" /> : media.name}
              </button>
              <div className="media-meta">
                <strong className="media-name">{media.name}</strong>
                <span className="muted">
                  {media.width}×{media.height}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
