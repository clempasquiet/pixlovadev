import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { encode } from 'uqr';
import { api } from '../api.js';
import { useSession } from '../session.js';
import { Field, Form, Loading } from '../ui.js';

function AuthCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="auth">
      <div className="card auth-card">
        <p className="brand">pixlova · administration plateforme</p>
        <h1>{title}</h1>
        <p className="warning-note">Accès réservé aux opérateurs. Toute action est journalisée.</p>
        {children}
      </div>
    </main>
  );
}

function QrCode({ value }: { value: string }) {
  const qr = encode(value, { ecc: 'M', border: 2 });
  let path = '';
  qr.data.forEach((row, y) => row.forEach((dark, x) => dark && (path += `M${x} ${y}h1v1h-1z`)));
  return (
    <svg
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      width="200"
      height="200"
      role="img"
      aria-label="QR code TOTP"
    >
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

export function LoginPage() {
  const session = useSession();
  const navigate = useNavigate();
  if (session.status === 'loading') return <Loading />;
  if (session.status === 'ready') return <Navigate to="/" replace />;
  if (session.status === 'mfa') return <Navigate to="/mfa" replace />;
  return (
    <AuthCard title="Connexion">
      <Form
        submitLabel="Continuer"
        onSubmit={async (values) => {
          await api('POST', '/auth/login', { email: values.email, password: values.password });
          await session.refresh();
          navigate('/mfa');
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
        <a href="/activate">Activer un compte opérateur</a>
      </p>
    </AuthCard>
  );
}

export function MfaPage() {
  const session = useSession();
  const navigate = useNavigate();
  if (session.status === 'loading') return <Loading />;
  if (session.status === 'anonymous') return <Navigate to="/login" replace />;
  if (session.status === 'ready') return <Navigate to="/" replace />;
  return (
    <AuthCard title="Second facteur">
      <Form
        submitLabel="Vérifier"
        onSubmit={async (values) => {
          await api('POST', '/auth/mfa/verify', { code: values.code });
          await session.refresh();
          navigate('/');
        }}
      >
        <Field
          label="Code de votre application TOTP"
          name="code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          autoComplete="one-time-code"
        />
      </Form>
    </AuthCard>
  );
}

export function ActivatePage() {
  const session = useSession();
  const navigate = useNavigate();
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauth_uri: string } | null>(
    null,
  );
  if (session.status === 'ready') return <Navigate to="/" replace />;
  if (!enrollment) {
    return (
      <AuthCard title="Activer mon accès">
        <p className="muted">
          Saisissez le code d’activation remis par un SuperAdmin et choisissez votre mot de passe.
          Le second facteur est obligatoire.
        </p>
        <Form
          submitLabel="Continuer"
          onSubmit={async (values) => {
            setEnrollment(
              await api('POST', '/auth/activate', {
                email: values.email,
                activation_code: (values.activation_code ?? '').trim(),
                password: values.password,
              }),
            );
          }}
        >
          <Field label="Adresse email" name="email" type="email" autoComplete="username" />
          <Field label="Code d’activation" name="activation_code" autoComplete="off" />
          <Field
            label="Nouveau mot de passe"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            hint="12 caractères au moins ; une phrase de passe est recommandée."
          />
        </Form>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="Enrôler le second facteur">
      <p>Scannez ce QR code avec votre application TOTP, puis saisissez le code affiché.</p>
      <QrCode value={enrollment.otpauth_uri} />
      <p className="muted">
        Clé manuelle : <code data-testid="totp-secret">{enrollment.secret}</code>
      </p>
      <Form
        submitLabel="Activer"
        onSubmit={async (values) => {
          await api('POST', '/auth/activate/confirm', { code: values.code });
          await session.refresh();
          navigate('/');
        }}
      >
        <Field
          label="Code à 6 chiffres"
          name="code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          autoComplete="one-time-code"
        />
      </Form>
    </AuthCard>
  );
}
