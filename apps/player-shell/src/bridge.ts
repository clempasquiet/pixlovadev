/**
 * Pont de la page de lecture du renderer natif : messages vers l’hôte par l’IPC de la
 * WebView (wry), messages de l’hôte par `window.pixlova.receive`.
 */
import type { HostMessage, PageMessage } from '@pixlova/player-core';

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
