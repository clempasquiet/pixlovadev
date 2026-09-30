import { useState } from 'react';
import type { ContentRef } from '@pixlova/contracts';
import { parseLocalDate, resolveLocal } from '@pixlova/scheduling';
import { api, idempotencyKey } from '../api.js';
import { useLoad } from '../data.js';
import { useSession } from '../session.js';
import { Empty, ErrorMessage, Loading } from '../ui.js';
import { ContentPicker, type PickedContent } from './content-picker.js';
import {
  COMPILATION_LABEL,
  DELIVERY_LABEL,
  formatInstantIn,
  KIND_LABEL,
  MASK_LABEL,
} from './model.js';
import { StatusBadge } from './programs.js';

interface Entry {
  starts_at: string;
  ends_at: string;
  winner: {
    kind: string;
    program_id: string;
    rule_id: string;
    priority: number;
    content: ContentRef;
    exception_id: string | null;
    occurrence: { starts_at: string; ends_at: string };
  } | null;
  masked: { kind: string; program_id: string; rule_id: string; priority: number; reason: string }[];
}

interface EffectiveProgram {
  timezone: string;
  assigned: boolean;
  fallback: ContentRef | null;
  entries: Entry[];
  programs: Record<string, { name: string; kind: string }>;
  contents: Record<string, { name: string; status: string }>;
}

interface DeliverySummary {
  manifest_id: string;
  version: string;
  generated_at: string;
  schedule_until: string;
  state: string | null;
  applied_at: string | null;
  error_code: string | null;
  detail: string | null;
}

interface Delivery {
  desired: DeliverySummary | null;
  prepared: DeliverySummary | null;
  applied: DeliverySummary | null;
  horizon: { until: string | null; exhausted_soon: boolean };
  compilations: {
    id: string;
    config_revision: string;
    status: string;
    issues: { severity: string; message: string }[];
    created_at: string;
  }[];
  fallback: ContentRef | null;
}

const RANGES = { day: 1, week: 7, month: 31 } as const;

/** Minuit local d’une date dans le fuseau de l’écran (jamais celui du navigateur). */
function midnight(date: string, timezone: string): number | null {
  const days = parseLocalDate(date);
  if (days === null) return null;
  const resolved = resolveLocal(days, 0, timezone);
  return resolved.kind === 'exact'
    ? resolved.instant
    : resolved.kind === 'repeated'
      ? resolved.first
      : resolved.next;
}

function contentName(program: EffectiveProgram, ref: ContentRef | null): string {
  if (!ref) return 'Écran d’attente';
  return program.contents[`${ref.type}:${ref.id}`]?.name ?? 'Contenu indisponible';
}

/** Programme expliqué (PLN-005, PROD-003) : même moteur que le manifest, fuseau affiché. */
function ProgramExplanation(props: { displayId: string; timezone: string }) {
  const [range, setRange] = useState<keyof typeof RANGES>('day');
  const [date, setDate] = useState(() =>
    new Intl.DateTimeFormat('en-CA', { timeZone: props.timezone }).format(new Date()),
  );
  const from = midnight(date, props.timezone);
  const until =
    from === null
      ? null
      : midnight(
          new Date(Date.parse(`${date}T12:00:00Z`) + RANGES[range] * 86_400_000)
            .toISOString()
            .slice(0, 10),
          props.timezone,
        );
  const query =
    from !== null && until !== null
      ? `?from=${new Date(from).toISOString().replace(/\.000Z$/, 'Z')}&until=${new Date(until).toISOString().replace(/\.000Z$/, 'Z')}`
      : '';
  const program = useLoad<EffectiveProgram>(
    query ? `/displays/${props.displayId}/effective-program${query}` : null,
  );
  const p = program.data;
  return (
    <div className="card">
      <div className="page-header">
        <h2>Programme</h2>
        <span className="inline-controls">
          <select
            aria-label="Vue"
            value={range}
            onChange={(e) => setRange(e.target.value as keyof typeof RANGES)}
          >
            <option value="day">Jour</option>
            <option value="week">Semaine</option>
            <option value="month">Mois</option>
          </select>
          <input
            type="date"
            aria-label="Date simulée"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
        </span>
      </div>
      <p className="muted">
        Horaires affichés dans le fuseau de l’écran :{' '}
        <strong>{p?.timezone ?? props.timezone}</strong>. La simulation utilise le même moteur de
        décision que les manifests distribués.
      </p>
      <ErrorMessage error={program.error} />
      {!p && !program.error && <Loading />}
      {p && p.entries.length === 0 && <Empty>Aucune période.</Empty>}
      {p && p.entries.length > 0 && (
        <table aria-label="Programme expliqué">
          <thead>
            <tr>
              <th scope="col">Période</th>
              <th scope="col">Contenu</th>
              <th scope="col">Pourquoi</th>
              <th scope="col">Règles masquées</th>
            </tr>
          </thead>
          <tbody>
            {p.entries.map((entry) => (
              <tr key={entry.starts_at}>
                <td>
                  {formatInstantIn(entry.starts_at, p.timezone)} →{' '}
                  {formatInstantIn(entry.ends_at, p.timezone, range !== 'day')}
                </td>
                <td>
                  {entry.winner
                    ? contentName(p, entry.winner.content)
                    : `Repli : ${contentName(p, p.fallback)}`}
                </td>
                <td>
                  {entry.winner ? (
                    <>
                      {KIND_LABEL[entry.winner.kind] ?? entry.winner.kind} «{' '}
                      {p.programs[entry.winner.program_id]?.name ?? '—'} » · priorité{' '}
                      {entry.winner.priority}
                      {entry.winner.exception_id && ' · exception datée'}
                      <p className="muted">
                        Occurrence {formatInstantIn(entry.winner.occurrence.starts_at, p.timezone)}{' '}
                        → {formatInstantIn(entry.winner.occurrence.ends_at, p.timezone)}
                      </p>
                    </>
                  ) : (
                    'Aucune règle active et jouable'
                  )}
                </td>
                <td>
                  {entry.masked.length === 0
                    ? '—'
                    : entry.masked.map((m) => (
                        <p key={`${m.rule_id}-${m.reason}`} className="muted">
                          {KIND_LABEL[m.kind] ?? m.kind} « {p.programs[m.program_id]?.name ?? '—'} »
                          (priorité {m.priority}) : {MASK_LABEL[m.reason] ?? m.reason}
                        </p>
                      ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** États désiré, préparé et appliqué (FON-002) ; « appliqué » vient toujours du Player. */
function DeliveryCard(props: { displayId: string; timezone: string }) {
  const delivery = useLoad<Delivery>(`/displays/${props.displayId}/delivery`);
  const d = delivery.data;
  const row = (label: string, value: DeliverySummary | null) => (
    <tr>
      <th scope="row">{label}</th>
      <td>
        {value ? (
          <>
            Version {value.version} · générée {formatInstantIn(value.generated_at, props.timezone)}
            {value.state && (
              <span className="muted"> · {DELIVERY_LABEL[value.state] ?? value.state}</span>
            )}
            {value.error_code && <span className="danger-text"> · {value.error_code}</span>}
          </>
        ) : (
          <span className="muted">Aucune</span>
        )}
      </td>
    </tr>
  );
  return (
    <div className="card">
      <div className="page-header">
        <h2>Diffusion</h2>
        <button type="button" className="link" onClick={() => void delivery.reload()}>
          Actualiser
        </button>
      </div>
      <ErrorMessage error={delivery.error} />
      {!d && !delivery.error && <Loading />}
      {d && (
        <>
          <table aria-label="États de diffusion">
            <tbody>
              {row('Désirée', d.desired)}
              {row('Préparée', d.prepared)}
              {row('Appliquée', d.applied)}
            </tbody>
          </table>
          <p className={d.horizon.exhausted_soon ? 'alert alert-error' : 'muted'}>
            {d.horizon.until
              ? `Programmation compilée jusqu’au ${formatInstantIn(d.horizon.until, props.timezone)}${d.horizon.exhausted_soon ? ' : horizon bientôt épuisé.' : '.'}`
              : 'Aucun manifest compilé pour le moment.'}
          </p>
          <p className="hint">
            Une version n’est « appliquée » qu’après confirmation du Player. Un Player hors ligne
            conserve sa diffusion locale ; aucune prise en compte immédiate n’est promise.
          </p>
          {d.compilations.length > 0 && (
            <details>
              <summary>Historique des compilations</summary>
              <ul className="plain-list">
                {d.compilations.map((c) => (
                  <li key={c.id}>
                    {new Date(c.created_at).toLocaleString('fr-FR')} · révision {c.config_revision}{' '}
                    · {COMPILATION_LABEL[c.status] ?? c.status}
                    {c.issues
                      .filter((i) => i.severity === 'error')
                      .map((i) => (
                        <p key={i.message} className="danger-text">
                          {i.message}
                        </p>
                      ))}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** Repli local (PLN-010) : contenu permanent, sinon écran d’attente explicite. */
function FallbackCard(props: { displayId: string; siteId: string }) {
  const { can } = useSession();
  const delivery = useLoad<Delivery>(`/displays/${props.displayId}/delivery`);
  const [picking, setPicking] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const current = delivery.data?.fallback ?? null;
  const set = async (content: ContentRef | null) => {
    try {
      setError(null);
      await api('PUT', `/displays/${props.displayId}/fallback`, { content });
      await delivery.reload();
    } catch (caught) {
      setError(caught);
    }
  };
  return (
    <div className="card">
      <h2>Repli</h2>
      <p>
        {current
          ? `Contenu de repli : ${name ?? `${current.type} choisi`}`
          : 'Écran d’attente explicite (aucun contenu de repli).'}
      </p>
      <p className="hint">
        Joué hors programmation et après la fin de l’horizon compilé. Seuls les éléments sans date
        de fin y sont retenus : une campagne n’est jamais prolongée.
      </p>
      <ErrorMessage error={error} />
      {can('player.configure') && (
        <div className="inline-controls">
          <button type="button" onClick={() => setPicking(true)}>
            Choisir un contenu de repli
          </button>
          {current && (
            <button type="button" className="link" onClick={() => void set(null)}>
              Revenir à l’écran d’attente
            </button>
          )}
        </div>
      )}
      {picking && (
        <ContentPicker
          title="Contenu de repli"
          onClose={() => setPicking(false)}
          onPick={(picked: PickedContent) => {
            setName(picked.name);
            setPicking(false);
            void set(picked.ref);
          }}
        />
      )}
    </div>
  );
}

interface OverrideItem {
  id: string;
  name: string;
  status: string;
  published: { ends_at: string | null; priority: number } | null;
}

/** « Diffuser maintenant » (PAR-005) : durée bornée, contenu interrompu, heure de retour. */
function BroadcastCard(props: { displayId: string; timezone: string }) {
  const { can } = useSession();
  const active = useLoad<{ items: OverrideItem[] }>('/overrides?active=true');
  const now = useLoad<EffectiveProgram>(`/displays/${props.displayId}/effective-program`);
  const [picked, setPicked] = useState<PickedContent | null>(null);
  const [picking, setPicking] = useState(false);
  const [minutes, setMinutes] = useState(30);
  const [emergency, setEmergency] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!can('override.create')) return null;
  const current = now.data?.entries[0];
  const interrupted = now.data
    ? current?.winner
      ? contentName(now.data, current.winner.content)
      : `repli (${contentName(now.data, now.data.fallback)})`
    : '…';
  return (
    <div className="card">
      <h2>Diffuser maintenant</h2>
      <p className="muted">Contenu interrompu sur cet écran : {interrupted}</p>
      <div className="inline-controls">
        <span>{picked ? picked.name : 'Aucun contenu choisi'}</span>
        <button type="button" onClick={() => setPicking(true)}>
          Choisir
        </button>
        <label>
          Durée{' '}
          <select
            aria-label="Durée de la diffusion"
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          >
            {[15, 30, 60, 120, 240, 480, 1440].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} min` : `${m / 60} h`}
              </option>
            ))}
          </select>
        </label>
        {can('override.emergency') && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={emergency}
              onChange={(e) => setEmergency(e.target.checked)}
            />
            Urgence (priorité 100)
          </label>
        )}
        <button
          type="button"
          disabled={!picked}
          onClick={async () => {
            try {
              setError(null);
              const ends = new Date(Date.now() + minutes * 60_000)
                .toISOString()
                .replace(/\.[0-9]{3}Z$/, 'Z');
              const created = await api<{ returns_at: string; targets: { count: number } }>(
                'POST',
                '/overrides',
                {
                  content: picked!.ref,
                  ends_at: ends,
                  priority: emergency ? 100 : 90,
                  targets: { include: [{ type: 'display', id: props.displayId }], exclude: [] },
                },
                idempotencyKey(),
              );
              setResult(
                `Diffusion acceptée par le cloud. Retour à la programmation le ${formatInstantIn(created.returns_at, props.timezone)}. L’écran l’appliquera après réception et préparation.`,
              );
              await Promise.all([active.reload(), now.reload()]);
            } catch (caught) {
              setError(caught);
            }
          }}
        >
          Diffuser
        </button>
      </div>
      {result && (
        <p className="alert alert-info" role="status">
          {result}
        </p>
      )}
      <ErrorMessage error={error} />
      {active.data && active.data.items.length > 0 && (
        <>
          <h3>Diffusions immédiates en cours</h3>
          <ul className="plain-list">
            {active.data.items.map((item) => (
              <li key={item.id}>
                {item.name} <StatusBadge status={item.status} />
                {item.published?.ends_at && (
                  <span className="muted">
                    {' '}
                    · jusqu’au {formatInstantIn(item.published.ends_at, props.timezone)}
                  </span>
                )}{' '}
                <button
                  type="button"
                  className="link danger-text"
                  onClick={async () => {
                    await api('POST', `/overrides/${item.id}/cancel`);
                    await Promise.all([active.reload(), now.reload()]);
                  }}
                >
                  Interrompre
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {picking && (
        <ContentPicker
          title="Contenu à diffuser"
          onClose={() => setPicking(false)}
          onPick={(content) => {
            setPicked(content);
            setPicking(false);
          }}
        />
      )}
    </div>
  );
}

/** Programme et diffusion d’un écran, dans son fuseau effectif (écran, site, organisation). */
export function DisplayProgramPanel(props: { displayId: string; siteId: string }) {
  const probe = useLoad<EffectiveProgram>(`/displays/${props.displayId}/effective-program`);
  if (!probe.data) return probe.error ? <ErrorMessage error={probe.error} /> : <Loading />;
  const timezone = probe.data.timezone;
  return (
    <>
      <BroadcastCard displayId={props.displayId} timezone={timezone} />
      <ProgramExplanation displayId={props.displayId} timezone={timezone} />
      <DeliveryCard displayId={props.displayId} timezone={timezone} />
      <FallbackCard displayId={props.displayId} siteId={props.siteId} />
    </>
  );
}
