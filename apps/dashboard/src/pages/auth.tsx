import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { api, ApiRequestError } from '../api.js';
import { useSession } from '../session.js';
import { ErrorMessage, Field, Form, Loading } from '../ui.js';

function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="auth">
      <div className="card auth-card">
        <p className="brand">pixlova</p>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function LoginPage() {
  const { refresh, status } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/';
  if (status === 'ready') return <Navigate to={next} replace />;
  return (
    <AuthCard title="Connexion">
      <Form
        submitLabel="Se connecter"
        onSubmit={async (values) => {
          const result = await api<{ mfa_required: boolean }>('POST', '/auth/login', {
            email: values.email,
            password: values.password,
          });
          await refresh();
          navigate(result.mfa_required ? `/mfa?next=${encodeURIComponent(next)}` : next, {
            replace: true,
          });
        }}
      >
        <Field label="Adresse email" name="email" type="email" autoComplete="username" />
        <Field
          label="Mot de passe"
          name="password"
          type="password"
          autoComplete="current-password"
        />
      </Form>
      <p className="links">
        <Link to="/register">Créer un compte</Link> ·{' '}
        <Link to="/password-reset">Mot de passe oublié</Link>
      </p>
    </AuthCard>
  );
}

export function RegisterPage() {
  const [sent, setSent] = useState<string | null>(null);
  if (sent) {
    return (
      <AuthCard title="Vérifiez votre boîte mail">
        <p>
          Si l’adresse <strong>{sent}</strong> peut être utilisée, un lien de confirmation vient d’y
          être envoyé. Il expire dans 24 heures.
        </p>
        <p className="links">
          <Link to="/login">Retour à la connexion</Link>
        </p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Créer un compte">
      <Form
        submitLabel="Créer mon compte"
        onSubmit={async (values) => {
          await api('POST', '/auth/register', {
            email: values.email,
            password: values.password,
            ...(values.display_name ? { display_name: values.display_name } : {}),
          });
          setSent(values.email ?? '');
        }}
      >
        <Field label="Nom affiché" name="display_name" autoComplete="name" required={false} />
        <Field label="Adresse email" name="email" type="email" autoComplete="email" />
        <Field
          label="Mot de passe"
          name="password"
          type="password"
          autoComplete="new-password"
          hint="12 caractères minimum ; une phrase de passe est recommandée."
        />
      </Form>
      <p className="links">
        <Link to="/login">J’ai déjà un compte</Link>
      </p>
    </AuthCard>
  );
}

/** Actions de lien email en cours : un jeton n’est envoyé qu’une fois, même si React rejoue l’effet. */
const inflight = new Map<string, Promise<void>>();

function useTokenAction(action: (token: string) => Promise<void>) {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<{ status: 'pending' | 'done' | 'error'; error?: unknown }>({
    status: 'pending',
  });
  useEffect(() => {
    if (!token) {
      setState({ status: 'error', error: new Error('Lien incomplet.') });
      return;
    }
    let cancelled = false;
    const promise = inflight.get(token) ?? action(token);
    inflight.set(token, promise);
    promise
      .then(() => !cancelled && setState({ status: 'done' }))
      .catch((error: unknown) => !cancelled && setState({ status: 'error', error }));
    return () => {
      cancelled = true;
    };
  }, [token, action]);
  return { token, ...state };
}

const verifyEmail = (token: string) =>
  api('POST', '/auth/verify-email', { token }).then(() => undefined);

export function VerifyEmailPage() {
  const { status, error } = useTokenAction(verifyEmail);
  return (
    <AuthCard title="Confirmation de l’adresse">
      {status === 'pending' && <Loading label="Vérification en cours…" />}
      {status === 'done' && <p>Adresse confirmée. Vous pouvez vous connecter.</p>}
      {status === 'error' && <ErrorMessage error={error} />}
      <p className="links">
        <Link to="/login">Se connecter</Link>
      </p>
    </AuthCard>
  );
}

export function PasswordResetRequestPage() {
  const [sent, setSent] = useState(false);
  return (
    <AuthCard title="Mot de passe oublié">
      {sent ? (
        <p>
          Si un compte correspond à cette adresse, un lien de réinitialisation valable une heure
          vient d’être envoyé.
        </p>
      ) : (
        <Form
          submitLabel="Envoyer le lien"
          onSubmit={async (values) => {
            await api('POST', '/auth/password-reset/request', { email: values.email });
            setSent(true);
          }}
        >
          <Field label="Adresse email" name="email" type="email" autoComplete="email" />
        </Form>
      )}
      <p className="links">
        <Link to="/login">Retour à la connexion</Link>
      </p>
    </AuthCard>
  );
}

export function PasswordResetConfirmPage() {
  const [params] = useSearchParams();
  const [done, setDone] = useState(false);
  return (
    <AuthCard title="Nouveau mot de passe">
      {done ? (
        <p>Mot de passe modifié. Toutes vos sessions ont été fermées ; reconnectez-vous.</p>
      ) : (
        <Form
          submitLabel="Enregistrer"
          onSubmit={async (values) => {
            await api('POST', '/auth/password-reset/confirm', {
              token: params.get('token') ?? '',
              password: values.password,
            });
            setDone(true);
          }}
        >
          <Field
            label="Nouveau mot de passe"
            name="password"
            type="password"
            autoComplete="new-password"
            hint="12 caractères minimum."
          />
        </Form>
      )}
      <p className="links">
        <Link to="/login">Se connecter</Link>
      </p>
    </AuthCard>
  );
}

export function MfaChallengePage() {
  const { refresh, status } = useSession();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [useRecovery, setUseRecovery] = useState(false);
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  return (
    <AuthCard title="Double authentification">
      <Form
        submitLabel="Valider"
        onSubmit={async (values) => {
          await api(
            'POST',
            '/auth/mfa/verify',
            useRecovery ? { recovery_code: values.code } : { code: values.code },
          );
          await refresh();
          navigate(params.get('next') ?? '/', { replace: true });
        }}
      >
        {useRecovery ? (
          <Field
            label="Code de secours"
            name="code"
            autoComplete="one-time-code"
            pattern="[a-z0-9]{5}-[a-z0-9]{5}"
          />
        ) : (
          <Field
            label="Code à 6 chiffres"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
          />
        )}
      </Form>
      <p className="links">
        <button type="button" className="link" onClick={() => setUseRecovery(!useRecovery)}>
          {useRecovery
            ? 'Utiliser l’application d’authentification'
            : 'Utiliser un code de secours'}
        </button>
      </p>
    </AuthCard>
  );
}

export function AcceptInvitationPage() {
  const { status, refresh, selectOrganization } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null);
  const token = params.get('token') ?? '';
  if (status === 'loading') return <Loading />;
  if (status === 'anonymous') {
    const next = `/invitations/accept?token=${encodeURIComponent(token)}`;
    return (
      <AuthCard title="Invitation">
        <p>
          Connectez-vous avec l’adresse qui a reçu l’invitation, ou créez un compte avec cette
          adresse.
        </p>
        <p className="links">
          <Link to={`/login?next=${encodeURIComponent(next)}`}>Se connecter</Link> ·{' '}
          <Link to="/register">Créer un compte</Link>
        </p>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Rejoindre une organisation">
      <p>L’invitation n’ajoute que le rôle et le périmètre qu’elle indique.</p>
      <ErrorMessage error={error} />
      <button
        type="button"
        onClick={async () => {
          try {
            const result = await api<{ organization_id: string }>('POST', '/invitations/accept', {
              token,
            });
            selectOrganization(result.organization_id);
            await refresh();
            navigate('/', { replace: true });
          } catch (caught) {
            setError(caught);
          }
        }}
      >
        Accepter l’invitation
      </button>
    </AuthCard>
  );
}

export function isForbidden(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 403;
}
