/** Écrans d’information hors diffusion : appairage, révocation, attente. */
import type { Notice } from './bridge.js';

export function renderNotice(root: HTMLElement, notice: Notice | null): void {
  if (!notice) {
    root.hidden = true;
    root.replaceChildren();
    return;
  }
  const line = (className: string, text: string) => {
    const element = document.createElement('div');
    element.className = className;
    element.textContent = text;
    return element;
  };
  switch (notice.kind) {
    case 'pairing':
      root.replaceChildren(
        line('title', 'Code d’appairage'),
        line('code', notice.pairing_code),
        line('hint', 'Dans pixlova, ouvrez Players → Appairer un Player et saisissez ce code.'),
      );
      break;
    case 'revoked':
      root.replaceChildren(
        line('title', 'Ce Player a été retiré de son organisation.'),
        line('hint', 'Un nouveau code d’appairage va s’afficher.'),
      );
      break;
    case 'waiting':
      root.replaceChildren(
        line('title', 'Player appairé'),
        line('hint', 'En attente d’un écran affecté et de sa programmation.'),
      );
      break;
  }
  root.hidden = false;
}
