import { useState } from 'react';
import { api, formatDate } from '../api.js';
import { useSession } from '../session.js';
import { Empty, Field, Form, ReasonField } from '../ui.js';

interface Customer {
  id: string;
  email: string;
  display_name: string | null;
  status: string;
  email_verified: boolean;
  mfa_enabled: boolean;
  created_at: string;
  active_sessions: number;
  last_seen_at: string | null;
  memberships: {
    organization_id: string;
    organization_name: string;
    status: string;
    roles: string[];
  }[];
}

/**
 * Comptes clients : recherche par adresse exacte (pas de liste), actions bornées au compte
 * trouvé, motif et second facteur récent ; aucune impersonation (ADM-003).
 */
export function CustomersPage() {
  const session = useSession();
  const [customer, setCustomer] = useState<Customer | null | undefined>(undefined);
  const [done, setDone] = useState<string | null>(null);
  return (
    <section>
      <h1>Comptes clients</h1>
      <div className="card narrow">
        <Form
          submitLabel="Rechercher"
          onSubmit={async (values) => {
            setDone(null);
            const result = await api<{ customer: Customer | null }>(
              'GET',
              `/customers?email=${encodeURIComponent(values.email ?? '')}`,
              undefined,
              values.reason,
            );
            setCustomer(result.customer);
          }}
        >
          <Field label="Adresse exacte du compte" name="email" type="email" autoComplete="off" />
          <ReasonField />
        </Form>
      </div>
      {customer === null && <Empty>Aucun compte avec cette adresse.</Empty>}
      {customer && (
        <>
          <div className="card">
            <h2>{customer.email}</h2>
            <dl>
              <dt>Statut</dt>
              <dd>{customer.status === 'active' ? 'actif' : 'désactivé'}</dd>
              <dt>Adresse vérifiée</dt>
              <dd>{customer.email_verified ? 'oui' : 'non'}</dd>
              <dt>Second facteur</dt>
              <dd>{customer.mfa_enabled ? 'actif' : 'inactif'}</dd>
              <dt>Sessions actives</dt>
              <dd>{customer.active_sessions}</dd>
              <dt>Dernière activité</dt>
              <dd>{formatDate(customer.last_seen_at)}</dd>
              <dt>Créé le</dt>
              <dd>{formatDate(customer.created_at)}</dd>
            </dl>
            <h3>Organisations</h3>
            <ul>
              {customer.memberships.map((m) => (
                <li key={m.organization_id}>
                  {m.organization_name} — {m.roles.join(', ') || 'aucun rôle'} ({m.status})
                </li>
              ))}
              {customer.memberships.length === 0 && <li>Aucune.</li>}
            </ul>
          </div>
          {done && (
            <p className="alert alert-info" role="status">
              {done}
            </p>
          )}
          <div className="grid-2">
            {session.can('platform.customers.revoke_sessions') && (
              <div className="card">
                <h2>Révoquer les sessions</h2>
                <p className="muted">Déconnecte le compte de tous ses appareils.</p>
                <Form
                  submitLabel="Révoquer les sessions"
                  danger
                  onSubmit={async (values) => {
                    const result = await session.protect(() =>
                      api<{ revoked_sessions: number; customer: Customer }>(
                        'POST',
                        `/customers/${customer.id}/sessions/revoke`,
                        { reason: values.reason },
                      ),
                    );
                    setCustomer(result.customer);
                    setDone(`${result.revoked_sessions} session(s) révoquée(s).`);
                  }}
                >
                  <ReasonField />
                </Form>
              </div>
            )}
            {session.can('platform.customers.reset_mfa') && customer.mfa_enabled && (
              <div className="card">
                <h2>Réinitialiser le second facteur</h2>
                <p className="muted">
                  Récupération d’un compte sans code de secours, après vérification de l’identité
                  hors de pixlova. Toutes les sessions sont fermées.
                </p>
                <Form
                  submitLabel="Réinitialiser le second facteur"
                  danger
                  onSubmit={async (values) => {
                    const result = await session.protect(() =>
                      api<{ customer: Customer }>('POST', `/customers/${customer.id}/mfa/reset`, {
                        reason: values.reason,
                        confirm_email: values.confirm_email,
                      }),
                    );
                    setCustomer(result.customer);
                    setDone('Second facteur réinitialisé.');
                  }}
                >
                  <ReasonField />
                  <Field
                    label="Recopiez l’adresse du compte"
                    name="confirm_email"
                    type="email"
                    autoComplete="off"
                  />
                </Form>
              </div>
            )}
            {session.can('platform.customers.set_status') && (
              <div className="card">
                <h2>
                  {customer.status === 'active' ? 'Désactiver le compte' : 'Réactiver le compte'}
                </h2>
                <Form
                  submitLabel={
                    customer.status === 'active' ? 'Désactiver le compte' : 'Réactiver le compte'
                  }
                  danger={customer.status === 'active'}
                  onSubmit={async (values) => {
                    const status = customer.status === 'active' ? 'disabled' : 'active';
                    const result = await session.protect(() =>
                      api<{ customer: Customer }>('POST', `/customers/${customer.id}/status`, {
                        status,
                        reason: values.reason,
                        confirm_email: values.confirm_email,
                      }),
                    );
                    setCustomer(result.customer);
                    setDone(status === 'disabled' ? 'Compte désactivé.' : 'Compte réactivé.');
                  }}
                >
                  <ReasonField />
                  <Field
                    label="Recopiez l’adresse du compte"
                    name="confirm_email"
                    type="email"
                    autoComplete="off"
                  />
                </Form>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
