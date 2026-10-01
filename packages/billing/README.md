# @pixlova/billing

Facturation pixlova ([ADR-017](../../docs/architecture/adr/0017-facturation-stripe-entitlements.md)) :

- `catalog` : validation et import versionné du catalogue d’offres, catalogue public sans identifiant Stripe ;
- `entitlements` : droits effectifs (actif, grâce, restreint, repli), fonction pure ;
- `gateway` / `stripe-gateway` : interface Stripe minimale et implémentation SDK (version d’API figée) ;
- `events` / `projection` : enregistrement des webhooks, relecture du client Stripe, réconciliation ;
- `access` : lecture des droits et de l’usage d’une organisation (sous RLS) ;
- `testing` : passerelle Stripe simulée avec vraie vérification de signature (tests uniquement).

`catalog/indicatif.json` reprend la grille indicative du cahier des charges (§11.1), sans prix Stripe : affichable, pas achetable. Les valeurs restent à valider par le responsable produit.

## Commandes

```sh
pnpm --filter @pixlova/billing test   # tests de base : PIXLOVA_TEST_DATABASE_URL (voir packages/db)
# Prix Stripe de TEST à partir d’un catalogue (refuse une clé de production) :
STRIPE_SECRET_KEY=sk_test_… node packages/billing/scripts/stripe-test-setup.mjs \
  packages/billing/catalog/indicatif.json > catalogue-test.json
```

Procédure de recette : [FACTURATION.md](../../docs/operations/FACTURATION.md).
