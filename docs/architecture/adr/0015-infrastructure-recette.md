# ADR-015 — Infrastructure Docker de recette, réseau privé et Cloudflare Tunnel

- Statut : acceptée pour la **recette**. L’hébergement de production reste à décider avec un mandat de déploiement. Les valeurs marquées **[à valider]** relèvent du responsable produit.
- Date : 2026-09-30
- Ticket / lot : [L09-I #11](https://github.com/clempasquiet/pixlovadev/issues/11)
- Exigences concernées : PRA-030, PRA-032, PRA-033, ADM-001 (préparation), ARC-014
- Décision remplaçant / remplacée par : complète l’[ADR-002](0002-backend-api-orm-jobs.md) (listeners), l’[ADR-004](0004-schema-migrations-isolation-tenant.md) (rôles, migrations) et l’[ADR-009](0009-bibliotheque-media-stockage-pipeline.md) (stockage objet)

## Problème et contraintes

Le responsable produit veut tester l’application sur son propre serveur Docker, exposé par un tunnel Cloudflare, sans provisioning payant ni DNS géré par ce lot. Contraintes :

- services séparés à permissions minimales, images épinglées, secrets hors dépôt, health checks utiles ;
- routes internes jamais joignables par le tunnel ;
- stockage objet privé, avec des limites d’envoi cohérentes avec le transport ;
- démarrage, arrêt propre, reprise du worker, migration et retour arrière exercés ;
- un seul serveur n’est pas hautement disponible, et ne doit pas être présenté comme tel (PRA-030).

Jusqu’ici, l’API refusait en production le seul transport email existant (console) et les quotas de développement. Aucune recette n’était donc possible avec `NODE_ENV=production`.

## Décision

### Topologie mono-serveur (`infra/recette/compose.yaml`)

| Service | Image | Réseaux | Rôle |
|---|---|---|---|
| `postgres` | `postgres:16.15` | `data` | Rôles ADR-004 créés au premier démarrage, mots de passe issus de `.env` |
| `redis` | `redis:7.4.9` | `data` | Limitation de débit partagée, mot de passe, sans persistance |
| `s3` | `versity/versitygw:v1.8.0` | `data`, `front` | Passerelle S3 sur le disque du serveur (POSIX) ; bucket privé |
| `mailpit` | `axllent/mailpit:v1.31.3` | `data`, `mail-ui` | Boîte de capture : aucun email ne sort ; interface protégée par mot de passe |
| `migrate` | image `api` | `data` | Étape ponctuelle : migrations (rôle propriétaire), puis création du bucket |
| `api` | `infra/docker/Dockerfile` cible `api` | `data`, `front` | Listener public 3000 ; listener interne sur 127.0.0.1:3001 **dans son conteneur** |
| `worker` | cible `worker` (FFmpeg) | `data` | Médias, manifests, alertes, purges |
| `gateway` | cible `gateway` (Caddy 2.11.4) | `front`, `edge` | Seule origine HTTP : dashboard, Player Web (`/play/`), `/api`, `/player`, bucket présigné |
| `cloudflared` | `cloudflare/cloudflared:2026.9.3` | `edge` | Connecteur sortant ; aucun port entrant ouvert sur le serveur |

Toutes les images tierces sont épinglées par version et par digest. Les images applicatives sont construites depuis le dépôt : Node 24.21 et Caddy sont également épinglés par digest.

Les réseaux `data` et `front` sont `internal` : ni l’API, ni le worker, ni la base n’ont d’accès Internet. La passerelle ne joint que l’API publique et le stockage, jamais la base ni Redis.

Seuls deux ports sont publiés sur l’hôte, liés par défaut à `127.0.0.1` : la passerelle (8080) et l’interface Mailpit (8025).

### Durcissement des conteneurs

- Utilisateurs non root : `node`, 10001 pour versitygw et Mailpit, 65534 pour Caddy, 65532 pour cloudflared.
- Options `cap_drop: ALL`, `no-new-privileges`, système de fichiers en lecture seule (sauf base et volumes de données) et journaux bornés.
- La capacité de fichier de Caddy est retirée de l’image (port non privilégié), sans quoi `no-new-privileges` empêche son exécution.

### Health checks

| Service | Contrôle |
|---|---|
| API | `/internal/v1/ready` sur le listener interne : ping des deux pools PostgreSQL et de Redis. Réponse 503 sans détail ; l’erreur reste dans les logs. |
| Worker | Témoin horodaté (`PIXLOVA_WORKER_HEALTH_FILE`), réécrit toutes les 15 s tant que la base répond ; considéré malade après 60 s. |
| Autres services | Leur propre sonde : `pg_isready`, `redis-cli ping`, `/health` versitygw, `mailpit readyz`, `/gateway-health` et `cloudflared tunnel ready`. |

L’ordre de démarrage attend ces sondes : la passerelle ne reçoit du trafic qu’une fois l’API prête (PRA-033).

### Routes internes et administration

Le listener interne de l’API reste sur la boucle locale de son conteneur. Il est refusé depuis un autre conteneur, vérifié.

La passerelle répond en outre 404 à tout chemin `/internal*`. L’administration plateforme (L09-A, `admin:8081`, ADM-001) n’existe pas encore. Elle devra rester sur un réseau de management privé, jamais sur un hostname public du tunnel.

### Stockage privé et limites d’envoi

Le bucket est adressé en style chemin sur l’origine publique (`https://hôte/<bucket>/<clé>`). La passerelle relaie ce chemin vers versitygw :

- méthodes GET, HEAD et PUT uniquement ;
- en-tête `Host` conservé, car il fait partie de la signature SigV4 ;
- corps limité à 100 Mo.

Le listing et les accès non signés sont refusés par versitygw (403). Les suppressions et les méthodes autres que GET, HEAD et PUT sont refusées par la passerelle (405).

Le plan gratuit Cloudflare refuse les corps de plus de 100 Mo, et l’envoi d’un média est un PUT unique. Deux variables abaissent donc les limites de l’API et du worker :

- `PIXLOVA_MEDIA_VIDEO_MAX_BYTES`, à 95 000 000 en recette **[à valider]** ;
- `PIXLOVA_MEDIA_IMAGE_MAX_BYTES`, à 50 000 000 en recette.

Ces variables ne peuvent qu’abaisser les limites du contrat. Un envoi trop gros est refusé avant tout transfert (413 `FILE_TOO_LARGE`). L’envoi en plusieurs parties, qui lèverait cette limite, reste hors périmètre.

### Adaptations applicatives

- **Transport SMTP** : `PIXLOVA_MAILER=smtp`, avec `PIXLOVA_SMTP_URL` et `PIXLOVA_MAIL_FROM` (nodemailer 10.0.10). En production, un transport est désormais obligatoire. En recette, il pointe vers Mailpit.
- **Mode de déploiement** : `PIXLOVA_DEPLOYMENT=development|recette|production`, dont la valeur par défaut suit `NODE_ENV`.
  - `recette` garde tous les contrôles de production : cookies sécurisés, stockage S3, Redis obligatoire, pas de mailer console. Il autorise seulement les quotas fixes `PIXLOVA_DEV_*`, faute de facturation avant L08, et journalise un avertissement au démarrage.
  - `development` est refusé avec `NODE_ENV=production`.
- **Bucket** : `node packages/storage/dist/ensure-bucket.js` crée le bucket s’il manque, sans aucune politique publique.

Les quotas de recette sont proposés **[à valider]** : 10 utilisateurs, 10 Displays, 20 Go et modèles activés.

### Secrets et clés de confiance

`infra/recette/scripts/init-recette.mjs` génère `infra/recette/.env`, en mode 600, ignoré par git et jamais écrasé. Il contient :

- les mots de passe PostgreSQL et Redis ;
- la clé de chiffrement des données ;
- les graines Ed25519 des manifests et des commandes ;
- les identifiants S3 et le mot de passe Mailpit.

Le jeton du tunnel y est ajouté par le responsable. Le script écrit aussi les clés **publiques** dans `infra/recette/trust/`, montées dans le Player Web et à installer sur les Players natifs.

### Migrations, sauvegarde et retour arrière

**Migrations.** Le service `migrate` s’exécute à chaque `up` avant l’API et le worker. Il est idempotent et utilise le rôle propriétaire. Les migrations restent en avant seulement et rétrocompatibles (PRA-033).

**Sauvegarde.** `backup.sh` produit dans `backups/` :

- un `pg_dump` au format custom ;
- une archive des objets, avec les attributs étendus qui portent les métadonnées S3 ;
- une copie de `.env` ;
- les sommes SHA-256.

**Retour arrière.** Il consiste à revenir au commit précédent, puis à reconstruire. Si une migration empêche l’ancien binaire, on ajoute la restauration de la sauvegarde prise juste avant la mise à jour, avec `restore.sh`. Ce script vérifie les sommes et exige le même `.env` que celui des données.

## Options évaluées

- **MinIO** : plus d’images publiées sur Docker Hub, licence AGPL. **Garage** (`dxflrs/garage`) : bonne option multi-nœuds, mais son initialisation (layout, clés) est plus lourde pour un seul serveur. **versitygw** : licence Apache-2.0, un binaire, stockage en fichiers ordinaires faciles à sauvegarder, sonde de santé intégrée. Retenu pour la recette ; un fournisseur S3 managé reste possible par simple configuration (`PIXLOVA_S3_*`).
- **Un hostname par service** (API, stockage, dashboard) : il faudrait des règles CORS et plusieurs routes de tunnel. Une origine unique derrière Caddy supprime le CORS : le Player Web est servi sur la même origine, comme le recommande l’ADR-013.
- **Relais SMTP réel** : il enverrait des emails à de vraies adresses depuis une recette. Mailpit a été choisi par le responsable produit ; un relais réel ne demande que `PIXLOVA_SMTP_URL`.
- **Nginx** : la configuration de Caddy est plus courte, son image est plus petite et il n’a pas besoin de TLS derrière le tunnel. Nginx convenait aussi.

## Conséquences et validation

**Disponibilité (PRA-030, PRA-032).** La panne du serveur interrompt le cloud, et ce déploiement n’est pas hautement disponible. Les Players natifs continuent sur leur état local ; les Players Web continuent sur leur cache dans les limites de l’ADR-013.

Deux connecteurs `cloudflared` tournent par défaut. Ils protègent d’une coupure de connexion, pas de la perte de l’hôte. La cible HA (PRA-031) est décrite dans [RECETTE.md](../../operations/RECETTE.md#cible-haute-disponibilité), sans engagement.

**Vérification automatisée.** `infra/recette/scripts/ci-recette.sh`, exécuté localement et par le job CI `recette-infra`, part d’une instance jetable :

- génère les secrets ;
- construit les images et démarre la pile ;
- exécute le parcours `smoke.mjs` à travers la passerelle :
  - inscription et email capturé par Mailpit ;
  - envoi présigné, traitement par le worker, relecture, signature altérée refusée ;
  - refus d’un envoi trop gros ;
  - appairage et jeton d’un Player simulé ;
  - routes internes en 404, listing du bucket en 403 ;
- vérifie la reprise d’une tâche après arrêt du worker ;
- vérifie un arrêt propre (codes 0) et le redémarrage avec données conservées ;
- fait une sauvegarde, détruit tous les volumes, restaure et relit les données.

**Vérifications manuelles.** Pendant le lot ont aussi été constatés :

- l’absence d’accès Internet depuis l’API ;
- le refus du listener interne depuis la passerelle ;
- l’absence de résolution de la base depuis la passerelle ;
- le Player Web chargé dans Chromium (service worker actif, code d’appairage affiché).

**Non vérifié ici.** Le tunnel Cloudflare réel, les limites effectives du plan Cloudflare et le matériel restent à vérifier sur le serveur du responsable, selon la procédure.

**Réexamen.** Au mandat de production : hébergement, stockage managé, relais email, sauvegardes hors site chiffrées, métriques collectées, HA.
