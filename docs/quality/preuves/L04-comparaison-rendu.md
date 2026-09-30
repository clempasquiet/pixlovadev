# L04 — Même composition dans la preview, le Player Web et le prototype natif

Preuve du premier critère de recette de L04 ([#5](https://github.com/clempasquiet/pixlovadev/issues/5)) et de l’[ADR-010](../../architecture/adr/0010-compositions-editeur-templates.md). Date : 2026-09-29, environnement de développement cloud (conteneur Linux, sans GPU).

## Ce qui est comparé

Cinq compositions de référence (`apps/render-lab/src/fixtures.ts`) :

| Composition | Format | Contenu |
|---|---|---|
| `paysage-1920x1080` | Paysage | Texte multiligne, formes (ellipse avec bordure, rectangle arrondi transparent), images `contain` et `cover`, QR Code, horloge, texte tourné à −8° |
| `portrait-1080x1920` | Portrait | Playfair Display, Open Sans, Roboto Mono, image `cover`, QR Code |
| `led-2688x672` | Bandeau LED | Texte de 200 px en Montserrat 900, formes arrondies |
| `led-3840x480` | Bandeau très large | Ligne unique en Roboto, horloge, date longue |
| `totem-768x2304` | Totem LED vertical | Textes empilés, image `contain`, texte tourné à 90° débordant du canvas |

Chaque composition passe par le même moteur (`@pixlova/render-engine`), rendue à l’échelle 1, avec des horloges figées au 15 janvier 2026 à 10:30 UTC, en fuseau `Europe/Paris`. Le mode `measure` du banc relève :

- la boîte englobante de chaque élément, comparée à `elementBounds` (géométrie calculée par le moteur, rotation comprise) ;
- le chargement effectif des polices qualifiées empaquetées ;
- le nombre de lignes de chaque texte non tourné ;
- le texte affiché par chaque horloge.

| Hôte | Moteur | Rôle |
|---|---|---|
| Chromium 141 headless (Playwright) | Blink | Preview du dashboard, Player Web, WebView2 du natif Windows |
| `pixlova-renderer` (prototype natif, `native/renderer`) sous Xvfb | WebKitGTK 2.52.6 | Renderer natif Linux |

## Résultat

```
Référence : Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.7390.37 Safari/537.36
Candidat : Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/60.5 Safari/605.1.15
```

| Composition | Éléments | Écart max. Chromium | Écart max. WebKitGTK | Textes au même nombre de lignes | Polices chargées |
|---|---:|---:|---:|---:|---:|
| paysage-1920x1080 | 10 | 0 px | 0 px | 2/2 | 4/4 |
| portrait-1080x1920 | 6 | 0 px | 0 px | 3/3 | 3/3 |
| led-2688x672 | 4 | 0 px | 0 px | 2/2 | 1/1 |
| led-3840x480 | 3 | 0 px | 0 px | 1/1 | 2/2 |
| totem-768x2304 | 5 | 0 px | 0 px | 2/2 | 3/3 |

Les deux moteurs affichent les mêmes horloges (« 11:30 », « jeudi 15 janvier 2026 ») et décodent toutes les images. Résultat : **identique, tolérance 1 px**. Relevés bruts : [Chromium](donnees/L04-mesure-chromium.json) et [WebKitGTK](donnees/L04-mesure-webkitgtk.json).

La comparaison s’exécute à chaque changement dans la CI (job « Rendu natif WebKitGTK ») et échoue dans chacun de ces cas :

- écart de plus de 1 px ;
- nombre de lignes différent ;
- horloge différente ;
- police non chargée ;
- image non décodée.

J’ai vérifié ce refus sur un relevé volontairement altéré (police, ligne, écart de 3,5 px) : trois écarts signalés, code de sortie 1.

## Limites

- **Géométrie et mise en page, pas pixels.** Le relevé compare les boîtes et le découpage des lignes, pas l’anticrénelage ni le rendu subpixel du texte, qui diffèrent légitimement entre moteurs. Il ne remplace pas l’observation visuelle du protocole de qualification sur l’écran réel.
- **Sans GPU ni sortie physique** : Xvfb et le rendu logiciel ne qualifient aucun matériel (REN-004).
- **WebView2 (Windows)** : même moteur que Chromium, mais non mesuré dans ce conteneur. La procédure est ci-dessous ; le responsable produit peut l’exécuter sur son PC de qualification.
- **Player Web** : il n’existe pas encore (L06-W). Il réutilisera ce moteur DOM ; le relevé Chromium en couvre donc le rendu, pas le cycle de vie navigateur.

## Rejouer sur un poste

```sh
pnpm install --frozen-lockfile && pnpm --filter @pixlova/render-lab... run build
pnpm --filter @pixlova/render-lab exec vitest run test/measure.browser.test.ts    # Chromium → test-results/measure-chromium.json
cargo build -p pixlova-renderer
target/debug/pixlova-renderer --lab-dir apps/render-lab/dist --query measure --out mesure-natif.json --windowed
pnpm --filter @pixlova/render-lab run compare-render "$PWD/apps/render-lab/test-results/measure-chromium.json" "$PWD/mesure-natif.json"
```

Sous Windows (WebView2), utiliser `target\debug\pixlova-renderer.exe` avec les mêmes options, puis joindre `mesure-natif.json` au ticket.
