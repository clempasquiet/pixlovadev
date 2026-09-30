import { useCallback, useEffect, useState } from 'react';
import { encode } from 'uqr';
import { api, ApiRequestError } from '../api.js';
import { useSession } from '../session.js';
import { ErrorMessage, Field, Form, Loading } from '../ui.js';

interface SessionRow {
  id: string;
  created_at: string;
  last_seen_at: string;
  ip: string | null;
  user_agent: string | null;
  current: boolean;
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
      aria-label="QR code de configuration"
    >
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/** Demande le mot de passe quand l’API exige une réauthentification récente, puis rejoue l’action. */
async function withReauthentication<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof ApiRequestError) || error.code !== 'REAUTHENTICATION_REQUIRED')
      throw error;
    const password = prompt('Pour cette action, confirmez votre mot de passe :');
    if (!password) throw error;
    await api('POST', '/auth/reauthenticate', { password });
    return action();
  }
}

function MfaSection() {
  const { me, refresh } = useSession();
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauth_uri: string } | null>(
    null,
  );
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (recovery) {
    return (
      <div className="card narrow">
        <h2>Codes de secours</h2>
        <p>
          Conservez ces codes en lieu sûr. Chacun ne sert qu’une fois ; ils ne seront plus affichés.
        </p>
        <pre className="codes">{recovery.join('\n')}</pre>
        <button type="button" onClick={() => setRecovery(null)}>
          J’ai conservé mes codes
        </button>
      </div>
    );
  }
  if (me?.user.mfa_enabled) {
    return (
      <div className="card narrow">
        <h2>Double authentification : activée</h2>
        <Form
          submitLabel="Désactiver"
          onSubmit={async (values) => {
            await withReauthentication(() =>
              api('POST', '/auth/mfa/disable', { code: values.code }),
            );
            await refresh();
          }}
        >
          <Field
            label="Code actuel à 6 chiffres"
            name="code"
            inputMode="numeric"
            pattern="[0-9]{6}"
            autoComplete="one-time-code"
          />
        </Form>
      </div>
    );
  }
  return (
    <div className="card narrow">
      <h2>Double authentification</h2>
      <ErrorMessage error={error} />
      {!enrollment ? (
        <button
          type="button"
          onClick={async () => {
            try {
              setError(null);
              setEnrollment(
                await withReauthentication(() =>
                  api<{ secret: string; otpauth_uri: string }>('POST', '/auth/mfa/enroll'),
                ),
              );
            } catch (caught) {
              setError(caught);
            }
          }}
        >
          Activer avec une application d’authentification
        </button>
      ) : (
        <>
          <p>
            Scannez ce QR code avec votre application (ou saisissez la clé), puis entrez le code
            affiché.
          </p>
          <QrCode value={enrollment.otpauth_uri} />
          <p>
            Clé : <code>{enrollment.secret}</code>
          </p>
          <Form
            submitLabel="Confirmer"
            onSubmit={async (values) => {
              const result = await api<{ recovery_codes: string[] }>('POST', '/auth/mfa/confirm', {
                code: values.code,
              });
              setEnrollment(null);
              setRecovery(result.recovery_codes);
              await refresh();
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
        </>
      )}
    </div>
  );
}

function SessionsSection() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setSessions((await api<{ items: SessionRow[] }>('GET', '/auth/sessions')).items);
    } catch (caught) {
      setError(caught);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="card">
      <h2>Sessions actives</h2>
      <ErrorMessage error={error} />
      {!sessions && <Loading />}
      {sessions && (
        <table>
          <thead>
            <tr>
              <th>Appareil</th>
              <th>Dernière activité</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id}>
                <td>
                  {session.user_agent ?? 'Inconnu'}
                  {session.current && <strong> (cette session)</strong>}
                  <br />
                  <span className="muted">{session.ip}</span>
                </td>
                <td>{new Date(session.last_seen_at).toLocaleString('fr-FR')}</td>
                <td>
                  {!session.current && (
                    <button
                      type="button"
                      className="danger"
                      onClick={() =>
                        void api('DELETE', `/auth/sessions/${session.id}`).then(load, setError)
                      }
                    >
                      Déconnecter
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button
        type="button"
        onClick={() => void api('POST', '/auth/sessions/revoke-all').then(load, setError)}
      >
        Déconnecter toutes les autres sessions
      </button>
    </div>
  );
}

export function AccountPage() {
  const { me } = useSession();
  const [changed, setChanged] = useState(false);
  return (
    <section>
      <h1>Mon compte</h1>
      <p className="muted">{me?.user.email}</p>
      <MfaSection />
      <SessionsSection />
      <div className="card narrow">
        <h2>Changer de mot de passe</h2>
        {changed && (
          <p className="alert alert-info">
            Mot de passe modifié ; vos autres sessions ont été fermées.
          </p>
        )}
        <Form
          submitLabel="Changer"
          onSubmit={async (values) => {
            await api('POST', '/auth/password/change', {
              current_password: values.current_password,
              new_password: values.new_password,
            });
            setChanged(true);
          }}
        >
          <Field
            label="Mot de passe actuel"
            name="current_password"
            type="password"
            autoComplete="current-password"
          />
          <Field
            label="Nouveau mot de passe"
            name="new_password"
            type="password"
            autoComplete="new-password"
            hint="12 caractères minimum."
          />
        </Form>
      </div>
    </section>
  );
}
