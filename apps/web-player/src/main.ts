/**
 * Player Web pixlova (ADR-013) : même modèle que le Player natif (appairage, manifests
 * signés, activation atomique), dans les limites d’un navigateur. La page active porte
 * la lecture ; le service worker ne sert que l’application hors ligne.
 */
import '@pixlova/render-engine/fonts.css';
import { decodeBase64url, type TrustStore } from '@pixlova/contracts';
import { renderNotice, type Notice } from '@pixlova/player-core';
import { AssetCache } from './assets.js';
import { browserOutput, capabilities } from './capabilities.js';
import { Cloud, CloudError } from './cloud.js';
import { PlayerHost } from './host.js';
import { loadOrCreateIdentity, type Identity } from './identity.js';
import { WebPipeline } from './pipeline.js';
import { EMPTY_ASSOCIATION, instant, state, type Association } from './state.js';
import { Supervision } from './supervision.js';

export const APP_VERSION = '0.1.0';

const surface = document.querySelector<HTMLElement>('#surface')!;
const noticeRoot = document.querySelector<HTMLElement>('#notice')!;
const startRoot = document.querySelector<HTMLElement>('#start')!;
const panel = document.querySelector<HTMLElement>('#panel')!;
const alertRoot = document.querySelector<HTMLElement>('#alert')!;

/** Statut complet envoyé au plus tard à cet intervalle [à valider] (OBS-003). */
const STATUS_INTERVAL_MS = 5 * 60_000;

interface Observed {
  online: boolean | null;
  lastError: string | null;
  persisted: boolean | null;
  quota: number | null;
  usage: number | null;
  notice: Notice | null;
}

const observed: Observed = {
  online: null,
  lastError: null,
  persisted: null,
  quota: null,
  usage: null,
  notice: null,
};

function showAlert(message: string | null): void {
  alertRoot.textContent = message ?? '';
  alertRoot.hidden = !message;
}

async function loadJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(path, { cache: 'no-cache' });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Clés publiques livrées avec l’application (PROTO-012) : manifests et commandes, dans deux
 * fichiers distincts (ADR-014).
 */
async function loadTrust(path: string): Promise<TrustStore> {
  const file = await loadJson<{ keys: { kid: string; public_key: string }[] }>(path);
  const trust = new Map<string, Uint8Array>();
  for (const key of file?.keys ?? []) {
    const bytes = decodeBase64url(key.public_key);
    if (bytes?.length === 32) trust.set(key.kid, bytes);
  }
  return trust;
}

/**
 * Service worker de l’application : une version en attente n’est activée qu’ici, au
 * démarrage et avant toute lecture, jamais pendant une diffusion (WEBPLY-004).
 */
async function registerAppShell(): Promise<void> {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  try {
    const registration = await navigator.serviceWorker.register('./sw.js');
    if (registration.waiting && navigator.serviceWorker.controller) {
      const reloaded = sessionStorage.getItem('pixlova:sw-update') === '1';
      if (!reloaded) {
        sessionStorage.setItem('pixlova:sw-update', '1');
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {
          once: true,
        });
        registration.waiting.postMessage('pixlova:activate-update');
        return;
      }
    }
    sessionStorage.removeItem('pixlova:sw-update');
  } catch {
    // Sans service worker, le Player fonctionne mais ne redémarre pas hors ligne.
  }
}

async function measureStorage(): Promise<void> {
  try {
    observed.persisted = (await navigator.storage?.persisted?.()) ?? null;
    if (observed.persisted === false) {
      observed.persisted = (await navigator.storage?.persist?.()) ?? false;
    }
    const estimate = await navigator.storage?.estimate?.();
    observed.quota = estimate?.quota ?? null;
    observed.usage = estimate?.usage ?? null;
  } catch {
    // mesures indisponibles : restent inconnues
  }
}

function formatBytes(value: number | null): string {
  if (value === null) return 'inconnu';
  return value >= 1e9 ? `${(value / 1e9).toFixed(1)} Go` : `${Math.round(value / 1e6)} Mo`;
}

class WebPlayer {
  private readonly cloud: Cloud;
  private readonly assets = new AssetCache();
  private readonly host: PlayerHost;
  private readonly pipeline: WebPipeline;
  private readonly supervision: Supervision;
  private outputsReported: string | null = null;
  private readonly started = Date.now();
  private statusSentAt = 0;
  private lastPlayback: string | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly identity: Identity,
    trust: TrustStore,
    commandTrust: TrustStore,
    apiUrl: string,
  ) {
    this.cloud = new Cloud(apiUrl);
    this.host = new PlayerHost(surface, (sha) => this.assets.urlFor(sha));
    this.pipeline = new WebPipeline(this.cloud, this.assets, trust, this.host);
    this.supervision = new Supervision(this.cloud, commandTrust);
    this.host.onFrame(() => document.body.classList.add('playing'));
  }

  /** Pause interrompue par `FORCE_SYNC`. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  private async setNotice(notice: Notice | null): Promise<void> {
    observed.notice = notice;
    renderNotice(noticeRoot, notice);
  }

  async start(): Promise<void> {
    await this.pipeline.recover();
    await this.supervision.recover();
    await this.supervision.record('PLAYER_STARTED', 'info', { version: APP_VERSION });
    // Reprise locale avant tout accès réseau : un redémarrage hors ligne rediffuse.
    const restored = await this.pipeline.restoreCurrent();
    if (!restored) await this.refreshNotice();
    for (;;) {
      let pause: number;
      try {
        const association = await state.association();
        pause =
          association.organization_id && association.player_id && !association.revoked_at
            ? await this.sync(association.organization_id, association.player_id)
            : await this.pairing(association);
      } catch (error) {
        pause = await this.failed(error);
      }
      this.renderPanel();
      await this.sleep(pause);
    }
  }

  private async refreshNotice(): Promise<void> {
    const association = await state.association();
    const display = await state.display();
    if (display?.current) return this.setNotice(null);
    if (association.player_id && !association.revoked_at)
      return this.setNotice({ kind: 'waiting' });
    if (association.pairing_code && association.pairing_expires_at) {
      return this.setNotice({
        kind: 'pairing',
        pairing_code: association.pairing_code,
        expires_at: association.pairing_expires_at,
      });
    }
    if (association.revoked_at) return this.setNotice({ kind: 'revoked' });
  }

  private probe() {
    return {
      userAgent: navigator.userAgent,
      canPlay: (type: string) => document.createElement('video').canPlayType(type),
      persisted: observed.persisted,
      quota: observed.quota,
      screen: { width: screen.width * devicePixelRatio, height: screen.height * devicePixelRatio },
    };
  }

  private output() {
    return browserOutput({ width: screen.width, height: screen.height }, devicePixelRatio);
  }

  /** Enregistrement puis attente de l’appairage (PROTO-001). */
  private async pairing(association: Association): Promise<number> {
    const expired =
      !association.pairing_expires_at || Date.parse(association.pairing_expires_at) <= Date.now();
    if (!association.registration_id || !association.poll_secret || expired) {
      const registration = await this.cloud.register({
        installation_id: this.identity.installationId,
        public_key: this.identity.publicKey,
        capabilities: capabilities(this.probe(), APP_VERSION),
        outputs: [this.output()],
        machine_fingerprint: null,
      });
      await state.saveAssociation({
        ...association,
        registration_id: registration.registration_id,
        poll_secret: registration.poll_secret,
        pairing_code: registration.pairing_code,
        pairing_expires_at: registration.expires_at,
      });
      observed.online = true;
      await this.refreshNotice();
      return registration.poll_interval_s * 1000;
    }
    try {
      const paired = await this.cloud.pair(association.registration_id, association.poll_secret);
      observed.online = true;
      if (paired.status === 'pending') return 3_000;
      await state.saveAssociation({
        ...association,
        organization_id: paired.organization_id,
        player_id: paired.player_id,
        poll_secret: null,
        pairing_code: null,
        revoked_at: null,
      });
      await this.refreshNotice();
      return 0;
    } catch (error) {
      if (
        error instanceof CloudError &&
        (error.code === 'PAIRING_EXPIRED' || error.code === 'RESOURCE_NOT_FOUND')
      ) {
        await state.saveAssociation({
          ...association,
          poll_secret: null,
          pairing_expires_at: null,
        });
        return 0;
      }
      throw error;
    }
  }

  private async sync(organizationId: string, playerId: string): Promise<number> {
    if (!this.cloud.hasToken()) await this.cloud.authenticate(playerId, this.identity);
    const output = this.output();
    const signature = JSON.stringify(output);
    if (this.outputsReported !== signature) {
      await this.cloud.reportOutputs([output]);
      this.outputsReported = signature;
    }
    const config = await this.cloud.config();
    if (config.organization_id !== organizationId || config.player_id !== playerId) {
      throw new CloudError('protocol', 'PROTOCOL_ERROR', null, 'configuration d’un autre Player');
    }
    await this.applyConfig(config.assignments);
    const display = await state.display();
    if (display) await this.pipeline.fetchCandidate(organizationId, playerId, display);
    await this.pipeline.advance();
    await this.flushOutbox();
    const pending = await this.heartbeat();
    if (observed.online === false) {
      await this.supervision.record('CLOUD_RESTORED', 'info');
    }
    observed.online = true;
    await this.superviseOnline(organizationId, playerId, pending);
    observed.lastError = (await state.display())?.last_error ?? null;
    await this.refreshNotice();
    return Math.min(config.heartbeat_interval_s * 1000, 10_000);
  }

  private async applyConfig(
    assignments: Awaited<ReturnType<Cloud['config']>>['assignments'],
  ): Promise<void> {
    const assignment = assignments.find((a) => a.output_key === 'browser') ?? assignments[0];
    const current = await state.display();
    if (!assignment) {
      if (current) {
        // Plus rien n’est diffusé pour un Display retiré de ce Player.
        await state.saveDisplay(null);
        this.host.player.dispose();
        location.reload();
      }
      return;
    }
    const sameGeneration =
      current?.display_id === assignment.display_id &&
      current.assignment_generation === assignment.assignment_generation;
    if (current && !sameGeneration) {
      // Nouvelle affectation : les manifests de l’ancienne ne redeviennent jamais légitimes.
      await state.saveDisplay(null);
      await state.pruneManifests(new Set());
      location.reload();
      return;
    }
    await state.saveDisplay({
      display_id: assignment.display_id,
      assignment_generation: assignment.assignment_generation,
      output_key: assignment.output_key,
      name: assignment.display.name,
      width: assignment.display.width,
      height: assignment.display.height,
      orientation: assignment.display.orientation,
      timezone: assignment.display.timezone,
      current: current?.current ?? null,
      previous: current?.previous ?? null,
      staging: current?.staging ?? null,
      highest_version: current?.highest_version ?? null,
      highest_hash: current?.highest_hash ?? null,
      last_error: current?.last_error ?? null,
      intent: current?.intent ?? null,
    });
  }

  private async flushOutbox(): Promise<void> {
    for (const entry of await state.outbox()) {
      try {
        await this.cloud.manifestStatus(
          entry.manifest_id,
          entry.state,
          entry.observed_at,
          entry.error_code,
          entry.detail,
        );
        await state.ack(entry.id!);
      } catch (error) {
        if (error instanceof CloudError && error.status === 404) {
          await state.ack(entry.id!);
          continue;
        }
        return;
      }
    }
  }

  /**
   * Commandes, statut et événements (ADR-014). Leur échec n’interrompt ni la lecture ni la
   * synchronisation : tout est conservé et retransmis au tour suivant.
   */
  private async superviseOnline(
    organizationId: string,
    playerId: string,
    pending: number,
  ): Promise<void> {
    try {
      await this.supervision.flushCommands();
      if (pending > 0) {
        await this.supervision.processCommands(organizationId, playerId, {
          sync: () => this.wake?.(),
          reloadContent: async () => {
            await this.pipeline.restoreCurrent();
          },
          sendStatus: () => this.sendStatus(),
          clearUnusedCache: () => this.clearUnusedCache(),
          restart: () => location.reload(),
        });
      }
      if (Date.now() - this.statusSentAt >= STATUS_INTERVAL_MS) await this.sendStatus();
      await this.supervision.flushEvents();
    } catch {
      // Conservé localement ; nouvel essai au prochain tour.
    }
  }

  /** Statut complet : le navigateur ne donne ni disque, ni CPU, ni température (`null`). */
  private async sendStatus(): Promise<void> {
    await measureStorage();
    const output = this.output();
    await this.cloud.status({
      observed_at: instant(),
      renderer: document.hidden ? 'degraded' : 'ok',
      renderer_restarts: null,
      storage_persistent: observed.persisted,
      metrics: {
        cpu_percent: null,
        memory_used_bytes: null,
        memory_total_bytes: null,
        disk_free_bytes: null,
        disk_total_bytes: null,
        temperature_c: null,
      },
      cache: null,
      outputs: [
        {
          output_key: output.output_key,
          connected: null,
          width: output.width,
          height: output.height,
          refresh_hz: null,
        },
      ],
    });
    this.statusSentAt = Date.now();
  }

  /** Assets hors des manifests courant, précédent et candidat. */
  private async clearUnusedCache(): Promise<number> {
    const pinned = await this.pipeline.pinned();
    let freed = 0;
    for (const entry of await this.assets.entries()) {
      if (pinned.has(entry.sha256)) continue;
      await this.assets.remove(entry.sha256);
      freed += entry.size;
    }
    return freed;
  }

  /** Heartbeat ; retourne le nombre de commandes annoncées par le cloud. */
  private async heartbeat(): Promise<number> {
    const display = await state.display();
    const applied = display?.current ? await state.manifest(display.current) : undefined;
    const playback = this.host.status.playback;
    if (display && playback === 'error' && this.lastPlayback !== 'error') {
      await this.supervision.record(
        'PLAYBACK_ERROR',
        'error',
        { manifest_id: this.host.status.manifest_id, content_ref: this.host.status.content_ref },
        display,
      );
    }
    this.lastPlayback = playback;
    const ack = await this.cloud.heartbeat({
      uptime_seconds: Math.floor((Date.now() - this.started) / 1000),
      // Page masquée : timers ralentis par le navigateur, lecture non garantie.
      renderer: document.hidden ? 'degraded' : 'ok',
      displays: display
        ? [
            {
              display_id: display.display_id,
              assignment_generation: display.assignment_generation,
              manifest_applied_version: applied?.version ?? null,
              playback,
            },
          ]
        : [],
    });
    return ack.pending_commands ?? 0;
  }

  private async failed(error: unknown): Promise<number> {
    if (error instanceof CloudError && error.kind === 'revoked') {
      // Révocation explicite : contenus retirés, nouvel appairage proposé.
      await state.saveAssociation({ ...EMPTY_ASSOCIATION, revoked_at: instant() });
      await state.saveDisplay(null);
      this.cloud.forgetToken();
      this.host.player.dispose();
      await this.setNotice({ kind: 'revoked' });
      return 3_000;
    }
    if (observed.online !== false) {
      await this.supervision.record('CLOUD_UNREACHABLE', 'warning', {
        code: error instanceof CloudError ? error.code : 'NETWORK_UNAVAILABLE',
      });
    }
    observed.online = false;
    observed.lastError = error instanceof CloudError ? error.code : String(error);
    return error instanceof CloudError && !error.transient ? 60_000 : 10_000;
  }

  renderPanel(): void {
    void measureStorage().then(async () => {
      const display = await state.display();
      const applied = display?.current ? await state.manifest(display.current) : undefined;
      const rows: [string, string][] = [
        ['Version', APP_VERSION],
        ['Installation', this.identity.installationId],
        ['Clé de l’appareil', this.identity.protection],
        [
          'Cloud',
          observed.online === null ? 'inconnu' : observed.online ? 'joignable' : 'injoignable',
        ],
        [
          'Stockage persistant',
          observed.persisted === null ? 'inconnu' : observed.persisted ? 'accordé' : 'refusé',
        ],
        ['Stockage utilisé', `${formatBytes(observed.usage)} sur ${formatBytes(observed.quota)}`],
        ['Écran', display ? display.name : 'aucun'],
        ['Manifest appliqué', applied ? `v${applied.version}` : 'aucun'],
        ['Dernière erreur', display?.last_error ?? observed.lastError ?? 'aucune'],
      ];
      const list = document.createElement('dl');
      for (const [label, value] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        dd.dataset.field = label;
        list.append(dt, dd);
      }
      panel.replaceChildren(list);
      panel.dataset.applied = applied?.version ?? '';
      panel.dataset.online = String(observed.online);
      panel.dataset.error = display?.last_error ?? '';
      panel.dataset.persisted = String(observed.persisted);
      if (observed.persisted === false) {
        showAlert(
          'Stockage non persistant : le navigateur peut effacer le contenu hors ligne. Voir la documentation du Player Web.',
        );
      }
    });
  }
}

/** Plein écran et son exigent une action ou une politique kiosk (WEBPLY-003). */
function setupStart(): void {
  const alreadyFullscreen =
    document.fullscreenElement !== null || matchMedia('(display-mode: fullscreen)').matches;
  if (alreadyFullscreen) return;
  startRoot.hidden = false;
  const dismiss = () => {
    startRoot.hidden = true;
  };
  // Sans intervention, la diffusion continue en fenêtre, sans son.
  const timer = setTimeout(() => {
    dismiss();
    if (!document.fullscreenElement) {
      showAlert(
        'Plein écran inactif : touchez l’écran ou configurez le mode kiosque du navigateur.',
      );
    }
  }, 15_000);
  const enter = async () => {
    clearTimeout(timer);
    dismiss();
    try {
      await document.documentElement.requestFullscreen();
      showAlert(null);
    } catch {
      showAlert('Plein écran refusé par le navigateur : utilisez son mode kiosque.');
    }
    try {
      await (
        navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<unknown> } }
      ).wakeLock?.request('screen');
    } catch {
      // Verrou d’éveil indisponible : la veille de l’écran reste à configurer.
    }
  };
  document.querySelector('#start-button')!.addEventListener('click', () => void enter());
  document.addEventListener('dblclick', () => void enter());
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'i') panel.hidden = !panel.hidden;
});
if (new URLSearchParams(location.search).has('status')) panel.hidden = false;

async function main(): Promise<void> {
  await registerAppShell();
  await measureStorage();
  const [config, trust, commandTrust] = await Promise.all([
    loadJson<{ api_url?: string }>('./config.json'),
    loadTrust('./trust/manifest-keys.json'),
    loadTrust('./trust/command-keys.json'),
  ]);
  if (trust.size === 0) {
    showAlert('Clés de confiance absentes : aucun contenu ne peut être accepté.');
  }
  let identity: Identity;
  try {
    identity = await loadOrCreateIdentity();
  } catch {
    showAlert(
      'Stockage du navigateur indisponible (navigation privée ?) : le Player ne peut pas fonctionner.',
    );
    return;
  }
  setupStart();
  const player = new WebPlayer(identity, trust, commandTrust, config?.api_url ?? '');
  player.renderPanel();
  await player.start();
}

void main();
