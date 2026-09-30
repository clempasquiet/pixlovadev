/**
 * Messages échangés entre la page de lecture et son hôte (renderer natif via l’IPC de la
 * WebView, ou Player Web). La page ne reçoit que des manifests déjà vérifiés et des
 * adresses locales d’assets ; elle n’a accès à aucun jeton ni URL cloud (SEC-012).
 */
import type { ManifestPayload } from '@pixlova/contracts';

export interface DisplayInfo {
  display_id: string;
  name: string;
  width: number;
  height: number;
  orientation: 0 | 90 | 180 | 270;
  timezone: string;
}

export type Notice =
  | { kind: 'pairing'; pairing_code: string; expires_at: string }
  | { kind: 'revoked' }
  | { kind: 'waiting' };

export type HostMessage =
  | {
      type: 'configure';
      display: DisplayInfo | null;
      notice: Notice | null;
      /** Préfixe des assets vérifiés, suivi du SHA-256 (`pixlova://asset/`). */
      asset_base: string;
    }
  | {
      type: 'prepare';
      manifest_id: string;
      manifest: ManifestPayload;
      /** `asset_id → sha256` */
      assets: Record<string, string>;
    }
  | { type: 'activate'; manifest_id: string };

export type Playback = 'playing' | 'fallback' | 'standby' | 'error' | 'unknown';

export type PageMessage =
  | { type: 'loaded' }
  | { type: 'prepared'; manifest_id: string; error: { code: string; detail: string } | null }
  | { type: 'frame'; manifest_id: string | null }
  | {
      type: 'status';
      manifest_id: string | null;
      playback: Playback;
      content_ref: string | null;
    };

declare global {
  interface Window {
    /** Canal injecté par wry ; absent dans un navigateur. */
    ipc?: { postMessage(message: string): void };
    /** Point d’entrée des messages de l’hôte. */
    pixlova?: { receive(message: HostMessage): void };
  }
}

export function post(message: PageMessage): void {
  window.ipc?.postMessage(JSON.stringify(message));
}
