/** Images de mire générées localement (aucun téléchargement) : dégradé, grille et libellé. */
import { ASSETS } from './scenarios.js';

async function mire(width: number, height: number, label: string, hue: number): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, `hsl(${hue} 70% 35%)`);
  gradient.addColorStop(1, `hsl(${(hue + 120) % 360} 70% 25%)`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
    ctx.stroke();
  }
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, width - 6, height - 6);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold ${Math.round(Math.min(width, height) / 8)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${label} ${width}×${height}`, width / 2, height / 2);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'),
  );
  return URL.createObjectURL(blob);
}

export async function generateAssets(video: File | null): Promise<Map<string, string>> {
  const urls = new Map<string, string>([
    [ASSETS.landscape, await mire(1920, 1080, 'Paysage', 200)],
    [ASSETS.portrait, await mire(1080, 1920, 'Portrait', 20)],
    [ASSETS.banner, await mire(2688, 672, 'LED', 280)],
  ]);
  if (video) urls.set(ASSETS.video, URL.createObjectURL(video));
  return urls;
}
