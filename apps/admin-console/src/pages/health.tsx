import { api, formatDate } from '../api.js';
import { useLoad } from '../load.js';
import { ErrorMessage, Loading, Unavailable } from '../ui.js';

interface Health {
  observed_at: string;
  organizations: number;
  active_users: number;
  players: { paired: number; online: number };
  incidents: { open: number; suspected_platform: number };
  emails: { pending: number; failing: number; oldest_pending_at: string | null };
  jobs: {
    stale_leases: number;
    failed_last_24h: number;
    by_kind: { kind: string; state: string; count: number }[];
  };
  schema: { migrations_applied: number; last_migration_at: string | null };
}

export function HealthPage() {
  const { data, error, reload } = useLoad(() => api<Health>('GET', '/health'), []);
  if (error) return <ErrorMessage error={error} />;
  if (!data) return <Loading />;
  const tiles: [string, string | number, string | undefined][] = [
    ['Organisations', data.organizations, undefined],
    ['Comptes actifs', data.active_users, undefined],
    ['Players en ligne', `${data.players.online} / ${data.players.paired}`, undefined],
    [
      'Incidents ouverts',
      data.incidents.open,
      data.incidents.suspected_platform
        ? `dont ${data.incidents.suspected_platform} suspectés plateforme`
        : undefined,
    ],
    [
      'Emails en attente',
      data.emails.pending,
      data.emails.failing ? `${data.emails.failing} en échec` : undefined,
    ],
    ['Tâches en échec (24 h)', data.jobs.failed_last_24h, undefined],
    ['Baux expirés', data.jobs.stale_leases, 'tâches en cours sans worker actif'],
    [
      'Migrations appliquées',
      data.schema.migrations_applied,
      formatDate(data.schema.last_migration_at),
    ],
  ];
  return (
    <section>
      <h1>Santé de la plateforme</h1>
      <p className="muted">
        Mesuré le {formatDate(data.observed_at)}.{' '}
        <button type="button" className="link" onClick={() => void reload()}>
          Actualiser
        </button>
      </p>
      <div className="tiles">
        {tiles.map(([label, value, note]) => (
          <div className="card tile" key={label}>
            <p className="muted">{label}</p>
            <p className="tile-value">{value}</p>
            {note && <p className="hint">{note}</p>}
          </div>
        ))}
      </div>
      <h2>Files de tâches</h2>
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>État</th>
            <th>Nombre</th>
          </tr>
        </thead>
        <tbody>
          {data.jobs.by_kind.map((row) => (
            <tr key={`${row.kind}-${row.state}`}>
              <td>{row.kind}</td>
              <td>{row.state}</td>
              <td>{row.count}</td>
            </tr>
          ))}
          {data.jobs.by_kind.length === 0 && (
            <tr>
              <td colSpan={3}>Aucune tâche récente.</td>
            </tr>
          )}
        </tbody>
      </table>
      <Unavailable>
        Releases des Players : aucun registre de publication n’existe encore côté plateforme ; les
        paquets restent signés hors ligne (ADR-012).
      </Unavailable>
    </section>
  );
}
