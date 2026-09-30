import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { PlaylistDocument, PlaylistItem } from '@pixlova/contracts';
import { api, ApiRequestError, idempotencyKey } from '../api.js';
import { useLoad } from '../data.js';
import { useSession } from '../session.js';
import { Empty, ErrorMessage, Forbidden, Loading } from '../ui.js';
import { ContentPicker, type PickedContent } from './content-picker.js';
import {
  browserTimezone,
  duplicateItem,
  formatDuration,
  instantToLocalInput,
  localInputToInstant,
  loopDurationMs,
  moveItem,
  removeAt,
} from './model.js';

interface PlaylistSummary {
  id: string;
  name: string;
  draft_revision: number;
  has_unpublished_changes: boolean;
  published_version: number | null;
  updated_at: string;
  item_count?: number;
}

interface Issue {
  severity: 'error' | 'warning';
  code: string;
  ref: string | null;
  message: string;
}

interface Reference {
  name: string;
  type: string;
  media_type: 'image' | 'video' | null;
  status: string;
  duration_ms: number | null;
}

interface PlaylistDetail extends PlaylistSummary {
  document: PlaylistDocument;
  references: Record<string, Reference>;
  issues: Issue[];
}

export function PublicationBadge(props: {
  published_version: number | null;
  has_unpublished_changes: boolean;
}) {
  return (
    <>
      {props.published_version ? (
        <span className="badge badge-ready">Version {props.published_version}</span>
      ) : (
        <span className="badge">Brouillon</span>
      )}
      {props.published_version && props.has_unpublished_changes && (
        <span className="muted"> · modifications non publiées</span>
      )}
    </>
  );
}

export function PlaylistsPage() {
  const { can } = useSession();
  const canEdit = can('content.manage');
  const list = useLoad<{ items: PlaylistSummary[] }>('/playlists');
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  return (
    <section>
      <h1>Playlists</h1>
      {canEdit ? (
        <form
          className="card narrow"
          onSubmit={async (event) => {
            event.preventDefault();
            const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
            try {
              setError(null);
              const created = await api<{ id: string }>(
                'POST',
                '/playlists',
                { name },
                idempotencyKey(),
              );
              navigate(`/playlists/${created.id}`);
            } catch (caught) {
              setError(caught);
            }
          }}
        >
          <h2>Nouvelle playlist</h2>
          <div className="field">
            <label htmlFor="playlist-name">Nom</label>
            <input id="playlist-name" name="name" required maxLength={120} />
          </div>
          <ErrorMessage error={error} />
          <button type="submit">Créer la playlist</button>
        </form>
      ) : (
        <Forbidden reason="Votre rôle permet de consulter les playlists, pas de les modifier." />
      )}
      <ErrorMessage error={list.error} />
      {!list.data && !list.error && <Loading />}
      {list.data?.items.length === 0 && <Empty>Aucune playlist pour le moment.</Empty>}
      {list.data && list.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Nom</th>
              <th scope="col">Éléments</th>
              <th scope="col">État</th>
              <th scope="col">Modifiée</th>
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((item) => (
              <tr key={item.id}>
                <td>
                  <Link to={`/playlists/${item.id}`}>{item.name}</Link>
                </td>
                <td>{item.item_count ?? '—'}</td>
                <td>
                  <PublicationBadge {...item} />
                </td>
                <td>{new Date(item.updated_at).toLocaleString('fr-FR')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function IssueList({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="issues" aria-label="Anomalies">
      {issues.map((issue, index) => (
        <li
          key={`${issue.code}-${index}`}
          className={issue.severity === 'error' ? 'danger-text' : 'muted'}
        >
          {issue.severity === 'error' ? 'Bloquant : ' : 'Attention : '}
          {issue.message}
        </li>
      ))}
    </ul>
  );
}
export { IssueList };

/** Éditeur de playlist (PLN-001) : ordre, durées, activation, validités, puis publication. */
export function PlaylistEditorPage() {
  const { id } = useParams();
  const { can } = useSession();
  const canEdit = can('content.manage');
  const navigate = useNavigate();
  const [detail, setDetail] = useState<PlaylistDetail | null>(null);
  const [doc, setDoc] = useState<PlaylistDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, Reference>>({});

  async function load() {
    try {
      const loaded = await api<PlaylistDetail>('GET', `/playlists/${id}`);
      setDetail(loaded);
      setDoc(loaded.document);
      setNames(loaded.references);
      setDirty(false);
    } catch (caught) {
      setError(caught);
    }
  }
  useEffect(() => {
    void load();
  }, [id]);

  const durations = useMemo(
    () => new Map(Object.entries(names).map(([key, ref]) => [key, ref.duration_ms])),
    [names],
  );
  if (!detail || !doc) return error ? <ErrorMessage error={error} /> : <Loading />;

  const change = (next: PlaylistDocument) => {
    setDoc(next);
    setDirty(true);
    setNotice(null);
  };
  const setItems = (items: PlaylistItem[]) => change({ ...doc, items });
  const patchItem = (index: number, patch: Partial<PlaylistItem>) =>
    setItems(doc.items.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  async function save(): Promise<PlaylistDetail | null> {
    try {
      setError(null);
      const saved = await api<PlaylistDetail>('PUT', `/playlists/${id}/draft`, {
        revision: detail!.draft_revision,
        document: doc,
      });
      setDetail({ ...detail!, ...saved, document: doc! });
      setNames(saved.references);
      setDirty(false);
      return saved;
    } catch (caught) {
      setError(caught);
      return null;
    }
  }

  async function publish() {
    const saved = dirty ? await save() : detail;
    if (!saved) return;
    try {
      setError(null);
      const result = await api<{ version: number }>('POST', `/playlists/${id}/publish`, {
        revision: saved.draft_revision,
      });
      setNotice(
        `Version ${result.version} publiée. Les écrans concernés reçoivent un nouveau manifest après compilation.`,
      );
      await load();
    } catch (caught) {
      setError(caught);
    }
  }

  const loop = loopDurationMs(doc.items, durations);
  const errors = detail.issues.filter((issue) => issue.severity === 'error');
  const tz = browserTimezone();

  return (
    <section>
      <p>
        <Link to="/playlists">← Playlists</Link>
      </p>
      <div className="page-header">
        <h1>{detail.name}</h1>
        <PublicationBadge {...detail} />
      </div>
      {notice && (
        <p className="alert alert-info" role="status">
          {notice}
        </p>
      )}
      <ErrorMessage error={error} />
      {error instanceof ApiRequestError && Array.isArray(error.body.details?.issues) && (
        <IssueList issues={error.body.details.issues as Issue[]} />
      )}
      <div className="card">
        <div className="inline-controls">
          <label>
            Transition{' '}
            <select
              aria-label="Transition"
              value={doc.transition}
              disabled={!canEdit}
              onChange={(e) => change({ ...doc, transition: e.target.value as 'cut' | 'fade' })}
            >
              <option value="cut">Coupe</option>
              <option value="fade">Fondu</option>
            </select>
          </label>
          <span className="muted">
            Durée d’un tour : {loop === null ? 'incomplète' : formatDuration(loop)}
          </span>
          {canEdit && (
            <>
              <button type="button" onClick={() => setPicking(true)}>
                + Ajouter un contenu
              </button>
              <button type="button" disabled={!dirty} onClick={() => void save()}>
                Enregistrer
              </button>
              <button type="button" onClick={() => void publish()}>
                Publier
              </button>
            </>
          )}
        </div>
        {!dirty && <IssueList issues={detail.issues} />}
        {dirty && <p className="muted">Modifications non enregistrées.</p>}
      </div>
      {doc.items.length === 0 ? (
        <Empty>Aucun élément. Ajoutez des médias ou des compositions publiées.</Empty>
      ) : (
        <table aria-label="Éléments de la playlist">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Contenu</th>
              <th scope="col">Durée (s)</th>
              <th scope="col">Actif</th>
              <th scope="col">Validité ({tz})</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {doc.items.map((item, index) => {
              const ref = names[`${item.content.type}:${item.content.id}`];
              const video = ref?.media_type === 'video';
              return (
                <tr key={item.id}>
                  <td>{index + 1}</td>
                  <td>
                    {ref?.name ?? 'Contenu introuvable'}
                    <span className="muted">
                      {' '}
                      ·{' '}
                      {item.content.type === 'composition'
                        ? 'composition'
                        : (ref?.media_type ?? 'média')}
                    </span>
                  </td>
                  <td>
                    <input
                      type="number"
                      aria-label={`Durée de l’élément ${index + 1} en secondes`}
                      min={0}
                      max={86400}
                      step={0.5}
                      disabled={!canEdit}
                      value={item.duration_ms === null ? '' : item.duration_ms / 1000}
                      placeholder={
                        ref?.duration_ms
                          ? String(ref.duration_ms / 1000)
                          : video
                            ? 'vidéo'
                            : 'requis'
                      }
                      onChange={(e) =>
                        patchItem(index, {
                          duration_ms:
                            e.target.value === '' || e.target.valueAsNumber <= 0
                              ? null
                              : Math.round(e.target.valueAsNumber * 1000),
                        })
                      }
                    />
                    {video && item.duration_ms !== null && ref?.duration_ms && (
                      <span className="hint">
                        {item.duration_ms < ref.duration_ms
                          ? 'vidéo coupée'
                          : item.duration_ms > ref.duration_ms
                            ? 'vidéo en boucle'
                            : ''}
                      </span>
                    )}
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Élément ${index + 1} actif`}
                      checked={item.enabled}
                      disabled={!canEdit}
                      onChange={(e) => patchItem(index, { enabled: e.target.checked })}
                    />
                  </td>
                  <td>
                    <span className="inline-controls">
                      <input
                        type="datetime-local"
                        aria-label={`Début de validité de l’élément ${index + 1}`}
                        disabled={!canEdit}
                        value={instantToLocalInput(item.valid_from)}
                        onChange={(e) =>
                          patchItem(index, { valid_from: localInputToInstant(e.target.value) })
                        }
                      />
                      <input
                        type="datetime-local"
                        aria-label={`Fin de validité de l’élément ${index + 1}`}
                        disabled={!canEdit}
                        value={instantToLocalInput(item.valid_until)}
                        onChange={(e) =>
                          patchItem(index, { valid_until: localInputToInstant(e.target.value) })
                        }
                      />
                    </span>
                  </td>
                  <td>
                    {canEdit && (
                      <span className="inline-controls">
                        <button
                          type="button"
                          className="link"
                          aria-label={`Monter l’élément ${index + 1}`}
                          disabled={index === 0}
                          onClick={() => setItems(moveItem(doc.items, index, -1))}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="link"
                          aria-label={`Descendre l’élément ${index + 1}`}
                          disabled={index === doc.items.length - 1}
                          onClick={() => setItems(moveItem(doc.items, index, 1))}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="link"
                          onClick={() =>
                            setItems(duplicateItem(doc.items, index, crypto.randomUUID()))
                          }
                        >
                          Dupliquer
                        </button>
                        <button
                          type="button"
                          className="link danger-text"
                          onClick={() => setItems(removeAt(doc.items, index))}
                        >
                          Retirer
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="hint">
        Un élément désactivé ou hors validité est ignoré ; une playlist sans élément jouable cède la
        place au niveau de programmation inférieur puis au repli de l’écran. À chaque changement de
        source, la lecture reprend au premier élément.
      </p>
      {canEdit && (
        <p>
          <button
            type="button"
            className="link danger-text"
            onClick={async () => {
              if (
                !confirm(
                  `Supprimer « ${detail.name} » ? Les écrans qui la diffusent seront recompilés.`,
                )
              )
                return;
              await api('DELETE', `/playlists/${id}`);
              navigate('/playlists');
            }}
          >
            Supprimer la playlist
          </button>
        </p>
      )}
      {picking && (
        <ContentPicker
          title="Ajouter à la playlist"
          types={['image', 'video', 'composition']}
          onClose={() => setPicking(false)}
          onPick={(picked: PickedContent) => {
            setNames({
              ...names,
              [`${picked.ref.type}:${picked.ref.id}`]: {
                name: picked.name,
                type: picked.ref.type,
                media_type: picked.media_type ?? null,
                status: 'ready',
                duration_ms: picked.duration_ms,
              },
            });
            setItems([
              ...doc.items,
              {
                id: crypto.randomUUID(),
                content: picked.ref as PlaylistItem['content'],
                duration_ms: picked.media_type === 'image' ? 10000 : null,
                enabled: true,
                valid_from: null,
                valid_until: null,
              },
            ]);
            setPicking(false);
          }}
        />
      )}
      {errors.length > 0 && !dirty && (
        <p className="muted">Corrigez les anomalies bloquantes avant de publier.</p>
      )}
    </section>
  );
}
