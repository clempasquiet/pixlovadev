# Runbooks de supervision

Procédures d’exploitation des incidents et signaux de la supervision ([ADR-014](../architecture/adr/0014-supervision-commandes-alertes.md)). Elles décrivent le logiciel livré par L07. Les seuils marqués **[à valider]** sont ceux du code, en attente de validation par le responsable produit. Le déploiement de recette, la sauvegarde et la restauration sont décrits dans [RECETTE.md](RECETTE.md) ; le plan de reprise de production relève de L09-R.

## Principes

- **Ne jamais conclure sur un seul signal.** Présence, santé du Player, rendu, sortie et capture sont indépendants :
  - un Player hors ligne peut diffuser depuis son cache ;
  - une sortie détectée ne prouve pas que la dalle est allumée ;
  - une capture montre ce que rend le renderer, pas ce que voit le public.
- **Lire d’abord la fiche de l’écran** (dashboard, *Écrans* → écran → *Supervision*), puis sa chronologie. Chaque entrée indique l’instant observé et, s’il diffère, l’instant de réception : des événements reçus en rafale après une coupure sont normaux.
- **Toute action à distance est une commande signée**, tracée dans le journal d’audit et la chronologie :
  - « transmise » signifie récupérée par le Player ;
  - « reçue » signifie inscrite durablement par le Player ;
  - seul le résultat dit si elle a réussi.
- **Une intervention prévue commence par une fenêtre de maintenance** (*Incidents* → *Maintenance*). Elle retient les notifications d’ouverture et de rappel, mais ni les incidents ni la collecte.

## Incidents

### `player_offline` — Player hors ligne

- **Déclenchement** : aucun contact depuis 5 min **[à valider]** (présence perdue après 90 s).
- **Résolution** : contact rétabli et stable pendant 2 min.

1. Vérifier dans *Supervision* si d’autres Players du même site ou de toute l’organisation sont hors ligne au même moment. Un incident marqué « panne commune probable côté plateforme » est traité comme un incident de plateforme (voir plus bas), pas comme une panne client.
2. Sur place : alimentation, câble réseau, Wi-Fi, portail captif, pare-feu. Le Player n’a besoin que de HTTPS sortant vers l’API et le stockage.
3. Si l’écran affiche toujours le contenu, la diffusion locale fonctionne : seule la liaison cloud est coupée. Aucune action urgente sur le contenu.
4. Player natif accessible localement : `sudo -u pixlova /var/lib/pixlova/versions/active/pixlova-agent diagnose`. Contrôler `runtime.online`, `last_cloud_error` et `clock_offset_ms`.
5. Au retour du contact : les événements de la coupure (`CLOUD_UNREACHABLE`, erreurs éventuelles) apparaissent dans la chronologie avec leur heure réelle.

### `manifest_not_applied` — Programmation non appliquée

- **Déclenchement** : manifest désiré non appliqué 10 min après sa compilation **[à valider]**, Player en ligne.
- **Résolution** : manifest désiré appliqué.

1. Fiche de l’écran, carte *Diffusion* : lire les états désiré, préparé et appliqué, et la dernière erreur.
2. Chronologie : chercher `MANIFEST_RECEIVED` (téléchargé) et les erreurs de préparation.
3. Envoyer **Forcer la synchronisation**. En cas d’échec, envoyer **Demander le statut** et contrôler l’espace disque et l’état du renderer.
4. Si le renderer est `degraded` ou `error` : **Redémarrer le renderer** (brève interruption, confirmée par le dashboard).

### `delivery_failed` — Échec de préparation

- **Déclenchement** : livraison `failed` sur le manifest désiré.
- **Résolution** : manifest désiré appliqué.

| Code | Cause probable | Action |
|---|---|---|
| `CHECKSUM_MISMATCH` | Asset altéré en transit (proxy, antivirus réseau) | Vérifier le réseau du site ; le Player retente et garde l’ancien contenu |
| `DISK_FULL`, `STORAGE_QUOTA_EXCEEDED` | Cache plein | **Vider le cache inutilisé**, puis réduire la programmation ou agrandir le disque |
| `SIGNATURE_INVALID`, `UNKNOWN_KEY` | Clé de manifest absente ou différente sur le Player | Voir [Rotation des clés](#rotation-des-clés) |
| `PREPARATION_FAILED` | Contenu illisible par le renderer | Vérifier le média dans la bibliothèque (format, profil vidéo) |

### `playback_errors` — Erreurs de lecture répétées

- **Déclenchement** : au moins 3 erreurs de lecture, de téléchargement ou de préparation en 15 min.
- **Résolution** : aucune erreur pendant 15 min.

1. Chronologie : identifier le contenu fautif (`content_ref`, `manifest_id`).
2. Si un même média est en cause, le retirer de la programmation ou le remplacer.
3. Demander une capture pour voir ce que rend le renderer (Player natif seulement).

### `disk_low` — Espace disque faible

- **Déclenchement** : disque utilisé à plus de 90 % **[à valider]**.
- **Résolution** : moins de 85 %.

1. **Vider le cache inutilisé** : seuls les assets hors des manifests courant, précédent et candidat sont supprimés.
2. Si l’espace ne se libère pas, l’occupation vient d’autre chose que du cache pixlova : intervention sur la machine.

## Panne commune probable (plateforme)

- **Déclenchement** : plus de 30 % des Players actifs de la plateforme, et au moins 10, perdent le contact dans la même fenêtre **[à valider]**.
- **Effet** : les incidents `player_offline` de la fenêtre sont marqués `suspected_platform` ; leurs emails sont retenus.

1. Vérifier l’API publique (`/health`), le tunnel, le DNS, les certificats et le stockage.
2. Consulter les métriques internes (voir plus bas) : `pixlova_http_requests_total{status_class="5xx"}` et la durée des requêtes `/player/v1/heartbeat`.
3. Les Players continuent de diffuser leur état local : aucune action n’est requise sur les sites.
4. Après rétablissement, les incidents se résolvent d’eux-mêmes ; aucun email de résolution n’est envoyé pour une ouverture retenue.

## Commandes et captures

- **`COMMANDS_UNAVAILABLE` (503)** : `PIXLOVA_COMMAND_KEY_ID` / `PIXLOVA_COMMAND_SIGNING_KEY` absents de l’API. Les définir, puis redémarrer l’API.
- **Commande restée « En attente de récupération »** : le Player ne contacte plus le cloud (voir `player_offline`).
  - Elle expire après 10 min **[à valider]** et n’est jamais exécutée ensuite.
  - Elle peut être annulée tant qu’elle n’est pas transmise.
- **Commande « Refusée par le Player »** : lire le code.
  - `STALE_ASSIGNMENT` : l’écran a été réaffecté entre-temps.
  - `SIGNATURE_INVALID`, `UNKNOWN_KEY` : clé de commande absente ou différente sur le Player.
  - `CAPABILITY_UNSUPPORTED` : la commande n’est pas prise en charge par ce Player.
- **Issue inconnue** : le Player a redémarré pendant l’exécution. Rien n’est rejoué ; vérifier l’état puis renvoyer une commande si besoin.
- **Capture** :
  - disponible pour le Player natif Linux (WebKitGTK) seulement ;
  - désactivable par organisation dans les réglages de supervision ;
  - conservée 24 h **[à valider]** puis purgée par le worker ;
  - chaque consultation est journalisée (`screenshot.viewed`).

## Support client (console d’administration)

Console privée décrite dans [RECETTE.md](RECETTE.md#5-administration-plateforme-privée) et l’[ADR-016](../architecture/adr/0016-administration-plateforme.md). Pas d’impersonation : le support ne se connecte jamais « en tant que » client.

- **Client qui ne peut plus se connecter** : rechercher son compte par adresse exacte, avec un motif. Vérifier le statut, l’adresse vérifiée, le second facteur et les sessions actives.
- **Appareil perdu ou session suspecte** : « Révoquer les sessions ». Le client se reconnecte avec son mot de passe et son second facteur.
- **Téléphone TOTP et codes de secours perdus** (SuperAdmin) :
  1. Vérifier l’identité hors de pixlova, par exemple par un contact déjà connu de l’organisation.
  2. « Réinitialiser le second facteur », en recopiant l’adresse.
  3. Le client réactive la MFA à sa prochaine connexion.
- **Compte compromis** (SuperAdmin) : « Désactiver le compte ». Les sessions sont fermées et la connexion refusée jusqu’à réactivation.
- **Média ou manifest bloqué** : dans **Tâches**, lire l’erreur de la tâche en échec, corriger la cause (fichier, stockage), puis la relancer avec un motif.
- **Contrôle** : chaque consultation et action figure dans le **Journal** avec l’opérateur, le motif et l’état avant/après.

## Rotation des clés

Trois clés distinctes : manifests (worker), releases (paquets) et commandes (API). Une même clé dans deux rôles est refusée par le Player natif.

1. Générer la nouvelle graine : `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`, avec un nouvel identifiant (`kid`).
2. Publier d’abord la **clé publique** aux Players : `command-keys.json` ou `manifest-keys.json`, livré par un paquet signé (natif) ou avec l’application (Web). Garder l’ancienne clé dans le fichier pendant la transition.
3. Basculer ensuite l’API (clé de commande) ou le worker (clé de manifest) sur la nouvelle graine.
4. Retirer l’ancienne clé publique au paquet suivant.

## Métriques et journaux

- **Métriques** : `GET /internal/v1/metrics`, sur le seul listener interne, format Prometheus. Labels bornés, sans identifiant de tenant ni de Player.
  - `pixlova_http_requests_total` et `pixlova_http_request_duration_seconds`, par route modèle ;
  - `pixlova_players{presence}` ;
  - `pixlova_alerts_open{rule,severity}` ;
  - `pixlova_commands_in_flight{status}` ;
  - `pixlova_jobs{kind,state}` ;
  - `pixlova_email_outbox_pending`.
- **Journaux** : JSON Pino, niveau `PIXLOVA_LOG_LEVEL`.
  - En-têtes d’authentification, cookies, jetons et secrets expurgés ; URL journalisées sans chaîne de requête.
  - Corréler par `request_id`, renvoyé au client dans l’en-tête `x-request-id` et dans chaque erreur.
- **Détail par Player** : il n’est jamais porté par les métriques. Utiliser la fiche de l’écran, sa chronologie et le journal d’audit.
