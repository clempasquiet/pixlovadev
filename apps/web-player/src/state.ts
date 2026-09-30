/** Modèle de l’état local persistant (IndexedDB), équivalent des tables du natif. */
import { idb } from './db.js';

export interface Association {
  registration_id: string | null;
  poll_secret: string | null;
  pairing_code: string | null;
  pairing_expires_at: string | null;
  organization_id: string | null;
  player_id: string | null;
  revoked_at: string | null;
}

export interface DisplayState {
  display_id: string;
  assignment_generation: string;
  output_key: string;
  name: string;
  width: number;
  height: number;
  orientation: 0 | 90 | 180 | 270;
  timezone: string;
  current: string | null;
  previous: string | null;
  staging: string | null;
  highest_version: string | null;
  highest_hash: string | null;
  last_error: string | null;
  /** Journal d’intention d’activation (NAT-008 étape 7). */
  intent: { old: string | null; new: string } | null;
}

export interface StoredManifest {
  manifest_id: string;
  display_id: string;
  version: string;
  manifest_hash: string;
  envelope: string;
}

export interface OutboxEntry {
  id?: number;
  manifest_id: string;
  state: 'downloading' | 'ready' | 'applied' | 'failed';
  error_code: string | null;
  detail: string | null;
  observed_at: string;
}

export const EMPTY_ASSOCIATION: Association = {
  registration_id: null,
  poll_secret: null,
  pairing_code: null,
  pairing_expires_at: null,
  organization_id: null,
  player_id: null,
  revoked_at: null,
};

export function instant(ms = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const state = {
  async association(): Promise<Association> {
    return (await idb.get<Association>('kv', 'association')) ?? EMPTY_ASSOCIATION;
  },
  saveAssociation(value: Association): Promise<unknown> {
    return idb.put('kv', value, 'association');
  },
  async display(): Promise<DisplayState | null> {
    return (await idb.get<DisplayState>('kv', 'display')) ?? null;
  },
  saveDisplay(value: DisplayState | null): Promise<unknown> {
    return value ? idb.put('kv', value, 'display') : idb.delete('kv', 'display');
  },
  manifest(id: string): Promise<StoredManifest | undefined> {
    return idb.get<StoredManifest>('manifests', id);
  },
  saveManifest(value: StoredManifest): Promise<unknown> {
    return idb.put('manifests', value, value.manifest_id);
  },
  async pruneManifests(keep: ReadonlySet<string>): Promise<void> {
    for (const key of await idb.keys('manifests')) {
      if (!keep.has(String(key))) await idb.delete('manifests', key);
    }
  },
  push(entry: Omit<OutboxEntry, 'id' | 'observed_at'>): Promise<unknown> {
    return idb.put('outbox', { ...entry, observed_at: instant() });
  },
  outbox(): Promise<OutboxEntry[]> {
    return idb.all<OutboxEntry>('outbox');
  },
  ack(id: number): Promise<unknown> {
    return idb.delete('outbox', id);
  },
};
