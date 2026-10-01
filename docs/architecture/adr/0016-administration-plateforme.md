# ADR-016 — Administration plateforme privée et support audité

- Statut : acceptée. La matrice des rôles, les durées de session et la visibilité des consultations par les clients sont **[à valider]** par le responsable produit.
- Date : 2026-09-30
- Ticket / lot : [L09-A #12](https://github.com/clempasquiet/pixlovadev/issues/12)
- Exigences concernées : PROD-005, OBS-012, DOC-021, ADM-001 à ADM-006, SEC-016
- Décision remplaçant / remplacée par : complète l’[ADR-006](0006-authentification-sessions.md) (procédure support de récupération sans code de secours), l’[ADR-007](0007-rbac-scopes.md) (rôles d’organisation) et l’[ADR-015](0015-infrastructure-recette.md) (réseau privé)

## Problème et contraintes

L’équipe pixlova doit pouvoir diagnostiquer les organisations, aider un client bloqué et exploiter la plateforme. Le cahier des charges fixe les garde-fous :

- une identité et une interface distinctes des clients ;
- une administration jamais publique ;
- le MFA obligatoire ;
- aucune impersonation en V1 ;
- des consultations et des actions motivées, limitées au besoin et auditées ;
- aucune donnée simulée.

## Décision

### Identités et rôles séparés (ADM-002)

- **Comptes opérateurs.** Ils vivent dans des tables `platform_*` (migration 0015), sans lien avec `users` ni avec les appartenances d’organisation.
- **Rôles plateforme.** Leurs clés sont `super_admin`, `support`, `billing_admin`, `operations` et `content_admin`. Les libellés reprennent ceux du cahier des charges. Ces clés ne reprennent jamais une clé de rôle d’organisation : un rôle tenant s’appelle déjà `Operator`, collision détectée par test.
  - `platformCan()` (`@pixlova/permissions`) ignore toute autre valeur : un Owner n’obtient aucun droit plateforme.
- **Matrice proposée [à valider].**

| Rôle | Permissions |
|---|---|
| SuperAdmin | Toutes, dont gestion de l’équipe, réinitialisation du second facteur et désactivation d’un compte client |
| Support | Organisations et diagnostic du parc, droits appliqués, recherche d’un compte par adresse exacte, révocation des sessions, incidents, tâches en échec |
| BillingAdmin | Organisations et droits appliqués ; facturation en lecture (`platform.billing.read` : abonnements, demandes, codes promotionnels, événements Stripe, [ADR-017](0017-facturation-stripe-entitlements.md)) |
| Operator (`operations`) | Santé, organisations et parc, incidents, tâches en échec et relance |
| ContentAdmin | Catalogue de templates (versionné avec le code, ADR-010) |

- **Relecture des rôles.** Ils sont relus en base à chaque requête : un retrait ou une désactivation s’appliquent immédiatement.

### Authentification

- **Premier accès.** Un code d’activation à usage unique est émis :
  - pour le premier SuperAdmin, par l’outil serveur `admin-cli` ;
  - ensuite, par un SuperAdmin dans la console.

  Il est affiché une seule fois, transmis hors bande et jamais envoyé par email. L’opérateur choisit un mot de passe (règles de l’ADR-006, Argon2id), puis enrôle un TOTP. Tant que le TOTP n’est pas confirmé, le compte reste `pending` et n’a aucun droit.
- **Connexion.** Elle exige toujours le mot de passe puis le TOTP, avec anti-rejeu par pas. Il n’y a pas de codes de secours : en cas de perte, un SuperAdmin (ou `admin-cli reset-operator`) émet un nouveau code, ce qui retire mot de passe, TOTP et sessions.
- **Sessions.** Le cookie `__Host-pixlova_admin` est `HttpOnly`, `Secure` et `SameSite=Strict`. Durées **[à valider]** : 30 min d’inactivité, 8 h au plus. Les actions dangereuses exigent un TOTP ressaisi depuis moins de 5 min.
- **Protections.** CSRF par origine. Limitation des tentatives par compte, par IP et par session.
- **Chiffrement.** Les secrets TOTP sont chiffrés avec un contexte propre aux opérateurs.

### Réseau et déploiement (ADM-001)

- **Conteneur.** L’administration tourne dans un conteneur distinct `admin` : même code que l’API, point d’entrée `admin-server.js`, console React `apps/admin-console`. Elle écoute sur 8081.
- **Routes.** Le listener public refuse l’enregistrement de toute route `/admin-api` ; l’application d’administration refuse `/api`, `/player` et `/internal`.
- **Exposition en recette.** Le port est publié sur `127.0.0.1` seulement, avec un accès par tunnel SSH. La passerelle publique ne peut pas joindre le conteneur : pas de réseau commun, vérifié. La cible d’accès distant reste une route privée Cloudflare avec poste enrôlé (Cloudflare One) ; elle n’est pas configurée par ce lot et ne doit jamais devenir un hostname public.
- **En-têtes.** CSP stricte (`default-src 'self'`, `frame-ancestors 'none'`), `no-referrer` et `noindex`.

### Rôle PostgreSQL `pixlova_platform` (migration 0016)

- **Lecture.** Le rôle contourne la RLS pour les vues inter-organisations, mais lit par **colonnes** : jamais d’empreinte de mot de passe, de secret TOTP, de jeton, de contenu d’email ni de charge utile de tâche. Il ne lit pas non plus les médias ni les identifiants des Players.
- **Écriture.** Il n’écrit que les colonnes des actions prévues.
- **Journal d’audit.** Ajout seul.
- **Séparation.** `pixlova_app` et `pixlova_system` n’ont aucun accès aux tables des opérateurs.
- **Rôles en recette.** Le service `db-roles` rejoue `bootstrap-roles.sql` et les mots de passe à chaque démarrage : un rôle nouveau apparaît sur une instance existante (`init-recette.mjs --upgrade`).

### Vues (ADM-004) : données réelles ou indisponibles

- **Santé.** Organisations, comptes, Players en ligne, incidents dont suspectés plateforme, emails en attente ou en échec, tâches par type et état, baux expirés, version du schéma.
- **Organisations.**
  - Recherche par nom, slug ou identifiant.
  - La fiche exige un **motif** : membres aux adresses masquées, usages, droits appliqués.
  - Le parc (Players, Displays, incidents) exige la permission de diagnostic, sans captures ni contenus.
- **Compte client.** Recherche par adresse **exacte** seulement, jamais de liste. Motif obligatoire.
- **Autres vues.** Incidents ouverts, tâches en échec, journal de la plateforme, catalogue de templates.
- **Abonnements.** Affichés « indisponibles (L08) ». Aucune valeur n’est inventée.
- **Registre des releases.** Déclaré inexistant.

### Actions de support (ADM-003) : explicites, bornées, traçables

| Action | Permission | Garde-fous |
|---|---|---|
| Révoquer les sessions d’un compte | Support, SuperAdmin | Motif, TOTP récent |
| Réinitialiser le second facteur (récupération sans code de secours) | SuperAdmin | Motif, TOTP récent, adresse recopiée ; sessions fermées |
| Désactiver ou réactiver un compte client | SuperAdmin | Motif, TOTP récent, adresse recopiée ; sessions fermées |
| Relancer une tâche | Operator, SuperAdmin | Motif ; seule transition `failed → queued`, conflit refusé |
| Gérer l’équipe | SuperAdmin | Motif, TOTP récent ; voir ci-dessous |

**Garde-fous de la gestion d’équipe :**

- pas d’auto-modification ;
- modifications sérialisées par verrou, avec revérification du droit sous verrou : deux SuperAdmin qui se rétrogradent simultanément laissent un SuperAdmin actif (testé) ;
- code d’activation affiché une fois.

**Audit.**
- Chaque consultation motivée, action ou refus de permission est journalisé avec : l’opérateur, la cible, le motif, l’IP, l’identifiant de requête et l’état avant/après.
- L’entrée porte `organization_id = NULL` : elle est invisible des organisations **[à valider]**. Informer les clients des consultations est une décision produit.
- Aucune impersonation.
- Les organisations suspendues ne sont pas proposées : ce statut n’est pas appliqué par l’API, l’action serait factice.

## Options évaluées

- **Console dans le dashboard client avec un drapeau « staff »** : écartée. Elle mélange les identités et expose les routes sur l’hôte public, contraire à ADM-001 et ADM-002.
- **Application et dépôt totalement séparés** : ils dupliqueraient mots de passe, TOTP, chiffrement, audit et erreurs. Le même paquet déployé dans un conteneur, un listener, un rôle PostgreSQL et un cookie distincts donne la séparation d’exploitation sans dupliquer la sécurité.
- **Réutiliser `pixlova_system`** : écartée. Ce rôle lit et écrit les secrets (jetons, emails) nécessaires à ses traitements, et l’administration n’en a pas besoin.
- **Impersonation** : exclue de la V1 (ADM-003).
- **Codes de secours pour les opérateurs** : remplacés par la réémission d’un code d’activation par un autre SuperAdmin ou par l’outil serveur. C’est moins de secrets durables, avec un contrôle humain.

## Conséquences et validation

**Tests automatisés.**
- Privilèges PostgreSQL : colonnes interdites, écritures bornées, tables d’opérateurs invisibles des rôles applicatifs.
- Permissions : disjonction avec les rôles tenant ; l’Owner n’a rien.
- 16 tests d’intégration sur PostgreSQL réel :
  - séparation des listeners ;
  - activation, TOTP, anti-rejeu, expiration, CSRF ;
  - permission par vue et refus audité ;
  - motifs et audit hors tenant ;
  - révocation, réinitialisation du second facteur, désactivation, relance ;
  - équipe et concurrence.
- Parcours Chromium de la console.

**Recette Docker** (`admin-smoke.mjs` dans `ci-recette.sh`, ADM-006).
- L’administration n’est servie ni par l’URL publique ni depuis la passerelle.
- Un opérateur jetable est activé ; ses droits sont bornés.
- Après révocation, sa session est fermée et sa connexion refusée.
- Arrêt propre vérifié.
- Le cookie `__Host-` sécurisé a été vérifié dans Chromium sur `http://127.0.0.1:8081`.

**Non couvert.** L’accès distant par Cloudflare One et un poste enrôlé n’a pas été exercé ici, faute de compte Zero Trust.

**Réexamen.** Il interviendra :
- avec L08 : vues abonnements et promotions livrées (ADR-017) ; actions de facturation (dérogations, remboursements) encore absentes ;
- avec un registre de releases ;
- avant la production (durées de session, matrice des rôles, information des clients sur les consultations, WebAuthn).
