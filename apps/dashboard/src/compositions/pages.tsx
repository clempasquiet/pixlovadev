import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { CompositionTemplate } from '@pixlova/contracts';
import { api, idempotencyKey } from '../api.js';
import { useLoad } from '../data.js';
import { useSession } from '../session.js';
import { Empty, ErrorMessage, Forbidden, Loading } from '../ui.js';
import { rememberMedia, type MediaInfo } from './media.js';
import { MediaPicker } from './media-picker.js';
import { ScaledDocument } from './render.js';

interface CompositionSummary {
  id: string;
  name: string;
  width: number;
  height: number;
  published_version: number | null;
  has_unpublished_changes: boolean;
  updated_at: string;
  source_template: { key: string; version: number } | null;
}

const FORMATS = [
  { label: 'Paysage 1920×1080', width: 1920, height: 1080 },
  { label: 'Portrait 1080×1920', width: 1080, height: 1920 },
  { label: 'Bandeau LED 2688×672', width: 2688, height: 672 },
  { label: 'Bandeau LED 3840×480', width: 3840, height: 480 },
  { label: 'Totem LED 768×2304', width: 768, height: 2304 },
  { label: '4K 3840×2160', width: 3840, height: 2160 },
];

export function CompositionsPage() {
  const { can } = useSession();
  const canEdit = can('content.manage');
  const list = useLoad<{ items: CompositionSummary[] }>('/compositions');
  const navigate = useNavigate();
  const [format, setFormat] = useState<string>('0');
  const [custom, setCustom] = useState({ width: 1920, height: 1080 });
  const [error, setError] = useState<unknown>(null);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
    const size = format === 'custom' ? custom : FORMATS[Number(format)]!;
    try {
      setError(null);
      const created = await api<{ id: string }>(
        'POST',
        '/compositions',
        { name, width: size.width, height: size.height },
        idempotencyKey(),
      );
      navigate(`/compositions/${created.id}`);
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <section>
      <div className="page-header">
        <h1>Compositions</h1>
        <Link to="/templates">Parcourir les modèles</Link>
      </div>
      {canEdit ? (
        <form className="card narrow" onSubmit={create}>
          <h2>Nouvelle composition</h2>
          <div className="field">
            <label htmlFor="composition-name">Nom</label>
            <input id="composition-name" name="name" required maxLength={120} />
          </div>
          <div className="field">
            <label htmlFor="composition-format">Format</label>
            <select
              id="composition-format"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
            >
              {FORMATS.map((f, index) => (
                <option key={f.label} value={String(index)}>
                  {f.label}
                </option>
              ))}
              <option value="custom">Format libre…</option>
            </select>
          </div>
          {format === 'custom' && (
            <div className="inline">
              <div className="field">
                <label htmlFor="composition-width">Largeur (px)</label>
                <input
                  id="composition-width"
                  type="number"
                  min={1}
                  max={32767}
                  value={custom.width}
                  onChange={(e) => setCustom({ ...custom, width: e.target.valueAsNumber })}
                />
              </div>
              <div className="field">
                <label htmlFor="composition-height">Hauteur (px)</label>
                <input
                  id="composition-height"
                  type="number"
                  min={1}
                  max={32767}
                  value={custom.height}
                  onChange={(e) => setCustom({ ...custom, height: e.target.valueAsNumber })}
                />
              </div>
            </div>
          )}
          <ErrorMessage error={error} />
          <button type="submit">Créer et ouvrir le créateur</button>
        </form>
      ) : (
        <Forbidden reason="Votre rôle permet de consulter les compositions, pas de les modifier." />
      )}
      <ErrorMessage error={list.error} />
      {!list.data && !list.error && <Loading />}
      {list.data?.items.length === 0 && <Empty>Aucune composition pour le moment.</Empty>}
      {list.data && list.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Nom</th>
              <th scope="col">Format</th>
              <th scope="col">État</th>
              <th scope="col">Modifiée</th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((item) => (
              <tr key={item.id}>
                <td>
                  <Link to={`/compositions/${item.id}`}>{item.name}</Link>
                  {item.source_template && <span className="muted"> · d’après un modèle</span>}
                </td>
                <td>
                  {item.width}×{item.height}
                </td>
                <td>
                  {item.published_version ? (
                    <span className="badge badge-ready">Version {item.published_version}</span>
                  ) : (
                    <span className="badge">Brouillon</span>
                  )}
                  {item.published_version && item.has_unpublished_changes && (
                    <span className="muted"> · modifications non publiées</span>
                  )}
                </td>
                <td>{new Date(item.updated_at).toLocaleString('fr-FR')}</td>
                <td>
                  {canEdit && (
                    <span className="inline-controls">
                      <button
                        type="button"
                        className="link"
                        onClick={async () => {
                          await api('POST', `/compositions/${item.id}/duplicate`, {
                            name: `${item.name} (copie)`,
                          });
                          await list.reload();
                        }}
                      >
                        Dupliquer
                      </button>
                      <button
                        type="button"
                        className="link danger-text"
                        onClick={async () => {
                          if (
                            !confirm(
                              `Supprimer « ${item.name} » ? Les versions publiées restent dans l’historique.`,
                            )
                          )
                            return;
                          await api('DELETE', `/compositions/${item.id}`);
                          await list.reload();
                        }}
                      >
                        Supprimer
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

type Template = CompositionTemplate & { available: boolean };

const CATEGORY_LABEL: Record<Template['category'], string> = {
  restauration: 'Restauration',
  hotellerie: 'Hôtellerie',
  retail: 'Commerce',
  immobilier: 'Immobilier',
  evenementiel: 'Événementiel',
};

const NO_MEDIA = new Map<string, MediaInfo | null>();

/** Galerie des modèles (TPL-001) : preview ouverte à tous, utilisation selon l’offre. */
export function TemplatesPage() {
  const { can } = useSession();
  const catalog = useLoad<{ items: Template[] }>('/templates');
  const [category, setCategory] = useState('');
  const [chosen, setChosen] = useState<Template | null>(null);
  const items = useMemo(
    () => catalog.data?.items.filter((t) => !category || t.category === category) ?? [],
    [catalog.data, category],
  );
  return (
    <section>
      <div className="page-header">
        <h1>Modèles</h1>
        <label>
          <span className="visually-hidden">Catégorie</span>
          <select
            aria-label="Catégorie"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">Toutes les catégories</option>
            {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorMessage error={catalog.error} />
      {!catalog.data && !catalog.error && <Loading />}
      {catalog.data && !catalog.data.items.some((t) => t.available) && (
        <p className="alert alert-info">
          Les modèles sont inclus dans les offres payantes. Vous pouvez les prévisualiser dès
          maintenant.
        </p>
      )}
      <ul className="template-grid" aria-label="Modèles">
        {items.map((template) => (
          <li key={template.key} className="card template-card">
            <ScaledDocument
              document={template.document}
              media={NO_MEDIA}
              maxWidth={360}
              maxHeight={220}
              label={`Aperçu du modèle ${template.name}`}
            />
            <h2>{template.name}</h2>
            <p className="muted">
              {CATEGORY_LABEL[template.category]} · {template.document.canvas.width}×
              {template.document.canvas.height}
            </p>
            <p>{template.description}</p>
            <button
              type="button"
              disabled={!template.available || !can('content.manage')}
              onClick={() => setChosen(template)}
            >
              Utiliser ce modèle
            </button>
            {!template.available && <p className="hint">Inclus dans les offres payantes.</p>}
          </li>
        ))}
      </ul>
      {chosen && <UseTemplateDialog template={chosen} onClose={() => setChosen(null)} />}
    </section>
  );
}

function UseTemplateDialog(props: { template: Template; onClose(): void }) {
  const navigate = useNavigate();
  const { template } = props;
  const [name, setName] = useState(template.name);
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(
      template.placeholders.filter((p) => p.default !== undefined).map((p) => [p.key, p.default!]),
    ),
  );
  const [images, setImages] = useState<Record<string, MediaInfo>>({});
  const [picking, setPicking] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [key] = useState(idempotencyKey);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    try {
      setError(null);
      const created = await api<{ id: string }>(
        'POST',
        `/templates/${template.key}/instantiate`,
        { name, values },
        key,
      );
      navigate(`/compositions/${created.id}`);
    } catch (caught) {
      setError(caught);
    }
  }

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <form
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-label={`Utiliser le modèle ${template.name}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2>Utiliser « {template.name} »</h2>
        <p className="muted">
          Une composition indépendante est créée : les évolutions du modèle ne la modifieront pas.
        </p>
        <div className="field">
          <label htmlFor="template-name">Nom de la composition</label>
          <input
            id="template-name"
            value={name}
            maxLength={120}
            required
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {template.placeholders.map((placeholder) => (
          <div className="field" key={placeholder.key}>
            <label htmlFor={`placeholder-${placeholder.key}`}>{placeholder.label}</label>
            {placeholder.type === 'text' && (
              <input
                id={`placeholder-${placeholder.key}`}
                value={values[placeholder.key] ?? ''}
                maxLength={2000}
                onChange={(e) => setValues({ ...values, [placeholder.key]: e.target.value })}
              />
            )}
            {placeholder.type === 'color' && (
              <input
                id={`placeholder-${placeholder.key}`}
                type="color"
                value={(values[placeholder.key] ?? '#000000').slice(0, 7)}
                onChange={(e) =>
                  setValues({ ...values, [placeholder.key]: e.target.value.toUpperCase() })
                }
              />
            )}
            {placeholder.type === 'image' && (
              <span className="inline-controls">
                <span className="muted">
                  {images[placeholder.key]?.name ?? 'À choisir plus tard dans le créateur'}
                </span>
                <button
                  id={`placeholder-${placeholder.key}`}
                  type="button"
                  onClick={() => setPicking(placeholder.key)}
                >
                  Choisir une image
                </button>
              </span>
            )}
          </div>
        ))}
        <ErrorMessage error={error} />
        <div className="inline-controls">
          <button type="submit">Créer la composition</button>
          <button type="button" className="link" onClick={props.onClose}>
            Annuler
          </button>
        </div>
        {picking && (
          <MediaPicker
            type="image"
            onClose={() => setPicking(null)}
            onPick={(media) => {
              rememberMedia(media);
              setImages({ ...images, [picking]: media });
              setValues({ ...values, [picking]: media.id });
              setPicking(null);
            }}
          />
        )}
      </form>
    </div>
  );
}
