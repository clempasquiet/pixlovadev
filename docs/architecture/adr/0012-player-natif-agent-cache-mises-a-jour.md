# ADR-012 — Player natif : agent, cache, activation atomique, IPC, supervision et mises à jour

- Statut : acceptée pour la partie logicielle ; la qualification matérielle (Linux, Windows, HDMI, 24 h hors ligne) reste à mesurer selon la procédure [PLAYER-NATIF](../../quality/PLAYER-NATIF.md). Les valeurs marquées **[à valider]** relèvent du responsable produit.
- Date : 2026-09-30
- Ticket / lot : [L06-N #7](https://github.com/clempasquiet/pixlovadev/issues/7)
- Exigences concernées : PLY-004, PLY-005, PLY-007, NAT-001 à NAT-015, PROTO-002, PROTO-004, PROTO-012 à PROTO-014, SEC-012, TST-052, TST-053
- Décision remplaçant / remplacée par : complète l’[ADR-005](0005-renderer-natif-webview.md) (renderer WebView), l’[ADR-008](0008-appairage-players-displays.md) (appairage) et l’[ADR-011](0011-programmation-compilation-manifests.md) (manifests)

## Contexte

Le cloud produit des manifests signés par écran (L05). Le Player natif doit :

- les appliquer sans jamais lire un contenu incomplet ou corrompu ;
- continuer à diffuser hors ligne ;
- survivre aux crashs et aux coupures de courant ;
- se mettre à jour sans risque de rester bloqué sur une version défectueuse.

Le renderer (WebView système, ADR-005) ne doit détenir aucun secret.

## Décision

### Processus et comptes (NAT-001, NAT-003)

| Binaire | Rôle | Compte |
|---|---|---|
| `pixlova-launcher` | Choisit la version active, compte les démarrages, revient en arrière (A/B) | service système, utilisateur dédié `pixlova` |
| `pixlova-agent` | Identité, API Player, SQLite, cache, activation, IPC, supervision, mises à jour | lancé par le lanceur |
| `pixlova-renderer` | WebView plein écran, page de lecture, aucun secret | session kiosk du même utilisateur `pixlova` |

- Même utilisateur Unix pour l’agent et le renderer : l’IPC peut authentifier le pair par `SO_PEERCRED` et l’agent peut arrêter un renderer figé.
- Le renderer reste lancé par la session graphique (unité `systemd --user`, `Restart=always`) : l’agent n’a pas de droits graphiques.
- En développement (`--renderer spawn`), l’agent lance lui-même le renderer.
- **Windows** : service (agent) distinct d’une tâche planifiée à l’ouverture de la session kiosk (renderer), IPC par Named Pipe restreint au compte. La conception est documentée ; l’implémentation et sa qualification Windows restent à faire (hors de portée de l’environnement de développement actuel). Le renderer WebView2 est déjà mesuré (ADR-005).

### Bibliothèques (NAT-001)

- Tokio (asynchrone), Reqwest avec rustls (HTTPS), rusqlite en mode `bundled` (SQLite embarqué, version maîtrisée).
- Tracing, avec journaux quotidiens et 7 fichiers au plus.
- sha2 et ed25519-dalek, déjà utilisés par `pixlova-contracts` : aucune cryptographie maison.
- uuid, fs4 (espace disque), tar (paquets de mise à jour).

Toutes sont sous licences MIT, Apache-2.0 ou équivalent.

### Données locales (NAT-005, NAT-007)

Racine configurable. Défaut Linux : `/var/lib/pixlova`.

| Chemin | Contenu |
|---|---|
| `identity/device.key` | Graine Ed25519 de l’appareil, `0600`, créée au premier démarrage : chaque clone d’image crée sa propre identité |
| `pixlova.db` | SQLite en WAL |
| `cache/blobs/<sha256>` | Assets vérifiés, adressés par contenu |
| `cache/tmp/` | Téléchargements partiels |
| `logs/` | Journaux bornés |
| `run/agent.sock` | Socket IPC (`0600`) |

- **Tables SQLite** :
  - installation et association ;
  - manifests reçus (octets signés conservés) et état par Display (current, previous, staging, plus haute version et empreinte, génération) ;
  - journal d’intention d’activation ;
  - blobs, avec dernier usage ;
  - outbox des états de livraison à déclarer ;
  - mises à jour ;
  - écart d’horloge.
- **Migrations additives uniquement** : nouvelles tables, colonnes avec défaut. Chaque base porte le niveau de lecture minimal d’un agent capable de la lire (`min_reader_level`) ; un agent de niveau inférieur refuse de l’ouvrir. Avant toute migration, une copie de la base est conservée pour le retour arrière (NAT-015).
- Le jeton d’accès n’est jamais écrit sur disque : l’agent se réauthentifie par challenge (PROTO-002).
- Protection de la clé sous Windows par DPAPI : à implémenter avec le portage Windows.

### Confiance (PROTO-012)

- Les clés publiques des manifests et des releases sont installées avec le paquet (`trust/manifest-keys.json`, `trust/release-keys.json`), lui-même signé.
- Aucune route ni commande ne peut ajouter une clé.
- Les clés de release sont distinctes des clés de manifest et des clés d’appareil (NAT-013).

### Cache et téléchargements (NAT-008 étapes 3 à 5, NAT-009, NAT-010)

- Chaque asset est téléchargé via `GET /player/v1/assets/:id/url?manifest_id=` (URL courte), dans `cache/tmp/<sha256>.part`.
- Une reprise par `Range` n’a lieu que si le fichier partiel correspond au même SHA-256 attendu et à la même taille annoncée. Une URL expirée est redemandée.
- Taille et SHA-256 sont vérifiés sur le fichier complet, puis le fichier est renommé atomiquement. Un blob au contenu faux est supprimé et jamais servi.
- **Épinglage** : les blobs des manifests current, previous et staging de chaque Display, ainsi que ceux de leur fallback. Le nettoyage n’évince que les blobs non épinglés, du plus ancien usage au plus récent, au-delà du budget.
- **Disque** : avant chaque préparation, l’espace nécessaire plus une réserve de **512 Mo [à valider]** est exigé. Sinon la préparation est abandonnée, l’erreur `DISK_FULL` est déclarée et la diffusion courante continue. L’actif n’est jamais supprimé pour faire de la place.

### Activation atomique par Display (NAT-008, PROTO-013)

1. Le manifest est vérifié (`verify_manifest` : signature, schéma, cohérence), puis accepté par `evaluate_manifest_candidate`. Sont refusés : mauvaise organisation, mauvais Player, mauvais Display, génération périmée, version rejouée ou conflictuelle, fenêtre d’activation dépassée.
2. Il est enregistré comme `staging`, sans toucher `current`.
3. Tous les assets sont téléchargés et vérifiés dans le cache.
4. Le renderer prépare le candidat (`PREPARE`) : décodage des images, métadonnées vidéo, polices. Une erreur empêche la bascule.
5. Une intention `{display, old, new}` est écrite en base, puis `ACTIVATE` est envoyé.
6. L’activation n’est confirmée qu’au premier `FRAME_PRESENTED` du nouveau manifest, dans un délai de **30 s [à valider]**. La transaction de confirmation fait alors : previous ← current, current ← new, intention close, livraison `applied` placée dans l’outbox.
7. **Au démarrage**, toute intention ouverte est résolue :
   - si le renderer confirme le nouveau manifest, elle est finalisée ;
   - sinon, l’ancien manifest est réactivé et la livraison déclarée `failed` (`ACTIVATION_INTERRUPTED`).

   Le compteur de versions n’est jamais abaissé.
8. Pendant toute la préparation, la diffusion courante continue.
9. La bascule a lieu dès que la préparation est confirmée. Le renderer garde l’image précédente jusqu’à la première image du nouveau contenu : aucun écran noir en bascule normale.

### IPC agent ↔ renderer (NAT-006, SEC-012)

- Socket Unix `0600` dans `run/`, pair vérifié par `SO_PEERCRED` (même uid), une seule connexion renderer à la fois.
- Messages JSON par lignes, 16 Mio au plus. Enveloppe : `protocol_version`, `message_id`, `type`, `correlation_id`, `payload`.
  - Commandes : `LOAD_MANIFEST`, `PREPARE`, `ACTIVATE`, `GET_STATUS`, `RELOAD`.
  - Réponses et événements : `HELLO`, `READY`, `STATUS`, `ERROR`, `FRAME_PRESENTED`.
  - Tout type inconnu est refusé.
- Le renderer reçoit le manifest vérifié et la correspondance `asset_id → sha256`. Il sert les fichiers par le protocole `pixlova://asset/<sha256>` :
  - seulement depuis `cache/blobs` ;
  - seulement pour un SHA-256 présent dans un manifest chargé ;
  - traversées et liens sortants refusés.

  Il ne reçoit aucun jeton ni aucune URL cloud.
- La page de lecture (`apps/player-shell`) est construite avec le moteur partagé et sera réutilisée par le Player Web (L06-W). Elle exécute `selectAt` localement : les fins de créneaux et d’overrides sont respectées hors ligne (NAT-011, PROTO-014).

### Supervision (PLY-004)

- Le renderer envoie `STATUS` toutes les **5 s**.
- Sans message pendant **30 s [à valider]**, l’agent tue le processus (même utilisateur). La session le relance, ou l’agent lui-même en mode `spawn`.
- **Boucle de crashs** : au-delà de 5 redémarrages en 5 minutes, attente croissante jusqu’à 60 s, et état `degraded` déclaré.
- À chaque (re)connexion, l’agent renvoie le manifest current de chaque Display depuis SQLite : un renderer relancé hors ligne reprend sans le cloud.

### Horloge (NAT-012)

- L’écart avec l’heure serveur (heartbeat) est conservé.
- Au-delà de **5 min [à valider]**, une dérive est signalée.
- Une horloge antérieure à la date de construction du binaire est jugée invalide : aucune nouvelle activation n’est lancée, la diffusion déjà validée continue.

### Mises à jour et retour arrière (PLY-005, NAT-013 à NAT-015)

- **Métadonnées signées** : enveloppe `SIGNAGE_RELEASE_V1`, avec :
  - `release_id`, `version`, `os`, `arch` ;
  - `sha256` et `size` du paquet ;
  - `protocol_min` et `protocol_max`, `sqlite_schema`, `renderer_build`.

  La clé de release est vérifiée avant tout téléchargement ou extraction.
- **Paquet** : archive tar vérifiée (taille, SHA-256), extraite dans `versions/<version>.tmp` en refusant les chemins absolus ou sortants, puis renommée.
- **Lanceur A/B** (`state/launcher.json`) :
  - il démarre la version `pending` ;
  - l’agent écrit un marqueur de santé seulement après : SQLite ouverte, IPC prêt, renderer connecté, première image ou écran d’attente affiché. Un accès cloud n’est pas requis (NAT-014) ;
  - **3 démarrages sans santé, ou 2 min sans marqueur [à valider]**, provoquent le retour à la version précédente ;
  - la release est alors **bloquée localement** et ne sera pas réinstallée automatiquement. L’erreur est publiée à la reconnexion.
- **Base** : en cas de retour arrière, la copie d’avant migration n’est restaurée que si l’association (organisation, Player) y est identique à l’actuelle. Sinon la base courante, compatible grâce aux migrations additives, est conservée (NAT-015).
- **V1 = mise à jour manuelle** (`pixlova-agent update apply <dossier>`). La distribution par le cloud (`GET /player/v1/releases/desired`) et l’affichage des versions souhaitée et installée relèvent d’un lot ultérieur.

### Sorties et diagnostic

- **Linux** : sorties lues dans `/sys/class/drm/card*-*` (connecteur, `status`, mode préféré). Un HDMI débranché est remonté en `connected: false` au cloud (DSP-005).
- `pixlova-agent diagnose` produit un rapport JSON local, sans secret :
  - version, chemins, espace disque ;
  - identité, association ;
  - états par Display ;
  - blobs ;
  - renderer ;
  - dérive d’horloge ;
  - dernières erreurs.

## Conséquences

- La logique métier de sélection reste au cloud et dans le moteur partagé : l’agent ne décide jamais du contenu, il garantit l’intégrité et l’atomicité.
- Le même utilisateur pour l’agent et le renderer simplifie l’IPC et la supervision, au prix d’une séparation par processus plutôt que par compte. Le renderer n’a toujours ni clé ni jeton.
- Windows exige un portage (Named Pipe, DPAPI, service, tâche planifiée) avant sa qualification.

## Vérification

- **Tests Rust** :
  - identité ;
  - migrations et compatibilité de lecture ;
  - cache : partiel, checksum faux, troncature, reprise ;
  - manifests corrompus, non signés, d’un autre Player ;
  - activation interrompue à chaque étape par injection de panne ;
  - disque plein ;
  - IPC : pair, taille, type inconnu ;
  - paquet non signé, altéré ou sortant du dossier ;
  - lanceur (3 échecs, délai, blocage) ;
  - restauration conditionnelle de la base.
- **Bout en bout** : l’agent réel est lancé contre l’API et le worker réels, avec un renderer de test. Parcours : appairage, heartbeat réel, manifest publié, préparation, première image, appliqué, coupure réseau et diffusion continue.
- **Renderer réel sous Xvfb** : chargement d’un manifest et première image.
- **Matériel** : procédure dans `docs/quality/PLAYER-NATIF.md` (Linux, Windows, HDMI, 24 h hors ligne, coupure de courant).
