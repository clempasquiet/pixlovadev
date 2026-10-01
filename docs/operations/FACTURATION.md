# Facturation Stripe : recette en mode test

Décision : [ADR-017](../architecture/adr/0017-facturation-stripe-entitlements.md). Cette procédure branche un compte Stripe **de test** sur la recette Docker ([RECETTE.md](RECETTE.md)). Aucune clé de production n’est acceptée hors déploiement `production`.

## 1. Préparer Stripe (tableau de bord, mode test)

1. Récupérer la clé secrète de test (`sk_test_…`), ou une clé restreinte `rk_test_…` avec les droits :
   - Customers, Checkout Sessions, Subscriptions et Subscription schedules : écriture ;
   - Invoices : lecture (aperçu du prorata) ;
   - Customer portal : écriture ;
   - Test clocks : écriture (uniquement avec `PIXLOVA_STRIPE_TEST_CLOCKS=true`) ;
   - Products et Prices : écriture (provisionnement).
2. Créer un endpoint webhook vers `https://<recette>/webhooks/stripe`.
   - Version d’API : `2026-08-26.dahlia` (celle du SDK épinglé).
   - Événements : ceux de la liste ci-dessous.
   - Noter le secret de signature `whsec_…`.
3. Configurer le **Customer portal** :
   - factures, moyens de paiement et informations de facturation : activés ;
   - annulation : **désactivée** (pilotée par pixlova, avec le choix des Displays conservés) ;
   - changement de formule et de quantité : **désactivés** (pilotés par pixlova, BILL-007, BILL-011).

   Une annulation faite malgré tout hors de pixlova (portail mal configuré, tableau de bord Stripe) reste prise en compte ; aucun Display n’est alors désactivé au hasard : l’organisation passe en `over_capacity` jusqu’à son choix (DEC-20).

## 2. Configurer la recette

Dans `infra/recette/.env` :

```sh
STRIPE_SECRET_KEY=sk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…
# Chaque nouveau client Stripe reçoit sa propre horloge de test (échéances, relances)
PIXLOVA_STRIPE_TEST_CLOCKS=true
# Les quotas fixes masquent la facturation : les vider pour la recette billing.
PIXLOVA_DEV_MAX_USERS=
PIXLOVA_DEV_DISPLAY_SLOTS=
PIXLOVA_DEV_STORAGE_BYTES=
PIXLOVA_DEV_FEATURES=
```

Puis démarrer avec la sortie réseau vers Stripe, réservée à l’API et au worker :

```sh
docker compose -f infra/recette/compose.yaml -f infra/recette/compose.stripe.yaml up -d
```

## 3. Créer les prix de test et publier le catalogue

```sh
cd infra/recette
# Produits et prix Stripe de test, à partir de la grille indicative du dépôt
docker compose -f compose.yaml -f compose.stripe.yaml exec -T worker \
  node packages/billing/scripts/stripe-test-setup.mjs packages/billing/catalog/indicatif.json \
  > catalogue-test.json
# Publication (vérifier d’abord avec --dry-run)
docker compose -f compose.yaml exec -T admin \
  node apps/api/dist/admin-cli.js catalog-import --file - --dry-run < catalogue-test.json
docker compose -f compose.yaml exec -T admin \
  node apps/api/dist/admin-cli.js catalog-import --file - < catalogue-test.json
```

Le script est rejouable : il réutilise les prix existants (clé de recherche incluant le montant). Un import sans changement ne crée aucune version. Le catalogue publié se lit sur `https://<recette>/api/v1/billing/catalog`.

## 4. Scénarios de recette (critères du ticket #10)

Cartes de test Stripe : `4242 4242 4242 4242` (succès), `4000 0027 6000 3184` (SCA), `4000 0000 0000 0341` (échec au renouvellement).

| Scénario | Action | Attendu |
|---|---|---|
| Souscription | `POST /api/v1/billing/checkout-session` (`pro`, `month`, 4 extras), payer | `GET /billing/subscription` : `active`, 14 slots |
| Double clic | Deux requêtes rapprochées | Une seule session ; la seconde reçoit `409 BILLING_PENDING` |
| Abandon | Fermer Checkout | La demande reste `pending_payment`, puis `expired` à l’échéance |
| SCA | Carte 3184 | `pending` tant que non authentifié, puis `active` |
| Code promo | Créer un code dans Stripe, le saisir dans Checkout | Réduction visible dans Stripe ; ligne dans `promotion_redemptions` |
| Impayé | Carte 0341, avancer l’horloge de test Stripe | `grace`, puis `restricted` après la grâce, sans suppression |
| Régularisation | Mettre à jour le moyen de paiement via le portail | Retour à `active` |
| Hausse d’offre | Tableau de bord → Abonnement, `pro` → `business` ou +2 extras, « Voir le détail » puis « Confirmer et payer » | Prorata affiché égal à la facture Stripe ; droits étendus dès le paiement |
| Hausse refusée | Carte 0341 comme moyen par défaut, puis hausse | Paiement refusé : anciens droits conservés, demande `failed` (`payment_not_completed`) |
| Baisse d’offre | Retirer des extras alors que plus de Displays sont actifs | Choix des Displays exigé ; changement `scheduled` (schedule Stripe) jusqu’à l’échéance |
| Échéance de la baisse | Avancer l’horloge de test au-delà de la période | Nouvelle offre appliquée ; Displays non retenus `inactive` (programmation conservée), les autres recompilés |
| Renoncer | « Renoncer » sur un changement programmé | Schedule libéré ou annulation retirée ; demande `cancelled` (`withdrawn`) |
| Annulation | Abonnement → « Annuler l’abonnement », choix des Displays | `cancel_at_period_end` ; à l’échéance, offre `free`, Displays au-delà désactivés, contenus conservés |
| Annulation hors flux | Annuler depuis le tableau de bord Stripe | `free` à l’échéance, aucun Display désactivé, alerte `over_capacity` (DEC-20) |
| Webhook perdu | Désactiver l’endpoint, modifier l’abonnement, le réactiver | Corrigé à la réconciliation (≤ 6 h, ou immédiatement si le client est en erreur) |
| Doublon | « Renvoyer » un événement depuis le tableau de bord | Un seul effet ; l’événement est enregistré une fois |

Les **horloges de test** Stripe (Test clocks) font avancer échéances, renouvellements et relances sans attendre. Avec `PIXLOVA_STRIPE_TEST_CLOCKS=true`, chaque organisation qui souscrit reçoit une horloge nommée `pixlova <organisation>` : Stripe → Billing → Test clocks → « Advance time ». Seuls les clients créés après l’activation en ont une. Option refusée avec une clé live ou en déploiement `production`.

## 5. Événements Stripe traités

Chaque événement ci-dessous déclenche la relecture complète du client chez Stripe. Les autres types sont enregistrés puis marqués `ignored`.

| Événement | Effet |
|---|---|
| `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` | Projection de l’abonnement, suivi de la demande |
| `checkout.session.expired` | Demande close (`expired`) |
| `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`, `.pending_update_applied`, `.pending_update_expired` | Statut, offre, extras, période, annulation programmée |
| `subscription_schedule.canceled`, `.completed`, `.released` | Suivi des baisses programmées (appliquées ou abandonnées) |
| `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required` | Statut (`active`, `past_due`, `incomplete`), grâce |
| `customer.discount.created`, `.updated`, `.deleted` | Réductions relevées |
| `payment_method.attached`, `customer.updated` | Sans effet sur les droits ; relecture de contrôle |

## 6. Exploitation

- **État de synchronisation** : `GET /api/v1/billing/subscription` → `sync.status` (`ok`, `error`) et `sync.last_synced_at`. Le détail de l’erreur est dans `billing_customers.sync_error`, rôle système.
- **Événements** : table `stripe_webhook_events` (`received`, `processed`, `ignored`, `failed`). Un événement `failed` a épuisé ses tentatives ; la réconciliation rattrape l’état.
- **Rattrapage manuel** : relancer la tâche en échec depuis l’administration (Tâches), ou attendre le balayage.
- **Sans Stripe** : sans `STRIPE_SECRET_KEY`, le catalogue et les droits restent servis, les achats répondent `503 BILLING_UNAVAILABLE` et l’endpoint webhook `404`.

## Domaines cibles de production

Domaines fixés par le responsable produit le 2026-10-01. L’hébergement de production reste à décider : ce ne sont que des valeurs de configuration, aucune n’est codée en dur.

| Usage | Valeur cible |
|---|---|
| Endpoint webhook Stripe (mode live) | `https://api.pixlova.com/webhooks/stripe` |
| Retour de Checkout et du portail (`PIXLOVA_APP_BASE_URL`) | `https://app.pixlova.com` → `/billing?change=…` |
| Lecture du catalogue public par le site `www.pixlova.com` | `https://api.pixlova.com/api/v1/billing/catalog` (CORS ouvert, sans credentials) |

`pixlova.fr` redirige vers `www.pixlova.com` et n’intervient pas dans la facturation.

## Variables

| Variable | Rôle |
|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | API et worker ; vont ensemble. Clé `sk_live_` refusée hors `production` |
| `PIXLOVA_BILLING_ENVIRONMENT` | `test` ou `live` ; conteneur d’administration (sans clé) |
| `PIXLOVA_BILLING_GRACE_DAYS` | Grâce d’un impayé, 7 jours par défaut **[à valider]** |
| `PIXLOVA_STRIPE_TEST_CLOCKS` | `true` : horloge de test Stripe par nouveau client (recette) ; refusé en `production` ou avec une clé live |
| `PIXLOVA_BILLING_CHECKOUT_MINUTES` | Validité d’une session Checkout, 60 min par défaut (30 min à 24 h) |
