import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AppLayout, RequireSession } from './layout.js';
import { AccountPage } from './pages/account.js';
import { DisplayDetailPage, DisplaysPage, PlayersPage } from './pages/fleet.js';
import {
  AcceptInvitationPage,
  LoginPage,
  MfaChallengePage,
  PasswordResetConfirmPage,
  PasswordResetRequestPage,
  RegisterPage,
  VerifyEmailPage,
} from './pages/auth.js';
import {
  AuditPage,
  CreateOrganizationPage,
  HomePage,
  MembersPage,
  SitesPage,
} from './pages/organization.js';
import { SessionProvider } from './session.js';
import './styles.css';

const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  { path: '/verify-email', element: <VerifyEmailPage /> },
  { path: '/password-reset', element: <PasswordResetRequestPage /> },
  { path: '/password-reset/confirm', element: <PasswordResetConfirmPage /> },
  { path: '/mfa', element: <MfaChallengePage /> },
  { path: '/invitations/accept', element: <AcceptInvitationPage /> },
  {
    element: <RequireSession />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'organizations/new', element: <CreateOrganizationPage /> },
          { path: 'displays', element: <DisplaysPage /> },
          { path: 'displays/:id', element: <DisplayDetailPage /> },
          { path: 'players', element: <PlayersPage /> },
          { path: 'sites', element: <SitesPage /> },
          { path: 'members', element: <MembersPage /> },
          { path: 'audit', element: <AuditPage /> },
          { path: 'account', element: <AccountPage /> },
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
