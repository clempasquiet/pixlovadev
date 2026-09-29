# ADR-010 — Compositions : document d’édition, polices qualifiées, publication et templates

- Statut : acceptée (les valeurs marquées **[à valider]** restent soumises au responsable produit)
- Date : 2026-09-29
- Ticket / lot : [L04 #5](https://github.com/clempasquiet/pixlovadev/issues/5)
- Exigences concernées : CMP-001 à CMP-007, TPL-001 à TPL-003, REN-001 à REN-003, PROD-002, PAR-004, DATA-003, DATA-009, API-006, SEC-003, SEC-012, SEC-013, TST-052
- Décision remplaçant / remplacée par : complète l’[ADR-003](0003-contrats-signature-fixtures.md) (document de rendu) et l’[ADR-009](0009-bibliotheque-media-stockage-pipeline.md) (usages des médias)

## Contexte

L00 a défini le document de composition **résolu** (`composition.json`) consommé par le moteur et embarqué dans les manifests. Ses médias y sont désignés par des `asset_id`. L04 doit ajouter :

- le créateur ;
- des brouillons et des versions immuables ;
- une validation avant publication ;
- des templates réservés aux offres payantes.

Il doit aussi démontrer que la même composition est rendue de façon identique par la preview, le Player Web et le prototype natif.

## Décision

### Deux documents, un seul moteur

- **Document d’édition** (`composition-document.json`, contrats partagés) :
  - il référence des médias de bibliothèque (`media_id`) ;
  - il accepte un média non encore choisi (`null`, placeholder de template) ;
  - il porte des champs d’édition sans effet sur la lecture (`name`, `locked`, `placeholder`).
- **Document résolu** (`composition.json`, inchangé) : produit par `resolveCompositionDocument`, qui remplace chaque média par l’asset de la variante retenue.
  - Pour la preview du dashboard, la variante `playback` est retenue.
  - Pour les manifests, la compilation de L05 choisit la variante selon les capacités du Player.
- Le moteur TypeScript (`@pixlova/render-engine`) ne lit que le document résolu (REN-001).

Éléments du créateur V1 : image, vidéo, texte, forme, QR Code, horloge.

- Une image ou une vidéo placée librement couvre le besoin de la « zone média ».
- La zone playlist suppose des playlists : elle arrive avec L05, qui étend le document d’édition (version de schéma incrémentée si nécessaire).

### Coordonnées et déterminisme (CMP-001, REN-002)

- Coordonnées et dimensions sont stockées en **pixels entiers** du canvas. L’éditeur affiche des pourcentages en lecture seule : `pourcentage = pixels × 100 / dimension du canvas`, arrondi au centième.
- Rotation : degrés, sens horaire, autour du centre de l’élément.
- Ordre d’empilement : `z_index` croissant, puis ordre du document.
- Canvas libre de 1 à 32 767 px par côté, sans hypothèse 16:9.

### Polices qualifiées (CMP-003, REN-002)

Six familles sous licence SIL OFL 1.1 sont empaquetées avec le moteur, en fichiers WOFF2 variables issus de Fontsource.

| Famille | Graisses disponibles |
|---|---|
| Inter | 100 à 900 |
| Roboto | 100 à 900 |
| Open Sans | 300 à 800 |
| Montserrat | 100 à 900 |
| Playfair Display | 400 à 900 |
| Roboto Mono | 100 à 700 |

- Le document d’édition n’accepte que ces familles. Le document résolu garde son motif générique, par compatibilité ascendante avec les manifests existants.
- Aucune police système n’est utilisée pour le rendu d’une composition.
- Les polices téléversées sont une extension future (CMP-003).

### Brouillon, versions et publication (CMP-007)

- **Brouillon** : `compositions.draft_document` et `draft_revision`. Chaque enregistrement fournit la révision lue.
  - Une révision périmée donne `409 COMPOSITION_CONFLICT`, sans écrasement (contrôle optimiste).
- **Publication** : elle crée `composition_versions(version n+1)`. Le document y est **immuable** : la table n’accorde pas `UPDATE` au rôle applicatif.
  - Elle matérialise les dépendances dans `content_dependencies` (`composition_version → media`).
- **Restauration d’une version** : crée une nouvelle version publiée n+1 au contenu identique, après une nouvelle validation, et remet le brouillon à ce contenu. L’historique n’est jamais réécrit.
- **Validation avant publication** (CMP-005, MED-007), en deux étapes :
  1. `lintCompositionDocument` (contrats, sans base) : identifiants uniques, média choisi, graisse disponible, intervalle vidéo, vidéos simultanées, sources audio, éléments hors canvas.
  2. Côté serveur : chaque média existe dans le tenant, est visible du périmètre de l’auteur, est `ready`, hors corbeille, et son type correspond à l’élément.
  - Une erreur bloque la publication (`422 COMPOSITION_INVALID`, liste d’anomalies avec l’élément concerné). Les avertissements sont affichés sans bloquer.
- Limites par composition **[à valider]** : 200 éléments, 2 vidéos simultanées. Ce sont des valeurs de départ, à qualifier par profil Player (REN-004, L06).

### Usages des médias (complète l’ADR-009)

`mediaUsages()` renvoie désormais :

- les **versions publiées** qui référencent le média (`content_dependencies`) ;
- les **brouillons** qui le référencent.

Seules les versions publiées exigent la suppression forcée (`content.force_delete`) : un brouillon ne diffuse rien. Sa publication échouera si le média a disparu.

### Templates (TPL-001 à TPL-003)

- Le catalogue plateforme V1 est **versionné avec le code** (`@pixlova/templates`) : chaque template a une clé, une version, une catégorie, des dimensions, un document d’édition et des placeholders.
  - La publication et le retrait par l’administration plateforme, avec stockage en base, relèvent de L09-A (ADM). Les tables `templates` et `template_versions` du modèle conceptuel y seront créées.
- Les templates n’emploient **aucun asset plateforme**. Les images (logo, photo) sont des placeholders à remplir avec un média de l’organisation : aucune copie d’asset entre tenants, et aucune dépendance inaccessible (TPL-002).
- La consultation et la preview sont ouvertes à tout membre, y compris en Free. L’**instanciation** exige le droit `templates` des entitlements, vérifié côté serveur : sinon `403 ENTITLEMENT_REQUIRED`.
  - Free : aucun droit `templates`. Offres payantes : L08.
- L’instanciation crée une composition indépendante qui trace `source_template_key` et `source_template_version`. Une nouvelle version du template ne modifie pas les copies.

### Preuve de rendu identique

- Des **fixtures de composition résolues** (`@pixlova/render-engine/fixtures`) couvrent paysage, portrait, bandeaux LED 2688×672 et 3840×480, et totem 768×2304. Elles combinent texte, formes, QR Code, horloge figée, images `contain`/`cover` et rotations.
- Le banc de rendu, en mode `measure`, rend chaque fixture à l’échelle 1 et relève :
  - la géométrie de chaque élément ;
  - la disponibilité des polices ;
  - le nombre de lignes des textes.

  Le relevé est comparé à la géométrie attendue, calculée par le moteur.
- Ce relevé est exécuté :
  - dans **Chromium** (preview et Player Web ; WebView2 du natif Windows) ;
  - dans le **prototype natif WebKitGTK**, sous Xvfb.
- Les deux relevés sont comparés : écart géométrique ≤ 1 px et même nombre de lignes. Le résultat est consigné dans `docs/quality/preuves/`.

## Conséquences

- Nouvelles tables `compositions`, `composition_versions`, `content_dependencies`, avec RLS tenant et FK composites.
- Le moteur dépend des paquets de polices Fontsource (OFL) ; les fichiers sont intégrés aux builds du dashboard, du banc et des Players.
- La CI exécute la comparaison Chromium / WebKitGTK à chaque changement.

## Vérification

- Contrats : validation du document d’édition, lint, résolution.
- API :
  - brouillon concurrent ;
  - publication refusée (média manquant, supprimé, d’un autre tenant, en préparation, de mauvais type ; police non qualifiée) ;
  - version immuable, restauration, usages ;
  - template refusé en Free et accepté avec droit ;
  - isolation entre organisations.
- Rendu : comparaison chiffrée Chromium / WebKitGTK sur toutes les fixtures ; test navigateur du créateur.
