# @pixlova/api

API Fastify à deux listeners ([ADR-002](../../docs/architecture/adr/0002-backend-api-orm-jobs.md)) :

- **public** : `/health`, `/api/v1` (dashboard, session par cookie), `/player/v1` ; `/storage/v1` seulement avec le pilote de stockage local (développement) ;
- **interne** : `/internal/v1`, réseau privé uniquement.

## Routes `/api/v1` disponibles (L01 à L05)

| Domaine | Routes |
|---|---|
| Compte | `POST /auth/register`, `/auth/verify-email`, `/auth/verify-email/resend`, `/auth/login`, `/auth/logout`, `/auth/reauthenticate`, `/auth/password/change`, `/auth/password-reset/request`, `/auth/password-reset/confirm` ; `GET /auth/me` |
| Sessions | `GET /auth/sessions`, `DELETE /auth/sessions/:id`, `POST /auth/sessions/revoke-all` |
| MFA | `POST /auth/mfa/enroll`, `/auth/mfa/confirm`, `/auth/mfa/verify`, `/auth/mfa/disable` |
| Organisations | `POST /organizations`, `GET/PATCH /organizations/:id`, `GET /permissions` |
| Sites | `GET/POST /sites`, `PATCH /sites/:id` |
| Membres | `GET /members`, `PUT /members/:id/grants`, `DELETE /members/:id` |
| Invitations | `GET/POST /invitations`, `POST /invitations/:id/revoke`, `/invitations/:id/resend`, `/invitations/accept` |
| Parc | `POST /players/pair` (Idempotency-Key), `GET /players`, `PATCH /players/:id`, `POST /players/:id/revoke` |
| Displays | `GET/POST /displays`, `GET/PATCH /displays/:id`, `PUT/DELETE /displays/:id/assignment` (Idempotency-Key) |
| Groupes | `GET/POST /display-groups`, `PUT /display-groups/:id/members` |
| Médias (L03, [ADR-009](../../docs/architecture/adr/0009-bibliotheque-media-stockage-pipeline.md)) | `POST /media/upload-session` (Idempotency-Key), `/media/upload-session/:id/complete`, `/media/upload-session/:id/abort` ; `GET /media?folder_id=&type=&status=&tag=&q=&trash=&limit=&cursor=`, `GET /media/usage`, `GET/PATCH/DELETE /media/:id`, `GET /media/:id/usages`, `GET /media/:id/assets/:variant/url`, `POST /media/:id/restore`, `/media/:id/purge`, `/media/:id/retry` |
| Dossiers et tags | `GET/POST /media-folders`, `PATCH/DELETE /media-folders/:id`, `GET /tags` |
| Compositions (L04, [ADR-010](../../docs/architecture/adr/0010-compositions-editeur-templates.md)) | `GET/POST /compositions` (Idempotency-Key), `GET/DELETE /compositions/:id`, `PUT /compositions/:id/draft` (révision), `POST /compositions/:id/publish`, `GET /compositions/:id/versions`, `GET /compositions/:id/versions/:version`, `POST /compositions/:id/restore-version`, `POST /compositions/:id/duplicate` |
| Templates | `GET /templates`, `POST /templates/:key/instantiate` (Idempotency-Key, droit `templates`) |
| Playlists (L05, [ADR-011](../../docs/architecture/adr/0011-programmation-compilation-manifests.md)) | `GET/POST /playlists` (Idempotency-Key), `GET/DELETE /playlists/:id`, `PUT /playlists/:id/draft` (révision), `POST /playlists/:id/publish` (idempotente), `GET /playlists/:id/versions`, `POST /playlists/:id/duplicate` |
| Plannings et campagnes | `GET/POST /schedules`, `GET/DELETE /schedules/:id`, `PUT /schedules/:id/draft`, `POST /schedules/:id/publish`, `/schedules/:id/deactivate`, `GET /schedules/:id/versions` ; mêmes routes sous `/campaigns`, arrêt par `POST /campaigns/:id/cancel` ; `POST /targets/preview` |
| Diffusion immédiate | `POST /overrides` (Idempotency-Key ; priorité 100 : droit `override.emergency`), `GET /overrides?active=true`, `POST /overrides/:id/cancel` |
| Programme d’un Display | `PUT /displays/:id/fallback`, `GET /displays/:id/effective-program?from=&until=` (31 jours au plus), `GET /displays/:id/delivery`, `GET /displays/:id/compilations/:compilationId` |
| Audit | `GET /audit?limit=&cursor=` |

## Routes `/player/v1` (L02, [ADR-008](../../docs/architecture/adr/0008-appairage-players-displays.md))

`POST /register`, `/pair`, `/token/challenge`, `/token/refresh` (sans jeton) ; `GET /config`, `POST /outputs`, `/heartbeat` (en-tête `Authorization: Bearer`).

Manifests (L05, [ADR-011](../../docs/architecture/adr/0011-programmation-compilation-manifests.md)) : `GET /manifest?display_id=` (ETag, `304`), `GET /manifests/:id`, `GET /assets/:id/url?manifest_id=` (URL signée courte, jamais journalisée), `POST /manifests/:id/status` (préparé, appliqué, échec : déclarés par le Player). Seule l’affectation active, à sa génération courante, y donne accès.

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
| `PIXLOVA_DEV_MAX_USERS`, `PIXLOVA_DEV_DISPLAY_SLOTS`, `PIXLOVA_DEV_STORAGE_BYTES`, `PIXLOVA_DEV_FEATURES` | Quotas et fonctionnalités de développement avant L08, par ex. `PIXLOVA_DEV_FEATURES=templates` (refusés en production) |
| `PIXLOVA_STORAGE_DRIVER` | `s3` (production) ou `local` (développement, refusé en production) |
| `PIXLOVA_STORAGE_LOCAL_ROOT`, `PIXLOVA_STORAGE_LOCAL_SECRET`, `PIXLOVA_STORAGE_PUBLIC_URL` | Pilote local : répertoire, secret HMAC des URLs signées, origine publique facultative |
| `PIXLOVA_S3_BUCKET`, `PIXLOVA_S3_REGION`, `PIXLOVA_S3_ENDPOINT`, `PIXLOVA_S3_PUBLIC_ENDPOINT`, `PIXLOVA_S3_FORCE_PATH_STYLE`, `PIXLOVA_S3_ACCESS_KEY_ID`, `PIXLOVA_S3_SECRET_ACCESS_KEY` | Pilote S3 compatible (fournisseur choisi avec L09-I) |
| `PIXLOVA_MEDIA_TRASH_RETENTION_DAYS`, `PIXLOVA_MEDIA_UPLOAD_URL_MINUTES`, `PIXLOVA_MEDIA_PREVIEW_URL_SECONDS` | Corbeille (30 j), URL d’envoi (15 min), URL d’aperçu (300 s) |
| `PIXLOVA_PAIRING_CODE_MINUTES`, `PIXLOVA_PLAYER_TOKEN_MINUTES`, `PIXLOVA_HEARTBEAT_SECONDS`, `PIXLOVA_PRESENCE_TIMEOUT_SECONDS` | Durées Player (5 min, 15 min, 30 s, 90 s) |
| `PIXLOVA_TRUST_PROXY` | `true` derrière la passerelle de confiance (adresse IP client) |

## Tests

```sh
PIXLOVA_TEST_DATABASE_URL=postgres://admin:pass@127.0.0.1:5432/postgres pnpm --filter @pixlova/api test
```

Les tests d’intégration créent une base éphémère par fichier (rôles, migrations, deux organisations de test) ; sans la variable, ils sont ignorés localement et échouent en CI.
