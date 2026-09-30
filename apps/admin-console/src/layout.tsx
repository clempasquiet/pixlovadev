import { NavLink, Navigate, Outlet, useNavigate } from 'react-router';
import type { PlatformPermission } from '@pixlova/permissions';
import { api, formatDate, ROLE_LABELS } from './api.js';
import { useSession } from './session.js';
import { Loading } from './ui.js';

const NAV: { to: string; label: string; permission: PlatformPermission }[] = [
  { to: '/health', label: 'Santé', permission: 'platform.health.read' },
  { to: '/organizations', label: 'Organisations', permission: 'platform.organizations.read' },
  { to: '/customers', label: 'Comptes clients', permission: 'platform.customers.lookup' },
  { to: '/incidents', label: 'Incidents', permission: 'platform.incidents.read' },
  { to: '/jobs', label: 'Tâches', permission: 'platform.jobs.read' },
  { to: '/templates', label: 'Templates', permission: 'platform.templates.read' },
  { to: '/team', label: 'Équipe', permission: 'platform.team.manage' },
  { to: '/audit', label: 'Journal', permission: 'platform.audit.read' },
];

export function RequireSession() {
  const session = useSession();
  if (session.status === 'loading') return <Loading />;
  if (session.status === 'anonymous') return <Navigate to="/login" replace />;
  if (session.status === 'mfa') return <Navigate to="/mfa" replace />;
  if (session.status === 'enrolling') return <Navigate to="/activate" replace />;
  return <Outlet />;
}

export function AppLayout() {
  const session = useSession();
  const navigate = useNavigate();
  const me = session.me!;
  const links = NAV.filter((item) => session.can(item.permission));
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">pixlova · plateforme</span>
        <nav aria-label="Navigation principale">
          {links.map((item) => (
            <NavLink key={item.to} to={item.to}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="operator">
          <span>{me.operator.email}</span>
          <span className="muted">{me.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ')}</span>
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              await api('POST', '/auth/logout');
              await session.refresh();
              navigate('/login');
            }}
          >
            Déconnexion
          </button>
        </div>
      </header>
      <p className="audit-banner" role="note">
        Administration plateforme privée : chaque consultation et action est journalisée avec son
        motif. Session valable jusqu’au {formatDate(me.session.expires_at)}.
      </p>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

export function HomeRedirect() {
  const session = useSession();
  const first = NAV.find((item) => session.can(item.permission));
  if (!first) {
    return (
      <p className="state">
        Aucun rôle plateforme ne vous est attribué : demandez à un SuperAdmin de vous en attribuer
        un.
      </p>
    );
  }
  return <Navigate to={first.to} replace />;
}
