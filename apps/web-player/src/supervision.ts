/**
 * Supervision du Player Web (ADR-014) : file d’événements bornée dans IndexedDB, retirée
 * seulement après accusé, et journal durable des commandes signées. Mêmes règles que le
 * Player natif : vérifier, décider, inscrire, accuser, exécuter, puis déclarer le résultat.
 * Aucune capture d’écran : le navigateur ne le permet pas sans invite (`unsupported`).
 */
import {
  evaluateCommand,
  verifyCommand,
  type CommandPayload,
  type CommandResult,
  type TrustStore,
} from '@pixlova/contracts';
import { CloudError, type Cloud } from './cloud.js';
import { idb } from './db.js';
import { instant, state } from './state.js';

/** Événements conservés au plus [à valider] ; au-delà, les plus anciens sont perdus et comptés. */
export const MAX_QUEUED_EVENTS = 2_000;
const EVENT_BATCH = 500;

type Severity = 'info' | 'warning' | 'error';

export interface QueuedEvent {
  local_id?: number;
  event_id: string;
  boot_id: string;
  seq: number;
  observed_at: string;
  type: string;
  severity: Severity;
  display_id: string | null;
  assignment_generation: string | null;
  payload: Record<string, string | number | boolean | null>;
}

export interface CommandEntry {
  command_id: string;
  command_hash: string;
  type: string;
  /** `received` (inscrite), `running` (lancée), `done` (résultat enregistré). */
  state: 'received' | 'running' | 'done';
  ack_sent: boolean;
  result: CommandResult | null;
  result_sent: boolean;
  expires_at: string;
}

type Outcome = Pick<CommandResult, 'status' | 'code' | 'detail'>;

/** Actions locales confiées au Player Web par le journal des commandes. */
export interface CommandEffects {
  sync(): void;
  reloadContent(): Promise<void>;
  sendStatus(): Promise<void>;
  clearUnusedCache(): Promise<number>;
  /** Rechargement de la page après transmission du résultat (RESTART_RENDERER). */
  restart(): void;
}

const success = (detail: string | null = null): Outcome => ({
  status: 'success',
  code: null,
  detail,
});
const failed = (code: string, detail: string | null = null): Outcome => ({
  status: 'failed',
  code,
  detail,
});
const rejected = (code: string): Outcome => ({ status: 'rejected', code, detail: null });

function contractCode(code: string): string {
  return /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : 'COMMAND_FAILED';
}

export class Supervision {
  readonly bootId = crypto.randomUUID();
  private seq = 0;
  private restartPending = false;

  constructor(
    private readonly cloud: Cloud,
    private readonly commandTrust: TrustStore,
  ) {}

  // --- Événements (PROTO-019) ----------------------------------------------------------

  async record(
    type: string,
    severity: Severity,
    payload: QueuedEvent['payload'] = {},
    display: { display_id: string; assignment_generation: string } | null = null,
  ): Promise<void> {
    const event: QueuedEvent = {
      event_id: crypto.randomUUID(),
      boot_id: this.bootId,
      seq: this.seq++,
      observed_at: instant(),
      type,
      severity,
      display_id: display?.display_id ?? null,
      assignment_generation: display?.assignment_generation ?? null,
      payload,
    };
    try {
      const keys = await idb.keys('events');
      if (keys.length >= MAX_QUEUED_EVENTS) {
        const excess = keys.length - MAX_QUEUED_EVENTS + 1;
        for (const key of keys.slice(0, excess)) await idb.delete('events', key);
        const dropped = (await idb.get<number>('kv', 'events:dropped')) ?? 0;
        await idb.put('kv', dropped + excess, 'events:dropped');
      }
      await idb.put('events', event);
    } catch {
      // Stockage indisponible : l’événement est perdu, la lecture continue.
    }
  }

  async flushEvents(): Promise<void> {
    for (let round = 0; round < 10; round++) {
      const queued = (await idb.all<QueuedEvent>('events')).slice(0, EVENT_BATCH);
      if (queued.length === 0) return;
      const dropped = (await idb.get<number>('kv', 'events:dropped')) ?? 0;
      const ack = await this.cloud.events(
        queued.map(({ local_id: _local, ...event }) => event),
        dropped,
      );
      const accepted = new Set(ack.accepted);
      for (const event of queued) {
        if (accepted.has(event.event_id)) await idb.delete('events', event.local_id!);
      }
      const remaining = Math.max(
        ((await idb.get<number>('kv', 'events:dropped')) ?? 0) - dropped,
        0,
      );
      await idb.put('kv', remaining, 'events:dropped');
      if (accepted.size < queued.length) return;
    }
  }

  // --- Commandes (PROTO-007, PROTO-008) -------------------------------------------------

  /** Au démarrage : une commande lancée sans résultat a un effet inconnu. */
  async recover(): Promise<void> {
    for (const entry of await idb.all<CommandEntry>('commands')) {
      if (entry.state === 'running' || (entry.state === 'received' && entry.ack_sent)) {
        const outcome: Outcome =
          entry.state === 'running'
            ? { status: 'unknown', code: 'INTERRUPTED', detail: null }
            : failed('INTERRUPTED_BEFORE_START');
        await this.finish(entry, outcome);
      }
    }
  }

  async processCommands(
    organizationId: string,
    playerId: string,
    effects: CommandEffects,
  ): Promise<void> {
    for (const raw of await this.cloud.commands()) {
      await this.handle(raw, organizationId, playerId, effects);
    }
    await this.flushCommands();
    if (this.restartPending) effects.restart();
  }

  private result(commandId: string, outcome: Outcome): CommandResult {
    return {
      command_id: commandId,
      status: outcome.status,
      finished_at: instant(),
      code: outcome.code === null ? null : contractCode(outcome.code),
      detail: outcome.detail?.slice(0, 500) ?? null,
    };
  }

  private async handle(
    raw: string,
    organizationId: string,
    playerId: string,
    effects: CommandEffects,
  ): Promise<void> {
    const verified = verifyCommand(raw, this.commandTrust);
    if (!verified.ok) {
      // Refus déclaré pour que la commande cesse d’être redistribuée ; aucun effet.
      const id = unverifiedId(raw);
      if (id && !(await idb.get<CommandEntry>('commands', id))) {
        await this.cloud
          .commandResult(id, this.result(id, rejected(verified.code)))
          .catch(() => undefined);
      }
      return;
    }
    const { command, commandHash } = verified;
    const entries = await idb.all<CommandEntry>('commands');
    const display = await state.display();
    const decision = evaluateCommand(
      command,
      commandHash,
      {
        organization_id: organizationId,
        player_id: playerId,
        assignments: new Map(display ? [[display.display_id, display.assignment_generation]] : []),
        seen: new Map(entries.map((e) => [e.command_id, e.command_hash])),
        capabilities: { reboot_host: 'unsupported', screenshot: 'unsupported' },
      },
      instant(),
    );
    const entry: CommandEntry = {
      command_id: command.command_id,
      command_hash: commandHash,
      type: command.type,
      state: 'received',
      ack_sent: false,
      result: null,
      result_sent: false,
      expires_at: command.expires_at,
    };
    if (decision.decision === 'duplicate') {
      const known = entries.find((e) => e.command_id === command.command_id);
      if (known?.state === 'received' && !known.ack_sent) await this.run(known, command, effects);
      return;
    }
    if (decision.decision === 'reject') {
      if (entries.some((e) => e.command_id === command.command_id)) return;
      await idb.put('commands', {
        ...entry,
        state: 'done',
        result: this.result(command.command_id, rejected(decision.code)),
      });
      return;
    }
    await idb.put('commands', entry);
    await this.run(entry, command, effects);
  }

  private async run(entry: CommandEntry, command: CommandPayload, effects: CommandEffects) {
    try {
      await this.cloud.commandAck(command.command_id);
      entry.ack_sent = true;
    } catch {
      // ACK renvoyé plus tard ; l’exécution n’en dépend pas.
    }
    entry.state = 'running';
    await idb.put('commands', entry);
    await this.finish(entry, await this.execute(command, effects));
  }

  private async finish(entry: CommandEntry, outcome: Outcome): Promise<void> {
    await idb.put('commands', {
      ...entry,
      state: 'done',
      result: this.result(entry.command_id, outcome),
    });
  }

  private async execute(command: CommandPayload, effects: CommandEffects): Promise<Outcome> {
    try {
      switch (command.type) {
        case 'FORCE_SYNC':
          effects.sync();
          return success('synchronisation lancée');
        case 'RELOAD_CONTENT':
          await effects.reloadContent();
          return success();
        case 'GET_STATUS':
          await effects.sendStatus();
          return success();
        case 'CLEAR_UNUSED_CACHE':
          return success(`${await effects.clearUnusedCache()} octets libérés`);
        case 'RESTART_RENDERER':
          // Rechargement de la page une fois le résultat transmis.
          this.restartPending = true;
          return success('rechargement de la page');
        default:
          return rejected('UNSUPPORTED_COMMAND');
      }
    } catch (error) {
      return failed(error instanceof CloudError ? error.code : 'COMMAND_FAILED', String(error));
    }
  }

  async flushCommands(): Promise<void> {
    const cutoff = Date.now() - 3_600_000;
    for (const entry of await idb.all<CommandEntry>('commands')) {
      try {
        if (!entry.ack_sent && entry.state !== 'done') {
          await this.cloud.commandAck(entry.command_id);
          entry.ack_sent = true;
          await idb.put('commands', entry);
        }
        if (entry.result && !entry.result_sent) {
          await this.cloud.commandResult(entry.command_id, entry.result);
          entry.result_sent = true;
          await idb.put('commands', entry);
        }
      } catch (error) {
        // 404 : commande oubliée ; 409 : un autre résultat fait foi côté cloud.
        if (error instanceof CloudError && (error.status === 404 || error.status === 409)) {
          await idb.put('commands', { ...entry, ack_sent: true, result_sent: true });
          continue;
        }
        return;
      }
      if (entry.state === 'done' && entry.result_sent && Date.parse(entry.expires_at) < cutoff) {
        await idb.delete('commands', entry.command_id);
      }
    }
  }
}

/** Identifiant annoncé par une enveloppe non vérifiée : seulement pour déclarer son refus. */
function unverifiedId(raw: string): string | null {
  try {
    const id = (JSON.parse(raw) as { payload?: { command_id?: unknown } }).payload?.command_id;
    return typeof id === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
      ? id.toLowerCase()
      : null;
  } catch {
    return null;
  }
}
