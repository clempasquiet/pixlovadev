import { useState } from 'react';
import { api, formatDate } from '../api.js';
import { useLoad } from '../load.js';
import { useSession } from '../session.js';
import { Empty, ErrorMessage, Form, Loading, ReasonField } from '../ui.js';

export function IncidentsPage() {
  const { data, error } = useLoad(
    () =>
      api<{
        items: {
          id: string;
          organization_id: string;
          organization_name: string;
          rule: string;
          severity: string;
          target_type: string;
          opened_at: string;
          suspected_platform: boolean;
        }[];
      }>('GET', '/incidents'),
    [],
  );
  if (error) return <ErrorMessage error={error} />;
  if (!data) return <Loading />;
  return (
    <section>
      <h1>Incidents ouverts</h1>
      {data.items.length === 0 ? (
        <Empty>Aucun incident ouvert.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Organisation</th>
              <th>Règle</th>
              <th>Gravité</th>
              <th>Cible</th>
              <th>Ouvert le</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((i) => (
              <tr key={i.id}>
                <td>{i.organization_name}</td>
                <td>
                  {i.rule}
                  {i.suspected_platform && <span className="badge">plateforme suspectée</span>}
                </td>
                <td>{i.severity}</td>
                <td>{i.target_type}</td>
                <td>{formatDate(i.opened_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface FailedJob {
  id: string;
  organization_name: string | null;
  kind: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  finished_at: string | null;
}

export function JobsPage() {
  const session = useSession();
  const { data, error, reload } = useLoad(() => api<{ items: FailedJob[] }>('GET', '/jobs'), []);
  const [retrying, setRetrying] = useState<string | null>(null);
  if (error) return <ErrorMessage error={error} />;
  if (!data) return <Loading />;
  return (
    <section>
      <h1>Tâches en échec</h1>
      {data.items.length === 0 ? (
        <Empty>Aucune tâche en échec.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Organisation</th>
              <th>Tentatives</th>
              <th>Dernière erreur</th>
              <th>Terminée le</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((job) => (
              <tr key={job.id}>
                <td>{job.kind}</td>
                <td>{job.organization_name ?? 'système'}</td>
                <td>
                  {job.attempts} / {job.max_attempts}
                </td>
                <td>
                  <code>{job.last_error ?? '—'}</code>
                </td>
                <td>{formatDate(job.finished_at)}</td>
                <td>
                  {session.can('platform.jobs.retry') &&
                    (retrying === job.id ? (
                      <Form
                        submitLabel="Relancer"
                        onSubmit={async (values) => {
                          await api('POST', `/jobs/${job.id}/retry`, { reason: values.reason });
                          setRetrying(null);
                          await reload();
                        }}
                      >
                        <ReasonField label="Motif de la relance" />
                      </Form>
                    ) : (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => setRetrying(job.id)}
                      >
                        Relancer…
                      </button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function TemplatesPage() {
  const { data, error } = useLoad(
    () =>
      api<{
        items: {
          key: string;
          version: number;
          name: string;
          category: string;
          description: string;
          required_features: string[];
          canvas: { width: number; height: number };
        }[];
      }>('GET', '/templates'),
    [],
  );
  if (error) return <ErrorMessage error={error} />;
  if (!data) return <Loading />;
  return (
    <section>
      <h1>Catalogue de templates</h1>
      <p className="muted">
        Versionné avec le code (ADR-010) : une modification passe par une nouvelle version publiée
        avec l’application, jamais par une édition en production.
      </p>
      <table>
        <thead>
          <tr>
            <th>Template</th>
            <th>Version</th>
            <th>Catégorie</th>
            <th>Format</th>
            <th>Fonctionnalités requises</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((t) => (
            <tr key={t.key}>
              <td>
                {t.name}
                <div className="hint">{t.description}</div>
              </td>
              <td>{t.version}</td>
              <td>{t.category}</td>
              <td>
                {t.canvas.width}×{t.canvas.height}
              </td>
              <td>{t.required_features.join(', ') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

interface AuditEntry {
  id: string;
  created_at: string;
  actor_email: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  result: string;
  reason: string | null;
  metadata: Record<string, unknown>;
}

export function AuditPage() {
  const [items, setItems] = useState<AuditEntry[]>([]);
  const { error } = useLoad(async () => {
    const page = await api<{ items: AuditEntry[] }>('GET', '/audit');
    setItems(page.items);
    return page;
  }, []);
  const [more, setMore] = useState(true);
  if (error) return <ErrorMessage error={error} />;
  return (
    <section>
      <h1>Journal de la plateforme</h1>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Opérateur</th>
            <th>Action</th>
            <th>Cible</th>
            <th>Résultat</th>
            <th>Motif</th>
            <th>Détail</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => (
            <tr key={e.id}>
              <td>{formatDate(e.created_at)}</td>
              <td>{e.actor_email ?? '—'}</td>
              <td>{e.action}</td>
              <td>{e.target_type ? `${e.target_type} ${e.target_id ?? ''}` : '—'}</td>
              <td>{e.result}</td>
              <td>{e.reason ?? '—'}</td>
              <td>
                <code>
                  {Object.keys(e.metadata ?? {}).length ? JSON.stringify(e.metadata) : ''}
                </code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {more && items.length > 0 && (
        <button
          type="button"
          className="secondary"
          onClick={async () => {
            const last = items.at(-1)!;
            const page = await api<{ items: AuditEntry[] }>(
              'GET',
              `/audit?before=${encodeURIComponent(last.created_at)}`,
            );
            setItems([...items, ...page.items]);
            if (page.items.length === 0) setMore(false);
          }}
        >
          Entrées plus anciennes
        </button>
      )}
    </section>
  );
}
