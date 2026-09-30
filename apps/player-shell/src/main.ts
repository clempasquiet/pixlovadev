/**
 * Page de lecture pixlova : une instance par Display (fenêtre du renderer natif). Elle
 * exécute localement le manifest vérifié reçu de l’hôte : les fins de créneaux et
 * d’overrides sont respectées sans le cloud (NAT-011, PROTO-014).
 */
import '@pixlova/render-engine/fonts.css';
import { post, type HostMessage } from './bridge.js';
import { renderNotice } from './notice.js';
import { DisplayPlayer } from './player.js';

const surface = document.querySelector<HTMLElement>('#surface')!;
const noticeRoot = document.querySelector<HTMLElement>('#notice')!;
let player: DisplayPlayer | null = null;

function receive(message: HostMessage): void {
  switch (message.type) {
    case 'configure': {
      if (player) player.configure(message.display, message.asset_base);
      else player = new DisplayPlayer(surface, message.display, message.asset_base);
      renderNotice(noticeRoot, message.display ? null : message.notice);
      if (!message.display) {
        // L’écran d’information est affiché : première image de cette fenêtre.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => post({ type: 'frame', manifest_id: null })),
        );
      }
      break;
    }
    case 'prepare':
      void player?.prepare(message.manifest_id, message.manifest, message.assets);
      break;
    case 'activate':
      player?.activate(message.manifest_id);
      break;
  }
}

window.pixlova = { receive };
post({ type: 'loaded' });
