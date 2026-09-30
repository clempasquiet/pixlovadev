# Protocole de qualification du rendu (REN-004)

Ce protocole produit les mesures nécessaires pour accepter l’[ADR-005](../architecture/adr/0005-renderer-natif-webview.md) et remplir la matrice de compatibilité (DEC-06). Il s’exécute **sur le matériel réel** : une mesure en conteneur ou en machine virtuelle ne qualifie aucun profil.

## Matériel et fichiers

- Une machine par profil candidat (ex. mini-PC Intel N100 sous Ubuntu 24.04, PC Windows 11), écran branché sur la sortie visée.
- Une vidéo **libre de droits** H.264/AAC 1080p30 (MP4, 30 s à 2 min) ; si possible une variante 2160p.
- Le dépôt au commit à qualifier.

## Préparer

```sh
corepack enable && pnpm install --frozen-lockfile
pnpm run build                                  # construit apps/render-lab/dist
cargo build --release -p pixlova-renderer       # Linux : paquets libwebkit2gtk-4.1-dev et libgtk-3-dev
```

Linux : installer aussi les décodeurs GStreamer, puis noter les versions :

```sh
sudo apt-get install gstreamer1.0-libav gstreamer1.0-plugins-good gstreamer1.0-plugins-bad gstreamer1.0-vaapi
gst-inspect-1.0 --version; vainfo | head -20
```

Windows : vérifier que le runtime WebView2 est installé (fourni avec Windows 11).

## Exécuter

Pour chaque runtime candidat, 60 secondes par scénario :

| Runtime | Commande |
|---|---|
| Renderer natif (WebKitGTK / WebView2) | `target/release/pixlova-renderer --lab-dir apps/render-lab/dist --video /chemin/video.mp4 --query "auto&duration=60" --out resultats-natif.json` |
| Navigateur (Player Web) | `pnpm --filter @pixlova/render-lab preview`, ouvrir l’URL affichée, choisir la vidéo, « Plein écran », « Lancer tous les scénarios », puis « Télécharger les résultats JSON » |

Pendant l’exécution, observer l’écran : défilement fluide de la vidéo, absence de déchirure ou de clignotement, texte net, QR code lisible par un téléphone, horloge à l’heure du fuseau attendu, rotation portrait dans le bon sens, bandeaux LED sans déformation.

## Rapporter

Pour chaque couple profil × runtime, joindre au ticket L06-N (ou à la PR de qualification) :

1. Le fichier JSON produit (environnement, codecs, mesures par scénario), avec un banc en version 0.1.1 ou ultérieure : la version 0.1.0 déclarait à tort H.264 non supporté par `MediaCapabilities`.
2. Une fiche remplie :

| Champ | Valeur |
|---|---|
| Machine (modèle, CPU, GPU, RAM) | |
| OS, version, serveur graphique (Wayland/X11) | |
| Pilote GPU, VA-API/DXVA actifs (oui/non, preuve) | |
| Runtime et version (WebKitGTK, WebView2, Chrome…) | |
| Sortie et mode (HDMI 1080p60, 4K30…) | |
| Vidéo testée (codec, résolution, débit) | |
| CPU moyen pendant la boucle vidéo (%) | |
| Images perdues / totales sur la boucle vidéo | |
| Observations visuelles et anomalies | |
| Durée de démarrage à froid jusqu’à la première image | |

3. Toute limite constatée (codec non supporté, format refusé, rotation incorrecte).

Les mesures d’endurance (72 h, TST-051), de coupure réseau (TST-030) et de redémarrage du renderer (TST-040) relèvent de L06-N, une fois l’agent, le watchdog et le cache implémentés.
