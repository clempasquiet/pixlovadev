import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ROLES, type Role } from '@pixlova/permissions';
import { api, type Grant } from '../api.js';
import { useActiveOrganization, useSession } from '../session.js';
import { Empty, ErrorMessage, Field, Forbidden, Form, Loading } from '../ui.js';

function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    setError(null);
    try {
      setData(await api<T>('GET', path));
    } catch (caught) {
      setError(caught);
    }
  }, [path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}

const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function CreateOrganizationPage() {
  const { refresh, selectOrganization } = useSession();
  const navigate = useNavigate();
  return (
    <section className="card narrow">
      <h1>Créer une organisation</h1>
      <p className="muted">
        Elle démarre avec l’offre gratuite : un Display actif et un utilisateur. Vous en devenez
        propriétaire.
      </p>
      <Form
        submitLabel="Créer l’organisation"
        onSubmit={async (values) => {
          const created = await api<{ id: string }>('POST', '/organizations', {
            name: values.name,
            country: (values.country ?? '').toUpperCase(),
            timezone: values.timezone,
          });
          selectOrganization(created.id);
          await refresh();
          navigate('/', { replace: true });
        }}
      >
        <Field label="Nom de l’organisation" name="name" autoComplete="organization" />
        <Field
          label="Pays (code ISO, ex. FR)"
          name="country"
          defaultValue="FR"
          pattern="[A-Za-z]{2}"
        />
        <Field
          label="Fuseau horaire"
          name="timezone"
          defaultValue={TIMEZONE}
          hint="Fuseau IANA utilisé par défaut pour la programmation des sites."
        />
      </Form>
    </section>
  );
}

export function HomePage() {
  const organization = useActiveOrganization();
  const { grants, me } = useSession();
  return (
    <section>
      <h1>{organization?.name}</h1>
      <div className="card">
        <h2>Premiers pas</h2>
        <ol className="steps">
          <li className="done">Compte créé et adresse confirmée ({me?.user.email})</li>
          <li className="done">Organisation créée</li>
          <li>
            <Link to="/players">Appairer un Player</Link> puis{' '}
            <Link to="/displays">créer un Display</Link> et lui affecter une sortie
          </li>
          <li>Importer un média et programmer une diffusion — lots L03 à L05</li>
        </ol>
      </div>
      <div className="card">
        <h2>Votre rôle</h2>
        <ul>
          {grants.map((grant, index) => (
            <li key={index}>
              {ROLES[grant.role as Role]?.label ?? grant.role} —{' '}
              {grant.scope.type === 'organization'
                ? 'toute l’organisation'
                : `${grant.scope.site_ids.length} site(s)`}
            </li>
          ))}
        </ul>
        {!me?.user.mfa_enabled && (
          <p className="alert alert-info">
            La double authentification n’est pas activée. Elle est exigée des propriétaires et
            administrateurs pour gérer les membres.
          </p>
        )}
      </div>
    </section>
  );
}

interface Site {
  id: string;
  name: string;
  timezone: string | null;
}

export function SitesPage() {
  const { can } = useSession();
  const { data, error, reload } = useResource<{ items: Site[] }>('/sites');
  return (
    <section>
      <h1>Sites</h1>
      <ErrorMessage error={error} />
      {!data && !error && <Loading />}
      {data && data.items.length === 0 && <Empty>Aucun site visible dans votre périmètre.</Empty>}
      {data && data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Nom</th>
              <th>Fuseau</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((site) => (
              <tr key={site.id}>
                <td>{site.name}</td>
                <td>{site.timezone ?? 'Hérité de l’organisation'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {can('sites.manage') ? (
        <div className="card narrow">
          <h2>Ajouter un site</h2>
          <Form
            submitLabel="Ajouter"
            onSubmit={async (values) => {
              await api('POST', '/sites', { name: values.name, timezone: values.timezone || null });
              await reload();
            }}
          >
            <Field label="Nom du site" name="name" />
            <Field
              label="Fuseau (vide : celui de l’organisation)"
              name="timezone"
              required={false}
            />
          </Form>
        </div>
      ) : (
        <Forbidden reason="La création de sites requiert la permission « Créer et modifier les sites » (Owner ou Admin)." />
      )}
    </section>
  );
}

interface Member {
  id: string;
  email: string;
  display_name: string | null;
  mfa_enabled: boolean;
  grants: Grant[];
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  expired: boolean;
}

function describe(grant: Grant, sites: Site[]): string {
  const label = ROLES[grant.role as Role]?.label ?? grant.role;
  if (grant.scope.type === 'organization') return `${label} (organisation)`;
  const names = grant.scope.site_ids.map((id) => sites.find((s) => s.id === id)?.name ?? 'site');
  return `${label} (${names.join(', ')})`;
}

const ASSIGNABLE: Role[] = [
  'Admin',
  'ContentManager',
  'Operator',
  'Technician',
  'Viewer',
  'BillingManager',
  'Owner',
];

export function MembersPage() {
  const { can, me } = useSession();
  const members = useResource<{ items: Member[] }>(can('members.read') ? '/members' : null);
  const invitations = useResource<{ items: Invitation[] }>(
    can('members.read') ? '/invitations' : null,
  );
  const sites = useResource<{ items: Site[] }>('/sites');
  const [actionError, setActionError] = useState<unknown>(null);
  if (!can('members.read')) {
    return (
      <section>
        <h1>Membres</h1>
        <Forbidden reason="La liste des membres est réservée aux propriétaires et administrateurs." />
      </section>
    );
  }
  const siteList = sites.data?.items ?? [];
  return (
    <section>
      <h1>Membres</h1>
      <ErrorMessage error={members.error ?? actionError} />
      {!members.data && !members.error && <Loading />}
      {members.data && (
        <table>
          <thead>
            <tr>
              <th>Membre</th>
              <th>Rôles</th>
              <th>MFA</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.data.items.map((member) => (
              <tr key={member.id}>
                <td>
                  {member.display_name ?? member.email}
                  <br />
                  <span className="muted">{member.email}</span>
                </td>
                <td>{member.grants.map((g) => describe(g, siteList)).join(' · ')}</td>
                <td>{member.mfa_enabled ? 'Activée' : 'Non'}</td>
                <td>
                  {can('members.manage') && member.email !== me?.user.email && (
                    <button
                      type="button"
                      className="danger"
                      onClick={async () => {
                        if (
                          !confirm(
                            `Retirer ${member.email} de l’organisation ? Ses accès sont révoqués immédiatement.`,
                          )
                        )
                          return;
                        try {
                          setActionError(null);
                          await api('DELETE', `/members/${member.id}`);
                          await members.reload();
                        } catch (error) {
                          setActionError(error);
                        }
                      }}
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

      <h2>Invitations en attente</h2>
      {invitations.data && invitations.data.items.length === 0 && (
        <Empty>Aucune invitation en attente.</Empty>
      )}
      {invitations.data && invitations.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Adresse</th>
              <th>Rôle</th>
              <th>Échéance</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {invitations.data.items.map((invitation) => (
              <tr key={invitation.id}>
                <td>{invitation.email}</td>
                <td>{ROLES[invitation.role as Role]?.label ?? invitation.role}</td>
                <td>
                  {invitation.expired
                    ? 'Expirée'
                    : new Date(invitation.expires_at).toLocaleString('fr-FR')}
                </td>
                <td>
                  {can('members.manage') && (
                    <>
                      <button
                        type="button"
                        onClick={() =>
                          void api('POST', `/invitations/${invitation.id}/resend`).then(
                            invitations.reload,
                            setActionError,
                          )
                        }
                      >
                        Renvoyer
                      </button>{' '}
                      <button
                        type="button"
                        className="danger"
                        onClick={() =>
                          void api('POST', `/invitations/${invitation.id}/revoke`).then(
                            invitations.reload,
                            setActionError,
                          )
                        }
                      >
                        Révoquer
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {can('members.manage') && (
        <div className="card narrow">
          <h2>Inviter une personne</h2>
          <Form
            submitLabel="Envoyer l’invitation"
            onSubmit={async (values) => {
              const scope = values.site
                ? { type: 'sites', site_ids: [values.site] }
                : { type: 'organization' };
              await api('POST', '/invitations', { email: values.email, role: values.role, scope });
              await invitations.reload();
            }}
          >
            <Field label="Adresse email" name="email" type="email" />
            <div className="field">
              <label htmlFor="field-role">Rôle</label>
              <select id="field-role" name="role" defaultValue="ContentManager">
                {ASSIGNABLE.map((role) => (
                  <option key={role} value={role}>
                    {ROLES[role].label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="field-site">Périmètre</label>
              <select id="field-site" name="site" defaultValue="">
                <option value="">Toute l’organisation</option>
                {siteList.map((site) => (
                  <option key={site.id} value={site.id}>
                    Site : {site.name}
                  </option>
                ))}
              </select>
              <p className="hint">
                Propriétaire, Administrateur et Responsable facturation s’appliquent à toute
                l’organisation.
              </p>
            </div>
          </Form>
        </div>
      )}
    </section>
  );
}

interface AuditEntry {
  id: string;
  created_at: string;
  action: string;
  actor_type: string;
  result: string;
  target_type: string | null;
}

export function AuditPage() {
  const { can } = useSession();
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async (after: string | null) => {
    setLoading(true);
    try {
      const page = await api<{
        items: AuditEntry[];
        next_cursor: string | null;
        has_more: boolean;
      }>('GET', `/audit?limit=50${after ? `&cursor=${after}` : ''}`);
      setItems((previous) => (after ? [...previous, ...page.items] : page.items));
      setCursor(page.next_cursor);
      setHasMore(page.has_more);
    } catch (caught) {
      setError(caught);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (can('audit.read')) void load(null);
  }, [can, load]);
  if (!can('audit.read')) {
    return (
      <section>
        <h1>Journal d’audit</h1>
        <Forbidden reason="Le journal d’audit est réservé aux propriétaires et administrateurs." />
      </section>
    );
  }
  return (
    <section>
      <h1>Journal d’audit</h1>
      <ErrorMessage error={error} />
      {items.length === 0 && !loading && <Empty>Aucun événement.</Empty>}
      {items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Action</th>
              <th>Acteur</th>
              <th>Résultat</th>
            </tr>
          </thead>
          <tbody>
            {items.map((entry) => (
              <tr key={entry.id}>
                <td>{new Date(entry.created_at).toLocaleString('fr-FR')}</td>
                <td>
                  <code>{entry.action}</code>
                </td>
                <td>{entry.actor_type}</td>
                <td>{entry.result}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {loading && <Loading />}
      {hasMore && !loading && (
        <button type="button" onClick={() => void load(cursor)}>
          Charger plus
        </button>
      )}
    </section>
  );
}
