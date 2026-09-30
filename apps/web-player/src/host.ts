/**
 * Hôte de la lecture dans la même page (Player Web) : pilote `DisplayPlayer` et
 * transforme ses messages en promesses (préparé, première image) pour le pipeline.
 */
import type { ManifestPayload } from '@pixlova/contracts';
import { DisplayPlayer, type PageMessage, type Playback } from '@pixlova/player-core';

export class HostError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(detail);
  }
}

export class PlayerHost {
  readonly player: DisplayPlayer;
  private readonly waiters = new Map<string, (message: PageMessage) => void>();
  status: { manifest_id: string | null; playback: Playback; content_ref: string | null } = {
    manifest_id: null,
    playback: 'standby',
    content_ref: null,
  };
  private frameListeners: ((manifestId: string | null) => void)[] = [];

  constructor(surface: HTMLElement, resolveAsset: (sha: string) => string) {
    this.player = new DisplayPlayer(surface, (message) => this.receive(message), resolveAsset);
  }

  onFrame(listener: (manifestId: string | null) => void): void {
    this.frameListeners.push(listener);
  }

  private receive(message: PageMessage): void {
    switch (message.type) {
      case 'prepared':
        this.waiters.get(`prepared:${message.manifest_id}`)?.(message);
        break;
      case 'frame':
        this.waiters.get(`frame:${message.manifest_id}`)?.(message);
        for (const listener of this.frameListeners) listener(message.manifest_id);
        break;
      case 'status':
        this.status = {
          manifest_id: message.manifest_id,
          playback: message.playback,
          content_ref: message.content_ref,
        };
        break;
      case 'loaded':
        break;
    }
  }

  private wait(key: string, timeoutMs: number): Promise<PageMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(new HostError('ACTIVATION_TIMEOUT', key));
      }, timeoutMs);
      this.waiters.set(key, (message) => {
        clearTimeout(timer);
        this.waiters.delete(key);
        resolve(message);
      });
    });
  }

  async prepare(
    id: string,
    manifest: ManifestPayload,
    assets: Record<string, string>,
  ): Promise<void> {
    const done = this.wait(`prepared:${id}`, 120_000);
    void this.player.prepare(id, manifest, assets);
    const message = await done;
    if (message.type === 'prepared' && message.error) {
      throw new HostError(message.error.code, message.error.detail);
    }
  }

  /** Active et attend la première image du manifest. */
  async activate(id: string, timeoutMs: number): Promise<void> {
    const frame = this.wait(`frame:${id}`, timeoutMs);
    this.player.activate(id);
    await frame;
  }
}
