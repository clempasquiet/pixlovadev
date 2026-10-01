import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, formatBytes, formatDate } from '../api.js';
import { useLoad } from '../load.js';
import { useSession } from '../session.js';
import { Empty, ErrorMessage, Form, Loading, ReasonField, Unavailable } from '../ui.js';

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  country: string;
  created_at: string;
  members: number;
  active_displays: number;
  paired_players: number;
}

export function OrganizationsPage() {
  const [query, setQuery] = useState('');
  const { data, error } = useLoad(
    () => api<{ items: OrganizationRow[] }>('GET', `/organizations?q=${encodeURIComponent(query)}`),
    [query],
  );
  return (
    <section>
      <h1>Organisations</h1>
      <form
        className="inline-form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(String(new FormData(event.currentTarget).get('q') ?? ''));
        }}
      >
        <label htmlFor="org-search">Nom, identifiant ou slug</label>
        <input id="org-search" name="q" type="search" />
        <button type="submit">Rechercher</button>
      </form>
      <ErrorMessage error={error} />
      {!data && !error && <Loading />}
      {data && data.items.length === 0 && <Empty>Aucune organisation.</Empty>}
      {data && data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Organisation</th>
              <th>Statut</th>
              <th>Membres</th>
              <th>Displays actifs</th>
              <th>Players</th>
              <th>Créée le</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((o) => (
              <tr key={o.id}>
                <td>
                  <Link to={`/organizations/${o.id}`}>{o.name}</Link>
                  <div className="hint">{o.id}</div>
                </td>
                <td>{o.status}</td>
                <td>{o.members}</td>
                <td>{o.active_displays}</td>
                <td>{o.paired_players}</td>
                <td>{formatDate(o.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface OrganizationDetail {
  organization: {
    id: string;
    name: string;
    slug: string;
    status: string;
    country: string;
    timezone: string;
    screenshots_enabled: boolean;
    created_at: string;
  };
  members: {
    membership_id: string;
    status: string;
    email: string;
    mfa_enabled: boolean;
    roles: string[];
  }[];
  usage: {
    sites: number;
    active_displays: number;
    active_members: number;
    storage_used_bytes: number;
    storage_reserved_bytes: number;
  };
  entitlements: {
    max_users: number;
    display_slots: number;
    storage_bytes: number;
    features: string[];
  } | null;
  subscription:
    | { available: false; reason: string }
    | {
        available: true;
        environment: 'test' | 'live';
        customer: {
          stripe_customer_id: string;
          sync_status: string;
          sync_error: string | null;
          last_synced_at: string | null;
        } | null;
        subscriptions: {
          stripe_subscription_id: string;
          status: string;
          plan: { key: string; version: number; name: string };
          extra_display_slots: number;
          current_period_end: string | null;
          cancel_at_period_end: boolean;
          grace_until: string | null;
          pending_update: boolean;
        }[];
        changes: {
          id: string;
          kind: string;
          status: string;
          plan_key: string | null;
          extra_display_slots: number;
          effective_at: string | null;
          selection_status: string | null;
          failure_reason: string | null;
          created_at: string;
        }[];
        promotion_redemptions: {
          code: string | null;
          percent_off: number | null;
          amount_off_minor: number | null;
          applied_at: string | null;
          ends_at: string | null;
        }[];
      };
}

type SubscriptionDetail = Extract<OrganizationDetail['subscription'], { available: true }>;

/** Abonnement relu dans la projection locale (ADR-017) : aucune donnée de paiement. */
function SubscriptionSummary({ subscription }: { subscription: SubscriptionDetail }) {
  const current = subscription.subscriptions[0];
  return (
    <>
      {!subscription.customer && <p>Aucun compte de facturation ({subscription.environment}).</p>}
      {subscription.customer && (
        <p className="muted">
          Client Stripe {subscription.customer.stripe_customer_id} · synchronisation{' '}
          {subscription.customer.sync_status}
          {subscription.customer.last_synced_at &&
            ` le ${formatDate(subscription.customer.last_synced_at)}`}
          {subscription.customer.sync_error && ` · ${subscription.customer.sync_error}`}
        </p>
      )}
      {current && (
        <dl>
          <dt>Offre</dt>
          <dd>
            {current.plan.name} v{current.plan.version} + {current.extra_display_slots} écran(s)
          </dd>
          <dt>Statut Stripe</dt>
          <dd>
            {current.status}
            {current.pending_update && ' · hausse en attente de paiement'}
            {current.cancel_at_period_end && ' · annulation à l’échéance'}
            {current.grace_until && ` · grâce jusqu’au ${formatDate(current.grace_until)}`}
          </dd>
          <dt>Échéance</dt>
          <dd>{formatDate(current.current_period_end)}</dd>
        </dl>
      )}
      {subscription.changes.length > 0 && (
        <>
          <h3>Demandes récentes</h3>
          <ul>
            {subscription.changes.map((change) => (
              <li key={change.id}>
                {formatDate(change.created_at)} · {change.kind} {change.plan_key ?? ''} ·{' '}
                {change.status}
                {change.effective_at && ` (effet ${formatDate(change.effective_at)})`}
                {change.selection_status && ` · sélection ${change.selection_status}`}
                {change.failure_reason && ` · ${change.failure_reason}`}
              </li>
            ))}
          </ul>
        </>
      )}
      {subscription.promotion_redemptions.length > 0 && (
        <>
          <h3>Codes promotionnels</h3>
          <ul>
            {subscription.promotion_redemptions.map((r, index) => (
              <li key={index}>
                {r.code ?? 'remise'} ·{' '}
                {r.percent_off !== null
                  ? `${r.percent_off} %`
                  : `${(r.amount_off_minor ?? 0) / 100} €`}{' '}
                · {formatDate(r.applied_at)}
                {r.ends_at && ` → ${formatDate(r.ends_at)}`}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

interface Fleet {
  players: {
    id: string;
    name: string;
    type: string;
    lifecycle_status: string;
    app_version: string | null;
    os: string | null;
    last_seen_at: string | null;
    online: boolean;
    renderer: string | null;
    disk_free_bytes: number | null;
    disk_total_bytes: number | null;
  }[];
  displays: {
    id: string;
    name: string;
    width: number;
    height: number;
    lifecycle_status: string;
    manifest_version: string | null;
    assigned_player_id: string | null;
    output_key: string | null;
  }[];
  incidents: {
    id: string;
    rule: string;
    severity: string;
    opened_at: string;
    suspected_platform: boolean;
  }[];
}

/** Fiche d’une organisation : le motif est saisi avant tout chargement (ADM-003). */
export function OrganizationPage() {
  const { id } = useParams();
  const session = useSession();
  const [reason, setReason] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrganizationDetail | null>(null);
  const [fleet, setFleet] = useState<Fleet | null>(null);
  if (!reason || !detail) {
    return (
      <section className="narrow">
        <h1>Consulter une organisation</h1>
        <p className="muted">
          La consultation est journalisée avec votre motif. Les adresses des membres restent
          masquées.
        </p>
        <Form
          submitLabel="Consulter"
          onSubmit={async (values) => {
            const loaded = await api<OrganizationDetail>(
              'GET',
              `/organizations/${id}`,
              undefined,
              values.reason,
            );
            setDetail(loaded);
            setReason(values.reason ?? '');
          }}
        >
          <ReasonField />
        </Form>
      </section>
    );
  }
  const { organization, usage, entitlements } = detail;
  return (
    <section>
      <h1>{organization.name}</h1>
      <p className="muted">
        {organization.id} · {organization.slug} · {organization.country} · {organization.timezone} ·
        statut {organization.status} · créée le {formatDate(organization.created_at)}
      </p>
      <p className="audit-banner" role="note">
        Organisation consultée : {organization.name}. Motif : {reason}
      </p>
      <div className="grid-2">
        <div className="card">
          <h2>Usages</h2>
          <dl>
            <dt>Sites</dt>
            <dd>{usage.sites}</dd>
            <dt>Displays actifs</dt>
            <dd>
              {usage.active_displays}
              {entitlements && ` / ${entitlements.display_slots}`}
            </dd>
            <dt>Membres actifs</dt>
            <dd>
              {usage.active_members}
              {entitlements && ` / ${entitlements.max_users}`}
            </dd>
            <dt>Stockage</dt>
            <dd>
              {formatBytes(usage.storage_used_bytes)}
              {entitlements && ` / ${formatBytes(entitlements.storage_bytes)}`}
              {usage.storage_reserved_bytes > 0 &&
                ` (+ ${formatBytes(usage.storage_reserved_bytes)} réservés)`}
            </dd>
            <dt>Fonctionnalités</dt>
            <dd>{entitlements ? entitlements.features.join(', ') || 'aucune' : 'non autorisé'}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Abonnement</h2>
          {detail.subscription.available ? (
            <SubscriptionSummary subscription={detail.subscription} />
          ) : (
            <Unavailable>{detail.subscription.reason}</Unavailable>
          )}
          <p className="muted">
            Captures d’écran : {organization.screenshots_enabled ? 'autorisées' : 'désactivées'} par
            l’organisation.
          </p>
        </div>
      </div>
      <h2>Membres</h2>
      <table>
        <thead>
          <tr>
            <th>Adresse (masquée)</th>
            <th>Rôles</th>
            <th>Statut</th>
            <th>MFA</th>
          </tr>
        </thead>
        <tbody>
          {detail.members.map((m) => (
            <tr key={m.membership_id}>
              <td>{m.email}</td>
              <td>{m.roles.join(', ') || '—'}</td>
              <td>{m.status}</td>
              <td>{m.mfa_enabled ? 'active' : 'non'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {session.can('platform.organizations.diagnostics') && (
        <>
          <h2>Parc et incidents</h2>
          {!fleet ? (
            <button
              type="button"
              onClick={async () =>
                setFleet(await api<Fleet>('GET', `/organizations/${id}/fleet`, undefined, reason))
              }
            >
              Charger le diagnostic du parc
            </button>
          ) : (
            <FleetView fleet={fleet} />
          )}
        </>
      )}
    </section>
  );
}

function FleetView({ fleet }: { fleet: Fleet }) {
  return (
    <>
      <table aria-label="Players">
        <thead>
          <tr>
            <th>Player</th>
            <th>Présence</th>
            <th>Version</th>
            <th>Renderer</th>
            <th>Disque libre</th>
            <th>Dernier contact</th>
          </tr>
        </thead>
        <tbody>
          {fleet.players.map((p) => (
            <tr key={p.id}>
              <td>
                {p.name}{' '}
                <span className="hint">
                  ({p.type}, {p.lifecycle_status})
                </span>
              </td>
              <td>{p.online ? 'en ligne' : 'hors ligne'}</td>
              <td>{p.app_version ?? 'indisponible'}</td>
              <td>{p.renderer ?? 'indisponible'}</td>
              <td>{formatBytes(p.disk_free_bytes)}</td>
              <td>{formatDate(p.last_seen_at)}</td>
            </tr>
          ))}
          {fleet.players.length === 0 && (
            <tr>
              <td colSpan={6}>Aucun Player.</td>
            </tr>
          )}
        </tbody>
      </table>
      <table aria-label="Displays">
        <thead>
          <tr>
            <th>Display</th>
            <th>Format</th>
            <th>Sortie affectée</th>
            <th>Manifest</th>
          </tr>
        </thead>
        <tbody>
          {fleet.displays.map((d) => (
            <tr key={d.id}>
              <td>{d.name}</td>
              <td>
                {d.width}×{d.height}
              </td>
              <td>{d.output_key ?? 'aucune'}</td>
              <td>{d.manifest_version ?? '—'}</td>
            </tr>
          ))}
          {fleet.displays.length === 0 && (
            <tr>
              <td colSpan={4}>Aucun Display.</td>
            </tr>
          )}
        </tbody>
      </table>
      <table aria-label="Incidents ouverts">
        <thead>
          <tr>
            <th>Incident</th>
            <th>Gravité</th>
            <th>Ouvert le</th>
          </tr>
        </thead>
        <tbody>
          {fleet.incidents.map((i) => (
            <tr key={i.id}>
              <td>
                {i.rule}
                {i.suspected_platform && <span className="badge">plateforme suspectée</span>}
              </td>
              <td>{i.severity}</td>
              <td>{formatDate(i.opened_at)}</td>
            </tr>
          ))}
          {fleet.incidents.length === 0 && (
            <tr>
              <td colSpan={3}>Aucun incident ouvert.</td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
