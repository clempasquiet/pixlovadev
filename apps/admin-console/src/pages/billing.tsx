import { api, formatDate } from '../api.js';
import { useLoad } from '../load.js';
import { Empty, ErrorMessage, Loading } from '../ui.js';

interface BillingOverview {
  environment: 'test' | 'live';
  subscriptions: { plan_key: string; status: string; count: number }[];
  promotion_codes: {
    code: string;
    uses: number;
    organizations: number;
    last_used_at: string | null;
  }[];
  customers_sync_error: number;
  events: { failed: number; pending: number };
  changes_scheduled: number;
  selections_invalid: number;
  failed_events: {
    stripe_event_id: string;
    type: string;
    stripe_customer_id: string | null;
    attempts: number;
    error: string | null;
    received_at: string;
  }[];
}

/**
 * Vue BillingAdmin (ADM-004, BILL-019) : répartition des abonnements, codes promotionnels
 * utilisés et santé de la synchronisation Stripe. Lecture seule ; la création des codes et
 * les remboursements restent dans Stripe.
 */
export function BillingPage() {
  const { data, error } = useLoad(() => api<BillingOverview>('GET', '/billing'), []);
  if (error) return <ErrorMessage error={error} />;
  if (!data) return <Loading />;
  return (
    <section>
      <h1>Facturation</h1>
      <p className="muted">
        Environnement Stripe : {data.environment === 'live' ? 'production' : 'test'}.
      </p>
      <div className="card">
        <h2>Synchronisation</h2>
        <dl>
          <dt>Clients en erreur de synchronisation</dt>
          <dd>{data.customers_sync_error}</dd>
          <dt>Événements Stripe en échec / en attente</dt>
          <dd>
            {data.events.failed} / {data.events.pending}
          </dd>
          <dt>Changements programmés</dt>
          <dd>{data.changes_scheduled}</dd>
          <dt>Sélections d’écrans invalides à l’échéance</dt>
          <dd>{data.selections_invalid}</dd>
        </dl>
      </div>
      <h2>Abonnements</h2>
      {data.subscriptions.length === 0 ? (
        <Empty>Aucun abonnement.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Offre</th>
              <th>Statut Stripe</th>
              <th>Nombre</th>
            </tr>
          </thead>
          <tbody>
            {data.subscriptions.map((row) => (
              <tr key={`${row.plan_key}:${row.status}`}>
                <td>{row.plan_key}</td>
                <td>{row.status}</td>
                <td>{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Codes promotionnels utilisés</h2>
      {data.promotion_codes.length === 0 ? (
        <Empty>Aucun code utilisé.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Utilisations</th>
              <th>Organisations</th>
              <th>Dernière utilisation</th>
            </tr>
          </thead>
          <tbody>
            {data.promotion_codes.map((row) => (
              <tr key={row.code}>
                <td>{row.code}</td>
                <td>{row.uses}</td>
                <td>{row.organizations}</td>
                <td>{formatDate(row.last_used_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Événements en échec</h2>
      {data.failed_events.length === 0 ? (
        <Empty>Aucun événement en échec.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Reçu le</th>
              <th>Type</th>
              <th>Client Stripe</th>
              <th>Tentatives</th>
              <th>Erreur</th>
            </tr>
          </thead>
          <tbody>
            {data.failed_events.map((row) => (
              <tr key={row.stripe_event_id}>
                <td>{formatDate(row.received_at)}</td>
                <td>{row.type}</td>
                <td>{row.stripe_customer_id ?? '—'}</td>
                <td>{row.attempts}</td>
                <td>{row.error ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
