import { useId, useState } from 'react';
import { api, formatBytes, formatDate, upload } from '../api.js';
import { useLoad } from '../load.js';
import { useSession } from '../session.js';
import { Empty, ErrorMessage, Field, Form, Loading, ReasonField, Unavailable } from '../ui.js';

/** Registre des releases du Player natif (ADM-004, ADM-005, ADR-019). */

interface Release {
  id: string;
  version: string;
  channel: string;
  os: string;
  architecture: string;
  status: 'draft' | 'published' | 'blocked';
  package: { sha256: string; size_bytes: number; uploaded: boolean };
  key_id: string;
  protocol: { min: number; max: number };
  sqlite_schema: number;
  renderer_build: string;
  notes: string | null;
  created_at: string;
  published_at: string | null;
  blocked_at: string | null;
  block_reason: string | null;
  desired: boolean;
  running_players: number;
  deployment: Record<'installed' | 'promoted' | 'rolled_back' | 'failed', number>;
}

interface ReleaseList {
  configured: { signature_keys: boolean; storage: boolean };
  items: Release[];
  fleet: {
    os: string | null;
    architecture: string | null;
    version: string | null;
    players: number;
  }[];
}

interface Impact {
  platform: { os: string; architecture: string };
  native_players: number;
  organizations: number;
  versions: { version: string | null; players: number; organizations: number }[];
  publish: {
    current_desired: string | null;
    desired_after: string;
    players_to_update: number;
    players_up_to_date: number;
    players_newer: number;
    players_unknown_version: number;
  };
  block: { players_to_roll_back: number; desired_after: string | null };
}

const STATUS_LABELS: Record<Release['status'], string> = {
  draft: 'brouillon',
  published: 'publiée',
  blocked: 'bloquée',
};

export function ReleasesPage() {
  const session = useSession();
  const { data, error, reload } = useLoad(() => api<ReleaseList>('GET', '/releases'), []);
  const [selected, setSelected] = useState<string | null>(null);
  if (error) return <ErrorMessage error={error} />;
  if (!data) return <Loading />;
  const manage = session.can('platform.releases.manage');
  const current = data.items.find((r) => r.id === selected) ?? null;
  return (
    <section>
      <h1>Releases du Player natif</h1>
      <p className="muted">
        Les Players natifs installent automatiquement la release publiée la plus récente pour leur
        système, après vérification de la signature et du paquet ; bloquer une release fait revenir
        les Players qui l’exécutent à leur version précédente.
      </p>
      {!data.configured.signature_keys && (
        <Unavailable>
          Aucune clé publique de release configurée (PIXLOVA_RELEASE_PUBLIC_KEYS) : le dépôt est
          impossible.
        </Unavailable>
      )}
      {!data.configured.storage && (
        <Unavailable>
          Stockage objet non configuré pour l’administration : les paquets ne peuvent pas être
          déposés.
        </Unavailable>
      )}

      {data.items.length === 0 ? (
        <Empty>Aucune release déposée.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Plateforme</th>
              <th>Statut</th>
              <th>Paquet</th>
              <th>En service</th>
              <th>Déploiement</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.version}</strong>
                  {r.desired && <span className="badge">souhaitée</span>}
                  {r.notes && <div className="hint">{r.notes}</div>}
                </td>
                <td>
                  {r.os} / {r.architecture}
                </td>
                <td>
                  {STATUS_LABELS[r.status]}
                  <div className="hint">
                    {r.status === 'blocked'
                      ? `${formatDate(r.blocked_at)} : ${r.block_reason ?? ''}`
                      : r.status === 'published'
                        ? formatDate(r.published_at)
                        : formatDate(r.created_at)}
                  </div>
                </td>
                <td>
                  {formatBytes(r.package.size_bytes)}
                  <div className="hint">{r.package.uploaded ? 'déposé' : 'à déposer'}</div>
                </td>
                <td>{r.running_players}</td>
                <td>
                  {r.deployment.installed} installé(s), {r.deployment.promoted} validé(s),{' '}
                  {r.deployment.rolled_back} annulé(s), {r.deployment.failed} en échec
                </td>
                <td>
                  <button
                    type="button"
                    className="secondary"
                    aria-expanded={selected === r.id}
                    onClick={() => setSelected(selected === r.id ? null : r.id)}
                  >
                    {selected === r.id ? 'Fermer' : 'Détails…'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {current && (
        <ReleaseDetail
          key={current.id}
          release={current}
          manage={manage}
          onChange={async (removed) => {
            if (removed) setSelected(null);
            await reload();
          }}
        />
      )}

      <h2>Versions en service</h2>
      {data.fleet.length === 0 ? (
        <Empty>Aucun Player natif appairé.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Plateforme</th>
              <th>Version</th>
              <th>Players</th>
            </tr>
          </thead>
          <tbody>
            {data.fleet.map((f) => (
              <tr key={`${f.os}/${f.architecture}/${f.version}`}>
                <td>
                  {f.os ?? 'inconnue'} / {f.architecture ?? 'inconnue'}
                </td>
                <td>{f.version ?? 'non déclarée'}</td>
                <td>{f.players}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {manage && data.configured.signature_keys && (
        <div className="card">
          <h2>Déposer une release</h2>
          <p className="muted">
            Coller l’enveloppe SIGNAGE_RELEASE_V1 produite par la chaîne de signature hors ligne. La
            release est créée en brouillon ; le paquet est déposé ensuite, puis publié.
          </p>
          <Form
            submitLabel="Déposer le brouillon"
            onSubmit={async (values, form) => {
              const created = await api<Release>('POST', '/releases', {
                envelope: values.envelope?.trim() ?? '',
                ...(values.notes ? { notes: values.notes } : {}),
              });
              form.reset();
              setSelected(created.id);
              await reload();
            }}
          >
            <TextArea label="Enveloppe signée (JSON)" name="envelope" rows={6} />
            <Field
              label="Notes de version (facultatif)"
              name="notes"
              required={false}
              hint="Visibles des opérateurs uniquement."
            />
          </Form>
        </div>
      )}
    </section>
  );
}

function ReleaseDetail(props: {
  release: Release;
  manage: boolean;
  onChange(removed?: boolean): Promise<void>;
}) {
  const session = useSession();
  const { release } = props;
  const { data, error, reload } = useLoad(
    () => api<{ impact: Impact }>('GET', `/releases/${release.id}/impact`),
    [release.id, release.status],
  );
  const draft = release.status === 'draft';
  return (
    <div className="card">
      <h2>
        Release {release.version} ({release.os} / {release.architecture})
      </h2>
      <dl>
        <dt>Identifiant</dt>
        <dd>
          <code>{release.id}</code>
        </dd>
        <dt>SHA-256 du paquet</dt>
        <dd>
          <code>{release.package.sha256}</code>
        </dd>
        <dt>Clé de signature</dt>
        <dd>
          <code>{release.key_id}</code>
        </dd>
        <dt>Protocole Player</dt>
        <dd>
          {release.protocol.min} à {release.protocol.max} ; schéma SQLite {release.sqlite_schema} ;
          renderer {release.renderer_build}
        </dd>
      </dl>

      <h3>Périmètre</h3>
      {error ? (
        <ErrorMessage error={error} />
      ) : !data ? (
        <Loading />
      ) : (
        <ImpactSummary impact={data.impact} release={release} />
      )}

      {props.manage && draft && !release.package.uploaded && (
        <>
          <h3>Paquet</h3>
          <Form
            submitLabel="Envoyer le paquet"
            onSubmit={async (_values, form) => {
              const input = form.elements.namedItem('package') as HTMLInputElement | null;
              const file = input?.files?.[0];
              if (!file) throw new Error('Choisir le fichier du paquet.');
              if (file.size !== release.package.size_bytes) {
                throw new Error(
                  `Taille différente des métadonnées signées (${formatBytes(release.package.size_bytes)} attendus).`,
                );
              }
              await upload('PUT', `/releases/${release.id}/package`, file);
              await props.onChange();
            }}
          >
            <Field
              label="Archive tar signée"
              name="package"
              type="file"
              hint="Taille et empreinte vérifiées par le serveur avant stockage."
            />
          </Form>
        </>
      )}

      {props.manage && draft && release.package.uploaded && (
        <>
          <h3>Publier</h3>
          <p className="muted">
            Publiée, la release devient disponible pour les Players {release.os} /{' '}
            {release.architecture} selon le périmètre ci-dessus.
          </p>
          <Form
            submitLabel="Publier"
            onSubmit={async (values) => {
              await session.protect(() =>
                api('POST', `/releases/${release.id}/publish`, {
                  reason: values.reason,
                  confirm_version: values.confirm_version,
                }),
              );
              await reload();
              await props.onChange();
            }}
          >
            <ReasonField label="Motif de la publication" />
            <Field
              label={`Confirmer en saisissant la version (${release.version})`}
              name="confirm_version"
              autoComplete="off"
            />
          </Form>
        </>
      )}

      {props.manage && release.status === 'published' && (
        <>
          <h3>Bloquer</h3>
          <p className="muted">
            Irréversible : les Players qui exécutent cette version reviennent à leur version
            précédente et elle n’est plus distribuée. Un correctif se publie comme nouvelle version.
          </p>
          <Form
            danger
            submitLabel="Bloquer la release"
            onSubmit={async (values) => {
              await session.protect(() =>
                api('POST', `/releases/${release.id}/block`, {
                  reason: values.reason,
                  confirm_version: values.confirm_version,
                }),
              );
              await props.onChange();
            }}
          >
            <ReasonField label="Motif du blocage" />
            <Field
              label={`Confirmer en saisissant la version (${release.version})`}
              name="confirm_version"
              autoComplete="off"
            />
          </Form>
        </>
      )}

      {props.manage && draft && (
        <>
          <h3>Supprimer le brouillon</h3>
          <Form
            danger
            submitLabel="Supprimer"
            onSubmit={async () => {
              await api('DELETE', `/releases/${release.id}`);
              await props.onChange(true);
            }}
          >
            <p className="hint">Le paquet déposé est supprimé avec le brouillon.</p>
          </Form>
        </>
      )}
    </div>
  );
}

function ImpactSummary({ impact, release }: { impact: Impact; release: Release }) {
  return (
    <>
      <p>
        {impact.native_players} Player(s) natif(s) {impact.platform.os} /{' '}
        {impact.platform.architecture} dans {impact.organizations} organisation(s).
      </p>
      {release.status === 'draft' && (
        <ul>
          <li>
            Release souhaitée actuelle : {impact.publish.current_desired ?? 'aucune'} ; après
            publication : {impact.publish.desired_after}.
          </li>
          <li>{impact.publish.players_to_update} Player(s) seront mis à jour.</li>
          <li>{impact.publish.players_up_to_date} déjà dans cette version.</li>
          <li>{impact.publish.players_newer} dans une version plus récente (inchangés).</li>
          <li>
            {impact.publish.players_unknown_version} sans version déclarée (version connue à leur
            prochaine synchronisation).
          </li>
        </ul>
      )}
      {release.status === 'published' && (
        <ul>
          <li>
            Un blocage ferait revenir {impact.block.players_to_roll_back} Player(s) à leur version
            précédente.
          </li>
          <li>Release souhaitée après blocage : {impact.block.desired_after ?? 'aucune'}.</li>
        </ul>
      )}
    </>
  );
}

function TextArea(props: { label: string; name: string; rows: number }) {
  const id = `field-${props.name}-${useId()}`;
  return (
    <div className="field">
      <label htmlFor={id}>{props.label}</label>
      <textarea id={id} name={props.name} rows={props.rows} required spellCheck={false} />
    </div>
  );
}
