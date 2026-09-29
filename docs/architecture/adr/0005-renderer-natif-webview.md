# ADR-005 — Moteur de rendu partagé et runtime du renderer natif

- Statut : **proposée** — acceptation après les mesures matérielles du [protocole de qualification](../../quality/QUALIFICATION-RENDU.md)
- Date : 2026-09-29
- Ticket / lot : [L00 #1](https://github.com/clempasquiet/pixlovadev/issues/1), suite L04 et L06-N
- Exigences concernées : NAT-001, NAT-002, NAT-006, REN-001 à REN-004, SEC-012, PLY-004, PROD-002, DEC-06, DEC-07
- Décision remplaçant / remplacée par : —

## Problème et contraintes

Le même document de composition doit produire un rendu cohérent en prévisualisation, dans le Player Web et dans le renderer natif (REN-001). Le renderer natif est un processus séparé de l’agent, sans credentials cloud (SEC-012), capable de décoder H.264/AAC (REN-003), de gérer les formats atypiques et la rotation (PROD-002), sous Linux et Windows. NAT-002 impose un prototype mesuré avant de choisir entre WebView/Chromium et moteur GPU.

## Proposition

1. **Moteur unique en TypeScript** (`packages/render-engine`) : calculs de mise en page déterministes (`fitRect`, `stageTransform`, `renderOrder`), sélection temporelle depuis un manifest vérifié (`selectAt`, `playlistPosition`) et rendu DOM (`@pixlova/render-engine/dom`). Aucun HTML ni script du document n’est interprété : texte par `textContent`, propriétés typées uniquement.
2. **Renderer natif = hôte WebView système** (`native/renderer`, crate `pixlova-renderer`, wry/tao) : **WebKitGTK** sous Linux, **WebView2** sous Windows. Les fichiers sont servis par le protocole local `pixlova`, limité à une racine (refus des traversées, encodages, séparateurs Windows et liens symboliques sortants), avec support des requêtes `Range` pour la vidéo. Aucun port réseau n’est ouvert. Les résultats remontent par IPC borné.
3. **Solution de repli** si la qualification échoue sur un profil cible (décodage H.264 matériel absent, performances insuffisantes) : runtime Chromium avec codecs propriétaires embarqué (CEF ou Electron), même moteur TypeScript et même protocole local.
4. L’IPC agent ↔ renderer (Unix socket / Named Pipe, NAT-006), le watchdog et la préparation/activation atomique relèvent de L06-N. Le prototype ne contient ni agent, ni cache, ni clé.

## Preuves disponibles (environnement cloud, sans matériel)

Détail : [preuves L00 — rendu en environnement cloud](../../quality/preuves/L00-rendu-environnement-cloud.md).

- Chromium headless (Playwright 1.56.1, Chromium 141) : les 6 scénarios sans vidéo sont rendus sans erreur ; positions de la scène et des éléments conformes au calcul au pixel près ; **H.264 et HEVC non décodés** (Chromium libre sans codecs propriétaires), VP9 et AV1 oui.
- `pixlova-renderer` sous WebKitGTK 2.52 (Xvfb, rendu logiciel) : 6 scénarios rendus, environ 60 images/s, p95 17–26 ms ; **H.264 non décodé faute de plugins GStreamer** dans le conteneur.

Conséquence déjà établie : un Chromium libre ne suffit pas pour H.264. Sous Linux, WebKitGTK exige GStreamer avec `gst-libav` et, pour l’accélération, VA-API ; l’installation du Player doit l’imposer et la qualification doit le mesurer.

## Options évaluées

| Option | Atouts | Risques à mesurer |
|---|---|---|
| WebView système via wry (proposée) | Binaire léger, mises à jour de sécurité du moteur par l’OS (WebView2), protocole local natif | Linux : dépendance à la version WebKitGTK/GStreamer de la distribution, performances vidéo et GPU variables |
| Chromium avec codecs (CEF/Electron) | Comportement identique Linux/Windows, H.264 intégré, outils de mesure | Taille (~150 Mo), patchs de sécurité à livrer nous-mêmes, licences codecs à vérifier |
| Chrome/Chromium du système en mode kiosk | Aucun moteur à livrer | Serveur local nécessaire pour les assets, contrôle de version et d’isolation faibles |
| Moteur GPU natif (wgpu, Skia) | Contrôle total, déterminisme | Réimplémentation du texte, de la vidéo et de la preview ; hors budget V1 |

## Conditions d’acceptation

L’ADR passe « acceptée » quand, pour chaque profil cible (au minimum Linux x86-64 Debian/Ubuntu avec GPU Intel, et Windows x86-64), le protocole de qualification fournit : décodage H.264 1080p accéléré sans perte significative d’images, boucle vidéo stable, scénarios de composition et formats LED, démarrage et reprise mesurés, limites connues. Sinon, l’option de repli est retenue pour le profil concerné et consignée ici.
