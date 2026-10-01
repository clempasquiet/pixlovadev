import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from './api.js';
import { useActiveOrganization, useSession } from './session.js';
import { Loading } from './ui.js';

export function RequireSession() {
  const { status, me } = useSession();
  const location = useLocation();
  if (status === 'loading') return <Loading />;
  if (status === 'anonymous')
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
        replace
      />
    );
  if (status === 'mfa')
    return <Navigate to={`/mfa?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (
    me &&
    me.organizations.length === 0 &&
    location.pathname !== '/organizations/new' &&
    location.pathname !== '/account'
  ) {
    return <Navigate to="/organizations/new" replace />;
  }
  return <Outlet />;
}

function OrganizationSwitcher() {
  const { me, organizationId, selectOrganization } = useSession();
  const navigate = useNavigate();
  if (!me || me.organizations.length === 0) return null;
  return (
    <label className="switcher">
      <span className="visually-hidden">Organisation active</span>
      <select
        value={organizationId ?? ''}
        onChange={(event) => {
          if (event.target.value === '__new__') navigate('/organizations/new');
          else selectOrganization(event.target.value);
        }}
      >
        {me.organizations.map((organization) => (
          <option key={organization.id} value={organization.id}>
            {organization.name}
          </option>
        ))}
        <option value="__new__">+ Nouvelle organisation</option>
      </select>
    </label>
  );
}

export function AppLayout() {
  const { me, refresh } = useSession();
  const organization = useActiveOrganization();
  const navigate = useNavigate();
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">pixlova</span>
        <OrganizationSwitcher />
        <nav aria-label="Compte">
          <NavLink to="/account">{me?.user.display_name ?? me?.user.email}</NavLink>
          <button
            type="button"
            className="link"
            onClick={async () => {
              await api('POST', '/auth/logout');
              await refresh();
              navigate('/login');
            }}
          >
            Déconnexion
          </button>
        </nav>
      </header>
      <div className="body">
        {organization && (
          <nav className="sidebar" aria-label="Navigation principale">
            <NavLink to="/" end>
              Tableau de bord
            </NavLink>
            <NavLink to="/library">Bibliothèque</NavLink>
            <NavLink to="/compositions">Compositions</NavLink>
            <NavLink to="/templates">Modèles</NavLink>
            <NavLink to="/playlists">Playlists</NavLink>
            <NavLink to="/schedules">Plannings</NavLink>
            <NavLink to="/campaigns">Campagnes</NavLink>
            <NavLink to="/displays">Écrans</NavLink>
            <NavLink to="/players">Players</NavLink>
            <NavLink to="/supervision">Supervision</NavLink>
            <NavLink to="/incidents">Incidents</NavLink>
            <NavLink to="/sites">Sites</NavLink>
            <NavLink to="/members">Membres</NavLink>
            <NavLink to="/audit">Journal d’audit</NavLink>
            <NavLink to="/billing">Abonnement</NavLink>
          </nav>
        )}
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
