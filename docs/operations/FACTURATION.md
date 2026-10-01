# Facturation Stripe : recette en mode test

Décision : [ADR-017](../architecture/adr/0017-facturation-stripe-entitlements.md). Cette procédure branche un compte Stripe **de test** sur la recette Docker ([RECETTE.md](RECETTE.md)). Aucune clé de production n’est acceptée hors déploiement `production`.

## 1. Préparer Stripe (tableau de bord, mode test)

1. Récupérer la clé secrète de test (`sk_test_…`), ou une clé restreinte `rk_test_…` avec les droits :
   - Customers, Checkout Sessions et Subscriptions : écriture ;
   - Customer portal : écriture ;
   - Products et Prices : écriture (provisionnement).
2. Créer un endpoint webhook vers `https://<recette>/webhooks/stripe`.
   - Version d’API : `2026-08-26.dahlia` (celle du SDK épinglé).
   - Événements : ceux de la liste ci-dessous.
   - Noter le secret de signature `whsec_…`.
3. Configurer le **Customer portal** :
   - factures, moyens de paiement et informations de facturation : activés ;
   - annulation : en fin de période ;
   - changement de formule et de quantité : **désactivés** (pilotés par pixlova, BILL-007).

## 2. Configurer la recette

Dans `infra/recette/.env` :

```sh
STRIPE_SECRET_KEY=sk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…
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
| Annulation | Portail, annulation en fin de période | `cancel_at_period_end`, puis `free` ; Displays et contenus conservés |
| Webhook perdu | Désactiver l’endpoint, modifier l’abonnement, le réactiver | Corrigé à la réconciliation (≤ 6 h, ou immédiatement si le client est en erreur) |
| Doublon | « Renvoyer » un événement depuis le tableau de bord | Un seul effet ; l’événement est enregistré une fois |

Les **horloges de test** Stripe (Test clocks) font avancer renouvellements et relances sans attendre.

## 5. Événements Stripe traités

Chaque événement ci-dessous déclenche la relecture complète du client chez Stripe. Les autres types sont enregistrés puis marqués `ignored`.

| Événement | Effet |
|---|---|
| `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` | Projection de l’abonnement, suivi de la demande |
| `checkout.session.expired` | Demande close (`expired`) |
| `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`, `.pending_update_applied`, `.pending_update_expired` | Statut, offre, extras, période, annulation programmée |
| `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required` | Statut (`active`, `past_due`, `incomplete`), grâce |
| `customer.discount.created`, `.updated`, `.deleted` | Réductions relevées |
| `payment_method.attached`, `customer.updated` | Sans effet sur les droits ; relecture de contrôle |

## 6. Exploitation

- **État de synchronisation** : `GET /api/v1/billing/subscription` → `sync.status` (`ok`, `error`) et `sync.last_synced_at`. Le détail de l’erreur est dans `billing_customers.sync_error`, rôle système.
- **Événements** : table `stripe_webhook_events` (`received`, `processed`, `ignored`, `failed`). Un événement `failed` a épuisé ses tentatives ; la réconciliation rattrape l’état.
- **Rattrapage manuel** : relancer la tâche en échec depuis l’administration (Tâches), ou attendre le balayage.
- **Sans Stripe** : sans `STRIPE_SECRET_KEY`, le catalogue et les droits restent servis, les achats répondent `503 BILLING_UNAVAILABLE` et l’endpoint webhook `404`.

## Variables

| Variable | Rôle |
|---|---|
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | API et worker ; vont ensemble. Clé `sk_live_` refusée hors `production` |
| `PIXLOVA_BILLING_ENVIRONMENT` | `test` ou `live` ; conteneur d’administration (sans clé) |
| `PIXLOVA_BILLING_GRACE_DAYS` | Grâce d’un impayé, 7 jours par défaut **[à valider]** |
| `PIXLOVA_BILLING_CHECKOUT_MINUTES` | Validité d’une session Checkout, 60 min par défaut (30 min à 24 h) |
