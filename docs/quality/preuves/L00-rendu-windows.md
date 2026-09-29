# Preuves L00 — rendu sous Windows (poste du responsable produit)

- Date des mesures : 2026-09-29 (20:50 et 21:01 UTC)
- Banc : `apps/render-lab` version 0.1.0, commit `52c259f`
- Opérateur : responsable produit, sur son poste personnel
- Nature : **mesure sur matériel réel**, un seul poste, un seul essai par runtime. Ce n’est pas encore une qualification de profil : il manque les éléments listés en fin de document.

## Environnement relevé

| Élément | Renderer natif (`pixlova-renderer`) | Navigateur |
|---|---|---|
| Runtime | WebView2 (Edge 154) via wry 0.57 | Brave (Chromium 154) |
| OS | Windows 10/11 x64 (l’agent utilisateur ne distingue pas les deux) | idem |
| GPU | Intel UHD Graphics 630 (Direct3D 11) | masqué par Brave |
| Threads CPU | 8 | 8 |
| Écran / fenêtre | 1920×1080, plein écran | écran 2560×1440, fenêtre 1920×951 (non plein écran) |
| Vidéo fournie | oui, 60 s par scénario | non (scénario vidéo ignoré) |

Fichiers bruts : [WebView2](donnees/L00-windows-webview2-uhd630.json), [Brave](donnees/L00-windows-brave.json).

## Résultats du renderer natif (WebView2)

| Scénario | Première image (ms) | Images/s | Intervalle p95 / max (ms) | Images vidéo perdues |
|---|---:|---:|---|---|
| video-loop (1920×1080) | 238 | 59,94 | 16,8 / 17,0 | **0 / 1797** |
| text-qr-clock | 50 | 59,94 | 16,8 / 17,2 | — |
| two-media-zones (image + vidéo) | 123 | 59,94 | 16,8 / 17,4 | 2 / 1797 |
| portrait-rotated (90°) | 86 | 59,94 | 16,8 / 20,0 | — |
| led-2688x672 (playlist en fondu) | 55 | 59,94 | 16,8 / 17,0 | — |
| led-3840x480 | 14 | 59,94 | 16,8 / 16,9 | — |
| led-768x2304 | 69 | 59,94 | 16,8 / 17,9 | — |

Aucune erreur, aucune saccade > 50 ms, aucune tâche longue. La vidéo tourne à environ 30 images/s (1797 images en 60 s) sans perte en plein écran.

Navigateur Brave (sans vidéo) : 6 scénarios à 59,94 images/s, p95 16,8 ms, aucune erreur.

## Erratum sur le support des codecs

Les fichiers de la version 0.1.0 du banc indiquent `decoding.supported: false` pour H.264 alors que la vidéo a été lue sans perte. La cause est une erreur du banc : les sondes H.264 déclaraient la vidéo **et** l’audio dans une seule configuration `MediaCapabilities`, que l’API refuse. Corrigé en 0.1.1 (une sonde par codec, AAC sondée séparément, test automatique). Pour ces fichiers, seule la colonne `can_play_type` (« probably » pour H.264 dans les deux runtimes) est exploitable. Les conclusions du [document de preuves en conteneur](L00-rendu-environnement-cloud.md) restent valables : `canPlayType` y renvoie aussi une chaîne vide pour H.264.

## Ce qui manque pour qualifier le profil Windows

1. Codec, résolution et débit de la vidéo utilisée (propriétés du fichier ou MediaInfo).
2. Nouvelle mesure avec le banc 0.1.1 (support des codecs fiable).
3. Charge CPU pendant la boucle vidéo (Gestionnaire des tâches) et confirmation du décodage matériel (colonne « Décodage vidéo » du GPU).
4. Observations visuelles : netteté, QR code scanné, heure de l’horloge, sens de la rotation portrait, absence de déchirure.
5. Modèle exact du poste et de la sortie (HDMI/DisplayPort, fréquence).
