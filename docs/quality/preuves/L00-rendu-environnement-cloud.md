# Preuves L00 — rendu en environnement cloud (sans matériel)

- Date : 2026-09-29
- Commit : branche `claude/charming-cori-ha2tmb`, lot L00
- Nature : **tests automatisés en conteneur**. Aucune sortie vidéo physique, aucun GPU réel (rendu logiciel SwiftShader / llvmpipe). Ces résultats **ne qualifient aucun profil matériel**.

## Environnement

- Ubuntu 24.04 (conteneur), 4 vCPU, Xvfb 1920×1080×24 pour la WebView.
- Chromium 141.0.7390.37 headless (Playwright 1.56.1), WebGL : SwiftShader.
- WebKitGTK 2.52.6 via `pixlova-renderer` (wry 0.57, tao 0.37), sans plugins GStreamer `libav`.

## Procédure

```sh
pnpm run build
pnpm --filter @pixlova/render-lab run test:browser        # Chromium headless, 9 tests
cargo build -p pixlova-renderer
xvfb-run -a -s "-screen 0 1920x1080x24" target/debug/pixlova-renderer \
  --lab-dir apps/render-lab/dist --query "auto&duration=3" --out webkitgtk-xvfb.json
```

## Résultats

Géométrie (Chromium headless, fenêtre 1920×1080) : pour les 6 scénarios sans vidéo, la scène occupe exactement l’emprise calculée par `stageTransform` (écart < 0,5 px) ; dans le bandeau 2688×672, le titre est placé à (1660, 40) × échelle, à moins de 0,5 px près ; texte Unicode (« — », « « », « é », emoji) affiché tel quel ; QR code généré ; ordre de profondeur respecté.

| Scénario | Chromium : première image (ms) | WebKitGTK/Xvfb : première image (ms) | WebKitGTK : images/s, p95 (ms) |
|---|---:|---:|---|
| text-qr-clock | mesuré, non conservé | 14 | 61,6 ; 17 |
| two-media-zones | mesuré, non conservé | 35 | 61,7 ; 17 |
| portrait-rotated | mesuré, non conservé | 20 | 61,7 ; 17 |
| led-2688x672 | mesuré, non conservé | 35 | 61,4 ; 17 |
| led-3840x480 | mesuré, non conservé | 14 | 60,9 ; 17 |
| led-768x2304 | mesuré, non conservé | 30 | 58,4 ; 26 |

La boucle vidéo n’a pas été exécutée : aucune vidéo H.264 n’est disponible dans le conteneur, et aucun des deux runtimes n’y décode H.264.

Support déclaré des codecs :

| Profil | Chromium libre (Playwright) | WebKitGTK sans gst-libav |
|---|---|---|
| H.264 Baseline/Main/High 1080p | non | non |
| H.264 High 2160p | non | non |
| HEVC 2160p | non | non |
| VP9 1080p | oui (smooth) | oui (smooth) |
| AV1 1080p | oui (smooth) | non |

## Limites

- La fenêtre WebKitGTK est restée en 800×600 : sans gestionnaire de fenêtres, Xvfb n’applique pas le plein écran. La géométrie en WebKitGTK n’a donc pas été vérifiée au pixel près ; elle l’est en Chromium.
- WebKit masque le nom du GPU (`Apple GPU`) : le relever par `vainfo` ou `glxinfo` sur la machine.
- Un défaut a été corrigé pendant ces essais : un texte trop long centré verticalement était rogné en haut ; le centrage est désormais `safe`.
