# Console d’administration plateforme

Console React de l’équipe pixlova ([ADR-016](../../docs/architecture/adr/0016-administration-plateforme.md)), servie par le serveur d’administration (`apps/api/src/admin-server.ts`) sur un listener privé. Jamais servie par la passerelle publique ni par un hostname public.

```sh
pnpm --filter @pixlova/admin-console run build          # dist/, servi par le conteneur admin
pnpm --filter @pixlova/admin-console run dev            # Vite (5174), relaie /admin-api vers 127.0.0.1:8081
pnpm --filter @pixlova/admin-console run test:browser   # Chromium + serveur admin + PostgreSQL réels (PIXLOVA_TEST_DATABASE_URL)
```

- Connexion : mot de passe puis TOTP, obligatoires ; activation par code à usage unique.
- Chaque consultation d’organisation ou de compte demande un motif ; les actions sensibles redemandent un code TOTP.
- La navigation reflète les permissions renvoyées par le serveur, qui les contrôle à chaque requête.
- Données absentes affichées comme indisponibles (abonnements avant L08, registre de releases).
