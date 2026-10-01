// Comportements du site public, sans dépendance : menu mobile, calculateur de tarifs et
// dessin du mur LED. Sans JavaScript, les pages restent complètes et navigables.
(() => {
  document.documentElement.classList.add('js');

  // Menu mobile
  const toggle = document.querySelector('.menu-toggle');
  const nav = document.getElementById('navigation');
  if (toggle && nav) {
    const setOpen = (open) => {
      nav.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    toggle.addEventListener('click', () => setOpen(!nav.classList.contains('open')));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && nav.classList.contains('open')) {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  // Calculateur : les devis sont calculés au build, une valeur par nombre d’écrans.
  for (const calc of document.querySelectorAll('.calc[data-quotes]')) {
    const quotes = JSON.parse(calc.getAttribute('data-quotes') || '[]');
    const input = calc.querySelector('input[type="range"]');
    const count = calc.querySelector('.count');
    const result = calc.querySelector('.eq');
    if (!input || !count || !result) continue;
    const update = () => {
      const n = Number(input.value);
      count.textContent = `${n} écran${n > 1 ? 's' : ''}`;
      input.setAttribute('aria-valuetext', count.textContent);
      result.textContent = quotes[n - 1] || '';
    };
    input.addEventListener('input', update);
    update();
  }

  // Mur LED : texte rendu dans une matrice de points (suréchantillonnée).
  const canvas = document.querySelector('canvas.led');
  if (!canvas) return;
  const PINK = '#e9457f';
  const draw = () => {
    const width = canvas.clientWidth;
    if (!width) return;
    const mobile = width < 600;
    const pitch = mobile ? 3.2 : 6.4;
    const cols = Math.floor(width / pitch);
    const rows = mobile ? 46 : 52;
    const S = 4;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(rows * pitch * dpr);
    canvas.style.height = `${rows * pitch}px`;

    const off = document.createElement('canvas');
    off.width = cols * S;
    off.height = rows * S;
    const x = off.getContext('2d');
    if (!x) return;
    x.scale(S, S);
    x.fillStyle = '#000';
    x.fillRect(0, 0, cols, rows);
    const RED = '#ff0000';
    const GREEN = '#00ff00';
    const L = 2;
    const R = cols - 2;
    const fit = (text, weight, family, max, maxWidth) => {
      let size = max;
      for (; size > 4; size -= 0.25) {
        x.font = `${weight} ${size}px ${family}`;
        if (x.measureText(text).width <= maxWidth) break;
      }
    };
    const display = '"Archivo", sans-serif';
    const mono = '"IBM Plex Mono", monospace';
    if (!mobile) {
      x.fillStyle = GREEN;
      x.font = `500 8px ${mono}`;
      x.fillText('SERVICE DU MIDI  11:30-14:30', L, 9);
      x.fillStyle = RED;
      fit('PLAT DU JOUR', 800, display, 30, cols - 4);
      x.fillText('PLAT DU JOUR', L, 35);
      x.fillStyle = GREEN;
      x.font = `700 11px ${display}`;
      x.fillText('RISOTTO AUX CÈPES', L, 49);
      x.fillStyle = RED;
      x.textAlign = 'right';
      x.fillText('14,50 €', R, 49);
    } else {
      x.fillStyle = GREEN;
      x.font = `500 7px ${mono}`;
      x.fillText('MIDI 11:30-14:30', L, 8);
      x.fillStyle = RED;
      fit('PLAT DU JOUR', 800, display, 22, cols - 4);
      x.fillText('PLAT DU JOUR', L, 29);
      x.fillStyle = GREEN;
      x.font = `700 9px ${display}`;
      x.fillText('RISOTTO', L, 42);
      x.fillStyle = RED;
      x.textAlign = 'right';
      x.fillText('14,50 €', R, 42);
    }

    const data = x.getImageData(0, 0, cols * S, rows * S).data;
    const line = cols * S;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, rows * pitch);
    const radius = pitch * 0.38;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        let red = 0;
        let green = 0;
        for (let a = 0; a < S; a++) {
          for (let b = 0; b < S; b++) {
            const k = ((j * S + a) * line + (i * S + b)) * 4;
            red += data[k];
            green += data[k + 1];
          }
        }
        red /= S * S * 255;
        green /= S * S * 255;
        g.beginPath();
        g.arc(i * pitch + pitch / 2, j * pitch + pitch / 2, radius, 0, Math.PI * 2);
        if (red > 0.3) {
          g.fillStyle = PINK;
          g.shadowColor = 'rgba(233, 69, 127, 0.85)';
          g.shadowBlur = pitch;
        } else if (green > 0.42) {
          g.fillStyle = '#fffff2';
          g.shadowColor = 'rgba(255, 255, 242, 0.55)';
          g.shadowBlur = pitch;
        } else {
          g.fillStyle = '#1f1f1d';
          g.shadowBlur = 0;
        }
        g.fill();
      }
    }
    canvas.dataset.drawn = 'true';
  };

  let lastWidth = 0;
  let timer = 0;
  const redraw = () => {
    if (canvas.clientWidth === lastWidth) return;
    lastWidth = canvas.clientWidth;
    draw();
  };
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = window.setTimeout(redraw, 150);
  });
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(() => {
    Promise.all([
      document.fonts?.load(`800 30px "Archivo"`),
      document.fonts?.load(`500 8px "IBM Plex Mono"`),
    ]).finally(redraw);
  });
})();
