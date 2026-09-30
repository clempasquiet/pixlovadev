import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type {
  CampaignDocument,
  ContentRef,
  ProgramDocument,
  ScheduleDocument,
  ScheduleExceptionDocument,
  ScheduleRuleDocument,
  Target,
  Targeting,
} from '@pixlova/contracts';
import { api, ApiRequestError, idempotencyKey } from '../api.js';
import { useLoad } from '../data.js';
import { useSession } from '../session.js';
import { Empty, ErrorMessage, Forbidden, Loading } from '../ui.js';
import { ContentPicker, type PickedContent } from './content-picker.js';
import {
  browserTimezone,
  describeRule,
  instantToLocalInput,
  localInputToInstant,
  newRule,
  STATUS_LABEL,
  targetKey,
  WEEKDAYS,
} from './model.js';
import { IssueList } from './playlists.js';

type Kind = 'schedule' | 'campaign';

interface Issue {
  severity: 'error' | 'warning';
  code: string;
  ref: string | null;
  message: string;
}

interface ProgramSummary {
  id: string;
  kind: Kind | 'override';
  name: string;
  site_id: string | null;
  status: string;
  draft_revision: number;
  has_unpublished_changes: boolean;
  published_version: number | null;
  published: {
    content: ContentRef | null;
    starts_at: string | null;
    ends_at: string | null;
    priority: number;
  } | null;
  updated_at: string;
}

interface ProgramDetail extends ProgramSummary {
  document: ProgramDocument;
  references: Record<string, { name: string; status: string }>;
  targets: { count: number; displays: { id: string; name: string }[] };
  issues: Issue[];
}

const PATH: Record<Kind, string> = { schedule: '/schedules', campaign: '/campaigns' };
const TITLE: Record<Kind, string> = { schedule: 'Plannings', campaign: 'Campagnes' };
const NEW: Record<Kind, string> = { schedule: 'Nouveau planning', campaign: 'Nouvelle campagne' };

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'active' || status === 'published'
      ? 'badge-ready'
      : status === 'cancelled'
        ? 'badge-error'
        : '';
  return <span className={`badge ${tone}`}>{STATUS_LABEL[status] ?? status}</span>;
}

function ProgramsPage({ kind }: { kind: Kind }) {
  const { can } = useSession();
  const canEdit = can('content.publish');
  const list = useLoad<{ items: ProgramSummary[] }>(PATH[kind]);
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  return (
    <section>
      <h1>{TITLE[kind]}</h1>
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
                PATH[kind],
                { name },
                idempotencyKey(),
              );
              navigate(`${PATH[kind]}/${created.id}`);
            } catch (caught) {
              setError(caught);
            }
          }}
        >
          <h2>{NEW[kind]}</h2>
          <div className="field">
            <label htmlFor="program-name">Nom</label>
            <input id="program-name" name="name" required maxLength={120} />
          </div>
          <ErrorMessage error={error} />
          <button type="submit">Créer</button>
        </form>
      ) : (
        <Forbidden reason="Votre rôle permet de consulter la programmation, pas de la publier." />
      )}
      <ErrorMessage error={list.error} />
      {!list.data && !list.error && <Loading />}
      {list.data?.items.length === 0 && <Empty>Rien pour le moment.</Empty>}
      {list.data && list.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Nom</th>
              <th scope="col">État</th>
              {kind === 'campaign' && <th scope="col">Période</th>}
              <th scope="col">Modifié</th>
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((item) => (
              <tr key={item.id}>
                <td>
                  <Link to={`${PATH[kind]}/${item.id}`}>{item.name}</Link>
                  {item.has_unpublished_changes && item.published_version && (
                    <span className="muted"> · modifications non publiées</span>
                  )}
                </td>
                <td>
                  <StatusBadge status={item.status} />
                </td>
                {kind === 'campaign' && (
                  <td>
                    {item.published?.starts_at
                      ? `${new Date(item.published.starts_at).toLocaleString('fr-FR')} → ${new Date(item.published.ends_at!).toLocaleString('fr-FR')}`
                      : '—'}
                  </td>
                )}
                <td>{new Date(item.updated_at).toLocaleString('fr-FR')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export const SchedulesPage = () => <ProgramsPage kind="schedule" />;
export const CampaignsPage = () => <ProgramsPage kind="campaign" />;

interface Named {
  id: string;
  name: string;
}

/** Cibles avec exclusions (PLN-006, PLN-007) ; le serveur résout et compte les Displays. */
export function TargetsEditor(props: {
  value: Targeting;
  disabled: boolean;
  onChange(value: Targeting): void;
}) {
  const sites = useLoad<{ items: Named[] }>('/sites');
  const groups = useLoad<{ items: Named[] }>('/display-groups');
  const displays = useLoad<{ items: Named[] }>('/displays');
  const [type, setType] = useState<Target['type']>('organization');
  const [id, setId] = useState('');
  const options =
    type === 'site'
      ? sites.data?.items
      : type === 'group'
        ? groups.data?.items
        : type === 'display'
          ? displays.data?.items
          : [];
  const label = (target: Target) => {
    if (target.type === 'organization')
      return 'Toute l’organisation (dans le périmètre du programme)';
    const source = target.type === 'site' ? sites : target.type === 'group' ? groups : displays;
    const name = source.data?.items.find((item) => item.id === target.id)?.name ?? 'introuvable';
    return `${target.type === 'site' ? 'Site' : target.type === 'group' ? 'Groupe' : 'Écran'} « ${name} »`;
  };
  const add = (list: 'include' | 'exclude') => {
    const target: Target | null = type === 'organization' ? { type } : id ? { type, id } : null;
    if (!target) return;
    const existing = props.value[list];
    if (existing.some((t) => targetKey(t) === targetKey(target))) return;
    props.onChange({ ...props.value, [list]: [...existing, target] });
  };
  const remove = (list: 'include' | 'exclude', key: string) =>
    props.onChange({
      ...props.value,
      [list]: props.value[list].filter((t) => targetKey(t) !== key),
    });
  return (
    <fieldset className="card">
      <legend>Cibles</legend>
      {(['include', 'exclude'] as const).map((list) => (
        <div key={list}>
          <h3>{list === 'include' ? 'Inclure' : 'Exclure (prioritaire)'}</h3>
          {props.value[list].length === 0 ? (
            <p className="muted">Aucune.</p>
          ) : (
            <ul className="plain-list">
              {props.value[list].map((target) => (
                <li key={targetKey(target)}>
                  {label(target)}{' '}
                  {!props.disabled && (
                    <button
                      type="button"
                      className="link danger-text"
                      onClick={() => remove(list, targetKey(target))}
                    >
                      Retirer
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {!props.disabled && (
        <div className="inline-controls">
          <select
            aria-label="Type de cible"
            value={type}
            onChange={(e) => {
              setType(e.target.value as Target['type']);
              setId('');
            }}
          >
            <option value="organization">Toute l’organisation</option>
            <option value="site">Site</option>
            <option value="group">Groupe</option>
            <option value="display">Écran</option>
          </select>
          {type !== 'organization' && (
            <select aria-label="Cible" value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">Choisir…</option>
              {options?.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          )}
          <button type="button" onClick={() => add('include')}>
            Inclure
          </button>
          <button type="button" onClick={() => add('exclude')}>
            Exclure
          </button>
        </div>
      )}
    </fieldset>
  );
}

function useProgram(kind: Kind, id: string | undefined) {
  const [detail, setDetail] = useState<ProgramDetail | null>(null);
  const [doc, setDoc] = useState<ProgramDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});

  async function load() {
    try {
      const loaded = await api<ProgramDetail>('GET', `${PATH[kind]}/${id}`);
      setDetail(loaded);
      setDoc(loaded.document);
      setNames(Object.fromEntries(Object.entries(loaded.references).map(([k, v]) => [k, v.name])));
      setDirty(false);
    } catch (caught) {
      setError(caught);
    }
  }
  useEffect(() => {
    void load();
  }, [kind, id]);

  async function save(): Promise<ProgramDetail | null> {
    try {
      setError(null);
      const saved = await api<ProgramDetail>('PUT', `${PATH[kind]}/${id}/draft`, {
        revision: detail!.draft_revision,
        document: doc,
      });
      setDetail({ ...detail!, ...saved, document: doc! });
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
      const result = await api<{ version: number; targets: { count: number } }>(
        'POST',
        `${PATH[kind]}/${id}/publish`,
        { revision: saved.draft_revision },
      );
      setNotice(
        `Version ${result.version} publiée pour ${result.targets.count} écran(s). Chaque écran l’applique après compilation et préparation : suivez l’état sur sa fiche.`,
      );
      await load();
    } catch (caught) {
      setError(caught);
    }
  }

  async function stop() {
    const action = kind === 'schedule' ? 'deactivate' : 'cancel';
    if (
      !confirm(
        kind === 'schedule'
          ? 'Désactiver ce planning ?'
          : 'Arrêter cette campagne ? L’arrêt est définitif pour cette version.',
      )
    )
      return;
    try {
      await api('POST', `${PATH[kind]}/${id}/${action}`);
      await load();
    } catch (caught) {
      setError(caught);
    }
  }

  return {
    detail,
    doc,
    dirty,
    error,
    notice,
    names,
    setNames,
    change(next: ProgramDocument) {
      setDoc(next);
      setDirty(true);
      setNotice(null);
    },
    save,
    publish,
    stop,
  };
}

function ProgramHeader(props: {
  kind: Kind;
  program: ReturnType<typeof useProgram>;
  canEdit: boolean;
}) {
  const { detail, dirty, error, notice } = props.program;
  if (!detail) return null;
  const serverIssues =
    error instanceof ApiRequestError && Array.isArray(error.body.details?.issues)
      ? (error.body.details.issues as Issue[])
      : null;
  return (
    <>
      <p>
        <Link to={PATH[props.kind]}>← {TITLE[props.kind]}</Link>
      </p>
      <div className="page-header">
        <h1>{detail.name}</h1>
        <StatusBadge status={detail.status} />
      </div>
      {notice && (
        <p className="alert alert-info" role="status">
          {notice}
        </p>
      )}
      <ErrorMessage error={error} />
      {serverIssues && <IssueList issues={serverIssues} />}
      <div className="card">
        <p>
          Écrans visés actuellement : <strong>{detail.targets.count}</strong>
          {detail.targets.displays.length > 0 && (
            <span className="muted">
              {' '}
              ({detail.targets.displays.map((d) => d.name).join(', ')})
            </span>
          )}
        </p>
        {!dirty && <IssueList issues={detail.issues} />}
        {dirty && <p className="muted">Modifications non enregistrées.</p>}
        {props.canEdit && (
          <div className="inline-controls">
            <button type="button" disabled={!dirty} onClick={() => void props.program.save()}>
              Enregistrer
            </button>
            <button type="button" onClick={() => void props.program.publish()}>
              Publier
            </button>
            {detail.published_version && detail.status !== 'cancelled' && (
              <button type="button" className="danger" onClick={() => void props.program.stop()}>
                {props.kind === 'schedule' ? 'Désactiver' : 'Arrêter la campagne'}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** Éditeur de planning (PLN-003, PLN-004) : créneaux locaux, fuseau explicite, exceptions. */
export function ScheduleEditorPage() {
  const { id } = useParams();
  const { can } = useSession();
  const canEdit = can('content.publish');
  const program = useProgram('schedule', id);
  const [picking, setPicking] = useState<{ rule: number | null; exception?: number } | null>(null);
  const { detail, doc } = program;
  if (!detail || !doc) return program.error ? <ErrorMessage error={program.error} /> : <Loading />;
  const schedule = doc as ScheduleDocument;
  const set = (patch: Partial<ScheduleDocument>) => program.change({ ...schedule, ...patch });
  const patchRule = (index: number, patch: Partial<ScheduleRuleDocument>) =>
    set({ rules: schedule.rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)) });
  const patchException = (index: number, patch: Partial<ScheduleExceptionDocument>) =>
    set({ exceptions: schedule.exceptions.map((e, i) => (i === index ? { ...e, ...patch } : e)) });
  const name = (ref: ContentRef | null) =>
    ref ? (program.names[`${ref.type}:${ref.id}`] ?? 'Contenu introuvable') : '—';

  return (
    <section>
      <ProgramHeader kind="schedule" program={program} canEdit={canEdit} />
      <div className="card">
        <div className="field">
          <label htmlFor="schedule-timezone">Fuseau des horaires</label>
          <input
            id="schedule-timezone"
            placeholder="Fuseau de chaque écran"
            value={schedule.timezone ?? ''}
            disabled={!canEdit}
            onChange={(e) => set({ timezone: e.target.value.trim() || null })}
          />
          <p className="hint">
            Vide : chaque écran applique les horaires dans son propre fuseau (écran, sinon site,
            sinon organisation). Le fuseau de votre navigateur n’est jamais utilisé.
          </p>
        </div>
      </div>
      <TargetsEditor
        value={schedule.targets}
        disabled={!canEdit}
        onChange={(targets) => set({ targets })}
      />
      <div className="card">
        <div className="page-header">
          <h2>Créneaux</h2>
          {canEdit && (
            <button type="button" onClick={() => setPicking({ rule: null })}>
              + Ajouter un créneau
            </button>
          )}
        </div>
        {schedule.rules.length === 0 ? (
          <Empty>Aucun créneau.</Empty>
        ) : (
          <table aria-label="Créneaux">
            <thead>
              <tr>
                <th scope="col">Contenu</th>
                <th scope="col">Jours</th>
                <th scope="col">Heures</th>
                <th scope="col">Dates</th>
                <th scope="col">Priorité (0–19)</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {schedule.rules.map((rule, index) => (
                <tr key={rule.id}>
                  <td>
                    {name(rule.content)}
                    <p className="muted">{describeRule(rule)}</p>
                  </td>
                  <td>
                    <span className="inline-controls">
                      {WEEKDAYS.map(([day, label]) => (
                        <label key={day} className="checkbox">
                          <input
                            type="checkbox"
                            disabled={!canEdit}
                            checked={rule.weekdays.includes(day)}
                            onChange={(e) =>
                              patchRule(index, {
                                weekdays: e.target.checked
                                  ? [...rule.weekdays, day].sort()
                                  : rule.weekdays.filter((d) => d !== day),
                              })
                            }
                          />
                          {label}
                        </label>
                      ))}
                    </span>
                  </td>
                  <td>
                    <span className="inline-controls">
                      <input
                        type="time"
                        aria-label={`Début du créneau ${index + 1}`}
                        disabled={!canEdit}
                        value={rule.start_time}
                        onChange={(e) => patchRule(index, { start_time: e.target.value })}
                      />
                      <input
                        type="time"
                        aria-label={`Fin du créneau ${index + 1}`}
                        disabled={!canEdit || rule.end_time === '24:00'}
                        value={rule.end_time === '24:00' ? '00:00' : rule.end_time}
                        onChange={(e) => patchRule(index, { end_time: e.target.value })}
                      />
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          disabled={!canEdit}
                          checked={rule.end_time === '24:00'}
                          onChange={(e) =>
                            patchRule(index, { end_time: e.target.checked ? '24:00' : '23:00' })
                          }
                        />
                        jusqu’à minuit
                      </label>
                    </span>
                  </td>
                  <td>
                    <span className="inline-controls">
                      <input
                        type="date"
                        aria-label={`Premier jour du créneau ${index + 1}`}
                        disabled={!canEdit}
                        value={rule.start_date ?? ''}
                        onChange={(e) => patchRule(index, { start_date: e.target.value || null })}
                      />
                      <input
                        type="date"
                        aria-label={`Dernier jour du créneau ${index + 1}`}
                        disabled={!canEdit}
                        value={rule.end_date ?? ''}
                        onChange={(e) => patchRule(index, { end_date: e.target.value || null })}
                      />
                    </span>
                  </td>
                  <td>
                    <input
                      type="number"
                      aria-label={`Priorité du créneau ${index + 1}`}
                      min={0}
                      max={19}
                      disabled={!canEdit}
                      value={rule.priority}
                      onChange={(e) =>
                        patchRule(index, {
                          priority: Math.max(0, Math.min(19, e.target.valueAsNumber || 0)),
                        })
                      }
                    />
                  </td>
                  <td>
                    {canEdit && (
                      <span className="inline-controls">
                        <button
                          type="button"
                          className="link"
                          onClick={() => setPicking({ rule: index })}
                        >
                          Changer le contenu
                        </button>
                        <button
                          type="button"
                          className="link danger-text"
                          onClick={() =>
                            set({ rules: schedule.rules.filter((_, i) => i !== index) })
                          }
                        >
                          Retirer
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">
          À priorité égale, le créneau commencé le plus récemment l’emporte. Un créneau dont l’heure
          de début n’existe pas (passage à l’heure d’été) est omis ; une heure répétée (retour à
          l’heure d’hiver) ne compte qu’une fois.
        </p>
      </div>
      <div className="card">
        <div className="page-header">
          <h2>Exceptions datées</h2>
          {canEdit && (
            <button
              type="button"
              onClick={() =>
                set({
                  exceptions: [
                    ...schedule.exceptions,
                    {
                      id: crypto.randomUUID(),
                      date: new Date().toISOString().slice(0, 10),
                      rule_id: null,
                      action: 'skip',
                      content: null,
                    },
                  ],
                })
              }
            >
              + Ajouter une exception
            </button>
          )}
        </div>
        {schedule.exceptions.length === 0 ? (
          <Empty>Aucune exception.</Empty>
        ) : (
          <table aria-label="Exceptions">
            <tbody>
              {schedule.exceptions.map((exception, index) => (
                <tr key={exception.id}>
                  <td>
                    <input
                      type="date"
                      aria-label={`Date de l’exception ${index + 1}`}
                      disabled={!canEdit}
                      value={exception.date}
                      onChange={(e) => patchException(index, { date: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      aria-label={`Créneau visé par l’exception ${index + 1}`}
                      disabled={!canEdit}
                      value={exception.rule_id ?? ''}
                      onChange={(e) => patchException(index, { rule_id: e.target.value || null })}
                    >
                      <option value="">Tous les créneaux</option>
                      {schedule.rules.map((rule, i) => (
                        <option key={rule.id} value={rule.id}>
                          Créneau {i + 1} · {name(rule.content)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      aria-label={`Action de l’exception ${index + 1}`}
                      disabled={!canEdit}
                      value={exception.action}
                      onChange={(e) =>
                        patchException(
                          index,
                          e.target.value === 'skip'
                            ? { action: 'skip', content: null }
                            : { action: 'replace' },
                        )
                      }
                    >
                      <option value="skip">Ne rien diffuser de ce planning</option>
                      <option value="replace">Remplacer le contenu</option>
                    </select>
                  </td>
                  <td>
                    {exception.action === 'replace' && (
                      <>
                        {name(exception.content)}{' '}
                        {canEdit && (
                          <button
                            type="button"
                            className="link"
                            onClick={() => setPicking({ rule: null, exception: index })}
                          >
                            Choisir
                          </button>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    {canEdit && (
                      <button
                        type="button"
                        className="link danger-text"
                        onClick={() =>
                          set({ exceptions: schedule.exceptions.filter((_, i) => i !== index) })
                        }
                      >
                        Retirer
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {picking && (
        <ContentPicker
          title="Choisir le contenu"
          onClose={() => setPicking(null)}
          onPick={(picked: PickedContent) => {
            program.setNames({
              ...program.names,
              [`${picked.ref.type}:${picked.ref.id}`]: picked.name,
            });
            if (picking.exception !== undefined)
              patchException(picking.exception, { content: picked.ref });
            else if (picking.rule === null)
              set({ rules: [...schedule.rules, newRule(picked.ref, crypto.randomUUID())] });
            else patchRule(picking.rule, { content: picked.ref });
            setPicking(null);
          }}
        />
      )}
    </section>
  );
}

/** Éditeur de campagne (PLN-006) : contenu, période bornée, priorité, cibles. */
export function CampaignEditorPage() {
  const { id } = useParams();
  const { can } = useSession();
  const canEdit = can('content.publish');
  const program = useProgram('campaign', id);
  const [picking, setPicking] = useState(false);
  const { detail, doc } = program;
  if (!detail || !doc) return program.error ? <ErrorMessage error={program.error} /> : <Loading />;
  const campaign = doc as CampaignDocument;
  const set = (patch: Partial<CampaignDocument>) => program.change({ ...campaign, ...patch });
  const tz = browserTimezone();
  return (
    <section>
      <ProgramHeader kind="campaign" program={program} canEdit={canEdit} />
      <div className="card">
        <div className="prop">
          <span className="prop-label">Contenu</span>
          <span>
            {campaign.content
              ? (program.names[`${campaign.content.type}:${campaign.content.id}`] ??
                'Contenu introuvable')
              : 'Aucun'}
          </span>
          {canEdit && (
            <button type="button" onClick={() => setPicking(true)}>
              Choisir
            </button>
          )}
        </div>
        <div className="inline-controls">
          <label>
            Début ({tz}){' '}
            <input
              type="datetime-local"
              aria-label="Début de la campagne"
              disabled={!canEdit}
              value={instantToLocalInput(campaign.starts_at)}
              onChange={(e) => set({ starts_at: localInputToInstant(e.target.value) })}
            />
          </label>
          <label>
            Fin ({tz}){' '}
            <input
              type="datetime-local"
              aria-label="Fin de la campagne"
              disabled={!canEdit}
              value={instantToLocalInput(campaign.ends_at)}
              onChange={(e) => set({ ends_at: localInputToInstant(e.target.value) })}
            />
          </label>
          <label>
            Priorité (20–79){' '}
            <input
              type="number"
              aria-label="Priorité de la campagne"
              min={20}
              max={79}
              disabled={!canEdit}
              value={campaign.priority}
              onChange={(e) =>
                set({ priority: Math.max(20, Math.min(79, e.target.valueAsNumber || 50)) })
              }
            />
          </label>
        </div>
        <p className="hint">
          Début et fin sont des instants absolus, saisis ici dans le fuseau de votre navigateur. À
          la fin, chaque écran reprend la programmation courante, même hors ligne.
        </p>
      </div>
      <TargetsEditor
        value={campaign.targets}
        disabled={!canEdit}
        onChange={(targets) => set({ targets })}
      />
      {picking && (
        <ContentPicker
          title="Contenu de la campagne"
          onClose={() => setPicking(false)}
          onPick={(picked) => {
            program.setNames({
              ...program.names,
              [`${picked.ref.type}:${picked.ref.id}`]: picked.name,
            });
            set({ content: picked.ref });
            setPicking(false);
          }}
        />
      )}
    </section>
  );
}
