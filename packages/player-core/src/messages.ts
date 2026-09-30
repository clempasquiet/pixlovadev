/**
 * Messages échangés entre la lecture d’un Display et son hôte : renderer natif (IPC de la
 * WebView) ou Player Web (même page). La lecture ne reçoit que des manifests déjà vérifiés
 * et des adresses locales d’assets ; jamais de jeton ni d’URL cloud (SEC-012).
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

export type Emit = (message: PageMessage) => void;
