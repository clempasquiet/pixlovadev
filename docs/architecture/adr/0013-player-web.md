# ADR-013 — Player Web : identité navigateur, cache vérifié et limites assumées

- Statut : acceptée pour la partie logicielle ; la matrice navigateur/OS reste à mesurer sur matériel selon [PLAYER-WEB](../../quality/PLAYER-WEB.md). Les valeurs marquées **[à valider]** relèvent du responsable produit.
- Date : 2026-09-30
- Ticket / lot : [L06-W #8](https://github.com/clempasquiet/pixlovadev/issues/8)
- Exigences concernées : PLY-006, PLY-007, WEBPLY-001 à WEBPLY-005, PROTO-001 à PROTO-004, PROTO-012 à PROTO-014, SEC-012, TST-043
- Décision remplaçant / remplacée par : complète l’[ADR-012](0012-player-natif-agent-cache-mises-a-jour.md) (Player natif) et l’[ADR-008](0008-appairage-players-displays.md) (appairage)

## Contexte

Le Player Web doit utiliser le même modèle que le natif : Display, appairage, manifests signés, contenus compatibles.

Il s’exécute pourtant dans un navigateur :

- l’identité dépend du profil ;
- le stockage peut être évincé ;
- l’onglet peut être fermé ou suspendu ;
- le plein écran et l’autoplay dépendent d’une action utilisateur ou d’une politique kiosk.

Il ne doit jamais être présenté comme équivalent au service natif.

## Décision

### Application et déploiement

- `apps/web-player` est une application statique servie en HTTPS. Elle est construite avec Vite et le moteur de rendu partagé.
- La lecture d’un Display est celle du renderer natif. Elle est extraite dans `@pixlova/player-core` (préparation, bascule, planification locale, écrans d’information) : aucune logique de priorité n’est dupliquée.
- **Déploiement recommandé : même origine que l’API.** `/player/v1` et le stockage local sont servis par le même proxy : aucun CORS n’est nécessaire.
- **Autre origine** : `PIXLOVA_WEB_PLAYER_ORIGINS` autorise une liste d’origines.
  - Le CORS s’applique aux seules routes `/player/v1`, sans cookie ni credentials, pour les en-têtes `authorization`, `content-type` et `if-none-match`, avec `etag` exposé.
  - Un stockage S3 devra alors autoriser la même origine en lecture (configuration L09-I).
- En développement, le serveur Vite relaie `/player/v1` et `/storage` vers l’API.

### Identité (WEBPLY-001)

- À la première ouverture, le navigateur crée un **UUID d’installation** et une **paire Ed25519**, conservés dans IndexedDB.
- Quand le navigateur prend en charge Ed25519 dans WebCrypto, la clé privée est **non extractible** : IndexedDB conserve l’objet `CryptoKey`, jamais ses octets.
- Sinon, la graine est générée et conservée par la page (`@noble/curves`). Cette protection est moindre ; elle est signalée dans la matrice.
- Effacer les données du site ou changer de profil crée une **nouvelle installation** : un nouvel appairage est nécessaire, par exemple avec le remplacement de l’ancien Player.
- Aucune empreinte matérielle n’est collectée.
- Le jeton d’accès reste en mémoire. Après un rechargement, la page se réauthentifie par challenge signé (PROTO-002).

### Confiance (PROTO-012)

- Les clés publiques des manifests sont livrées avec l’application : `trust/manifest-keys.json` est servi avec les fichiers de la version et précaché.
- Leur confiance est celle du code de l’application lui-même ; aucune route ne peut en ajouter.
- Chaque manifest est vérifié par `verifyManifest`, puis accepté par `evaluateManifestCandidate`, les mêmes fonctions que la preview et que les vecteurs partagés avec Rust.

### Stockage (WEBPLY-002, PLY-007)

| Donnée | Emplacement |
|---|---|
| Installation, clé, association, Displays, manifests reçus (enveloppes signées), outbox des états de livraison | IndexedDB `pixlova-player` |
| Assets vérifiés | Cache API `pixlova-assets-v1`, clé = SHA-256 |
| Application (HTML, JS, CSS, polices, clés de confiance) | Cache du service worker, par version |

- **Assets** :
  - téléchargés entièrement, puis contrôlés (taille, SHA-256 par `SubtleCrypto`) avant l’écriture dans le cache ; un contenu faux n’est jamais écrit ;
  - recontrôlés une fois par session avant leur première présentation ;
  - présentés à la lecture par des URL `blob:` créées depuis le cache, jamais par l’URL du stockage.
- **Épinglage** : assets des manifests courant, précédent et candidat. Les autres sont évincés du plus ancien usage au plus récent.
- **Quota** :
  - avant chaque préparation, l’espace requis est comparé à `navigator.storage.estimate()`, au-delà d’une marge de **10 % du quota [à valider]** ;
  - sinon, les assets non épinglés sont évincés ;
  - à défaut, la préparation échoue avec `STORAGE_QUOTA_EXCEEDED` et la diffusion courante continue ;
  - une `QuotaExceededError` pendant l’écriture a le même effet.
- **Persistance** : `navigator.storage.persist()` est demandé au démarrage. Le résultat (`granted` ou `denied`) est remonté dans les capacités et affiché.

### Activation (PLY-007)

La chaîne est identique à celle du natif, dans la même page :

1. vérification ;
2. staging ;
3. assets complets et vérifiés ;
4. préparation par `player-core` (décodage, polices) ;
5. activation ;
6. première image ;
7. puis, seulement, current ← candidat et livraison `applied`.

Une préparation incomplète laisse le dernier manifest valide à l’écran et remonte sa cause.

### Cycle de vie et hors ligne (WEBPLY-002, WEBPLY-004)

- Un **service worker** précache l’intégralité d’une version de l’application : fichiers produits par le build, clés de confiance.
- Après un rechargement hors ligne, la page reprend le manifest courant depuis IndexedDB et le cache d’assets.
- **Mise à jour de l’application** :
  - une nouvelle version s’installe en arrière-plan, complète ;
  - elle ne prend la main qu’au chargement suivant (pas de `skipWaiting` pendant une lecture) : les bundles de deux versions ne sont jamais mélangés.
- La page active porte la lecture. Le service worker peut être interrompu par le navigateur : il ne sert que l’application hors ligne.
- Quand la page est masquée, les timers peuvent être ralentis : le heartbeat déclare le renderer `degraded`.
- L’API Wake Lock est demandée quand elle existe.

### Plein écran et audio (WEBPLY-003)

- Un écran de démarrage demande une action : « Démarrer la diffusion ». Elle active le plein écran et autorise l’audio.
- Les vidéos sont lues muettes, sauf son autorisé.
- Un plein écran ou un autoplay refusé est affiché avec la marche à suivre.
- En kiosk, les options du navigateur sont documentées (Chrome `--kiosk --autoplay-policy=no-user-gesture-required`) ; aucune n’est présumée.

### Capacités (WEBPLY-005)

- `player_type: web`, une sortie `browser` à la taille de l’écran.
- `multi_output`, `screenshot`, `volume_control`, `reboot_host` : `unsupported`.
- `video_profiles` : selon `canPlayType`.
- `persistent_storage` et `storage_quota_bytes` : mesurés.
- Une valeur inconnue reste `unknown`, jamais un succès.

## Conséquences

- Aucune garantie de 24 h hors ligne ne peut être donnée universellement. La procédure TST-043 publie les résultats par navigateur et OS, avec leurs préconditions : amorçage complet, persistance accordée, onglet ouvert.
- La protection de la clé dépend du navigateur (WebCrypto Ed25519).
- Un effacement de profil équivaut à une perte d’identité.

## Vérification

- **Chromium réel** (`apps/web-player/test/web-player.browser.test.ts`), contre l’API, le worker et PostgreSQL réels :
  - appairage par le code affiché, activation complète, état « appliqué » visible au dashboard ;
  - asset altéré en transit refusé (`CHECKSUM_MISMATCH`), contenu courant conservé, puis reprise ;
  - manifest altéré refusé (`SIGNATURE_INVALID`) ;
  - fermeture et réouverture sans nouvel appairage ;
  - rechargement hors ligne après amorçage, servi par le service worker ;
  - quota plein (`STORAGE_QUOTA_EXCEEDED`), contenu courant conservé ;
  - données du site effacées : nouvelle installation ; clé non extractible.
- **Isolation** : un manifest d’un autre Player, d’une autre organisation ou d’une génération périmée est refusé par `evaluateManifestCandidate`, couverte par les vecteurs partagés avec Rust ; l’API n’accepte que le jeton du Player (tests de l’API).
- **Tests unitaires** : politique d’éviction et de quota, capacités déclarées (validées par le schéma).
- **Matrice** : [PLAYER-WEB](../../quality/PLAYER-WEB.md).
