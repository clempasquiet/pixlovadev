# ADR-017 — Facturation : catalogue versionné, projection Stripe et droits effectifs

- Statut : acceptée (socle technique) ; valeurs commerciales **à valider**
- Date : 2026-10-01
- Ticket / lot : [L08 #10](https://github.com/clempasquiet/pixlovadev/issues/10)
- Exigences concernées : BILL-001 à BILL-015, BILL-017, BILL-019, ADM-004, DATA-007, DATA-008, API-005, PROD-004, PROD-005, SEC-016, TST-052, DEC-02, DEC-03, DEC-04, DEC-19, DEC-20
- Décision remplaçant / remplacée par : complète l’[ADR-007](0007-rbac-scopes.md) (`EntitlementsProvider`) et l’[ADR-015](0015-infrastructure-recette.md) (sortie réseau vers Stripe)

## Problème et contraintes

Les quotas (Displays, utilisateurs, stockage, templates) étaient fixés à l’offre Free ou par des variables `PIXLOVA_DEV_*`. L08 doit les dériver d’un abonnement Stripe sans faire de Stripe une dépendance de chaque action. Contraintes :

- Stripe est la référence financière ; les droits locaux gouvernent les accès (invariant 6). Aucun appel Stripe par action utilisateur (BILL-009).
- Le retour navigateur de Checkout ne prouve pas un paiement (BILL-008).
- Les webhooks peuvent être dupliqués, perdus ou désordonnés (BILL-010).
- Un downgrade, un impayé ou une résiliation ne suppriment aucune donnée (BILL-013, TST-052).
- Les noms d’offre ne servent jamais de condition (BILL-001). Les prix et quotas sont indicatifs (DEC-02, DEC-03).
- Aucun vrai débit ni catalogue de production dans ce lot.

## Décision

### Catalogue versionné

- Tables globales `plans` et `plan_prices`. Une offre porte ses capacités : slots inclus, maximum de slots supplémentaires, `entitlements` JSON validé par le contrat partagé `plan-entitlements.json` (`max_users`, `storage_quota_bytes`, `features`).
- Un import (`admin-cli catalog-import`, rôle `pixlova_platform`, audité) compare chaque offre à sa version publiée. Une offre modifiée devient une **nouvelle version** ; l’ancienne est archivée et ses prix désactivés.
- Un abonnement reste lié à sa version tant que son prix de base Stripe ne change pas (BILL-005).
- Une offre de repli (`is_fallback`) s’applique sans abonnement payant. À défaut, l’offre Free intégrée (1 Display, 1 utilisateur, 2 Go) s’applique.
- Un prix sans identifiant Stripe est affiché mais pas achetable. Le dépôt livre ainsi `packages/billing/catalog/indicatif.json` (grille du §11.1, mensuel seulement, `indicative: true`).
- `GET /api/v1/billing/catalog` est **public** : sans session, sans identifiant Stripe, mis en cache 5 min, CORS ouvert. Le site commercial (L09-M) le consomme ; son schéma est `billing-catalog.json`.

### Achat et suivi

- `POST /billing/checkout-session` exige `billing.manage`, la MFA des administrateurs et `Idempotency-Key`.
  - La demande est d’abord enregistrée dans `billing_changes` (clé durable, empreinte de la requête), sous verrou de l’organisation.
  - Les appels Stripe se font ensuite, hors transaction, avec des clés d’idempotence dérivées : client `pixlova:customer:<env>:<org>`, session `pixlova:checkout:<demande>`.
  - Un index unique partiel limite à une souscription ouverte par organisation (double clic, deux onglets). Une session échue ou une demande sans session depuis 2 min libère la place.
  - Prix et quantités viennent du catalogue serveur. `allow_promotion_codes` est activé (BILL-017).
- `GET /billing/changes/:id` relit Stripe avant de répondre au retour de Checkout. Il n’accorde rien lui-même.
- `POST /billing/portal-session` ouvre le Billing Portal pour les factures et le moyen de paiement. Les changements de formule, de slots et l’annulation n’y sont pas configurés : pixlova les pilote (ci-dessous), pour imposer le choix des Displays.

### Modification d’un abonnement (tranche 2)

- `POST /billing/subscription/preview` montre, sans effet :
  - l’ancien et le nouveau montant récurrent ;
  - le montant dû immédiatement, calculé par Stripe (`invoices.createPreview`) ;
  - la date d’effet et la prochaine échéance ;
  - la capacité future et la nécessité de choisir des Displays ;
  - les dépassements d’utilisateurs ou de stockage qui seront conservés (BILL-004, BILL-011, BILL-013).
- **Hausse** : un montant supérieur sans aucune capacité réduite.
  - Elle est immédiate, facturée au prorata (`always_invoice`) à la date de prorata de la prévisualisation (30 min de validité).
  - Avec `pending_if_incomplete`, Stripe n’applique les nouvelles lignes qu’après paiement (SCA, refus). Les droits restent ceux payés.
  - La demande passe `pending_payment`, puis `applied` quand la projection lit les nouvelles lignes, ou `failed` quand la mise à jour expire.
- **Baisse** : toute autre modification. Elle prend effet à l’échéance, sans prorata, par une planification Stripe (`subscription_schedules`, phase suivante, puis relâchée).
  - Les droits payés restent en place jusqu’à l’échéance.
- **Annulation** (`POST /billing/subscription/cancel`) : `cancel_at_period_end`, puis retour à l’offre de repli à l’échéance (BILL-014).
- **Choix des Displays** (BILL-012, BILL-014) :
  - Si la capacité future est inférieure aux Displays actifs, la baisse et l’annulation exigent `keep_display_ids` : des Displays actifs de l’organisation, au plus la capacité future.
  - Le choix reste modifiable (`PUT /billing/changes/:id/selection`) et chaque modification est auditée.
  - À l’échéance, le worker revérifie le choix. Les Displays non retenus passent `inactive` et sont recompilés : ils ne diffusent plus, sans suppression ni perte de programmation (BILL-013).
  - Un choix devenu invalide n’entraîne aucune désactivation (`selection_status = invalid`, audit).
- **Renoncer** (`DELETE /billing/changes/:id`) relâche la planification ou lève l’annulation avant l’échéance.
- **Concurrence** : une seule modification ouverte par organisation (index unique partiel). Chaque demande est enregistrée sous `Idempotency-Key` avant l’appel Stripe, qui reçoit une clé dérivée de la demande.
- **Annulation hors parcours** (portail, tableau de bord Stripe, DEC-20) : aucun Display n’est choisi au hasard. Tous restent actifs, le dépassement est signalé (`over_capacity`) et bloque les nouvelles activations.
  - La préférence `preferred_free_display_id` et la suspension des nouvelles publications proposées par DEC-20 restent **à ratifier**.
- Le changement de périodicité ou de devise est refusé tant qu’aucun tarif annuel n’est validé (BILL-016).
- Validé par le responsable produit le 2026-10-01 : hausse immédiate, baisse et annulation à l’échéance, annulation hors parcours sans désactivation (`over_capacity`).

### Projection et webhooks

- `POST /webhooks/stripe`, endpoint public hors `/api` : pas de cookie ni de CSRF. La signature est vérifiée sur le corps brut (SDK `stripe` 22.6.2, API `2026-08-26.dahlia` figée). L’événement est stocké dans `stripe_webhook_events`, unique par (environnement, identifiant), et une tâche est créée dans la même transaction. La réponse 200 est immédiate.
- Le worker traite l’événement en **relisant chez Stripe l’état complet du client** (`subscriptions.list`, statut `all`, réductions développées). L’effet ne dépend donc ni de l’ordre ni du nombre de réceptions. Les synchronisations d’un même client sont sérialisées par le verrou de sa ligne `billing_customers` ; la lecture Stripe est faite sous ce verrou, qui ne bloque pas les lectures de droits.
- La projection (`subscriptions`, `promotion_redemptions`, état de synchronisation) n’est écrite que par le rôle système. Le rôle applicatif ne peut que la lire : l’API ne peut pas s’accorder de droits.
- Chaque changement de statut, d’offre, de slots ou d’annulation programmée est audité (acteur système).
- **Réconciliation** : toutes les 6 h, et immédiatement pour un client en erreur ou avec une demande ouverte, le worker relit le client. Un webhook perdu est ainsi corrigé.
- Une erreur Stripe conserve la projection précédente et rend l’erreur visible (`sync.status = error`). Un prix inconnu du catalogue est traité de la même façon.
- Le contenu des événements est effacé après 30 jours ; la ligne reste pour la déduplication.

### Droits effectifs

`effectiveEntitlements` (fonction pure) calcule l’état présenté et les capacités :

| Statut Stripe | État | Droits appliqués |
|---|---|---|
| `active`, `trialing` | `active` | Offre souscrite + extras (bornés par l’offre) |
| `past_due` avant `grace_until` | `grace` | Offre souscrite |
| `past_due` après la grâce, `unpaid`, `paused` | `restricted` | Offre de repli |
| `incomplete` | `pending` | Offre de repli |
| `canceled`, `incomplete_expired`, aucun | `free` | Offre de repli |

- `grace_until` est fixé au premier passage en `past_due` (7 jours par défaut, `PIXLOVA_BILLING_GRACE_DAYS`, **à valider**, DEC-04). Il est effacé à la régularisation.
- Les droits de repli s’appliquent **aux nouvelles opérations** : activation de Display, invitation, envoi de média, instanciation de template. Rien n’est supprimé, désactivé ni choisi au hasard. Les Displays déjà actifs le restent et `display_slots.over_capacity` le signale.
- `projectedEntitlements` implémente l’`EntitlementsProvider` existant. Les contrôles de quota de L01 à L04 l’utilisent sans modification. `PIXLOVA_DEV_*` reste prioritaire hors production, pour les recettes sans Stripe.

### Environnements et sécurité

- Le mode vient de la clé (`sk_test_` / `sk_live_`). Une clé de production est refusée hors déploiement `production`, par l’API comme par le worker.
- Le conteneur d’administration ne détient pas la clé : il lit `PIXLOVA_BILLING_ENVIRONMENT`.
- En recette, l’accès sortant à Stripe est **opt-in** (`compose.stripe.yaml`). Il ajoute un réseau de sortie à l’API et au worker seulement ; la base, Redis et le stockage restent sans Internet.

## Options évaluées

- **Appliquer directement le contenu des webhooks** : plus simple, mais exposé au désordre et aux pertes ; il exige un ordonnancement que `created` ne garantit pas (BILL-010). La relecture coûte un appel Stripe par événement, acceptable au volume V1.
- **Une table par ligne d’abonnement (`subscription_items`)** et **`plan_entitlements` clé/valeur** (modèle de référence §16) : la V1 n’a que deux lignes (base, slot supplémentaire). Les colonnes `stripe_base_item_id` / `stripe_extra_item_id` et un JSON validé par contrat suffisent. On passera au modèle détaillé avec les add-ons.
- **Licences par Display (`display_licenses`)** : le comptage des Displays actifs sous verrou de l’organisation (ADR-008) garantit déjà « pas de dépassement concurrent ». Les licences nominatives arrivent si des sources partenaires ou dérogatoires l’exigent.
- **Retirer des Displays automatiquement en fin de grâce ou à l’annulation** : interdit sans sélection explicite (BILL-012).
- **Baisse par mise à jour immédiate sans prorata** : plus simple que la planification, mais la projection lirait aussitôt les nouvelles lignes et retirerait des droits déjà payés. La planification Stripe porte la date d’effet.
- **Changements dans le Billing Portal** : le portail ne demande pas quels Displays conserver ; il reste limité aux factures et au moyen de paiement.

## Conséquences et validation

- Migrations additives :
  - `0017_billing` (tables, RLS, contraintes) et `0018_billing_grants` (droits par rôle) ;
  - `0019_billing_plan_changes` (types de demande, sélection, planification, hausse en attente) et `0020_billing_plan_changes_grants`. Retour arrière : arrêter l’usage (sans clé Stripe, les achats répondent 503 et l’offre de repli s’applique). Les tables peuvent rester.
- Tests réels sur PostgreSQL 16 (`apps/api/test/billing.integration.test.ts`, `packages/billing/test/*`), avec un Stripe simulé qui vérifie les vraies signatures du SDK. Ils couvrent :
  - catalogue public, versions et repli ;
  - Free par défaut, clé d’idempotence, rejeu, conflit, double clic concurrent ;
  - retour navigateur sans effet, isolation entre organisations ;
  - signature absente ou altérée, paiement avec code promo audité, événement dupliqué, événements désordonnés ;
  - grâce puis restriction sans suppression, régularisation ;
  - panne Stripe et reprise, webhook perdu corrigé par réconciliation, résiliation sans effacement ;
  - prix inconnu, session expirée, portail, instance sans Stripe ;
  - synchronisations concurrentes d’un même client.
- Tranche 2 (`apps/api/test/billing-changes.integration.test.ts`, `apps/dashboard/test/e2e/billing.browser.test.ts`, console d’administration). Elle couvre :
  - prévisualisation et prorata, hausse rejouable sans double appel ;
  - prévisualisation expirée, paiement refusé puis expiré sans changement de droits ;
  - choix des Displays obligatoire, borné et limité à l’organisation ;
  - baisse programmée sans perte de droits, choix modifiable ;
  - application à l’échéance sans suppression, avec recompilation ;
  - annulation retirée puis effective ;
  - annulation hors parcours sans désactivation ;
  - vue BillingAdmin et refus au rôle Support ;
  - parcours complet dans Chromium.
- **Non couvert (à suivre)** :
  - dérogations (`entitlement_overrides`) et actions de facturation de l’administration ;
  - préférence d’écran DEC-20 ;
  - règles fines DEC-19 (édition et publication des fonctions retirées) ;
  - tests en **sandbox Stripe réelle**, dont planification et SCA (procédure : [FACTURATION.md](../../operations/FACTURATION.md)).
- **À valider par le responsable produit avant toute mise en vente** :
  - prix, quotas et nombre d’utilisateurs Business (100 est une valeur de travail, le cahier des charges indique « À fixer ») ;
  - durée de grâce et politique de fin d’impayé (DEC-04) ;
  - tarif annuel et essai (BILL-016) ;
  - taxes et mentions.
