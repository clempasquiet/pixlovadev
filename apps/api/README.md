# @pixlova/api

API Fastify à deux listeners ([ADR-002](../../docs/architecture/adr/0002-backend-api-orm-jobs.md)) :

- **public** : `/health`, `/api/v1` (dashboard, session par cookie) ;
- **interne** : `/internal/v1`, réseau privé uniquement.

## Routes `/api/v1` disponibles (L01)

| Domaine | Routes |
|---|---|
| Compte | `POST /auth/register`, `/auth/verify-email`, `/auth/verify-email/resend`, `/auth/login`, `/auth/logout`, `/auth/reauthenticate`, `/auth/password/change`, `/auth/password-reset/request`, `/auth/password-reset/confirm` ; `GET /auth/me` |
| Sessions | `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-all` |
| MFA | `POST /auth/mfa/enroll`, `/auth/mfa/confirm`, `/auth/mfa/verify`, `/auth/mfa/disable` |
| Organisations | `POST /organizations`, `GET/PATCH /organizations/:id`, `GET /permissions` |
| Sites | `GET/POST /sites`, `PATCH /sites/:id` |
| Membres | `GET /members`, `PUT /members/:id/grants`, `DELETE /members/:id` |
| Invitations | `GET/POST /invitations`, `POST /invitations/:id/revoke`, `/invitations/:id/resend`, `/invitations/accept` |
| Audit | `GET /audit?limit=&cursor=` |

- Les routes d’une organisation exigent l’en-tête `x-organization-id`.
- Les requêtes modifiantes exigent un en-tête `Origin` autorisé.
- Les erreurs suivent l’enveloppe API-006 (codes dans `@pixlova/contracts`).
- Règles de sécurité : [ADR-006](../../docs/architecture/adr/0006-authentification-sessions.md) et [ADR-007](../../docs/architecture/adr/0007-rbac-scopes.md).

## Configuration

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Connexion rôle `pixlova_app` (soumis à RLS) |
| `DATABASE_SYSTEM_URL` | Connexion rôle `pixlova_system` (opérations inter-tenants nommées) |
| `PIXLOVA_DATA_KEYS` | Clés AES-256 `kid:base64` séparées par des virgules ; la première chiffre |
| `REDIS_URL` | Limitation de débit partagée ; obligatoire en production |
| `PIXLOVA_APP_BASE_URL`, `PIXLOVA_ALLOWED_ORIGINS` | Liens des emails ; origines acceptées (CSRF) |
| `PIXLOVA_COOKIE_SECURE` | `false` uniquement en développement HTTP |
| `PIXLOVA_SESSION_IDLE_HOURS`, `PIXLOVA_SESSION_ABSOLUTE_DAYS`, `PIXLOVA_RECENT_AUTH_MINUTES` | Durées de session |
| `PIXLOVA_REQUIRE_MFA_FOR_ADMINS` | MFA exigée des administrateurs pour les actions sensibles (défaut `true`) |
| `PIXLOVA_MAILER=console` | Emails affichés dans la console (développement ; refusé en production) |
| `PIXLOVA_DEV_MAX_USERS` | Quota d’utilisateurs de développement avant L08 (refusé en production) |
| `PIXLOVA_TRUST_PROXY` | `true` derrière la passerelle de confiance (adresse IP client) |

## Tests

```sh
PIXLOVA_TEST_DATABASE_URL=postgres://admin:pass@127.0.0.1:5432/postgres pnpm --filter @pixlova/api test
```

Les tests d’intégration créent une base éphémère par fichier (rôles, migrations, deux organisations de test) ; sans la variable, ils sont ignorés localement et échouent en CI.
