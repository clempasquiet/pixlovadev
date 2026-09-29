import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Link, useParams } from 'react-router';
import {
  documentMediaIds,
  lintCompositionDocument,
  type CompositionDocument,
  type CompositionIssue,
  type DocumentElement,
} from '@pixlova/contracts';
import { renderOrder } from '@pixlova/render-engine';
import { api, ApiRequestError } from '../api.js';
import { useLoad } from '../data.js';
import { useSession } from '../session.js';
import { ErrorMessage, Loading } from '../ui.js';
import { rememberMedia, useMediaInfo, type MediaInfo } from './media.js';
import { MediaPicker } from './media-picker.js';
import { CanvasProperties, ElementProperties } from './properties.js';
import { RenderedDocument } from './render.js';
import {
  addElement,
  createElement,
  duplicateElements,
  editorReducer,
  initialState,
  moveInStack,
  removeElements,
  renameElement,
  snapPosition,
  updateElement,
  updateProps,
  type NewElementKind,
} from './state.js';

interface CompositionDetail {
  id: string;
  name: string;
  site_id: string | null;
  draft_revision: number;
  has_unpublished_changes: boolean;
  published_version: number | null;
  published_at: string | null;
  document: CompositionDocument;
  issues: CompositionIssue[];
}

interface Version {
  id: string;
  version: number;
  restored_from: number | null;
  published_at: string;
  published_by: string | null;
}

const TYPE_LABEL: Record<DocumentElement['type'], string> = {
  text: 'Texte',
  shape: 'Forme',
  image: 'Image',
  video: 'Vidéo',
  qr: 'QR Code',
  clock: 'Horloge',
};

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Handle = (typeof HANDLES)[number];

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)
  );
}

function describeElement(element: DocumentElement): string {
  if (element.name) return element.name;
  if (element.type === 'text')
    return element.props.text.split('\n')[0]!.slice(0, 40) || 'Texte vide';
  return `${TYPE_LABEL[element.type]} ${element.id}`;
}

export function CompositionEditorPage() {
  const { id } = useParams();
  const { can } = useSession();
  const canEdit = can('content.manage');
  const [detail, setDetail] = useState<CompositionDetail | null>(null);
  const [savedDoc, setSavedDoc] = useState<CompositionDocument | null>(null);
  const [serverIssues, setServerIssues] = useState<CompositionIssue[]>([]);
  const [state, dispatch] = useReducer(editorReducer, undefined, () =>
    initialState({
      schema_version: 1,
      canvas: { width: 1920, height: 1080, background: '#101820' },
      elements: [],
      settings: { audio_policy: 'muted' },
    }),
  );
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<{ type: 'image' | 'video'; target: string | null } | null>(
    null,
  );
  const [showPreview, setShowPreview] = useState(false);
  const [grid, setGrid] = useState(true);
  const [snap, setSnap] = useState(true);
  const [safeZone, setSafeZone] = useState(false);
  const [zoom, setZoom] = useState<'fit' | number>('fit');
  const [guides, setGuides] = useState<{ vertical: number[]; horizontal: number[] }>({
    vertical: [],
    horizontal: [],
  });
  const [available, setAvailable] = useState({ width: 800, height: 500 });
  const stageRef = useRef<HTMLDivElement>(null);
  const versions = useLoad<{ items: Version[] }>(id ? `/compositions/${id}/versions` : null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const loaded = await api<CompositionDetail>('GET', `/compositions/${id}`);
      setDetail(loaded);
      setSavedDoc(loaded.document);
      setServerIssues(
        loaded.issues.filter(
          (issue) => issue.code.startsWith('MEDIA_') && issue.code !== 'MEDIA_REQUIRED',
        ),
      );
      setConflict(false);
      dispatch({ type: 'load', doc: loaded.document });
    } catch (caught) {
      setError(caught);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const doc = state.doc;
  const dirty = savedDoc !== null && doc !== savedDoc;
  const mediaIds = useMemo(() => documentMediaIds(doc), [doc]);
  const media = useMediaInfo(mediaIds);
  const lint = useMemo(() => lintCompositionDocument(doc), [doc]);
  const issues = [
    ...lint,
    ...serverIssues.filter((issue) => doc.elements.some((e) => e.id === issue.element_id)),
  ];
  const errors = issues.filter((issue) => issue.severity === 'error');
  const selectedElements = doc.elements.filter((e) => state.selected.includes(e.id));
  const primary = selectedElements[0] ?? null;

  // Espace disponible : largeur de la zone, hauteur bornée par la fenêtre (sans hypothèse de ratio).
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () =>
      setAvailable({
        width: node.clientWidth - 32,
        height: Math.max(240, window.innerHeight - 320),
      });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [detail]);
  const fitScale = Math.min(
    available.width / doc.canvas.width,
    available.height / doc.canvas.height,
  );
  const scale = zoom === 'fit' ? fitScale : zoom;

  const change = useCallback(
    (next: CompositionDocument, mode: 'push' | 'replace' = 'push') =>
      dispatch({ type: 'change', doc: next, mode }),
    [],
  );

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function save(): Promise<CompositionDetail | null> {
    if (!detail || !canEdit) return null;
    setBusy(true);
    setError(null);
    try {
      const updated = await api<CompositionDetail>('PUT', `/compositions/${detail.id}/draft`, {
        revision: detail.draft_revision,
        document: doc,
      });
      setDetail({ ...detail, ...updated, document: doc });
      setSavedDoc(doc);
      setServerIssues(
        updated.issues.filter(
          (issue) => issue.code.startsWith('MEDIA_') && issue.code !== 'MEDIA_REQUIRED',
        ),
      );
      setNotice('Brouillon enregistré.');
      return { ...detail, ...updated, document: doc };
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.code === 'COMPOSITION_CONFLICT')
        setConflict(true);
      else setError(caught);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!detail) return;
    const current = dirty ? await save() : detail;
    if (!current) return;
    setBusy(true);
    try {
      const result = await api<{ version: number; composition: CompositionDetail }>(
        'POST',
        `/compositions/${detail.id}/publish`,
        {
          revision: current.draft_revision,
        },
      );
      setDetail({ ...current, ...result.composition, document: doc });
      setNotice(`Version ${result.version} publiée.`);
      setServerIssues([]);
      await versions.reload();
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.code === 'COMPOSITION_INVALID') {
        setServerIssues((caught.body.details?.issues as CompositionIssue[]) ?? []);
        setNotice(null);
      }
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function restore(version: number) {
    if (
      !detail ||
      !confirm(
        `Republier la version ${version} ? Elle deviendra une nouvelle version, et le brouillon sera remplacé.`,
      )
    )
      return;
    try {
      await api('POST', `/compositions/${detail.id}/restore-version`, { version });
      await load();
      await versions.reload();
      setNotice(`Version ${version} republiée.`);
    } catch (caught) {
      setError(caught);
    }
  }

  function add(kind: NewElementKind) {
    if (kind === 'image' || kind === 'video') {
      setPicker({ type: kind, target: null });
      return;
    }
    const element = createElement(doc, kind);
    change(addElement(doc, element));
    dispatch({ type: 'select', ids: [element.id] });
  }

  function pickMedia(picked: MediaInfo) {
    if (!picker) return;
    rememberMedia(picked);
    if (picker.target) {
      change(updateProps(doc, picker.target, { media_id: picked.id }));
    } else {
      const element = createElement(doc, picker.type, picked.id);
      // Proportions du média conservées à l’insertion.
      if (picked.width && picked.height) {
        const ratio = picked.width / picked.height;
        element.height = Math.max(1, Math.round(element.width / ratio));
        if (element.height > doc.canvas.height) {
          element.height = doc.canvas.height;
          element.width = Math.max(1, Math.round(element.height * ratio));
        }
        element.x = Math.round((doc.canvas.width - element.width) / 2);
        element.y = Math.round((doc.canvas.height - element.height) / 2);
      }
      change(addElement(doc, element));
      dispatch({ type: 'select', ids: [element.id] });
    }
    setPicker(null);
  }

  // Raccourcis clavier (CMP-002) : supprimer, déplacer, annuler, copier, coller, dupliquer, enregistrer.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const mod = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (mod && key === 's') {
        event.preventDefault();
        void save();
        return;
      }
      if (!canEdit) return;
      if (mod && key === 'z') {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' });
      } else if (mod && key === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
      } else if (mod && key === 'c') {
        dispatch({ type: 'copy' });
      } else if (mod && key === 'v') {
        dispatch({ type: 'paste' });
      } else if (mod && key === 'd' && selectedElements.length) {
        event.preventDefault();
        const result = duplicateElements(doc, selectedElements);
        change(result.doc);
        dispatch({ type: 'select', ids: result.ids });
      } else if ((key === 'delete' || key === 'backspace') && selectedElements.length) {
        event.preventDefault();
        change(
          removeElements(
            doc,
            selectedElements.filter((e) => !e.locked).map((e) => e.id),
          ),
        );
      } else if (key.startsWith('arrow') && selectedElements.length) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
        const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
        let next = doc;
        for (const element of selectedElements) {
          if (!element.locked)
            next = updateElement(next, element.id, { x: element.x + dx, y: element.y + dy });
        }
        change(next);
      } else if (key === 'escape') {
        dispatch({ type: 'select', ids: [] });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // Déplacement et redimensionnement directs, avec aimantation et guides.
  const drag = useRef<{
    mode: 'move' | Handle;
    startX: number;
    startY: number;
    origin: Map<string, { x: number; y: number; width: number; height: number }>;
    moved: boolean;
  } | null>(null);

  function beginDrag(event: ReactPointerEvent, element: DocumentElement, mode: 'move' | Handle) {
    event.stopPropagation();
    if (event.button !== 0) return;
    const ids =
      mode === 'move' && event.shiftKey
        ? state.selected.includes(element.id)
          ? state.selected.filter((s) => s !== element.id)
          : [...state.selected, element.id]
        : state.selected.includes(element.id) && mode === 'move'
          ? state.selected
          : [element.id];
    dispatch({ type: 'select', ids });
    if (!canEdit || element.locked) return;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    const origin = new Map(
      doc.elements
        .filter((e) => ids.includes(e.id) && !e.locked)
        .map((e) => [e.id, { x: e.x, y: e.y, width: e.width, height: e.height }]),
    );
    drag.current = { mode, startX: event.clientX, startY: event.clientY, origin, moved: false };
  }

  function onDrag(event: ReactPointerEvent, element: DocumentElement) {
    const current = drag.current;
    if (!current) return;
    const dx = (event.clientX - current.startX) / scale;
    const dy = (event.clientY - current.startY) / scale;
    if (!current.moved && Math.abs(dx) + Math.abs(dy) < 1) return;
    const start = current.origin.get(element.id);
    if (!start) return;
    let next = doc;
    if (current.mode === 'move') {
      const snapped = snapPosition(
        doc,
        {
          id: element.id,
          x: start.x + dx,
          y: start.y + dy,
          width: start.width,
          height: start.height,
        },
        { grid: snap && grid ? gridStep(doc) : null, threshold: snap ? 6 / scale : 0 },
      );
      const offsetX = snapped.x - start.x;
      const offsetY = snapped.y - start.y;
      for (const [elementId, origin] of current.origin) {
        next = updateElement(next, elementId, { x: origin.x + offsetX, y: origin.y + offsetY });
      }
      setGuides(snapped.guides);
    } else {
      const handle = current.mode;
      let { x, y, width, height } = start;
      if (handle.includes('e')) width = Math.max(1, Math.round(start.width + dx));
      if (handle.includes('s')) height = Math.max(1, Math.round(start.height + dy));
      if (handle.includes('w')) {
        width = Math.max(1, Math.round(start.width - dx));
        x = start.x + start.width - width;
      }
      if (handle.includes('n')) {
        height = Math.max(1, Math.round(start.height - dy));
        y = start.y + start.height - height;
      }
      if (event.shiftKey && handle.length === 2) {
        // Proportions conservées depuis un coin.
        const ratio = start.width / start.height;
        height = Math.max(1, Math.round(width / ratio));
        if (handle.includes('n')) y = start.y + start.height - height;
      }
      next = updateElement(doc, element.id, { x: Math.round(x), y: Math.round(y), width, height });
    }
    change(next, current.moved ? 'replace' : 'push');
    current.moved = true;
  }

  function endDrag() {
    drag.current = null;
    setGuides({ vertical: [], horizontal: [] });
  }

  if (error && !detail) return <ErrorMessage error={error} />;
  if (!detail) return <Loading />;

  const ordered = renderOrder(doc.elements.map((e) => ({ ...e, visible: true })));
  const layers = [...ordered].reverse();

  return (
    <section className="editor">
      <div className="page-header">
        <div>
          <p className="muted">
            <Link to="/compositions">Compositions</Link> ›
          </p>
          <h1>{detail.name}</h1>
          <p className="muted" aria-live="polite">
            {doc.canvas.width}×{doc.canvas.height} px ·{' '}
            {detail.published_version
              ? `version publiée ${detail.published_version}`
              : 'jamais publiée'}
            {dirty
              ? ' · modifications non enregistrées'
              : detail.has_unpublished_changes && detail.published_version
                ? ' · brouillon non publié'
                : ''}
          </p>
        </div>
        <div className="inline-controls">
          <button type="button" onClick={() => setShowPreview(true)}>
            Prévisualiser
          </button>
          {canEdit && (
            <>
              <button type="button" disabled={busy || !dirty} onClick={() => void save()}>
                Enregistrer
              </button>
              <button
                type="button"
                disabled={busy || errors.length > 0}
                onClick={() => void publish()}
                title={errors.length ? 'Corrigez les erreurs avant de publier' : undefined}
              >
                Publier
              </button>
            </>
          )}
        </div>
      </div>
      {conflict && (
        <div className="alert alert-error" role="alert">
          <p>
            Cette composition a été modifiée par une autre personne depuis son ouverture. Vos
            changements n’ont pas été enregistrés.
          </p>
          <button type="button" onClick={() => void load()}>
            Recharger la dernière version (vos modifications seront perdues)
          </button>
        </div>
      )}
      {notice && !error && (
        <p className="alert alert-info" role="status">
          {notice}
        </p>
      )}
      <ErrorMessage error={error} />

      {canEdit && (
        <div className="toolbar" role="toolbar" aria-label="Ajouter un élément">
          <button type="button" onClick={() => add('text')}>
            + Texte
          </button>
          <button type="button" onClick={() => add('rectangle')}>
            + Rectangle
          </button>
          <button type="button" onClick={() => add('ellipse')}>
            + Ellipse
          </button>
          <button type="button" onClick={() => add('image')}>
            + Image
          </button>
          <button type="button" onClick={() => add('video')}>
            + Vidéo
          </button>
          <button type="button" onClick={() => add('qr')}>
            + QR Code
          </button>
          <button type="button" onClick={() => add('clock')}>
            + Horloge
          </button>
          <span className="toolbar-sep" />
          <button
            type="button"
            disabled={state.past.length === 0}
            onClick={() => dispatch({ type: 'undo' })}
            aria-label="Annuler"
          >
            ↶ Annuler
          </button>
          <button
            type="button"
            disabled={state.future.length === 0}
            onClick={() => dispatch({ type: 'redo' })}
            aria-label="Rétablir"
          >
            ↷ Rétablir
          </button>
          <span className="toolbar-sep" />
          <label className="checkbox">
            <input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} />{' '}
            Grille
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />{' '}
            Aimantation
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={safeZone}
              onChange={(e) => setSafeZone(e.target.checked)}
            />{' '}
            Zone de sécurité
          </label>
          <select
            aria-label="Zoom"
            value={String(zoom)}
            onChange={(e) => setZoom(e.target.value === 'fit' ? 'fit' : Number(e.target.value))}
          >
            <option value="fit">Ajuster ({Math.round(fitScale * 100)} %)</option>
            <option value="0.25">25 %</option>
            <option value="0.5">50 %</option>
            <option value="1">100 %</option>
          </select>
        </div>
      )}

      <div className="editor-body">
        <aside className="card editor-layers" aria-label="Calques">
          <h2>Calques</h2>
          {layers.length === 0 && (
            <p className="muted">Ajoutez un élément avec la barre d’outils.</p>
          )}
          <ul>
            {layers.map((layer) => {
              const element = doc.elements.find((e) => e.id === layer.id)!;
              const selected = state.selected.includes(element.id);
              return (
                <li key={element.id} className={selected ? 'layer layer-selected' : 'layer'}>
                  <button
                    type="button"
                    className="link layer-name"
                    aria-pressed={selected}
                    onClick={() => dispatch({ type: 'select', ids: [element.id] })}
                  >
                    <span className="muted">{TYPE_LABEL[element.type]}</span>{' '}
                    {describeElement(element)}
                  </button>
                  {canEdit && (
                    <span className="layer-actions">
                      <button
                        type="button"
                        className="icon"
                        title={element.visible ? 'Masquer' : 'Afficher'}
                        aria-label={`${element.visible ? 'Masquer' : 'Afficher'} ${describeElement(element)}`}
                        onClick={() =>
                          change(updateElement(doc, element.id, { visible: !element.visible }))
                        }
                      >
                        {element.visible ? '👁' : '◌'}
                      </button>
                      <button
                        type="button"
                        className="icon"
                        title={element.locked ? 'Déverrouiller' : 'Verrouiller'}
                        aria-label={`${element.locked ? 'Déverrouiller' : 'Verrouiller'} ${describeElement(element)}`}
                        onClick={() =>
                          change(updateElement(doc, element.id, { locked: !element.locked }))
                        }
                      >
                        {element.locked ? '🔒' : '🔓'}
                      </button>
                      <button
                        type="button"
                        className="icon"
                        title="Monter"
                        aria-label={`Monter ${describeElement(element)}`}
                        onClick={() => change(moveInStack(doc, element.id, 'up'))}
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        className="icon"
                        title="Descendre"
                        aria-label={`Descendre ${describeElement(element)}`}
                        onClick={() => change(moveInStack(doc, element.id, 'down'))}
                      >
                        ▼
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {issues.length > 0 && (
            <div className="issues" aria-label="Anomalies">
              <h2>Anomalies</h2>
              <ul>
                {issues.map((issue, index) => (
                  <li
                    key={`${issue.code}-${issue.element_id}-${index}`}
                    className={issue.severity === 'error' ? 'error-text' : 'muted'}
                  >
                    {issue.element_id ? (
                      <button
                        type="button"
                        className="link"
                        onClick={() => dispatch({ type: 'select', ids: [issue.element_id!] })}
                      >
                        {issue.message}
                      </button>
                    ) : (
                      issue.message
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        <div className="editor-stage" ref={stageRef}>
          <div
            className="editor-canvas"
            style={{ width: doc.canvas.width * scale, height: doc.canvas.height * scale }}
          >
            <div
              style={{
                width: doc.canvas.width,
                height: doc.canvas.height,
                transform: `scale(${scale})`,
                transformOrigin: '0 0',
                position: 'relative',
              }}
            >
              <RenderedDocument document={doc} media={media} />
              <div
                className={`overlay${grid ? ' overlay-grid' : ''}`}
                style={{ ['--grid' as string]: `${gridStep(doc)}px` }}
                onPointerDown={() => dispatch({ type: 'select', ids: [] })}
                data-testid="canvas-overlay"
              >
                {ordered
                  .filter((layer) => doc.elements.find((e) => e.id === layer.id)!.visible)
                  .map((layer) => {
                    const element = doc.elements.find((e) => e.id === layer.id)!;
                    const selected = state.selected.includes(element.id);
                    return (
                      <div
                        key={element.id}
                        className={`box${selected ? ' box-selected' : ''}${element.locked ? ' box-locked' : ''}`}
                        data-element={element.id}
                        style={{
                          left: element.x,
                          top: element.y,
                          width: element.width,
                          height: element.height,
                          transform: element.rotation
                            ? `rotate(${element.rotation}deg)`
                            : undefined,
                          ['--inv' as string]: String(1 / scale),
                        }}
                        onPointerDown={(event) => beginDrag(event, element, 'move')}
                        onPointerMove={(event) => onDrag(event, element)}
                        onPointerUp={endDrag}
                        onPointerCancel={endDrag}
                      >
                        {selected &&
                          canEdit &&
                          !element.locked &&
                          state.selected.length === 1 &&
                          HANDLES.map((handle) => (
                            <span
                              key={handle}
                              className={`resize resize-${handle}`}
                              onPointerDown={(event) => beginDrag(event, element, handle)}
                              onPointerMove={(event) => onDrag(event, element)}
                              onPointerUp={endDrag}
                            />
                          ))}
                      </div>
                    );
                  })}
                {guides.vertical.map((x) => (
                  <div key={`v${x}`} className="guide guide-v" style={{ left: x }} />
                ))}
                {guides.horizontal.map((y) => (
                  <div key={`h${y}`} className="guide guide-h" style={{ top: y }} />
                ))}
                {safeZone && (
                  <div
                    className="safe-zone"
                    style={{
                      left: doc.canvas.width * 0.05,
                      top: doc.canvas.height * 0.05,
                      width: doc.canvas.width * 0.9,
                      height: doc.canvas.height * 0.9,
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        </div>

        <aside className="card editor-properties" aria-label="Propriétés">
          <h2>
            {primary ? `${TYPE_LABEL[primary.type]} · ${describeElement(primary)}` : 'Composition'}
          </h2>
          {primary ? (
            <>
              {canEdit && (
                <div className="inline-controls">
                  <button
                    type="button"
                    onClick={() => {
                      const result = duplicateElements(doc, selectedElements);
                      change(result.doc);
                      dispatch({ type: 'select', ids: result.ids });
                    }}
                  >
                    Dupliquer
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={primary.locked}
                    onClick={() => change(removeElements(doc, [primary.id]))}
                  >
                    Supprimer
                  </button>
                </div>
              )}
              <div className="prop">
                <label htmlFor="prop-nom">Nom du calque</label>
                <input
                  id="prop-nom"
                  value={primary.name ?? ''}
                  maxLength={80}
                  disabled={!canEdit}
                  onChange={(e) => change(renameElement(doc, primary.id, e.target.value))}
                />
              </div>
              <ElementProperties
                doc={doc}
                element={primary}
                media={media}
                disabled={!canEdit}
                onChange={(patch) => change(updateElement(doc, primary.id, patch))}
                onProps={(patch) => change(updateProps(doc, primary.id, patch))}
                onPickMedia={() =>
                  (primary.type === 'image' || primary.type === 'video') &&
                  setPicker({ type: primary.type, target: primary.id })
                }
              />
            </>
          ) : (
            <CanvasProperties doc={doc} onChange={(next) => change(next)} disabled={!canEdit} />
          )}
          <details className="versions">
            <summary>Versions publiées ({versions.data?.items.length ?? 0})</summary>
            <ul>
              {versions.data?.items.map((version) => (
                <li key={version.id}>
                  <strong>v{version.version}</strong> ·{' '}
                  {new Date(version.published_at).toLocaleString('fr-FR')}
                  {version.published_by && ` · ${version.published_by}`}
                  {version.restored_from && ` · reprise de v${version.restored_from}`}
                  {canEdit && version.version !== detail.published_version && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => void restore(version.version)}
                    >
                      Republier
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        </aside>
      </div>

      {picker && (
        <MediaPicker type={picker.type} onPick={pickMedia} onClose={() => setPicker(null)} />
      )}
      {showPreview && (
        <PreviewDialog doc={doc} media={media} onClose={() => setShowPreview(false)} />
      )}
    </section>
  );
}

/** Pas de grille : 1/40 du petit côté, arrondi à 4 px (au moins 4 px). */
export function gridStep(doc: CompositionDocument): number {
  return Math.max(4, Math.round(Math.min(doc.canvas.width, doc.canvas.height) / 40 / 4) * 4);
}

interface DisplayOption {
  id: string;
  name: string;
  width: number;
  height: number;
  orientation: number;
  timezone: string | null;
}

/**
 * Prévisualisation (CMP-006) : canvas seul, profil d’un Display réel (sa résolution et son
 * fuseau) ou format personnalisé. Une preview locale ne confirme pas le rendu physique.
 */
function PreviewDialog(props: {
  doc: CompositionDocument;
  media: ReadonlyMap<string, MediaInfo | null>;
  onClose(): void;
}) {
  const displays = useLoad<{ items: DisplayOption[] }>('/displays');
  const [profile, setProfile] = useState('canvas');
  const [custom, setCustom] = useState({ width: 1920, height: 1080 });
  const display = displays.data?.items.find((d) => d.id === profile);
  const target =
    profile === 'canvas'
      ? { width: props.doc.canvas.width, height: props.doc.canvas.height }
      : profile === 'custom'
        ? custom
        : {
            width: display?.width ?? props.doc.canvas.width,
            height: display?.height ?? props.doc.canvas.height,
          };
  const scale = Math.min(900 / target.width, 520 / target.height);
  const ratioDiffers =
    Math.abs(target.width / target.height - props.doc.canvas.width / props.doc.canvas.height) >
    0.01;
  // La composition est ajustée (contain) dans la surface cible, comme sur le Player.
  const fit = Math.min(
    target.width / props.doc.canvas.width,
    target.height / props.doc.canvas.height,
  );
  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        className="modal card modal-wide"
        role="dialog"
        aria-modal="true"
        aria-label="Prévisualisation"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="page-header">
          <h2>Prévisualisation</h2>
          <button type="button" className="link" onClick={props.onClose}>
            Fermer
          </button>
        </div>
        <div className="inline-controls">
          <label>
            Profil{' '}
            <select
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              aria-label="Profil de prévisualisation"
            >
              <option value="canvas">
                Canvas ({props.doc.canvas.width}×{props.doc.canvas.height})
              </option>
              {displays.data?.items.map((d) => (
                <option key={d.id} value={d.id}>
                  Écran « {d.name} » ({d.width}×{d.height})
                </option>
              ))}
              <option value="custom">Format personnalisé</option>
            </select>
          </label>
          {profile === 'custom' && (
            <>
              <input
                type="number"
                aria-label="Largeur personnalisée"
                min={1}
                max={32767}
                value={custom.width}
                onChange={(e) =>
                  setCustom({ ...custom, width: Math.max(1, e.target.valueAsNumber || 1) })
                }
              />
              <input
                type="number"
                aria-label="Hauteur personnalisée"
                min={1}
                max={32767}
                value={custom.height}
                onChange={(e) =>
                  setCustom({ ...custom, height: Math.max(1, e.target.valueAsNumber || 1) })
                }
              />
            </>
          )}
        </div>
        <div
          className="preview-surface"
          style={{
            width: Math.round(target.width * scale),
            height: Math.round(target.height * scale),
          }}
        >
          <div
            style={{
              position: 'absolute',
              left: Math.floor((target.width - props.doc.canvas.width * fit) / 2) * scale,
              top: Math.floor((target.height - props.doc.canvas.height * fit) / 2) * scale,
              transform: `scale(${fit * scale})`,
              transformOrigin: '0 0',
            }}
          >
            <RenderedDocument
              document={props.doc}
              media={props.media}
              {...(display?.timezone ? { timezone: display.timezone } : {})}
            />
          </div>
        </div>
        <ul className="muted">
          {ratioDiffers && (
            <li>
              Le format de l’écran diffère de celui de la composition : des bandes apparaîtront
              (ajustement « contenir »).
            </li>
          )}
          {display && display.orientation !== 0 && (
            <li>
              Écran monté tourné de {display.orientation}° : le Player applique la rotation à la
              sortie.
            </li>
          )}
          <li>
            Polices, recadrages et médias sont ceux des Players ; une preview locale ne confirme pas
            le rendu sur l’écran physique.
          </li>
        </ul>
      </div>
    </div>
  );
}
