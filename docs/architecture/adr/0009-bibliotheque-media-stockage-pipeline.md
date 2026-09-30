# ADR-009 — Bibliothèque média, stockage objet et pipeline de préparation

- Statut : acceptée (les valeurs marquées **[à valider]** restent soumises au responsable produit)
- Date : 2026-09-29
- Ticket / lot : [L03 #4](https://github.com/clempasquiet/pixlovadev/issues/4)
- Exigences concernées : MED-001 à MED-010, ARC-004 à ARC-006, ARC-011, API-006, API-007, DATA-008, DATA-011, SEC-003, SEC-008, SEC-014, SEC-016, BILL-005, TST-002, TST-052
- Décision remplaçant / remplacée par : modifie l’[ADR-002](0002-backend-api-orm-jobs.md) (file de tâches) ; complète l’[ADR-007](0007-rbac-scopes.md) (visibilité des contenus par site)

## Contexte

L03 introduit les premiers fichiers clients : upload direct, validation, traitements lourds, variantes immuables, quotas et corbeille.

Le cahier laisse ouverts plusieurs choix :

- le fournisseur de stockage (ARC-005) ;
- l’usage de BullMQ par rapport à une outbox PostgreSQL (ARC-004) ;
- les limites de formats (MED-004) ;
- la règle de quota (MED-006) ;
- la rétention de la corbeille (MED-008).

Le conteneur de développement et la CI n’ont ni MinIO ni démon Docker local.

## Décision

### Stockage objet (`@pixlova/storage`)

- Une interface `ObjectStorage` expose les opérations suivantes : URL signée d’envoi (`PUT`) ou de lecture (`GET`, Range), `head`, lecture en flux, écriture depuis un fichier, suppression.
- Deux pilotes :
  - **`s3`** : tout stockage compatible S3 (S3, R2, MinIO, Ceph, B2). URLs présignées SigV4 avec `Content-Length` et `Content-Type` signés. Le choix du fournisseur reste à L09-I.
  - **`local`** : système de fichiers pour le développement et les tests. Les URLs signées HMAC (opération, clé, taille maximale, expiration) sont servies par l’API sous `/storage/v1`, avec contrôle de taille pendant l’écriture et Range en lecture. Ce pilote est **refusé en production**.
- Les clés sont opaques et construites par le serveur (`org/<org>/uploads/<upload>`, `org/<org>/media/<media>/<variante>`). Aucun chemin ou nom fourni par le client n’y entre. Les clés sont validées (pas de `..`, pas de segment vide) avant tout accès au pilote.
- Le navigateur ne reçoit jamais de credential de stockage : seulement des URLs signées de courte durée (15 min pour l’envoi, 5 min pour les aperçus).

### Upload direct (MED-002, API-007)

1. `POST /api/v1/media/upload-session`, avec `Idempotency-Key`, reçoit : nom, MIME déclaré, taille, dossier ou site facultatifs, SHA-256 client facultatif. Le serveur :
   - refuse un MIME non accepté (`415`) ou une taille hors limite (`413`) ;
   - **réserve** la taille déclarée sur le quota, sous verrou du compteur ; en cas de dépassement, `409 STORAGE_QUOTA_EXCEEDED` ;
   - crée le média `uploading` et renvoie l’URL signée vers la clé de **quarantaine**.
2. `…/complete` vérifie par `HEAD` que l’objet existe et que sa taille égale la taille déclarée. Sinon, `422 UPLOAD_INCOMPLETE` ou `UPLOAD_SIZE_MISMATCH`. En cas de succès, dans la même transaction : la réservation devient une consommation, le média passe `processing` et une tâche d’ingestion est créée.
3. `…/abort` libère la réservation et supprime l’objet. Une session non finalisée expire : un balayage libère la réservation et nettoie la quarantaine.
4. Le pipeline copie les octets **vérifiés** de la quarantaine vers la clé définitive. Un nouvel envoi sur une URL encore valide ne modifie donc jamais un média accepté.

Reporté : upload multipart avec reprise (proposition MED-002). Un seul `PUT` est limité à 2 Gio **[à valider]**.

### File de tâches (ARC-004)

- La table `jobs` est la source de vérité. Une tâche y est écrite dans la même transaction que la décision métier : c’est l’outbox transactionnelle proposée par ARC-004.
- Un worker réclame une tâche par `FOR UPDATE SKIP LOCKED` sous un **bail** (60 s, renouvelé pendant le traitement).
  - Worker arrêté : son bail expire et un autre worker reprend la tâche.
  - Écriture finale : conditionnée au bail courant (fencing).
- Unicité : une seule tâche active par (`kind`, `dedupe_key`), garantie par un index unique partiel. Les finalisations rejouées ne créent donc pas de doublon.
- Échecs :
  - **transitoires** (stockage indisponible, délai dépassé) : reprise avec backoff exponentiel, 5 tentatives au maximum ;
  - **définitifs** (format invalide, fichier corrompu, limite dépassée) : erreur immédiate avec un code exploitable ;
  - un utilisateur autorisé relance explicitement un média en erreur (`POST /media/:id/retry`).
- **Modification de l’ADR-002** : les workers réclament directement les tâches dans PostgreSQL, sans relais vers Redis/BullMQ. Ce choix supprime un relais à fiabiliser, permet de tester la reprise sans Redis et suffit au débit visé. Redis ne détient ainsi aucune décision (ARC-004). BullMQ pourra servir d’accélérateur de notification, jamais de source de vérité.

### Pipeline d’ingestion (MED-003, MED-004, SEC-014)

Le worker `apps/workers` traite chaque tâche dans un répertoire temporaire propre, supprimé en fin de tâche :

1. Téléchargement de la quarantaine :
   - taille bornée à la taille déclarée ;
   - SHA-256 calculé en flux, puis comparé au SHA-256 client s’il a été fourni (`CHECKSUM_MISMATCH`).
2. **Signature réelle** du fichier (octets magiques), jamais l’extension ni le MIME déclaré. La catégorie détectée doit correspondre à la catégorie déclarée.
3. Images, avec sharp/libvips :
   - `limitInputPixels` et lecture complète des pixels : un fichier tronqué échoue ;
   - rotation EXIF appliquée pour les dimensions ;
   - variante `playback` = l’original si le format est accepté et l’orientation neutre ; sinon ré-encodage (`image-normalized-v1`) ;
   - `thumbnail` en WebP, 480 px sur le grand côté (`webp-thumb-480-v1`).
4. Vidéos, avec FFprobe puis FFmpeg :
   - analyse avec délai borné, `-protocol_whitelist file`, sans entrée standard ;
   - profil de référence **MP4 H.264 (Baseline/Main/High, yuv420p, niveau ≤ 5.2) + AAC ou sans audio** ;
   - vidéo déjà compatible : l’original sert de `playback` (profil `passthrough`), sans transcodage inutile (MED-004) ;
   - sinon, transcodage `h264-aac-mp4-v1` :
     - `libx264` CRF 20, preset `medium`, `yuv420p` ;
     - réduction au-delà de 4096 px de côté ou de 3840×2160 pixels, cadence plafonnée à 60 i/s ;
     - AAC 160 kb/s et `+faststart`, avec délai proportionnel à la durée ;
   - vignette WebP extraite à 1 s (ou à la moitié de la durée pour une vidéo courte).
5. Chaque variante est écrite, relue pour son SHA-256 et sa taille, puis enregistrée dans `media_assets`, unique par (média, variante). Une variante déjà présente n’est pas refaite.
6. Le média passe `ready` seulement quand `original`, `playback` et `thumbnail` existent (contrainte `media_ready_complete`). Un média qui n’est pas `ready` n’est jamais sélectionnable pour une publication (MED-007, L05).

Les versions de FFmpeg et de sharp/libvips sont enregistrées dans `codec_metadata`. Les limites processus (mémoire, CPU, réseau fermé) seront imposées par le conteneur worker (L09-I). En L03, elles sont garanties par délais, pixels bornés et protocoles restreints.

### Formats et limites **[à valider]** (configurables)

| Type | Formats acceptés (signature réelle) | Taille | Autres limites |
|---|---|---|---|
| Image | JPEG, PNG, WebP (GIF, SVG, HEIC refusés en V1) | 50 Mio | 16 384 px de côté, 100 Mpx |
| Vidéo | MP4/MOV (ISO BMFF), WebM/Matroska | 2 Gio | durée ≤ 4 h ; sortie ≤ 60 i/s, ≤ 4096 px de côté et ≤ 3840×2160 px |

La compatibilité par Player (`max_canvas`, profils déclarés) est vérifiée à la publication (L05). La matrice qualifiée relève de L06.

### Quotas (DATA-008, MED-006, BILL-005)

- Compteur `usage_counters(storage_bytes)` : `observed` + `reserved`, modifié uniquement sous verrou de sa ligne.
- Règle **[à valider]** :
  - l’organisation est facturée de la taille de l’**original** de chaque média non purgé, **corbeille comprise** ;
  - les variantes et vignettes sont un coût de service non imputé.
- La capacité vient de `EntitlementsProvider.storageBytes` : Free = 2 Go, valeur indicative de BILL-003 **[à valider]**. La projection réelle relève de L08.
- Au-delà de la capacité, aucun nouvel upload n’est accepté. Rien n’est supprimé (TST-052).
- Pas de déduplication en V1 : chaque média possède ses binaires. Il n’y a donc aucune révélation entre tenants, et la purge ne peut pas retirer le binaire d’un autre média.

### Corbeille et suppression (MED-008, MED-009)

- `DELETE /media/:id` place le média en corbeille avec `purge_after = maintenant + rétention`, de 30 jours par défaut **[à valider]** (`PIXLOVA_MEDIA_TRASH_RETENTION_DAYS`).
- `POST /media/:id/restore` conserve l’identifiant.
- Purge définitive, par le balayage à l’échéance ou par `POST /media/:id/purge` depuis la corbeille : suppression des objets, des lignes, puis libération du quota.
- Références : le graphe `content_dependencies` arrive avec L05. En attendant, `GET /media/:id/usages` renvoie une liste vide, calculée par une fonction unique que L05 complétera. Supprimer un média référencé exigera alors `force` et `content.force_delete`. Ce contrôle est déjà câblé.
- Remplacer un média crée un nouveau média : aucun binaire n’est modifié en place (MED-005). Le remplacement assisté avec impact relève de L05.

### Visibilité par site (complète l’ADR-007)

- `media.site_id` et `media_folders.site_id` sont nullables :
  - `NULL` : bibliothèque de l’organisation, visible des grants de niveau organisation ;
  - sinon : visible des grants couvrant ce site (`organization.read`) et modifiable avec `content.manage` sur ce site.
- C’est la même règle que pour Players et Displays.
- Le partage explicite de contenus d’organisation vers des sites reste une extension ultérieure.

### Accès aux fichiers

- Les URLs d’aperçu du dashboard sont émises après contrôle du tenant et du site. Elles expirent et ne donnent accès qu’à un objet.
- Les URLs des Players (`GET /player/v1/assets/:id/url?manifest_id=…`, PROTO-004) dépendent des manifests et relèvent de L05/L06.

## Conséquences

- Les tests couvrent sans service externe :
  - l’API et le worker, avec le pilote `local` ;
  - le pilote `s3`, contre un serveur compatible S3 lancé en test : `moto`, en local comme en CI.
- La CI installe FFmpeg (Ubuntu 24.04 : FFmpeg 6.1).
- La production exige le pilote `s3`, une politique CORS du bucket limitée à l’origine du dashboard, et le conteneur worker isolé (L09-I).

## Vérification

- Tests du package `storage` : signatures, expiration, taille, Range, traversée de clé ; S3 : URL présignée, `head`, copie, suppression.
- Tests du worker :
  - image et vidéo compatibles, sans transcodage ;
  - vidéo à transcoder ;
  - fichiers tronqués ou corrompus, faux MIME, formats refusés, dimensions excessives ;
  - SHA-256 client faux ;
  - stockage indisponible puis rétabli ;
  - bail expiré repris par un autre worker ;
  - rejeu sans doublon.
- Tests d’intégration de l’API :
  - isolation entre organisations (session, finalisation, lecture, URL) ;
  - quota concurrent sur les derniers octets ;
  - upload incomplet ou de mauvaise taille ;
  - abandon et expiration ;
  - corbeille, restauration, purge et quota libéré.
