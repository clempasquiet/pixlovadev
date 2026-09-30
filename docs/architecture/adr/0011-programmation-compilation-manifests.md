# ADR-011 — Playlists, programmation, arbitrage et compilation des manifests

- Statut : acceptée (les valeurs marquées **[à valider]** restent soumises au responsable produit)
- Date : 2026-09-29
- Ticket / lot : [L05 #6](https://github.com/clempasquiet/pixlovadev/issues/6)
- Exigences concernées : PLN-001 à PLN-013, PROD-003, FON-002, FON-003, PAR-005, PLY-007, DATA-003, DATA-010, DATA-011, PROTO-004, PROTO-009, PROTO-013, PROTO-014, PROTO-016 à PROTO-018, PROTO-021, NAT-011, NAT-012
- Décision remplaçant / remplacée par : complète l’[ADR-003](0003-contrats-signature-fixtures.md) (manifest signé), l’[ADR-009](0009-bibliotheque-media-stockage-pipeline.md) (file de tâches, usages) et l’[ADR-010](0010-compositions-editeur-templates.md) (document d’édition)

## Contexte

L00 a fixé le manifest signé et la sélection locale (`selectAt`) : le Player exécute des intervalles UTC, jamais des règles métier. L05 doit produire ces manifests à partir de règles éditoriales :

- playlists ;
- plannings récurrents en heure locale ;
- campagnes ;
- overrides et urgence.

Le compilateur doit être déterministe, idempotent, résistant aux reprises de tâches, et expliquer chaque choix. Le dashboard doit montrer séparément l’état désiré, préparé et appliqué de chaque Display.

## Décision

### Modèle éditorial

- **Playlists.**
  - Un brouillon (`draft_document`, concurrence optimiste par `draft_revision`, comme les compositions) contient :
    - des éléments ordonnés : média ou composition, durée, activation, période de validité en instants UTC ;
    - une transition (`cut` ou `fade`).
  - La publication crée une `playlist_versions` immuable.
  - Une playlist ne contient pas de playlist : l’imbrication passe par la zone playlist d’une composition.
- **Programmes.** Plannings, campagnes et overrides partagent une table `programs`, avec un `kind` et des versions immuables `program_versions`.
  - **Planning** :
    - fuseau imposé facultatif ;
    - cibles ;
    - règles récurrentes : contenu, priorité 0–19, jours ISO, heure de début, heure de fin (`24:00` admis), dates locales incluses ;
    - exceptions datées : `skip` ou `replace`, pour une règle ou pour tout le planning. Une exception ciblée prime sur une exception de planning.
  - **Campagne** : contenu, instants de début et de fin, priorité 20–79, cibles. Elle est préparée en brouillon, publiée, puis arrêtée par `cancel`, avec auteur et date conservés.
  - **Override** :
    - créé et publié en une seule opération idempotente ;
    - priorité 80–99, 90 par défaut ;
    - priorité 100 = urgence, permission `override.emergency` ;
    - interrompu par `cancel`.

  Le statut d’une campagne (brouillon, programmée, active, terminée, annulée) est **calculé** à partir de l’instant courant ; il ne dépend d’aucun cron.
- **Références dynamiques.**
  - Programmes et playlists désignent des contenus logiques (`media`, `composition`, `playlist` + UUID).
  - La compilation retient la **dernière version publiée** de chaque composition et playlist.
  - Le manifest et l’enregistrement de compilation figent les versions et assets exacts.
  - Republier une composition met donc à jour toutes les diffusions qui l’utilisent, après recompilation.
  - Écart assumé avec la mention « références de versions précises » de `playlist_versions` (§16.6) : la précision est portée par l’artefact distribué, pas par le brouillon éditorial.
- **Brouillons en JSON, publications en relations typées.**
  - Les brouillons sont des documents validés par les contrats partagés.
  - À la publication, chaque référence de contenu devient une ligne de `content_dependencies`.
  - La table est généralisée avec clés étrangères typées exclusives (DATA-003) :
    - source : version de composition, de playlist ou de programme ;
    - cible : média, composition ou playlist ;
    - contrainte « exactement une source, exactement une cible ».
  - Les cibles (site, groupe, Display) restent dans le document publié : un groupe supprimé ne résout simplement plus de Display. Un programme n’empêche pas la suppression d’un groupe.

### Heures locales et changements d’heure (PLN-003, PLN-004)

- Les règles sont évaluées dans le fuseau effectif du Display (Display → site → organisation), sauf fuseau imposé par le planning.
- Le fuseau du navigateur n’intervient jamais.
- Seule la base tz de `Intl` (ICU) est utilisée ; aucune règle de fuseau n’est codée.
- Une occurrence appartient à la date locale de son **début**. Une fin inférieure ou égale au début traverse minuit.
- Retenu (reprend la proposition PLN-004) :
  - début dans une heure absente → occurrence omise ;
  - heure répétée → première occurrence, pour le début comme pour la fin ;
  - fin dans une heure absente → premier instant existant après le saut ;
  - chaque occurrence logique (règle, date locale) n’est produite qu’une fois.
- Récurrences complexes (« premier lundi du mois ») : V2.

### Ciblage et périmètre (PLN-006, PLN-007)

- Cibles : organisation, site, groupe, Display, avec exclusions.
- Les exclusions priment. Un Display n’est retenu qu’une fois.
- Les groupes sont réévalués à chaque compilation. Un changement d’appartenance déclenche une recompilation.
- Un programme porte un `site_id` facultatif, comme les médias et compositions :
  - un utilisateur limité à des sites ne crée que des programmes rattachés à l’un de ses sites ;
  - la résolution est **toujours bornée à ce site**, même avec la cible « organisation » ;
  - un contenu référencé doit être global ou du même site.
- Le nombre et la liste des Displays visés sont rendus à la publication.

### Arbitrage unique (PLN-008, PROTO-018)

- Le moteur `@pixlova/scheduling` est pur et sans base de données. Il est utilisé par la compilation et par la simulation du dashboard : l’aperçu utilise le même moteur que le manifest.
- Les frontières de la fenêtre sont :
  - les débuts et fins d’occurrences ;
  - les bornes de validité des éléments de playlist, y compris dans les zones imbriquées.
- Sur chaque segment `[début, fin)`, les occurrences actives sont classées par :
  1. priorité décroissante ;
  2. début d’occurrence le plus récent ;
  3. identifiant de règle en **ordre lexical croissant** (règle du planning, ou programme pour une campagne ou un override).
- La première occurrence au contenu jouable gagne. Une playlist sans élément éligible cède au niveau inférieur, puis au fallback.
- Les segments contigus de même contenu résolu et de même règle sont fusionnés. Un changement de source crée une nouvelle entrée : la playlist redémarre à son premier élément éligible (PLN-002).
- Les trous de timeline correspondent au fallback du Display.
- Le type de source du manifest vaut `emergency` pour la priorité 100.

### Contenus du manifest

- Les identifiants locaux de contenus sont dérivés de l’empreinte de leur forme canonique. Un contenu identique a donc le même identifiant d’une compilation à l’autre.
- **Durées :**
  - élément de playlist : durée explicite, sinon durée de la vidéo, sinon `settings.duration_ms` de la composition ;
  - une image ou une composition sans durée est refusée à la publication ;
  - une vidéo jouée plus longtemps que sa durée boucle, plus courtement elle est coupée ;
  - média ou composition programmé directement : durée de la vidéo, sinon `settings.duration_ms`, sinon **10 s [à valider]** (valeur indicative : le contenu boucle).
- **Ajustement** : un média programmé directement ou placé dans une playlist est affiché en `contain` (aucun recadrage) ; le recadrage se règle dans une composition.
- **Variantes :**
  - image : variante `playback` si son type MIME est annoncé par le Player, sinon `original` si annoncé, sinon refus au préflight ;
  - vidéo : variante `playback` (profil `mp4-h264-aac`, ADR-009).
  - Les capacités guident ce choix (PROTO-017) ; elles ne sont pas une autorisation.
- **Zone playlist.** Le document d’édition des compositions reçoit l’élément `playlist_zone` (ajout compatible, `schema_version` inchangée).
  - Une zone dont la playlist n’a plus d’élément éligible est omise du document résolu.
  - Cycles détectés à la publication (composition ou playlist) et à la compilation.
  - Profondeur maximale **4 niveaux [à valider]**.
- **Fallback (PLN-010) :**
  - chaque Display peut désigner un contenu de repli (média, composition ou playlist publiée), sinon l’écran d’attente local ;
  - le fallback ne retient que les éléments de playlist **sans fin de validité** et déjà commencés : un contenu soumis à une fin impérative n’est jamais prolongé ;
  - `after_schedule` vaut `play_fallback` si un contenu de repli existe, sinon `standby_screen`.

### Compilation, idempotence et reprise (DATA-010, PLN-011, PLN-012)

- **Révision désirée.** Chaque Display porte un compteur `config_revision`. Toute modification pertinente l’incrémente dans la transaction métier et enfile une tâche `compile_display` dédupliquée par `(display, révision)`. Modifications pertinentes :
  - publication, suppression ou annulation d’un contenu ou d’un programme ;
  - média mis en corbeille ou restauré ;
  - fuseau ou fallback ;
  - groupe ;
  - affectation.

  Une publication de contenu incrémente tous les Displays de l’organisation. Les compilations sans effet sont écartées par l’empreinte ci-dessous.
- **Snapshot et empreinte.**
  - La tâche lit un snapshot cohérent (transaction `REPEATABLE READ`) :
    - Display et affectation active ;
    - capacités du Player ;
    - programmes publiés visant le Display ;
    - contenus publiés et assets.
  - `input_hash` = SHA-256 de la forme canonique de ce snapshot, hors fenêtre temporelle.
  - Même empreinte que le manifest désiré, même génération d’affectation et horizon suffisant : aucun nouveau manifest (compilation `unchanged`). **La publication est idempotente.**
- **Fenêtre.**
  - Du moment de compilation à **+7 jours [à valider]** (PLN-011).
  - `activate_before` = `schedule_until`.
  - Un balayage périodique recompile les Displays dont l’horizon désiré passe sous **5 jours [à valider]**.
  - Si la timeline dépasse les limites du schéma (20 000 entrées, 5 000 contenus), l’horizon est réduit au dernier instant représentable. L’horizon réel est affiché et un horizon de moins de 48 h est signalé.
- **Validation finale sous verrou.**
  - La tâche verrouille le Display. Si `config_revision` a changé, le résultat est abandonné (`superseded`) : la tâche de la révision suivante le remplace, et un job ancien n’écrase jamais une version plus récente.
  - Sinon, dans la même transaction :
    - allouer `version` = compteur du Display + 1 ;
    - assembler et signer le payload ;
    - insérer `manifests` (immuable : ni UPDATE ni DELETE pour le rôle applicatif), `manifest_assets` et la livraison `desired` ;
    - marquer `superseded` les livraisons précédentes non appliquées ;
    - écrire l’événement outbox `manifest.desired`.
- Une tâche interrompue est reprise par le bail de la file PG (ADR-009). Rejouée, elle aboutit à `unchanged` ou `superseded`.

### Préflight avant distribution

Un manifest n’est enregistré qu’après ces contrôles. Un échec produit une compilation `rejected` avec ses causes ; le Player garde sa version courante.

1. Capacités du Player :
   - schémas de manifest et de rendu ;
   - types d’images et profils vidéo ;
   - canvas maximal ;
   - vidéos simultanées par composition ;
   - quota de stockage annoncé comparé au total des assets.
2. Ressources : médias prêts, hors corbeille, assets présents avec taille et SHA-256 ; aucun cycle.
3. Contrat : validation JSON Schema et contrôles sémantiques partagés avec Rust (`checkManifestSemantics`).
4. Signature : l’enveloppe est vérifiée par `verifyManifest` avec la clé publique correspondante (aller-retour), taille comprise.

### Signature

- Clé Ed25519 du compilateur, fournie par l’environnement :
  - `PIXLOVA_MANIFEST_SIGNING_KEY` : graine de 32 octets en base64url ;
  - `PIXLOVA_MANIFEST_KEY_ID`.
- Le worker refuse de démarrer sans clé hors mode test.
- Le dépôt ne contient aucune clé.
- La garde de la clé et sa rotation relèvent de L09-I. La distribution des clés publiques de confiance aux Players relève de L06 (PROTO-012) : aucune route ne permet d’ajouter une clé de confiance.

### États désiré, préparé et appliqué (FON-002, FON-003)

- `manifest_deliveries`, une ligne par manifest, Player et génération. États : `desired` → `received` → `downloading` → `ready` → `applied`, ou `failed`, ou `superseded`.
- `received` est observé par le cloud lors du téléchargement du manifest. Les états suivants ne sont **déclarés que par le Player** (`POST /player/v1/manifests/:id/status`) ; les transitions sont monotones et idempotentes.
- « Appliqué » n’est affiché qu’après l’acquittement du Player. Le dashboard montre, par Display :
  - la version désirée ;
  - la version préparée (`ready`) ;
  - la version appliquée ;
  - l’horizon ;
  - la dernière erreur.

  Aucune bascule simultanée n’est promise entre Displays.

### Routes Player

- `GET /player/v1/manifest?display_id=` : dernier manifest désiré pour une affectation active de ce Player et de sa génération. `ETag` = empreinte du payload, `304` si inchangé.
- `GET /player/v1/manifests/:id` : version précise, si elle appartient à l’affectation active.
- `GET /player/v1/assets/:id/url?manifest_id=` (PROTO-004) :
  - l’asset doit figurer dans ce manifest, autorisé pour ce Player et sa génération courante ;
  - la réponse donne une URL signée courte (durée du stockage, ADR-009), l’expiration, la taille, le SHA-256 et le support de `Range` ;
  - l’URL n’est pas journalisée ; une fuite reste utilisable jusqu’à expiration (limite documentée).
- `GET /player/v1/config` indique pour chaque affectation la version désirée du manifest.

### Usages et purge

- `GET /media/:id/usages` ajoute :
  - les versions de playlists et de programmes (bloquantes) ;
  - les brouillons (informatifs).
- La purge définitive d’un média est refusée (`409 MEDIA_REFERENCED`) tant qu’un asset figure dans le manifest désiré ou appliqué d’un Display (DATA-009, NAT-009).

### Explication et historique (PLN-005, PROD-003)

- Chaque compilation (`display_compilations`) conserve :
  - la révision et l’empreinte ;
  - le résultat (`published`, `unchanged`, `superseded`, `rejected`, `unassigned`) ;
  - les causes de refus ;
  - une explication compacte : pour chaque segment, source gagnante, priorité, bornes, règles masquées avec leur motif (`lower_priority`, `older_start`, `identifier_order`, `content_unavailable`).
- `GET /displays/:id/effective-program` exécute le même moteur sur les données publiées pour une date quelconque, y compris future. Le fuseau utilisé est toujours affiché.

### Limites V1 **[à valider]**

| Paramètre | Valeur |
|---|---|
| Éléments par playlist | 200 |
| Règles par planning | 100 |
| Exceptions par planning | 200 |
| Cibles incluses et exclues par programme | 100 chacune |
| Durée maximale d’un override | 7 jours |
| Horizon de compilation | 7 jours, renouvelé sous 5 jours |
| Durée par défaut d’un média fixe programmé directement | 10 s |
| Profondeur d’imbrication | 4 |

## Conséquences

- Le Player reste un exécutant d’intervalles UTC. Toute règle métier (priorités, DST, validités) est tranchée au cloud, ce qui simplifie L06 et garantit une décision identique hors ligne.
- Une publication de contenu déclenche une compilation par Display de l’organisation. L’empreinte d’entrée évite les nouveaux manifests inutiles. Une indexation fine des Displays concernés pourra réduire ce coût si les parcs grandissent.
- La timeline d’une semaine est bornée par le schéma. Des plannings très fragmentés réduisent l’horizon réel, qui est affiché.
- Pas de synchronisation multi-machines, ni d’acquittement inventé pour un Player hors ligne : une livraison reste `desired` tant que le Player ne s’est pas manifesté.

## Vérification

- Fixtures de programmation (`packages/scheduling/fixtures`) :
  - conflits de priorités ;
  - égalités (début récent, ordre lexical) ;
  - chevauchements ;
  - minuit ;
  - heures absentes et répétées à Paris et New York ;
  - fin et expiration d’override, urgence ;
  - playlist devenue vide ;
  - exceptions ;
  - fuseau imposé.

  Le déterminisme est contrôlé en inversant l’ordre des sources.
- Tests du compilateur :
  - idempotence (`unchanged`) ;
  - révision dépassée (`superseded`) ;
  - reprise après bail expiré ;
  - préflight refusé ;
  - manifest vérifié par `verifyManifest` et accepté par `evaluateManifestCandidate` ;
  - fallback et expiration via `selectAt`.
- Tests API :
  - droits et périmètres ;
  - cycles ;
  - usages ;
  - routes Player (mauvaise affectation, asset hors manifest) ;
  - transitions de livraison.
- Parcours navigateur : playlist, planning, override, explication et états.
