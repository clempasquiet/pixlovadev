import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import { api, ApiRequestError } from '../api.js';
import { useLoad } from '../data.js';
import { useSession } from '../session.js';
import { Empty, ErrorMessage, Forbidden, Loading } from '../ui.js';

type MediaStatus = 'uploading' | 'processing' | 'ready' | 'error';

interface Media {
  id: string;
  name: string;
  type: 'image' | 'video';
  status: MediaStatus;
  site_id: string | null;
  folder_id: string | null;
  mime_type: string;
  original_filename: string;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  error: { code: string; message: string | null } | null;
  tags: string[];
  thumbnail_url: string | null;
  created_at: string;
  deleted_at: string | null;
  purge_after: string | null;
  purging: boolean;
}

interface MediaDetail extends Media {
  checksum_sha256: string | null;
  assets: {
    variant: 'original' | 'playback' | 'thumbnail';
    profile: string;
    mime_type: string;
    size_bytes: number;
    checksum_sha256: string;
    width: number | null;
    height: number | null;
  }[];
  usages: { type: string; id: string; name: string }[];
}

interface Folder {
  id: string;
  name: string;
  parent_id: string | null;
  site_id: string | null;
}

interface Page {
  items: Media[];
  has_more: boolean;
  next_cursor: string | null;
}

/** Types acceptés (ADR-009) : le format réel est revérifié côté serveur. */
const ACCEPT =
  'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,video/x-matroska';

const STATUS_LABEL: Record<MediaStatus, string> = {
  uploading: 'Envoi non finalisé',
  processing: 'En préparation',
  ready: 'Prêt',
  error: 'Erreur',
};

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1000) return `${bytes} o`;
  const units = ['ko', 'Mo', 'Go', 'To'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toLocaleString('fr-FR', { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function describe(media: Media): string {
  const parts = [media.type === 'image' ? 'Image' : 'Vidéo'];
  if (media.width && media.height) parts.push(`${media.width}×${media.height}`);
  if (media.duration_ms) parts.push(formatDuration(media.duration_ms));
  parts.push(formatBytes(media.size_bytes));
  return parts.join(' · ');
}

// --- Envois ------------------------------------------------------------------------------

interface UploadTask {
  key: string;
  file: File;
  state: 'waiting' | 'sending' | 'finalizing' | 'done' | 'failed' | 'cancelled';
  progress: number;
  mediaId?: string;
  uploadId?: string;
  error?: string;
  xhr?: XMLHttpRequest;
}

function putFile(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (ratio: number) => void,
  onStart: (xhr: XMLHttpRequest) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Envoi refusé par le stockage (${xhr.status}).`));
    xhr.onerror = () => reject(new Error('Connexion interrompue pendant l’envoi.'));
    xhr.onabort = () => reject(new Error('Envoi annulé.'));
    onStart(xhr);
    xhr.send(file);
  });
}

function useUploads(folderId: string | null, onChange: () => void) {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const update = useCallback((key: string, patch: Partial<UploadTask>) => {
    setTasks((current) => current.map((task) => (task.key === key ? { ...task, ...patch } : task)));
  }, []);

  const run = useCallback(
    async (task: UploadTask) => {
      try {
        update(task.key, { state: 'sending', progress: 0 });
        const session = await api<{
          upload_id: string;
          media: { id: string };
          upload: { url: string; headers: Record<string, string> };
        }>(
          'POST',
          '/media/upload-session',
          {
            filename: task.file.name,
            mime_type: task.file.type,
            size_bytes: task.file.size,
            ...(folderId ? { folder_id: folderId } : {}),
          },
          { 'idempotency-key': task.key },
        );
        update(task.key, { uploadId: session.upload_id, mediaId: session.media.id });
        onChange();
        await putFile(
          session.upload.url,
          session.upload.headers,
          task.file,
          (ratio) => update(task.key, { progress: ratio }),
          (xhr) => update(task.key, { xhr }),
        );
        update(task.key, { state: 'finalizing', progress: 1 });
        await api('POST', `/media/upload-session/${session.upload_id}/complete`);
        update(task.key, { state: 'done' });
      } catch (caught) {
        update(task.key, {
          state: 'failed',
          error: caught instanceof Error ? caught.message : 'Envoi impossible.',
        });
      } finally {
        onChange();
      }
    },
    [folderId, onChange, update],
  );

  const add = useCallback(
    (files: FileList | File[]) => {
      const created = [...files].map<UploadTask>((file) => ({
        key: crypto.randomUUID(),
        file,
        state: 'waiting',
        progress: 0,
      }));
      setTasks((current) => [...created, ...current]);
      // Envois indépendants, suivis individuellement (MED-001).
      void (async () => {
        for (const task of created) await run(task);
      })();
    },
    [run],
  );

  const cancel = useCallback(
    async (task: UploadTask) => {
      task.xhr?.abort();
      if (task.uploadId) {
        await api('POST', `/media/upload-session/${task.uploadId}/abort`).catch(() => undefined);
      }
      update(task.key, { state: 'cancelled' });
      onChange();
    },
    [onChange, update],
  );

  const clearFinished = useCallback(() => {
    setTasks((current) =>
      current.filter((task) => ['waiting', 'sending', 'finalizing'].includes(task.state)),
    );
  }, []);

  return { tasks, add, cancel, clearFinished };
}

function UploadQueue({ uploads }: { uploads: ReturnType<typeof useUploads> }) {
  if (uploads.tasks.length === 0) return null;
  const label: Record<UploadTask['state'], string> = {
    waiting: 'En attente',
    sending: 'Envoi',
    finalizing: 'Vérification',
    done: 'Reçu',
    failed: 'Échec',
    cancelled: 'Annulé',
  };
  return (
    <div className="card" aria-label="Envois en cours">
      <div className="page-header">
        <h2>Envois</h2>
        <button type="button" className="link" onClick={uploads.clearFinished}>
          Masquer les envois terminés
        </button>
      </div>
      <ul className="uploads">
        {uploads.tasks.map((task) => (
          <li key={task.key} data-state={task.state}>
            <span className="upload-name">{task.file.name}</span>
            <span className="muted">{formatBytes(task.file.size)}</span>
            <progress
              max={1}
              value={task.progress}
              aria-label={`Progression de ${task.file.name}`}
            />
            <span className={task.state === 'failed' ? 'error-text' : 'muted'}>
              {label[task.state]}
              {task.state === 'sending' && ` ${Math.round(task.progress * 100)} %`}
              {task.error && ` : ${task.error}`}
            </span>
            {(task.state === 'sending' || task.state === 'waiting') && (
              <button type="button" className="link" onClick={() => void uploads.cancel(task)}>
                Annuler
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- Page ---------------------------------------------------------------------------------

export function LibraryPage() {
  const { can } = useSession();
  const canManage = can('content.manage');
  const [view, setView] = useState<'library' | 'trash'>('library');
  const [folderId, setFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [tag, setTag] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [items, setItems] = useState<Media[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const usage = useLoad<{ limit_bytes: number; used_bytes: number; reserved_bytes: number }>(
    '/media/usage',
  );
  const folders = useLoad<{ items: Folder[] }>('/media-folders');
  const tags = useLoad<{ items: string[] }>('/tags');

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (view === 'trash') params.set('trash', 'true');
    else if (folderId) params.set('folder_id', folderId);
    if (search.trim()) params.set('q', search.trim());
    if (type) params.set('type', type);
    if (status) params.set('status', status);
    if (tag) params.set('tag', tag);
    params.set('limit', '48');
    return params.toString();
  }, [view, folderId, search, type, status, tag]);

  const load = useCallback(async () => {
    try {
      setError(null);
      const page = await api<Page>('GET', `/media?${query}`);
      setItems(page.items);
      setCursor(page.next_cursor);
    } catch (caught) {
      setError(caught);
    }
  }, [query]);

  const refreshAll = useCallback(() => {
    void load();
    void usage.reload();
    void tags.reload();
  }, [load, usage, tags]);

  useEffect(() => {
    void load();
  }, [load]);

  // Suivi de la préparation : rechargement tant qu’un média n’est pas finalisé.
  const pending =
    items?.some((m) => m.status === 'processing' || m.status === 'uploading') ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [pending, load]);

  const uploads = useUploads(folderId, refreshAll);

  async function loadMore() {
    if (!cursor) return;
    const page = await api<Page>('GET', `/media?${query}&cursor=${cursor}`);
    setItems((current) => [...(current ?? []), ...page.items]);
    setCursor(page.next_cursor);
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulk(action: 'trash' | 'restore' | 'move', target?: string | null) {
    const ids = [...selected];
    if (action === 'trash' && !confirm(`Placer ${ids.length} média(s) dans la corbeille ?`)) return;
    const failures: string[] = [];
    for (const id of ids) {
      try {
        if (action === 'trash') await api('DELETE', `/media/${id}`);
        else if (action === 'restore') await api('POST', `/media/${id}/restore`);
        else await api('PATCH', `/media/${id}`, { folder_id: target ?? null });
      } catch (caught) {
        failures.push(caught instanceof ApiRequestError ? caught.message : id);
      }
    }
    setSelected(new Set());
    if (failures.length) setError(new Error(failures.join(' ; ')));
    refreshAll();
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (canManage && event.dataTransfer.files.length) uploads.add(event.dataTransfer.files);
  }

  const used = usage.data ? usage.data.used_bytes + usage.data.reserved_bytes : 0;
  return (
    <section>
      <div className="page-header">
        <h1>Bibliothèque</h1>
        {usage.data && (
          <p className="muted" aria-live="polite">
            Stockage : {formatBytes(used)} sur {formatBytes(usage.data.limit_bytes)}
            <meter min={0} max={usage.data.limit_bytes} value={used} className="usage" />
          </p>
        )}
      </div>

      <div className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'library'}
          onClick={() => {
            setView('library');
            setSelected(new Set());
          }}
        >
          Médias
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'trash'}
          onClick={() => {
            setView('trash');
            setSelected(new Set());
            setDetailId(null);
          }}
        >
          Corbeille
        </button>
      </div>

      <div className="library">
        {view === 'library' && (
          <FolderTree
            folders={folders.data?.items ?? []}
            current={folderId}
            onSelect={(id) => {
              setFolderId(id);
              setSelected(new Set());
            }}
            canManage={canManage}
            onChange={() => void folders.reload()}
          />
        )}
        <div className="library-main">
          {view === 'library' && canManage && (
            <div
              className={`dropzone${dragging ? ' dropzone-active' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <p>
                Glissez-déposez vos images et vidéos ici, ou{' '}
                <button type="button" className="link" onClick={() => fileInput.current?.click()}>
                  choisissez des fichiers
                </button>
                .
              </p>
              <p className="hint">
                JPEG, PNG, WebP (50 Mo max) · MP4, MOV, WebM (2 Go max). Chaque fichier est vérifié
                puis préparé pour les écrans.
              </p>
              <input
                ref={fileInput}
                type="file"
                multiple
                accept={ACCEPT}
                hidden
                aria-label="Fichiers à envoyer"
                onChange={(event) => {
                  if (event.target.files?.length) uploads.add(event.target.files);
                  event.target.value = '';
                }}
              />
            </div>
          )}
          {view === 'library' && !canManage && (
            <Forbidden reason="Votre rôle permet de consulter la bibliothèque, pas d’y ajouter des fichiers." />
          )}
          <UploadQueue uploads={uploads} />

          <div className="filters">
            <input
              aria-label="Rechercher un média"
              type="search"
              placeholder="Rechercher par nom"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label="Filtrer par type"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="">Tous les types</option>
              <option value="image">Images</option>
              <option value="video">Vidéos</option>
            </select>
            {view === 'library' && (
              <select
                aria-label="Filtrer par état"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">Tous les états</option>
                <option value="ready">Prêts</option>
                <option value="processing">En préparation</option>
                <option value="error">En erreur</option>
              </select>
            )}
            <select
              aria-label="Filtrer par tag"
              value={tag}
              onChange={(e) => setTag(e.target.value)}
            >
              <option value="">Tous les tags</option>
              {(tags.data?.items ?? []).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          {selected.size > 0 && canManage && (
            <div className="bulk" role="toolbar" aria-label="Actions sur la sélection">
              <span>{selected.size} sélectionné(s)</span>
              {view === 'library' ? (
                <>
                  <select
                    aria-label="Déplacer la sélection vers"
                    defaultValue=""
                    onChange={(e) => {
                      if (e.target.value)
                        void bulk('move', e.target.value === '__root__' ? null : e.target.value);
                    }}
                  >
                    <option value="">Déplacer vers…</option>
                    <option value="__root__">Racine</option>
                    {(folders.data?.items ?? []).map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="danger" onClick={() => void bulk('trash')}>
                    Mettre à la corbeille
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => void bulk('restore')}>
                  Restaurer
                </button>
              )}
              <button type="button" className="link" onClick={() => setSelected(new Set())}>
                Tout désélectionner
              </button>
            </div>
          )}

          <ErrorMessage error={error} />
          {items === null && !error && <Loading />}
          {items?.length === 0 && (
            <Empty>
              {view === 'trash' ? 'La corbeille est vide.' : 'Aucun média ici pour le moment.'}
            </Empty>
          )}
          {items && items.length > 0 && (
            <ul className="media-grid" aria-label={view === 'trash' ? 'Corbeille' : 'Médias'}>
              {items.map((media) => (
                <li
                  key={media.id}
                  className={`media-card${detailId === media.id ? ' media-card-active' : ''}`}
                >
                  {canManage && (
                    <input
                      type="checkbox"
                      className="media-select"
                      aria-label={`Sélectionner ${media.name}`}
                      checked={selected.has(media.id)}
                      onChange={() => toggle(media.id)}
                    />
                  )}
                  <button
                    type="button"
                    className="media-open"
                    onClick={() => setDetailId(media.id)}
                    aria-label={`Ouvrir ${media.name}`}
                  >
                    {media.thumbnail_url ? (
                      <img src={media.thumbnail_url} alt="" loading="lazy" />
                    ) : (
                      <span className="media-placeholder">
                        {media.type === 'video' ? 'Vidéo' : 'Image'}
                      </span>
                    )}
                  </button>
                  <div className="media-meta">
                    <strong className="media-name">{media.name}</strong>
                    <span className="muted">{describe(media)}</span>
                    {view === 'trash' ? (
                      <span className="muted">
                        {media.purging
                          ? 'Suppression définitive en cours'
                          : `Supprimé définitivement le ${new Date(media.purge_after!).toLocaleDateString('fr-FR')}`}
                      </span>
                    ) : (
                      <span className={`badge badge-${media.status}`}>
                        {STATUS_LABEL[media.status]}
                        {media.error && ` : ${media.error.message ?? media.error.code}`}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {cursor && (
            <button type="button" onClick={() => void loadMore()}>
              Afficher plus
            </button>
          )}
        </div>
        {detailId && (
          <MediaPanel
            id={detailId}
            folders={folders.data?.items ?? []}
            canManage={canManage}
            onClose={() => setDetailId(null)}
            onChange={refreshAll}
          />
        )}
      </div>
    </section>
  );
}

function FolderTree(props: {
  folders: Folder[];
  current: string | null;
  onSelect(id: string | null): void;
  canManage: boolean;
  onChange(): void;
}) {
  const [error, setError] = useState<unknown>(null);
  const children = (parent: string | null) => props.folders.filter((f) => f.parent_id === parent);
  const render = (parent: string | null, depth: number): ReactNode =>
    children(parent).map((folder) => (
      <li key={folder.id}>
        <button
          type="button"
          className="link"
          style={{ paddingLeft: `${depth * 0.9}rem` }}
          aria-current={props.current === folder.id ? 'true' : undefined}
          onClick={() => props.onSelect(folder.id)}
        >
          {folder.name}
        </button>
        {render(folder.id, depth + 1)}
      </li>
    ));

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get('name') ?? '').trim();
    if (!name) return;
    try {
      setError(null);
      await api('POST', '/media-folders', {
        name,
        ...(props.current ? { parent_id: props.current } : {}),
      });
      form.reset();
      props.onChange();
    } catch (caught) {
      setError(caught);
    }
  }

  async function remove() {
    if (!props.current) return;
    try {
      setError(null);
      await api('DELETE', `/media-folders/${props.current}`);
      props.onSelect(null);
      props.onChange();
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <nav className="folders" aria-label="Dossiers">
      <ul>
        <li>
          <button
            type="button"
            className="link"
            aria-current={props.current === null ? 'true' : undefined}
            onClick={() => props.onSelect(null)}
          >
            Tous les médias
          </button>
        </li>
        {render(null, 1)}
      </ul>
      {props.canManage && (
        <>
          <form onSubmit={create} className="folder-form">
            <label className="visually-hidden" htmlFor="folder-name">
              Nouveau dossier
            </label>
            <input
              id="folder-name"
              name="name"
              placeholder={props.current ? 'Nouveau sous-dossier' : 'Nouveau dossier'}
              maxLength={100}
            />
            <button type="submit">Créer</button>
          </form>
          {props.current && (
            <button type="button" className="link danger-text" onClick={() => void remove()}>
              Supprimer ce dossier (s’il est vide)
            </button>
          )}
        </>
      )}
      <ErrorMessage error={error} />
    </nav>
  );
}

const VARIANT_LABEL = {
  original: 'Original',
  playback: 'Diffusion',
  thumbnail: 'Vignette',
} as const;

function MediaPanel(props: {
  id: string;
  folders: Folder[];
  canManage: boolean;
  onClose(): void;
  onChange(): void;
}) {
  const detail = useLoad<MediaDetail>(`/media/${props.id}`);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const media = detail.data;

  useEffect(() => {
    setPreview(null);
    if (media?.status !== 'ready' || media.purging) return;
    let cancelled = false;
    api<{ url: string }>('GET', `/media/${media.id}/assets/playback/url`)
      .then((result) => {
        if (!cancelled) setPreview(result.url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [media?.id, media?.status, media?.purging]);

  async function act(work: () => Promise<unknown>) {
    try {
      setError(null);
      await work();
      await detail.reload();
      props.onChange();
    } catch (caught) {
      setError(caught);
    }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const folder = String(data.get('folder_id') ?? '');
    await act(() =>
      api('PATCH', `/media/${props.id}`, {
        name: String(data.get('name') ?? '').trim(),
        folder_id: folder || null,
        tags: String(data.get('tags') ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    );
  }

  return (
    <aside className="card media-panel" aria-label="Détail du média">
      <div className="page-header">
        <h2>{media?.name ?? 'Média'}</h2>
        <button type="button" className="link" onClick={props.onClose}>
          Fermer
        </button>
      </div>
      <ErrorMessage error={detail.error ?? error} />
      {!media && !detail.error && <Loading />}
      {media && (
        <>
          {preview &&
            (media.type === 'image' ? (
              <img className="preview" src={preview} alt={`Aperçu de ${media.name}`} />
            ) : (
              <video className="preview" src={preview} controls muted preload="metadata" />
            ))}
          <p className="muted">{describe(media)}</p>
          <p>
            <span className={`badge badge-${media.status}`}>{STATUS_LABEL[media.status]}</span>
          </p>
          {media.error && (
            <div className="alert alert-error" role="alert">
              <p>{media.error.message ?? media.error.code}</p>
              <p className="muted">Code : {media.error.code}</p>
            </div>
          )}
          <dl className="facts">
            <dt>Fichier d’origine</dt>
            <dd>{media.original_filename}</dd>
            <dt>Ajouté le</dt>
            <dd>{new Date(media.created_at).toLocaleString('fr-FR')}</dd>
            {media.checksum_sha256 && (
              <>
                <dt>SHA-256</dt>
                <dd>
                  <code title={media.checksum_sha256}>{media.checksum_sha256.slice(0, 16)}…</code>
                </dd>
              </>
            )}
            <dt>Utilisations</dt>
            <dd>
              {media.usages.length === 0
                ? 'Aucune (playlists et compositions arrivent avec les lots suivants).'
                : media.usages.map((u) => u.name).join(', ')}
            </dd>
          </dl>

          {media.assets.length > 0 && (
            <table>
              <caption className="visually-hidden">Variantes</caption>
              <thead>
                <tr>
                  <th scope="col">Variante</th>
                  <th scope="col">Format</th>
                  <th scope="col">Dimensions</th>
                  <th scope="col">Taille</th>
                </tr>
              </thead>
              <tbody>
                {media.assets.map((asset) => (
                  <tr key={asset.variant}>
                    <td title={asset.profile}>{VARIANT_LABEL[asset.variant]}</td>
                    <td title={asset.mime_type}>
                      {asset.mime_type.split('/')[1]?.replace('x-', '').toUpperCase()}
                    </td>
                    <td>{asset.width && asset.height ? `${asset.width}×${asset.height}` : '—'}</td>
                    <td>{formatBytes(asset.size_bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {props.canManage && !media.deleted_at && (
            <form onSubmit={save} key={media.id + media.tags.join()}>
              <div className="field">
                <label htmlFor="media-name">Nom</label>
                <input
                  id="media-name"
                  name="name"
                  defaultValue={media.name}
                  maxLength={200}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="media-folder">Dossier</label>
                <select id="media-folder" name="folder_id" defaultValue={media.folder_id ?? ''}>
                  <option value="">Racine</option>
                  {props.folders
                    .filter((f) => f.site_id === media.site_id)
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="media-tags">Tags</label>
                <input
                  id="media-tags"
                  name="tags"
                  defaultValue={media.tags.join(', ')}
                  aria-describedby="media-tags-hint"
                />
                <p className="hint" id="media-tags-hint">
                  Séparés par des virgules.
                </p>
              </div>
              <button type="submit">Enregistrer</button>
            </form>
          )}

          {props.canManage && (
            <div className="inline actions">
              {media.status === 'error' && !media.deleted_at && (
                <button
                  type="button"
                  onClick={() => void act(() => api('POST', `/media/${media.id}/retry`))}
                >
                  Réessayer la préparation
                </button>
              )}
              {!media.deleted_at && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    if (
                      confirm(
                        `Placer « ${media.name} » dans la corbeille ? Il reste restaurable jusqu’à sa suppression définitive.`,
                      )
                    ) {
                      void act(() => api('DELETE', `/media/${media.id}`)).then(props.onClose);
                    }
                  }}
                >
                  Mettre à la corbeille
                </button>
              )}
              {media.deleted_at && !media.purging && (
                <>
                  <button
                    type="button"
                    onClick={() => void act(() => api('POST', `/media/${media.id}/restore`))}
                  >
                    Restaurer
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => {
                      if (
                        confirm(
                          `Supprimer définitivement « ${media.name} » ? Cette action est irréversible.`,
                        )
                      ) {
                        void act(() => api('POST', `/media/${media.id}/purge`)).then(props.onClose);
                      }
                    }}
                  >
                    Supprimer définitivement
                  </button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </aside>
  );
}
