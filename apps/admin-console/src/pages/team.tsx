import { useState } from 'react';
import { api, formatDate, ROLE_LABELS } from '../api.js';
import { useLoad } from '../load.js';
import { useSession } from '../session.js';
import { ErrorMessage, Field, Form, Loading, ReasonField } from '../ui.js';

interface TeamData {
  roles: { key: string; label: string }[];
  items: {
    id: string;
    email: string;
    display_name: string;
    status: string;
    roles: string[];
    active_sessions: number;
    last_login_at: string | null;
    created_at: string;
  }[];
}

/** Code d’activation affiché une seule fois, à transmettre hors bande (jamais par email). */
function ActivationCode({ code, expires }: { code: string; expires: string }) {
  return (
    <div className="alert alert-info" role="status">
      <p>Code d’activation, affiché une seule fois (valable jusqu’au {formatDate(expires)}) :</p>
      <p>
        <code data-testid="activation-code">{code}</code>
      </p>
      <p className="muted">
        Transmettez-le par un canal distinct du mot de passe ; l’opérateur l’utilise sur la page «
        Activer un compte opérateur ».
      </p>
    </div>
  );
}

function RoleChoices({ roles, selected }: { roles: TeamData['roles']; selected: string[] }) {
  return (
    <fieldset className="field">
      <legend>Rôles plateforme</legend>
      {roles.map((role) => (
        <label key={role.key} className="checkbox">
          <input
            type="checkbox"
            name="roles"
            value={role.key}
            defaultChecked={selected.includes(role.key)}
          />
          {role.label}
        </label>
      ))}
    </fieldset>
  );
}

export function TeamPage() {
  const session = useSession();
  const { data, error, reload } = useLoad(() => api<TeamData>('GET', '/team'), []);
  const [issued, setIssued] = useState<{ code: string; expires: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  if (error) return <ErrorMessage error={error} />;
  if (!data) return <Loading />;
  const selfId = session.me!.operator.id;
  return (
    <section>
      <h1>Équipe plateforme</h1>
      {issued && <ActivationCode code={issued.code} expires={issued.expires} />}
      <table>
        <thead>
          <tr>
            <th>Opérateur</th>
            <th>Rôles</th>
            <th>Statut</th>
            <th>Sessions</th>
            <th>Dernière connexion</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.items.map((o) => (
            <tr key={o.id}>
              <td>
                {o.display_name}
                <div className="hint">{o.email}</div>
              </td>
              <td>{o.roles.map((r) => ROLE_LABELS[r] ?? r).join(', ') || 'aucun'}</td>
              <td>{o.status}</td>
              <td>{o.active_sessions}</td>
              <td>{formatDate(o.last_login_at)}</td>
              <td>
                {o.id === selfId ? (
                  <span className="hint">vous</span>
                ) : editing === o.id ? (
                  <div className="stack">
                    <Form
                      submitLabel="Enregistrer les rôles"
                      onSubmit={async (values) => {
                        await session.protect(() =>
                          api('PUT', `/team/${o.id}/roles`, {
                            roles: (values.roles ?? '').split(',').filter(Boolean),
                            reason: values.reason,
                          }),
                        );
                        setEditing(null);
                        await reload();
                      }}
                    >
                      <RoleChoices roles={data.roles} selected={o.roles} />
                      <ReasonField />
                    </Form>
                    <Form
                      submitLabel={o.status === 'disabled' ? 'Réactiver' : 'Désactiver'}
                      danger={o.status !== 'disabled'}
                      onSubmit={async (values) => {
                        await session.protect(() =>
                          api('POST', `/team/${o.id}/status`, {
                            status: o.status === 'disabled' ? 'active' : 'disabled',
                            reason: values.reason,
                          }),
                        );
                        setEditing(null);
                        await reload();
                      }}
                    >
                      <ReasonField />
                    </Form>
                    {o.status !== 'disabled' && (
                      <Form
                        submitLabel="Réinitialiser les facteurs"
                        danger
                        onSubmit={async (values) => {
                          const result = await session.protect(() =>
                            api<{ activation_code: string; activation_expires_at: string }>(
                              'POST',
                              `/team/${o.id}/activation`,
                              { reason: values.reason },
                            ),
                          );
                          setIssued({
                            code: result.activation_code,
                            expires: result.activation_expires_at,
                          });
                          setEditing(null);
                          await reload();
                        }}
                      >
                        <ReasonField />
                      </Form>
                    )}
                  </div>
                ) : (
                  <button type="button" className="secondary" onClick={() => setEditing(o.id)}>
                    Gérer…
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="card narrow">
        <h2>Ajouter un opérateur</h2>
        <Form
          submitLabel="Créer l’opérateur"
          onSubmit={async (values, form) => {
            const result = await session.protect(() =>
              api<{ activation_code: string; activation_expires_at: string }>('POST', '/team', {
                email: values.email,
                display_name: values.display_name,
                roles: (values.roles ?? '').split(',').filter(Boolean),
                reason: values.reason,
              }),
            );
            setIssued({ code: result.activation_code, expires: result.activation_expires_at });
            form.reset();
            await reload();
          }}
        >
          <Field label="Adresse email" name="email" type="email" autoComplete="off" />
          <Field label="Nom affiché" name="display_name" autoComplete="off" />
          <RoleChoices roles={data.roles} selected={[]} />
          <ReasonField />
        </Form>
      </div>
    </section>
  );
}
