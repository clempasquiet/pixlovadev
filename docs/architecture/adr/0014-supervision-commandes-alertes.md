# ADR-014 — Supervision, commandes, captures, alertes et observabilité

- Statut : acceptée. Les valeurs marquées **[à valider]** relèvent du responsable produit (DEC-11 pour les rétentions).
- Date : 2026-09-30
- Ticket / lot : [L07 #9](https://github.com/clempasquiet/pixlovadev/issues/9)
- Exigences concernées : PROD-006, SUP-001 à SUP-008, PROTO-007, PROTO-008, PROTO-019, OBS-001 à OBS-003, OBS-010 à OBS-012, OBS-020, OBS-021, TST-023
- Décision remplaçant / remplacée par : complète l’[ADR-008](0008-appairage-players-displays.md) (présence), l’[ADR-011](0011-programmation-compilation-manifests.md) (livraisons), l’[ADR-012](0012-player-natif-agent-cache-mises-a-jour.md) et l’[ADR-013](0013-player-web.md) (Players)

## Contexte

Les Players natif et Web diffusent, déclarent leurs livraisons et envoient un heartbeat HTTP. Il manque de quoi voir le parc et agir dessus sans confondre les signaux :

- présence ;
- santé du Player ;
- rendu ;
- sortie branchée ;
- dalle réellement visible.

Il faut aussi agir à distance de façon sûre et être prévenu sans bruit.

## Décision

### Signaux distincts (PROD-006, SUP-001, OBS-003)

La fiche d’un Display ne résume jamais son état en un voyant unique. Elle présente, chacun avec son horodatage et son caractère actuel ou ancien :

| Signal | Source | Ce qu’il ne prouve pas |
|---|---|---|
| Présence | Heure serveur du dernier heartbeat authentifié ; hors ligne après **90 s** (SUP-002) | Qu’aucune image n’est diffusée : le cache peut continuer |
| Santé du Player | Dernier statut : état du renderer, versions, disque, cache, mémoire | Que la sortie affiche quelque chose |
| Rendu | Lecture déclarée par Display (`playing`, `fallback`, `standby`, `error`, `unknown`) et manifest appliqué | Que la dalle est allumée |
| Sortie | Connecteur `connected` (`true`, `false` ou `null` inconnu) | Que la dalle est visible ou allumée |
| Capture | Image du renderer, datée | Un flux direct, ou que la dalle est visible |

Une valeur indisponible, par exemple sur le Player Web, reste « non disponible », jamais zéro.

### Transport (PROTO-005 à PROTO-008)

- **V1 de ce lot : HTTPS seulement**, avec les routes de repli prévues par la spec :
  - `GET /player/v1/commands` ;
  - `POST /player/v1/commands/:id/ack` et `/result` ;
  - `POST /player/v1/events`, `/status` ;
  - `POST /player/v1/screenshots/upload-session` et `/screenshots/:id/complete`.
- La réponse du heartbeat porte `pending_commands`. Le Player récupère alors ses commandes sans attendre : la latence d’une commande est bornée par l’intervalle de heartbeat (30 s).
- Le **canal WSS** (PROTO-005, PROTO-006) est **reporté**. Il réduira cette latence sans changer les identifiants ni les états : les messages `COMMAND`, `COMMAND_ACK` et `COMMAND_RESULT` du contrat WS portent les mêmes objets.

### Commandes (SUP-005, PROTO-007, PROTO-008, OBS-012)

- **Types proposés** :
  - `FORCE_SYNC`, `RELOAD_CONTENT`, `GET_STATUS` ;
  - `RESTART_RENDERER`, `CLEAR_UNUSED_CACHE` ;
  - `TAKE_SCREENSHOT` : seulement si la capacité `screenshot` est `supported`.
- **Mises à jour** ([ADR-019](0019-registre-releases-player.md)) : `UPDATE_PLAYER` (release souhaitée) et `ROLLBACK_PLAYER` (version précédente locale), Player natif et permission `player.command.disruptive`.
- **Type refusé** :
  - `REBOOT_HOST` : seulement pour une capacité qualifiée, avec la permission `player.command.disruptive`. Aucun Player ne la déclare en V1.
- **Signature** : chaque commande est signée par le cloud (`SIGNAGE_COMMAND_V1`) avec une **clé de commande distincte** de la clé des manifests (`PIXLOVA_COMMAND_KEY_ID`, `PIXLOVA_COMMAND_SIGNING_KEY`). Les Players la reçoivent avec leurs clés de confiance (`command-keys.json`).
- **Création** :
  - permission `player.command`, et `screenshots.request` pour une capture ;
  - Player dans le périmètre de l’utilisateur ;
  - génération d’affectation courante pour une commande liée à un Display ;
  - durée de validité de **10 min par défaut [à valider]**, 24 h au plus.
  - La demande est auditée.
- **États** :

  ```
  pending → sent → acknowledged → success | failed | rejected | unknown
  pending | sent → expired   (non récupérée ou non accusée avant expiration)
  pending → cancelled        (seulement avant distribution au Player)
  ```

  - `sent` : récupérée par le Player (`GET /player/v1/commands`), toujours redistribuée jusqu’à son ACK pour survivre à un redémarrage du Player.
  - Une commande `expired` côté cloud après sa distribution reste acceptée si le Player l’accuse ou en rend le résultat : il a pu la lancer juste avant l’échéance, et son résultat fait foi.
  - Une commande déjà distribuée ne peut plus être annulée : le Player a pu la lancer.

  L’ACK signifie « reçue et inscrite durablement », jamais « réussie ». Transport et résultat sont affichés séparément.
- **Côté Player** :
  1. vérifier la signature, le schéma et la fenêtre (`verifyCommand` / `verify_command`), puis `evaluate_command` (tenant, Player, génération, capacité, expiration) ;
  2. inscrire durablement l’identifiant et l’empreinte ;
  3. envoyer l’ACK ;
  4. exécuter, enregistrer, puis envoyer le résultat.

  Un doublon renvoie le résultat connu sans réexécuter ; un même identifiant au contenu différent est refusé.
- Le serveur n’accepte un résultat que du Player destinataire, une seule fois. Un résultat rejoué identique est idempotent.

### Captures (SUP-004)

- Réservées aux Players qui déclarent `screenshot: supported`.
  - **Natif** : instantané de la vue WebKitGTK, pris par le renderer à la demande de l’agent.
  - **Player Web** : `unsupported`. Le navigateur ne permet pas de capturer la page sans invite.
- Désactivables par organisation (`screenshots_enabled`, activé par défaut [à valider]).
- **Stockage** : clé privée `org/<organisation>/screenshots/<id>.png`, jamais publique. L’envoi n’est accepté que pour une capture demandée, non expirée, du Player destinataire, avec une taille bornée (5 Mo) et une empreinte vérifiée.
- **Rétention de 24 h [à valider]** (DEC-11). Après expiration, un job du worker supprime l’objet et la ligne.
- La demande, la réception et chaque consultation sont auditées. L’interface affiche l’heure de capture et « image du renderer, ne prouve pas que l’écran est visible ».

### Événements et timeline (PROTO-019, SUP-003, OBS-001, OBS-020)

- **Événements du Player** :
  - format `PlayerEvent` (UUID, boot ID, séquence, `observed_at`, type, sévérité, payload borné) ;
  - envoyés par lots ; le serveur ajoute `received_at`, déduplique sur `(player_id, event_id)` et accuse les identifiants persistés ; le Player ne retire que ceux-là ;
  - file locale bornée : les métriques répétitives sont éliminées d’abord, et un compteur de pertes est remonté.
- **Événements du cloud** dans la même table, avec `source = cloud` :
  - présence perdue ou retrouvée ;
  - commande demandée, reçue ou terminée ;
  - incident ouvert ou résolu.
- **Timeline d’un Display** : fusion, triée par instant observé, de ces événements, des livraisons de manifests (désiré, reçu, prêt, appliqué, échec) et des changements d’affectation.
  - Les événements d’un Player sans Display n’y figurent que pendant son affectation à ce Display.
  - Une publication apparaît par le manifest désiré qu’elle produit (identifiant et version).
  - Chaque entrée montre l’instant observé et l’instant de réception quand ils diffèrent (événements rattrapés après une coupure).
  - La corrélation publication → manifest → activation passe par l’identifiant de manifest et la version (OBS-001).

### Alertes et incidents (SUP-006 à SUP-008, OBS-010, OBS-011)

| Règle | Ouverture | Résolution | Sévérité |
|---|---|---|---|
| `player_offline` | Aucun contact depuis **5 min [à valider]** | Contact rétabli et stable 2 min | warning |
| `manifest_not_applied` | Manifest désiré non appliqué après **10 min [à valider]** | Manifest désiré appliqué | warning |
| `delivery_failed` | Livraison `failed` sur le manifest désiré | Manifest désiré appliqué | error |
| `playback_errors` | ≥ 3 erreurs de lecture ou de téléchargement en 15 min | Aucune pendant 15 min | warning |
| `disk_low` | Disque utilisé > **90 % [à valider]** | < 85 % | warning |

- **Incidents** :
  - un seul incident ouvert par règle et cible (index unique partiel) ;
  - une notification à l’ouverture et une à la résolution, au plus ;
  - rappel au plus toutes les 24 h [à valider] ;
  - chaque transition est écrite dans la timeline.
- **Évaluation** : job périodique du worker, toutes les minutes, idempotent, sous verrou consultatif.
- **Maintenance** : fenêtre bornée (organisation, site ou Display) avec auteur, motif et fin. Elle suspend les notifications, sans suspendre la collecte, les incidents ni la présence réelle. Son expiration réactive les règles.
- **Corrélation plateforme** : si plus de 30 % des Players de la plateforme (et au moins 10) passent hors ligne dans la même fenêtre de 5 min [à valider], les incidents `player_offline` ouverts dans cette fenêtre sont marqués `suspected_platform` et leurs emails sont retenus. La panne n’est pas attribuée au client.
- **Destinataires** : les membres qui ont `player.configure` sur la cible, emails vérifiés, via l’outbox email existante. Préférence individuelle de désabonnement des emails d’alerte. Les incidents restent visibles dans le dashboard.

### Observabilité (OBS-001, OBS-002)

- **Journaux structurés** (Pino), avec en-têtes et champs expurgés : `authorization`, `cookie`, jetons, secrets de suivi, URL signées, requêtes de stockage.
- **Métriques** au format Prometheus sur le **listener interne** seulement (`/internal/v1/metrics`), avec des labels à cardinalité bornée : route **modèle**, classe de statut, type de job, état. Aucun identifiant de Player ou d’organisation en label ; le détail par Player reste dans la base et les vues.
- **Runbooks** : [RUNBOOKS](../../operations/RUNBOOKS.md).

## Mise en œuvre (L07)

- **Événements émis** :
  - Player natif : `AGENT_STARTED`, `RENDERER_CONNECTED`, `RENDERER_DISCONNECTED`, `PLAYBACK_ERROR` (à la transition vers l’erreur), `CLOUD_UNREACHABLE`, `CLOUD_RESTORED`, `CLOCK_DRIFT` ;
  - Player Web : les mêmes, avec `PLAYER_STARTED` au lieu d’`AGENT_STARTED` ;
  - cloud : `PRESENCE_LOST` (worker, daté de l’échéance de présence), `PRESENCE_RESTORED`, `COMMAND_*`, `SCREENSHOT_RECEIVED`, `INCIDENT_OPENED`, `INCIDENT_RESOLVED`, `EVENTS_DROPPED`.
- **Files locales** : 10 000 événements (natif, SQLite) et 2 000 (Web, IndexedDB) **[à valider]**. Un lot rejoué n’est compté qu’une fois.
- **Statut complet** : toutes les 5 min **[à valider]** et sur `GET_STATUS`. Le Player Web ne mesure ni disque, ni CPU, ni température (`null`).
- **Chronologie d’un Display** : les événements d’un Player sans Display n’y figurent que pendant l’affectation de ce Player à ce Display.
- **Commandes** :
  - redistribuées tant qu’elles ne sont pas accusées ; après un redémarrage, une commande inscrite mais jamais lancée est exécutée à sa redistribution, une commande lancée sans résultat est déclarée `unknown` ;
  - une enveloppe invalide reçoit un résultat `rejected` (sans effet), pour cesser d’être redistribuée ;
  - Player Web : `RESTART_RENDERER` recharge la page une fois le résultat transmis.
- **Capture native** : message IPC `SCREENSHOT`, instantané de la vue WebKitGTK encodé en PNG. Un renderer sans affichage refuse (`SCREENSHOT_UNSUPPORTED`) et ne déclare pas la capacité. La capture sous Windows (WebView2) n’est pas implémentée.
- **Incidents** :
  - `manifest_not_applied` ne s’ouvre que si le Player est en ligne : sinon, c’est `player_offline` qui s’applique ;
  - une cible disparue (Player révoqué, Display désaffecté) clôt l’incident ;
  - la maintenance retient les ouvertures et les rappels ; la résolution d’un incident déjà annoncé est toujours annoncée.
- **Corrélation plateforme** : Players actifs dans les dernières 24 h ; perte de contact récente = silence entre 90 s et (seuil hors ligne + 5 min).
- **Notifications** : le worker écrit `alert.notification` dans `outbox_events`, dans la transaction de l’incident. L’API, qui détient la clé de chiffrement de l’outbox email, les convertit en emails.
- **Rétentions** : captures 24 h ; chronologie 90 j **[à valider]** (DEC-11).

## Conséquences

- La latence d’une commande reste celle du heartbeat tant que le WSS n’existe pas. Elle est affichée comme telle, en état « envoyée ».
- La capture reste un indice ; elle n’est jamais une preuve de visibilité.
- Les seuils sont configurables par variables d’environnement jusqu’à leur validation.

## Vérification

- Tests de l’API :
  - commande hors périmètre, sans permission, expirée, dupliquée ;
  - résultat d’un autre Player ;
  - capture désactivée, non demandée, expirée ou trop grande ;
  - consultation auditée ;
  - timeline triée avec rattrapage hors ligne ;
  - isolation entre organisations.
- Tests du worker : incidents ouverts, dédupliqués, résolus ; maintenance ; corrélation plateforme ; purge des captures.
- Players :
  - file d’événements bornée et accusée ;
  - commande vérifiée, dédupliquée, reprise après redémarrage ;
  - capture réelle WebKitGTK sous Xvfb.
- Bout en bout : commande et capture depuis le dashboard jusqu’au Player réel et retour.

Réalisé dans L07 :

| Preuve | Emplacement |
|---|---|
| API : permissions, idempotence, expiration, annulation, doublons, résultat d’un autre Player, isolation, capture altérée ou trop grande, consultation auditée, chronologie paginée, notifications ciblées, maintenance, métriques | `apps/api/test/supervision.integration.test.ts`, `listeners.test.ts` |
| Worker : ouverture unique sous concurrence, résolution stable, rappel, cible disparue, maintenance, hystérésis disque, échec de livraison, erreurs répétées, corrélation plateforme, purge des captures | `apps/workers/test/alerts.test.ts` |
| Agent natif : commandes vérifiées, refusées, dédupliquées, reprises après redémarrage ; file d’événements conservée hors ligne puis rattrapée | `native/agent/tests/commands.rs` |
| Capture WebKitGTK réelle sous Xvfb | `native/agent/tests/renderer.rs` |
| Player Web dans Chromium : commandes, statut, événements, capture refusée | `apps/web-player/test/web-player.browser.test.ts` |
| Dashboard dans Chromium : signaux, commande, capture, incident, maintenance | `apps/dashboard/test/e2e/supervision.browser.test.ts` |
| Bout en bout avec l’agent et le renderer réels (sans affichage et WebKitGTK) | `apps/api/scripts/e2e-native-player.mjs` |

Restent à prouver sur matériel : les essais 17 à 20 de [PLAYER-NATIF](../../quality/PLAYER-NATIF.md).
