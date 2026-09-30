# @pixlova/db

Schéma PostgreSQL (Drizzle), migrations SQL relues et accès sous contexte tenant. Décision : [ADR-004](../../docs/architecture/adr/0004-schema-migrations-isolation-tenant.md).

```sh
# Tests contre un PostgreSQL de test (compte administrateur jetable, jamais une base réelle)
PIXLOVA_TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/postgres pnpm --filter @pixlova/db test

# Après modification de src/schema : générer puis relire la migration
pnpm --filter @pixlova/db migrations:generate
pnpm --filter @pixlova/db migrations:check
```

Sans `PIXLOVA_TEST_DATABASE_URL`, les tests de base sont ignorés en local et échouent en CI (`CI=true`).
