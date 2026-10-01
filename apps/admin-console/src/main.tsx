import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppLayout, HomeRedirect, RequireSession } from './layout.js';
import { ActivatePage, LoginPage, MfaPage } from './pages/auth.js';
import { BillingPage } from './pages/billing.js';
import { ReleasesPage } from './pages/releases.js';
import { CustomersPage } from './pages/customers.js';
import { HealthPage } from './pages/health.js';
import { AuditPage, IncidentsPage, JobsPage, TemplatesPage } from './pages/operations.js';
import { OrganizationPage, OrganizationsPage } from './pages/organizations.js';
import { TeamPage } from './pages/team.js';
import { SessionProvider } from './session.js';
import './styles.css';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/mfa', element: <MfaPage /> },
  { path: '/activate', element: <ActivatePage /> },
  {
    element: <RequireSession />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <HomeRedirect /> },
          { path: 'health', element: <HealthPage /> },
          { path: 'organizations', element: <OrganizationsPage /> },
          { path: 'organizations/:id', element: <OrganizationPage /> },
          { path: 'customers', element: <CustomersPage /> },
          { path: 'billing', element: <BillingPage /> },
          { path: 'releases', element: <ReleasesPage /> },
          { path: 'incidents', element: <IncidentsPage /> },
          { path: 'jobs', element: <JobsPage /> },
          { path: 'templates', element: <TemplatesPage /> },
          { path: 'team', element: <TeamPage /> },
          { path: 'audit', element: <AuditPage /> },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>
  </StrictMode>,
);
