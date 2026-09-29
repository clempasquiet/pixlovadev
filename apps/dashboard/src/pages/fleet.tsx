import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { api, idempotencyKey } from '../api.js';
import { useSession } from '../session.js';
import { Empty, ErrorMessage, Field, Forbidden, Form, Loading } from '../ui.js';

interface Site {
  id: string;
  name: string;
}

interface Output {
  id: string;
  output_key: string;
  width: number | null;
  height: number | null;
  connected: boolean | null;
  display_id: string | null;
}

interface Player {
  id: string;
  name: string;
  site_id: string | null;
  type: 'native' | 'web';
  lifecycle_status: string;
  app_version: string | null;
  presence: 'online' | 'offline' | 'unknown';
  last_seen_at: string | null;
  outputs: Output[];
}

interface DisplaySummary {
  id: string;
  site_id: string;
  name: string;
  width: number;
  height: number;
  orientation: number;
  timezone: string | null;
  lifecycle_status: 'active' | 'inactive' | 'archived';
  assignment: {
    player_id: string;
    player_name: string;
    output_key: string;
    presence: Player['presence'];
    last_seen_at: string | null;
  } | null;
}

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const reload = useCallback(async () => {
    try {
      setError(null);
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

const PRESENCE_LABEL = {
  online: 'En ligne',
  offline: 'Hors ligne',
  unknown: 'Jamais connecté',
} as const;

/** Présence datée (SUP-001) : « hors ligne » ne signifie pas que l’écran est éteint. */
export function Presence({
  presence,
  lastSeenAt,
}: {
  presence: Player['presence'];
  lastSeenAt: string | null;
}) {
  return (
    <span
      className={`badge badge-${presence}`}
      title={
        lastSeenAt ? `Dernier contact : ${new Date(lastSeenAt).toLocaleString('fr-FR')}` : undefined
      }
    >
      {PRESENCE_LABEL[presence]}
      {presence === 'offline' && lastSeenAt && (
        <> · vu le {new Date(lastSeenAt).toLocaleString('fr-FR')}</>
      )}
    </span>
  );
}

const PRESETS = [
  { label: 'Paysage 1920×1080', width: 1920, height: 1080 },
  { label: 'Portrait 1080×1920', width: 1080, height: 1920 },
  { label: 'Bandeau LED 2688×672', width: 2688, height: 672 },
  { label: 'Bandeau LED 3840×480', width: 3840, height: 480 },
  { label: 'Totem LED 768×2304', width: 768, height: 2304 },
  { label: '4K 3840×2160', width: 3840, height: 2160 },
];

export function DisplaysPage() {
  const { can } = useSession();
  const displays = useLoad<{ slots: { allowed: number; active: number }; items: DisplaySummary[] }>(
    '/displays',
  );
  const sites = useLoad<{ items: Site[] }>('/sites');
  const [preset, setPreset] = useState(PRESETS[0]!);
  const navigate = useNavigate();
  const slots = displays.data?.slots;
  return (
    <section>
      <div className="page-header">
        <h1>Écrans</h1>
        {slots && (
          <p className="muted" aria-live="polite">
            Displays actifs : {slots.active} / {slots.allowed} licence(s)
          </p>
        )}
      </div>
      <ErrorMessage error={displays.error} />
      {!displays.data && !displays.error && <Loading />}
      {displays.data && displays.data.items.length === 0 && (
        <Empty>
          Aucun Display. Appairez un Player puis créez un Display pour lui confier une sortie.
        </Empty>
      )}
      {displays.data && displays.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Display</th>
              <th>Résolution</th>
              <th>Player</th>
              <th>Présence</th>
            </tr>
          </thead>
          <tbody>
            {displays.data.items.map((display) => (
              <tr key={display.id}>
                <td>
                  <Link to={`/displays/${display.id}`}>{display.name}</Link>
                  {display.lifecycle_status !== 'active' && <span className="badge"> Inactif</span>}
                </td>
                <td>
                  {display.width}×{display.height}
                  {display.orientation ? ` · ${display.orientation}°` : ''}
                </td>
                <td>
                  {display.assignment ? (
                    `${display.assignment.player_name} · ${display.assignment.output_key}`
                  ) : (
                    <span className="muted">Non affecté</span>
                  )}
                </td>
                <td>
                  {display.assignment ? (
                    <Presence
                      presence={display.assignment.presence}
                      lastSeenAt={display.assignment.last_seen_at}
                    />
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        <Link to="/players">Players et appairage →</Link>
      </p>
      {can('player.configure') ? (
        <div className="card narrow">
          <h2>Créer un Display</h2>
          {slots && slots.active >= slots.allowed && (
            <p className="alert alert-info">
              Toutes les licences sont utilisées. Désactivez un Display ou augmentez votre offre ;
              aucun Display supplémentaire n’est facturé sans votre confirmation.
            </p>
          )}
          <Form
            submitLabel="Créer le Display"
            onSubmit={async (values) => {
              const created = await api<{ id: string }>('POST', '/displays', {
                site_id: values.site_id,
                name: values.name,
                width: Number(values.width),
                height: Number(values.height),
                orientation: Number(values.orientation ?? 0),
                timezone: values.timezone || null,
              });
              navigate(`/displays/${created.id}`);
            }}
          >
            <Field label="Nom" name="name" />
            <div className="field">
              <label htmlFor="field-site_id">Site</label>
              <select id="field-site_id" name="site_id">
                {sites.data?.items.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="field-preset">Format</label>
              <select
                id="field-preset"
                onChange={(event) => setPreset(PRESETS[Number(event.target.value)] ?? PRESETS[0]!)}
              >
                {PRESETS.map((p, index) => (
                  <option key={p.label} value={index}>
                    {p.label}
                  </option>
                ))}
              </select>
              <p className="hint">
                Résolution libre : ajustez largeur et hauteur pour tout format LED.
              </p>
            </div>
            <div className="inline">
              <Field
                key={`w${preset.width}`}
                label="Largeur (px)"
                name="width"
                inputMode="numeric"
                defaultValue={String(preset.width)}
                pattern="[0-9]{1,5}"
              />
              <Field
                key={`h${preset.height}`}
                label="Hauteur (px)"
                name="height"
                inputMode="numeric"
                defaultValue={String(preset.height)}
                pattern="[0-9]{1,5}"
              />
            </div>
            <div className="field">
              <label htmlFor="field-orientation">Rotation de la dalle</label>
              <select id="field-orientation" name="orientation" defaultValue="0">
                <option value="0">Aucune</option>
                <option value="90">90° (sens horaire)</option>
                <option value="180">180°</option>
                <option value="270">270°</option>
              </select>
            </div>
            <Field label="Fuseau (vide : celui du site)" name="timezone" required={false} />
          </Form>
        </div>
      ) : (
        <Forbidden reason="La création de Displays requiert la permission de configuration technique." />
      )}
    </section>
  );
}

export function PlayersPage() {
  const { can } = useSession();
  const players = useLoad<{ items: Player[] }>('/players');
  const sites = useLoad<{ items: Site[] }>('/sites');
  const [paired, setPaired] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const siteName = (id: string | null) => sites.data?.items.find((s) => s.id === id)?.name ?? '—';
  return (
    <section>
      <h1>Players</h1>
      {can('player.pair') && (
        <div className="card narrow">
          <h2>Appairer un Player</h2>
          <p className="muted">
            Saisissez le code affiché par le Player (natif ou Web). Il est valable 5 minutes et ne
            sert qu’une fois. L’appairage ne crée aucun Display ni aucune licence.
          </p>
          {paired && (
            <p className="alert alert-info">
              Player « {paired} » appairé. Créez ou choisissez un Display pour l’une de ses sorties.
            </p>
          )}
          <Form
            submitLabel="Appairer"
            onSubmit={async (values) => {
              await api(
                'POST',
                '/players/pair',
                { code: values.code, name: values.name, site_id: values.site_id },
                idempotencyKey(),
              );
              setPaired(values.name ?? '');
              await players.reload();
            }}
          >
            <Field label="Code d’appairage" name="code" hint="Format XXXX-XXXX" />
            <Field label="Nom du Player" name="name" />
            <div className="field">
              <label htmlFor="field-pair-site">Site</label>
              <select id="field-pair-site" name="site_id">
                {sites.data?.items.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
            </div>
          </Form>
        </div>
      )}
      <ErrorMessage error={players.error ?? actionError} />
      {!players.data && !players.error && <Loading />}
      {players.data && players.data.items.length === 0 && <Empty>Aucun Player appairé.</Empty>}
      {players.data && players.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th>Site</th>
              <th>Présence</th>
              <th>Sorties</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {players.data.items.map((player) => (
              <tr key={player.id}>
                <td>
                  {player.name}
                  <br />
                  <span className="muted">
                    {player.type === 'native' ? 'Natif' : 'Web'} {player.app_version ?? ''}
                    {player.lifecycle_status === 'revoked' && ' · révoqué'}
                  </span>
                </td>
                <td>{siteName(player.site_id)}</td>
                <td>
                  <Presence presence={player.presence} lastSeenAt={player.last_seen_at} />
                </td>
                <td>
                  {player.outputs.map((output) => (
                    <div key={output.id}>
                      {output.output_key}{' '}
                      {output.width && output.height ? `(${output.width}×${output.height})` : ''}{' '}
                      {output.display_id ? (
                        <Link to={`/displays/${output.display_id}`}>Display affecté</Link>
                      ) : (
                        <span className="muted">libre</span>
                      )}
                    </div>
                  ))}
                </td>
                <td>
                  {can('player.configure') && player.lifecycle_status === 'paired' && (
                    <button
                      type="button"
                      className="danger"
                      onClick={async () => {
                        if (
                          !confirm(
                            `Révoquer « ${player.name} » ? Il ne pourra plus se synchroniser et ses Displays seront désaffectés (programmation conservée). S’il est hors ligne, il peut continuer à lire son cache jusqu’à sa reconnexion.`,
                          )
                        )
                          return;
                        try {
                          setActionError(null);
                          await api('POST', `/players/${player.id}/revoke`);
                          await players.reload();
                        } catch (error) {
                          setActionError(error);
                        }
                      }}
                    >
                      Révoquer
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface DisplayDetail extends Omit<DisplaySummary, 'assignment'> {
  assignment_generation: string;
  compatibility: 'ok' | 'exceeds_max_canvas' | 'unknown';
  groups: { id: string; name: string }[];
  assignment: {
    player: Player;
    player_output_id: string;
    output_key: string;
    output_connected: boolean | null;
    generation: string;
    started_at: string;
  } | null;
  history: {
    generation: string;
    player_name: string;
    output_key: string;
    started_at: string;
    ended_at: string | null;
  }[];
}

const COMPATIBILITY = {
  ok: 'Résolution compatible avec les capacités déclarées du Player.',
  exceeds_max_canvas:
    'La résolution dépasse le canvas maximal déclaré par le Player : la publication sera refusée.',
  unknown: 'Compatibilité inconnue (aucun Player affecté ou capacité non déclarée).',
} as const;

export function DisplayDetailPage() {
  const { id } = useParams();
  const { can } = useSession();
  const display = useLoad<DisplayDetail>(`/displays/${id}`);
  const players = useLoad<{ items: Player[] }>('/players');
  const [error, setError] = useState<unknown>(null);
  if (!display.data) return display.error ? <ErrorMessage error={display.error} /> : <Loading />;
  const d = display.data;
  const outputs = (players.data?.items ?? [])
    .filter((p) => p.lifecycle_status === 'paired')
    .flatMap((p) => p.outputs.map((o) => ({ ...o, player: p })));
  return (
    <section>
      <p>
        <Link to="/displays">← Écrans</Link>
      </p>
      <h1>{d.name}</h1>
      <div className="card">
        <p>
          {d.width}×{d.height} px{d.orientation ? ` · rotation ${d.orientation}°` : ''} · fuseau{' '}
          {d.timezone ?? 'du site'} ·{' '}
          {d.lifecycle_status === 'active'
            ? 'actif (licence utilisée)'
            : 'inactif (aucune licence utilisée)'}
        </p>
        <p className="muted">{COMPATIBILITY[d.compatibility]}</p>
        <p className="muted">
          Sans contenu programmé, le Player affiche un écran d’attente explicite.
        </p>
        {can('player.configure') && (
          <button
            type="button"
            onClick={async () => {
              try {
                setError(null);
                await api('PATCH', `/displays/${d.id}`, {
                  lifecycle_status: d.lifecycle_status === 'active' ? 'inactive' : 'active',
                });
                await display.reload();
              } catch (caught) {
                setError(caught);
              }
            }}
          >
            {d.lifecycle_status === 'active'
              ? 'Désactiver (libère la licence, conserve tout)'
              : 'Activer'}
          </button>
        )}
      </div>

      <div className="card">
        <h2>Player et sortie</h2>
        {d.assignment ? (
          <p>
            {d.assignment.player.name} · sortie {d.assignment.output_key} ·{' '}
            <Presence
              presence={d.assignment.player.presence}
              lastSeenAt={d.assignment.player.last_seen_at}
            />{' '}
            · sortie{' '}
            {d.assignment.output_connected === null
              ? 'état inconnu'
              : d.assignment.output_connected
                ? 'détectée'
                : 'non détectée'}
          </p>
        ) : (
          <p className="muted">Aucun Player affecté.</p>
        )}
        <ErrorMessage error={error} />
        {can('player.pair') && d.lifecycle_status === 'active' && (
          <Form
            submitLabel={d.assignment ? 'Remplacer le Player' : 'Affecter'}
            onSubmit={async (values) => {
              if (
                d.assignment &&
                !confirm(
                  'Le Display conserve son identité, ses contenus, sa programmation et son historique. L’ancienne affectation est close définitivement : l’ancien Player ne la reprendra pas à sa reconnexion. Continuer ?',
                )
              )
                return;
              await api(
                'PUT',
                `/displays/${d.id}/assignment`,
                { player_output_id: values.output },
                idempotencyKey(),
              );
              await Promise.all([display.reload(), players.reload()]);
            }}
          >
            <div className="field">
              <label htmlFor="field-output">Sortie</label>
              <select id="field-output" name="output">
                {outputs.map((output) => (
                  <option
                    key={output.id}
                    value={output.id}
                    disabled={Boolean(output.display_id && output.display_id !== d.id)}
                  >
                    {output.player.name} · {output.output_key}
                    {output.display_id && output.display_id !== d.id ? ' (occupée)' : ''}
                    {output.display_id === d.id ? ' (actuelle)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </Form>
        )}
      </div>

      <div className="card">
        <h2>Historique des affectations</h2>
        {d.history.length === 0 ? (
          <Empty>Aucune affectation.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Génération</th>
                <th>Player · sortie</th>
                <th>Début</th>
                <th>Fin</th>
              </tr>
            </thead>
            <tbody>
              {d.history.map((entry) => (
                <tr key={entry.generation}>
                  <td>{entry.generation}</td>
                  <td>
                    {entry.player_name} · {entry.output_key}
                  </td>
                  <td>{new Date(entry.started_at).toLocaleString('fr-FR')}</td>
                  <td>
                    {entry.ended_at ? new Date(entry.ended_at).toLocaleString('fr-FR') : 'en cours'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
