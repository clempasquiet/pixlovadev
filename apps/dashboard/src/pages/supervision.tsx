/**
 * Supervision (PROD-006, SUP-001 à SUP-008, ADR-014) : signaux distincts et datés, jamais un
 * voyant unique ; commandes avec transport et résultat séparés ; captures présentées comme
 * image du renderer ; incidents et fenêtres de maintenance.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { api, idempotencyKey } from '../api.js';
import { useLoad } from '../data.js';
import { useSession } from '../session.js';
import { Empty, ErrorMessage, Loading } from '../ui.js';

const at = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString('fr-FR') : 'jamais';

const PRESENCE: Record<string, string> = {
  online: 'En ligne',
  offline: 'Hors ligne',
  unknown: 'Jamais connecté',
  unassigned: 'Sans Player',
};
const PLAYBACK: Record<string, string> = {
  playing: 'Lecture',
  fallback: 'Contenu de secours',
  standby: 'Veille programmée',
  error: 'Erreur de lecture',
  unknown: 'Inconnue',
};
const RENDERER: Record<string, string> = {
  ok: 'OK',
  starting: 'Démarrage',
  degraded: 'Dégradé',
  error: 'Erreur',
  stopped: 'Arrêté',
  unknown: 'Inconnu',
};
export const RULES: Record<string, string> = {
  player_offline: 'Player hors ligne',
  manifest_not_applied: 'Programmation non appliquée',
  delivery_failed: 'Échec de préparation',
  playback_errors: 'Erreurs de lecture répétées',
  disk_low: 'Espace disque faible',
};
const COMMAND_STATUS: Record<string, string> = {
  pending: 'En attente de récupération',
  sent: 'Transmise, non confirmée',
  acknowledged: 'Reçue par le Player',
  success: 'Réussie',
  failed: 'Échouée',
  rejected: 'Refusée par le Player',
  expired: 'Expirée',
  cancelled: 'Annulée',
  unknown: 'Issue inconnue',
};
/** Libellés de la chronologie ; le code technique reste en infobulle. */
const EVENTS: Record<string, string> = {
  PLAYER_STARTED: 'Player démarré',
  AGENT_STARTED: 'Agent démarré',
  RENDERER_CONNECTED: 'Renderer connecté',
  RENDERER_DISCONNECTED: 'Renderer déconnecté',
  PLAYBACK_ERROR: 'Erreur de lecture',
  CLOUD_UNREACHABLE: 'Cloud injoignable (diffusion locale)',
  CLOUD_RESTORED: 'Cloud de nouveau joignable',
  CLOCK_DRIFT: 'Dérive d’horloge',
  EVENTS_DROPPED: 'Événements perdus (file locale pleine)',
  PRESENCE_LOST: 'Présence perdue',
  PRESENCE_RESTORED: 'Présence retrouvée',
  COMMAND_REQUESTED: 'Commande demandée',
  COMMAND_ACKNOWLEDGED: 'Commande reçue par le Player',
  COMMAND_COMPLETED: 'Commande terminée',
  COMMAND_EXPIRED: 'Commande expirée',
  COMMAND_CANCELLED: 'Commande annulée',
  SCREENSHOT_RECEIVED: 'Capture reçue',
  INCIDENT_OPENED: 'Incident ouvert',
  INCIDENT_RESOLVED: 'Incident résolu',
  MANIFEST_DESIRED: 'Programmation désirée',
  MANIFEST_RECEIVED: 'Programmation reçue',
  MANIFEST_READY: 'Programmation prête',
  MANIFEST_APPLIED: 'Programmation appliquée',
  MANIFEST_FAILED: 'Échec de préparation',
  ASSIGNMENT_STARTED: 'Affectation commencée',
  ASSIGNMENT_ENDED: 'Affectation terminée',
};

const COMMANDS: { type: string; label: string; display?: boolean; confirm?: string }[] = [
  { type: 'FORCE_SYNC', label: 'Forcer la synchronisation' },
  { type: 'RELOAD_CONTENT', label: 'Recharger le contenu', display: true },
  { type: 'GET_STATUS', label: 'Demander le statut' },
  { type: 'CLEAR_UNUSED_CACHE', label: 'Vider le cache inutilisé' },
  {
    type: 'RESTART_RENDERER',
    label: 'Redémarrer le renderer',
    confirm: 'L’écran sera brièvement interrompu pendant le redémarrage du renderer. Continuer ?',
  },
];

function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return 'non disponible';
  return value >= 1e9 ? `${(value / 1e9).toFixed(1)} Go` : `${Math.round(value / 1e6)} Mo`;
}

function Freshness({ current }: { current: boolean }) {
  return (
    <span className={`badge ${current ? 'badge-online' : 'badge-offline'}`}>
      {current ? 'actuel' : 'ancien'}
    </span>
  );
}

// --- Vue du parc ---------------------------------------------------------------------------

interface OverviewItem {
  display_id: string;
  name: string;
  site_id: string;
  player: { id: string; name: string; type: string } | null;
  presence: string;
  last_seen_at: string | null;
  renderer: string;
  playback: string;
  output_connected: boolean | null;
  manifest: {
    desired_version: string | null;
    applied_version: string | null;
    delivery_state: string | null;
  };
  open_alerts: number;
}

export function FleetOverviewPage() {
  const [filter, setFilter] = useState('');
  const query = filter === 'attention' ? '?attention=true' : filter ? `?presence=${filter}` : '';
  const overview = useLoad<{ counts: Record<string, number>; items: OverviewItem[] }>(
    `/fleet/overview${query}`,
  );
  return (
    <section>
      <h1>Supervision du parc</h1>
      <p className="muted">
        Chaque colonne est un signal distinct : un Player hors ligne peut continuer à diffuser
        depuis son cache ; une sortie détectée ne prouve pas que l’écran est allumé.
      </p>
      {overview.data && (
        <p aria-label="Compteurs du parc">
          {overview.data.counts.displays} écran(s) · {overview.data.counts.online} en ligne ·{' '}
          {overview.data.counts.offline} hors ligne · {overview.data.counts.unknown} jamais
          connecté(s) · {overview.data.counts.unassigned} sans Player ·{' '}
          {overview.data.counts.with_alerts} avec incident
        </p>
      )}
      <div className="field">
        <label htmlFor="field-filter">Filtrer</label>
        <select id="field-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">Tous les écrans</option>
          <option value="attention">À surveiller</option>
          <option value="online">En ligne</option>
          <option value="offline">Hors ligne</option>
          <option value="unknown">Jamais connectés</option>
          <option value="unassigned">Sans Player</option>
        </select>
      </div>
      <ErrorMessage error={overview.error} />
      {!overview.data ? (
        !overview.error && <Loading />
      ) : overview.data.items.length === 0 ? (
        <Empty>Aucun écran pour ce filtre.</Empty>
      ) : (
        <table aria-label="Vue du parc">
          <thead>
            <tr>
              <th>Écran</th>
              <th>Présence</th>
              <th>Renderer</th>
              <th>Lecture</th>
              <th>Sortie</th>
              <th>Programmation</th>
              <th>Incidents</th>
            </tr>
          </thead>
          <tbody>
            {overview.data.items.map((item) => (
              <tr key={item.display_id}>
                <td>
                  <Link to={`/displays/${item.display_id}`}>{item.name}</Link>
                  <div className="muted">{item.player?.name ?? 'aucun Player'}</div>
                </td>
                <td title={`Dernier contact : ${at(item.last_seen_at)}`}>
                  {PRESENCE[item.presence] ?? item.presence}
                </td>
                <td>{RENDERER[item.renderer] ?? item.renderer}</td>
                <td>{PLAYBACK[item.playback] ?? item.playback}</td>
                <td>
                  {item.output_connected === null
                    ? 'inconnue'
                    : item.output_connected
                      ? 'détectée'
                      : 'non détectée'}
                </td>
                <td>
                  {item.manifest.desired_version
                    ? `v${item.manifest.applied_version ?? '—'} / v${item.manifest.desired_version}`
                    : 'aucune'}
                  {item.manifest.delivery_state === 'failed' && (
                    <div className="badge badge-offline">échec</div>
                  )}
                </td>
                <td>{item.open_alerts || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// --- Fiche d’un Display --------------------------------------------------------------------

interface Supervision {
  player: { id: string; name: string; type: string; app_version: string | null } | null;
  presence: { state: string; last_seen_at: string | null; timeout_seconds: number };
  health: {
    current: boolean;
    renderer: string;
    heartbeat_received_at: string | null;
    status_observed_at: string | null;
    status_received_at: string | null;
    renderer_restarts: number | null;
    storage_persistent: boolean | null;
    metrics: {
      cpu_percent: number | null;
      memory_used_bytes: number | null;
      memory_total_bytes: number | null;
      disk_free_bytes: number | null;
      disk_total_bytes: number | null;
      temperature_c: number | null;
    } | null;
  } | null;
  rendering: {
    current: boolean;
    reported_at: string | null;
    playback: string;
    manifest_applied_version: string | null;
    desired: { version: string; state: string | null; error_code: string | null } | null;
    in_sync: boolean | null;
  };
  output: { output_key: string; connected: boolean | null; last_seen_at: string | null } | null;
  capture: {
    supported: string;
    enabled: boolean;
    latest: { id: string; captured_at: string | null } | null;
  };
  alerts: {
    id: string;
    rule: string;
    severity: string;
    opened_at: string;
    suspected_platform: boolean;
  }[];
}

interface Command {
  id: string;
  type: string;
  status: string;
  display_id: string | null;
  issued_at: string;
  expires_at: string;
  sent_at: string | null;
  acknowledged_at: string | null;
  completed_at: string | null;
  result_code: string | null;
  result_detail: string | null;
}

interface Screenshot {
  id: string;
  status: string;
  command_status: string | null;
  captured_at: string | null;
  expires_at: string;
  notice: string;
}

interface TimelineItem {
  source: string;
  type: string;
  severity: string;
  observed_at: string;
  received_at: string | null;
  payload: Record<string, unknown>;
}

function Signals({ s }: { s: Supervision }) {
  const m = s.health?.metrics;
  return (
    <div className="signals">
      <div className="card" aria-label="Présence">
        <h3>Présence</h3>
        <p>{PRESENCE[s.presence.state] ?? s.presence.state}</p>
        <p className="muted">Dernier contact : {at(s.presence.last_seen_at)}</p>
        <p className="hint">Hors ligne après {s.presence.timeout_seconds} s sans contact.</p>
      </div>
      <div className="card" aria-label="Santé du Player">
        <h3>Santé du Player</h3>
        {s.health ? (
          <>
            <p>
              Renderer : {RENDERER[s.health.renderer] ?? s.health.renderer}{' '}
              <Freshness current={s.health.current} />
            </p>
            <p className="muted">
              Disque libre : {bytes(m?.disk_free_bytes)} sur {bytes(m?.disk_total_bytes)} · mémoire
              : {bytes(m?.memory_used_bytes)} · redémarrages (5 min) :{' '}
              {s.health.renderer_restarts ?? 'non disponible'}
            </p>
            <p className="hint">Statut observé : {at(s.health.status_observed_at)}</p>
          </>
        ) : (
          <p className="muted">Aucun statut reçu.</p>
        )}
      </div>
      <div className="card" aria-label="Rendu">
        <h3>Rendu</h3>
        <p>
          {PLAYBACK[s.rendering.playback] ?? s.rendering.playback}{' '}
          <Freshness current={s.rendering.current} />
        </p>
        <p className="muted">
          Version appliquée : {s.rendering.manifest_applied_version ?? 'aucune'} · désirée :{' '}
          {s.rendering.desired?.version ?? 'aucune'}
          {s.rendering.desired?.state === 'failed' &&
            ` (échec ${s.rendering.desired.error_code ?? ''})`}
        </p>
        <p className="hint">
          Déclaré le {at(s.rendering.reported_at)}. Ne prouve pas que la dalle est allumée.
        </p>
      </div>
      <div className="card" aria-label="Sortie">
        <h3>Sortie</h3>
        {s.output ? (
          <>
            <p>
              {s.output.output_key} :{' '}
              {s.output.connected === null
                ? 'état inconnu'
                : s.output.connected
                  ? 'détectée'
                  : 'non détectée'}
            </p>
            <p className="hint">Mise à jour : {at(s.output.last_seen_at)}</p>
          </>
        ) : (
          <p className="muted">Aucune sortie affectée.</p>
        )}
      </div>
    </div>
  );
}

function Commands({
  playerId,
  displayId,
  onChange,
}: {
  playerId: string;
  displayId: string;
  onChange(): void;
}) {
  const { can } = useSession();
  const commands = useLoad<{ commands_available: boolean; items: Command[] }>(
    `/players/${playerId}/commands`,
  );
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState<string | null>(null);
  const send = async (command: (typeof COMMANDS)[number]) => {
    if (command.confirm && !confirm(command.confirm)) return;
    setPending(command.type);
    setError(null);
    try {
      await api(
        'POST',
        `/players/${playerId}/commands`,
        { type: command.type, ...(command.display ? { display_id: displayId } : {}) },
        idempotencyKey(),
      );
      await commands.reload();
      onChange();
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="card">
      <h2>Commandes</h2>
      <p className="hint">
        Une commande est récupérée au prochain contact du Player (30 s au plus). « Reçue » ne
        signifie pas « réussie » : le résultat est affiché séparément.
      </p>
      {can('player.command') && commands.data?.commands_available !== false && (
        <div className="inline">
          {COMMANDS.map((command) => (
            <button
              key={command.type}
              type="button"
              disabled={pending !== null}
              onClick={() => void send(command)}
            >
              {command.label}
            </button>
          ))}
        </div>
      )}
      {commands.data?.commands_available === false && (
        <p className="muted">Commandes distantes non configurées sur ce serveur.</p>
      )}
      <ErrorMessage error={error ?? commands.error} />
      <button type="button" className="link" onClick={() => void commands.reload()}>
        Mettre à jour les commandes
      </button>
      {commands.data && commands.data.items.length > 0 && (
        <table aria-label="Commandes récentes">
          <thead>
            <tr>
              <th>Commande</th>
              <th>Demandée</th>
              <th>Transport</th>
              <th>Résultat</th>
            </tr>
          </thead>
          <tbody>
            {commands.data.items.map((command) => (
              <tr key={command.id}>
                <td>
                  {command.type === 'TAKE_SCREENSHOT'
                    ? 'Capture d’écran'
                    : (COMMANDS.find((c) => c.type === command.type)?.label ?? command.type)}
                </td>
                <td>{at(command.issued_at)}</td>
                <td>
                  {command.acknowledged_at
                    ? `reçue ${at(command.acknowledged_at)}`
                    : command.sent_at
                      ? `transmise ${at(command.sent_at)}`
                      : 'non transmise'}
                </td>
                <td>
                  {COMMAND_STATUS[command.status] ?? command.status}
                  {command.result_code && <span className="muted"> · {command.result_code}</span>}
                  {command.status === 'pending' && can('player.command') && (
                    <button
                      type="button"
                      className="link"
                      onClick={async () => {
                        try {
                          await api('POST', `/commands/${command.id}/cancel`);
                          await commands.reload();
                        } catch (caught) {
                          setError(caught);
                        }
                      }}
                    >
                      Annuler
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Screenshots({
  displayId,
  capture,
}: {
  displayId: string;
  capture: Supervision['capture'];
}) {
  const { can } = useSession();
  const list = useLoad<{ enabled: boolean; retention_hours: number; items: Screenshot[] }>(
    can('screenshots.read') ? `/displays/${displayId}/screenshots` : null,
  );
  const [image, setImage] = useState<{ url: string; captured_at: string | null } | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (capture.supported !== 'supported') {
    return (
      <div className="card">
        <h2>Capture</h2>
        <p className="muted">Ce Player ne permet pas la capture d’écran.</p>
      </div>
    );
  }
  return (
    <div className="card">
      <h2>Capture</h2>
      <p className="hint">
        Image du renderer, datée : elle ne prouve pas que l’écran est allumé ou visible. Conservée{' '}
        {list.data?.retention_hours ?? 24} h ; chaque consultation est journalisée.
      </p>
      {!capture.enabled && <p className="muted">Captures désactivées pour cette organisation.</p>}
      {capture.enabled && can('screenshots.request') && (
        <button
          type="button"
          onClick={async () => {
            try {
              setError(null);
              await api('POST', `/displays/${displayId}/screenshots`, {}, idempotencyKey());
              await list.reload();
            } catch (caught) {
              setError(caught);
            }
          }}
        >
          Demander une capture
        </button>
      )}
      <ErrorMessage error={error ?? list.error} />
      {list.data && (
        <ul aria-label="Captures">
          {list.data.items.map((shot) => (
            <li key={shot.id}>
              {shot.status === 'available' ? (
                <button
                  type="button"
                  className="link"
                  onClick={async () => {
                    try {
                      setImage(
                        await api<{ url: string; captured_at: string | null }>(
                          'GET',
                          `/screenshots/${shot.id}/url`,
                        ),
                      );
                    } catch (caught) {
                      setError(caught);
                    }
                  }}
                >
                  Capture du {at(shot.captured_at)}
                </button>
              ) : (
                <span className="muted">
                  Demandée · {COMMAND_STATUS[shot.command_status ?? ''] ?? 'en cours'}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {image && (
        <figure className="capture">
          <img src={image.url} alt={`Capture du renderer du ${at(image.captured_at)}`} />
          <figcaption className="hint">
            Capturée le {at(image.captured_at)} · image du renderer, pas un flux direct.
          </figcaption>
        </figure>
      )}
    </div>
  );
}

function Timeline({ displayId }: { displayId: string }) {
  const [before, setBefore] = useState<string | null>(null);
  const timeline = useLoad<{ items: TimelineItem[]; next_before: string | null }>(
    `/displays/${displayId}/timeline?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`,
  );
  return (
    <div className="card">
      <h2>Chronologie</h2>
      <ErrorMessage error={timeline.error} />
      {!timeline.data ? (
        !timeline.error && <Loading />
      ) : timeline.data.items.length === 0 ? (
        <Empty>Aucun événement.</Empty>
      ) : (
        <table aria-label="Chronologie">
          <thead>
            <tr>
              <th>Observé</th>
              <th>Événement</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {timeline.data.items.map((item, index) => (
              <tr
                key={`${item.observed_at}-${item.type}-${index}`}
                className={`severity-${item.severity}`}
              >
                <td>
                  {at(item.observed_at)}
                  {item.received_at &&
                    Math.abs(Date.parse(item.received_at) - Date.parse(item.observed_at)) >
                      60_000 && <div className="hint">reçu le {at(item.received_at)}</div>}
                </td>
                <td title={item.type}>
                  {EVENTS[item.type] ?? item.type}
                  {typeof item.payload.status === 'string' &&
                    ` · ${COMMAND_STATUS[item.payload.status] ?? item.payload.status}`}
                  {typeof item.payload.version === 'string' && ` · v${item.payload.version}`}
                  {typeof item.payload.rule === 'string' &&
                    ` · ${RULES[item.payload.rule] ?? item.payload.rule}`}
                  {typeof item.payload.error_code === 'string' && ` · ${item.payload.error_code}`}
                </td>
                <td>{item.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="inline">
        {before && (
          <button type="button" className="link" onClick={() => setBefore(null)}>
            Plus récents
          </button>
        )}
        {timeline.data?.next_before && (
          <button
            type="button"
            className="link"
            onClick={() => setBefore(timeline.data!.next_before)}
          >
            Plus anciens
          </button>
        )}
      </div>
    </div>
  );
}

/** Panneau de supervision de la fiche d’un Display. */
export function DisplaySupervision({ displayId }: { displayId: string }) {
  const supervision = useLoad<Supervision>(`/displays/${displayId}/supervision`);
  if (!supervision.data) {
    return supervision.error ? <ErrorMessage error={supervision.error} /> : <Loading />;
  }
  const s = supervision.data;
  return (
    <>
      <h2>Supervision</h2>
      {s.alerts.length > 0 && (
        <div className="alert alert-error" role="alert" aria-label="Incidents ouverts">
          {s.alerts.map((alert) => (
            <p key={alert.id}>
              {RULES[alert.rule] ?? alert.rule} depuis le {at(alert.opened_at)}
              {alert.suspected_platform && ' (panne commune probable côté plateforme)'}
            </p>
          ))}
        </div>
      )}
      <Signals s={s} />
      {s.player && (
        <Commands
          playerId={s.player.id}
          displayId={displayId}
          onChange={() => void supervision.reload()}
        />
      )}
      <Screenshots displayId={displayId} capture={s.capture} />
      <Timeline displayId={displayId} />
    </>
  );
}

// --- Incidents et maintenance ---------------------------------------------------------------

interface Alert {
  id: string;
  rule: string;
  severity: string;
  status: string;
  target_type: 'player' | 'display';
  target_id: string;
  target_name: string | null;
  opened_at: string;
  resolved_at: string | null;
  notified_at: string | null;
  suspected_platform: boolean;
}

interface MaintenanceWindow {
  id: string;
  scope_type: 'organization' | 'site' | 'display';
  scope_id: string | null;
  starts_at: string;
  ends_at: string;
  reason: string;
  active: boolean;
}

function localInput(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export function IncidentsPage() {
  const { can } = useSession();
  const [status, setStatus] = useState<'open' | 'resolved'>('open');
  const alerts = useLoad<{ items: Alert[] }>(`/alerts?status=${status}`);
  const windows = useLoad<{ items: MaintenanceWindow[] }>('/maintenance-windows');
  const displays = useLoad<{ items: { id: string; name: string }[] }>('/displays');
  const preferences = useLoad<{ alert_emails: boolean }>('/supervision/preferences');
  const [error, setError] = useState<unknown>(null);
  const now = new Date();
  const [form, setForm] = useState({
    display: '',
    starts: localInput(now),
    ends: localInput(new Date(now.getTime() + 2 * 3600_000)),
    reason: '',
  });
  const displayName = (id: string | null) =>
    displays.data?.items.find((d) => d.id === id)?.name ?? id ?? 'organisation';
  return (
    <section>
      <h1>Incidents</h1>
      <div className="tabs" role="tablist">
        {(['open', 'resolved'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={status === value}
            onClick={() => setStatus(value)}
          >
            {value === 'open' ? 'Ouverts' : 'Résolus'}
          </button>
        ))}
      </div>
      <ErrorMessage error={alerts.error} />
      {!alerts.data ? (
        !alerts.error && <Loading />
      ) : alerts.data.items.length === 0 ? (
        <Empty>{status === 'open' ? 'Aucun incident ouvert.' : 'Aucun incident résolu.'}</Empty>
      ) : (
        <table aria-label="Incidents">
          <thead>
            <tr>
              <th>Règle</th>
              <th>Cible</th>
              <th>Ouvert</th>
              <th>{status === 'open' ? 'Notification' : 'Résolu'}</th>
            </tr>
          </thead>
          <tbody>
            {alerts.data.items.map((alert) => (
              <tr key={alert.id} className={`severity-${alert.severity}`}>
                <td>
                  {RULES[alert.rule] ?? alert.rule}
                  {alert.suspected_platform && (
                    <div className="hint">Panne commune probable côté plateforme</div>
                  )}
                </td>
                <td>
                  {alert.target_type === 'display' ? (
                    <Link to={`/displays/${alert.target_id}`}>{alert.target_name ?? 'Écran'}</Link>
                  ) : (
                    (alert.target_name ?? 'Player')
                  )}
                </td>
                <td>{at(alert.opened_at)}</td>
                <td>
                  {status === 'open'
                    ? alert.notified_at
                      ? `envoyée ${at(alert.notified_at)}`
                      : 'retenue'
                    : at(alert.resolved_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="card">
        <h2>Maintenance</h2>
        <p className="hint">
          Une fenêtre suspend les notifications pendant une intervention. Les incidents restent
          ouverts et visibles.
        </p>
        {windows.data && windows.data.items.length > 0 ? (
          <ul aria-label="Fenêtres de maintenance">
            {windows.data.items.map((window) => (
              <li key={window.id}>
                {window.scope_type === 'display'
                  ? displayName(window.scope_id)
                  : window.scope_type === 'site'
                    ? 'Site'
                    : 'Organisation'}{' '}
                · {at(window.starts_at)} → {at(window.ends_at)} · {window.reason}
                {window.active && <span className="badge"> en cours</span>}
                {can('player.configure') && (
                  <button
                    type="button"
                    className="link"
                    onClick={async () => {
                      try {
                        await api('POST', `/maintenance-windows/${window.id}/cancel`);
                        await windows.reload();
                      } catch (caught) {
                        setError(caught);
                      }
                    }}
                  >
                    Terminer
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Aucune fenêtre prévue.</Empty>
        )}
        {can('player.configure') && (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              try {
                setError(null);
                await api('POST', '/maintenance-windows', {
                  scope_type: form.display ? 'display' : 'organization',
                  scope_id: form.display || null,
                  starts_at: new Date(form.starts).toISOString(),
                  ends_at: new Date(form.ends).toISOString(),
                  reason: form.reason,
                });
                setForm({ ...form, reason: '' });
                await windows.reload();
              } catch (caught) {
                setError(caught);
              }
            }}
          >
            <div className="field">
              <label htmlFor="field-scope">Portée</label>
              <select
                id="field-scope"
                value={form.display}
                onChange={(e) => setForm({ ...form, display: e.target.value })}
              >
                <option value="">Toute l’organisation</option>
                {displays.data?.items.map((display) => (
                  <option key={display.id} value={display.id}>
                    {display.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="field-starts">Début</label>
              <input
                id="field-starts"
                type="datetime-local"
                value={form.starts}
                onChange={(e) => setForm({ ...form, starts: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="field-ends">Fin</label>
              <input
                id="field-ends"
                type="datetime-local"
                value={form.ends}
                onChange={(e) => setForm({ ...form, ends: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="field-reason">Motif</label>
              <input
                id="field-reason"
                required
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
              />
            </div>
            <button type="submit">Planifier la maintenance</button>
          </form>
        )}
        <ErrorMessage error={error} />
      </div>

      <div className="card">
        <h2>Mes notifications</h2>
        {preferences.data && (
          <label>
            <input
              type="checkbox"
              checked={preferences.data.alert_emails}
              onChange={async (event) => {
                try {
                  await api('PUT', '/supervision/preferences', {
                    alert_emails: event.target.checked,
                  });
                  await preferences.reload();
                } catch (caught) {
                  setError(caught);
                }
              }}
            />{' '}
            Recevoir les emails d’incident (si j’ai le droit de configurer le parc concerné)
          </label>
        )}
      </div>
    </section>
  );
}
