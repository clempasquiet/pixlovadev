# ADR-019 — Registre et distribution des releases du Player natif

- Statut : acceptée
- Date : 2026-10-01
- Ticket / lot : L09-A (#12)
- Exigences concernées : ADM-004, ADM-005, PLY-005, NAT-013, NAT-014, NAT-015, SEC-011, SUP-005
- Décision remplaçant / remplacée par : complète [ADR-012](0012-player-natif-agent-cache-mises-a-jour.md) (distribution par le cloud), [ADR-014](0014-supervision-commandes-alertes.md) (`UPDATE_PLAYER`, `ROLLBACK_PLAYER`) et [ADR-016](0016-administration-plateforme.md) (registre des releases)

## Problème et contraintes

Le Player natif savait installer une release signée et revenir en arrière avec son lanceur A/B (ADR-012), mais seulement à la main (`pixlova-agent update apply`). L’administration plateforme déclarait le registre des releases inexistant, et l’API refusait `UPDATE_PLAYER` et `ROLLBACK_PLAYER`.

Contraintes :

- **Signature hors plateforme** (ARC-018, SEC-011). Les releases sont signées dans l’environnement de release ; la plateforme ne détient que des clés publiques, distinctes des clés de manifest et de commande.
- **Rien n’est cru sans vérification** (NAT-013). Le Player vérifie signature, plateforme, protocole, taille et empreinte avant toute extraction, quoi que dise le cloud.
- **Continuité** (NAT-014, NAT-015). Une mise à jour ratée ne coupe pas la diffusion : le lanceur revient à la version précédente.
- **Administration privée et tracée** (ADM-001 à ADM-005). Périmètre affiché avant publication, motif, TOTP récent, audit avant/après.

## Décision

### Registre (`player_releases`, table globale)

- Une release est identifiée par son `release_id` signé, unique par (`os`, `architecture`, `version`).
- **Cycle de vie** : `draft` → `published` → `blocked`. Le blocage est **irréversible** ; un correctif se publie comme nouvelle version.
- **Dépôt** (`POST /admin-api/v1/releases`) : l’enveloppe `SIGNAGE_RELEASE_V1` est vérifiée avec les clés de `PIXLOVA_RELEASE_PUBLIC_KEYS` (`kid:clé,…`), protocole compatible exigé. Un rejet de signature est audité.
- **Paquet** (`PUT /releases/:id/package`, `application/octet-stream`) : lu en flux, taille et SHA-256 comparés aux métadonnées signées avant stockage sous `releases/<os>-<arch>/<version>-<aléa>.tar`.
- **Périmètre** (`GET /releases/:id/impact`, ADM-005) : calculé sur les versions déclarées par les Players natifs appairés. Il donne la release souhaitée avant et après, les Players à mettre à jour, déjà à jour, plus récents ou sans version, et les Players qui reviendraient en arrière en cas de blocage.
- **Publication et blocage** : permission `platform.releases.manage` (Operator, SuperAdmin), motif, version recopiée (`confirm_version`), TOTP récent, audit avant/après avec le périmètre. Support lit le registre (`platform.releases.read`).
- **Suppression** : brouillons seulement, paquet compris.
- **Droits PostgreSQL** : `pixlova_platform` écrit les seules colonnes du cycle de vie ; `pixlova_app` lit les colonnes nécessaires à la distribution, jamais l’auteur ni les notes.

### Distribution (API Player)

- **Release souhaitée** = la release publiée la plus récente (SemVer) pour l’`os` et l’`architecture` du Player, paquet déposé.
- `GET /player/v1/releases/desired?current_version=` renvoie l’enveloppe signée, une URL de paquet signée (15 min) et `rollback: true` si la version déclarée est bloquée. Un Player Web reçoit toujours une réponse vide.
- La version déclarée met à jour `players.app_version`, source des vues de parc et du périmètre.
- `POST /player/v1/updates/:release_id/status` reçoit les états `installed`, `promoted`, `rolled_back`, `failed` (table tenant `player_update_reports`, RLS). Un état plus ancien n’écrase pas un état plus récent. Chaque changement crée un événement `UPDATE_*` dans la timeline du Player.
- `GET /api/v1/players/:id/update` (tenant) donne version installée, release souhaitée, mise à jour disponible et dernier rapport.

### Commandes

- `UPDATE_PLAYER` et `ROLLBACK_PLAYER` sont acceptées pour un Player natif, avec la permission `player.command.disruptive`.
- `UPDATE_PLAYER` cible la release souhaitée (`{release_id}`) ; refus explicites `CAPABILITY_UNSUPPORTED`, `NO_RELEASE_AVAILABLE`, `PLAYER_UP_TO_DATE`.
- `ROLLBACK_PLAYER` revient à la version précédente installée localement, sans consulter le cloud.

### Agent natif

- **Contrôle périodique** (`release_check_interval_seconds`, 3600 s par défaut, minimum 60) seulement sous le lanceur A/B et avec des clés de release installées. Sans lanceur, aucune mise à jour n’est tentée (`LAUNCHER_ABSENT`).
- **Vérifications** avant téléchargement : signature avec les seules clés de release, plateforme, protocole, version **postérieure** à la version en service, release non bloquée localement. Puis téléchargement borné à la taille signée et empreinte revérifiée par `updater::apply`.
- **Installation** : version `pending` du lanceur, état `installed` déclaré, puis arrêt propre ; systemd relance le lanceur qui essaie la nouvelle version (ADR-012).
- **Retour arrière** : sur `rollback: true` ou `ROLLBACK_PLAYER`, l’agent inscrit `rollback_requested` dans `state/launcher.json` et s’arrête ; le lanceur bloque la version, revient à la précédente et restaure la base si l’association est identique (NAT-015).
- **Rapports** : l’historique du lanceur est importé dans SQLite (schéma v3, colonne `reported_state`) et chaque état est déclaré une fois ; une erreur 4xx définitive le marque déclaré, une erreur réseau le garde pour plus tard.

### Valeurs à valider

- **Mise à jour automatique** de tous les Players dès la publication, sans fenêtre de maintenance ni accord du client **[à valider]**.
- **Redémarrage immédiat** après installation : la diffusion s’interrompt le temps du relancement **[à valider]**.
- Intervalle de contrôle d’une heure **[à valider]**.

## Options évaluées

- **Signer dans la plateforme** : écartée (ARC-018). Une compromission de l’administration permettrait de diffuser un binaire arbitraire à tout le parc.
- **Bloquer sans retour arrière automatique** : écartée. Une release défectueuse resterait en service jusqu’à une nouvelle publication.
- **Débloquer une release** : écartée. Le blocage est inscrit localement par les Players ; une version corrigée est plus lisible et plus sûre.
- **Déploiement progressif, canaux bêta, fenêtres de maintenance** : reportés (V1.5). La colonne `channel` (`stable`) prépare le canal sans le mettre en œuvre.
- **Envoyer le paquet par la commande** : écartée. La commande ne transporte que l’identifiant ; la release souhaitée et son paquet passent par le même chemin vérifié que le contrôle périodique.

## Conséquences et validation

**Déploiement.**
- Le conteneur `admin` a besoin du stockage objet et de `PIXLOVA_RELEASE_PUBLIC_KEYS`. En production, une clé S3 limitée au préfixe `releases/` est recommandée ; la recette (versitygw) partage la clé du stockage.
- Le paquet transite par `/tmp` du conteneur (tmpfs) avant stockage.
- Les lanceurs installés avant ce changement ignorent `rollback_requested` : le premier déploiement automatique doit partir d’un paquet qui contient ce lanceur.

**Migrations.** `0021_player_releases` (tables), `0022_player_releases_grants` (droits par colonnes) ; SQLite de l’agent v3 (additive).

**Tests.**
- Privilèges PostgreSQL du registre et des rapports.
- 9 tests d’intégration sur PostgreSQL réel : dépôt signé et rejets audités, paquet vérifié, périmètre, publication avec TOTP récent, distribution et URL du paquet, Player Web, commandes, rapports et timeline, blocage et retour arrière, permissions.
- Agent : bout en bout contre une API simulée (paquet altéré refusé, installation, retour arrière demandé), retour arrière exécuté par le lanceur, rapports déclarés une fois.
- Console dans Chromium : dépôt, envoi du paquet, périmètre et publication avec ressaisie du TOTP.

**Non couvert.** Mise à jour réelle d’un Player installé par `install.sh` sous systemd ; à exercer en recette (L09-R).

**Réexamen.** Avant la production (valeurs à valider ci-dessus), et avec le déploiement progressif (V1.5).
