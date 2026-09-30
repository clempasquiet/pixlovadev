# ADR-006 — Authentification, sessions, MFA et emails transactionnels

- Statut : acceptée
- Date : 2026-09-29
- Ticket / lot : [L01 #2](https://github.com/clempasquiet/pixlovadev/issues/2)
- Exigences concernées : PAR-001, IAM-001, IAM-002, IAM-007, IAM-008, SEC-001, SEC-002, SEC-003, API-002, API-003, API-006
- Décision remplaçant / remplacée par : —

## Problème et contraintes

Le dashboard doit authentifier des comptes globaux appartenant à plusieurs organisations. Le cahier des charges impose :

- Argon2id, MFA, sessions révocables et expirantes, jetons à usage unique ;
- aucune journalisation de secret ;
- anti-énumération et limitation des tentatives ;
- protection CSRF des sessions par cookie ;
- une modification de droits appliquée aux sessions existantes.

## Décision

### Comptes et mots de passe

- Adresse normalisée (espaces retirés, minuscules), unique.
- Argon2id `m=19456 KiB, t=2, p=1` (`@node-rs/argon2`), paramètres inscrits dans l’empreinte PHC ; ré-empreinte transparente à la connexion si les paramètres changent.
- Mot de passe : 12 caractères minimum, 256 octets maximum, sans reprendre la partie locale de l’adresse.
- La connexion exige une adresse vérifiée.
- L’inscription d’une adresse déjà vérifiée renvoie la même réponse `202` et prévient le titulaire par email. Réinitialisation : réponse identique que le compte existe ou non. Connexion : même message et temps comparable (vérification d’une empreinte factice).

### Sessions

- Jeton opaque de 256 bits dans le cookie `__Host-pixlova_session` : `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, sans `Domain`. Seul le SHA-256 du jeton est stocké.
- Expiration d’inactivité 24 h (prolongée au plus une fois par minute) et expiration absolue 14 jours — valeurs de travail configurables (`PIXLOVA_SESSION_*`).
- Actions sensibles : mot de passe saisi depuis moins de 15 minutes (`POST /auth/reauthenticate`). Cela couvre l’activation ou la désactivation de la MFA, ainsi que l’attribution ou le retrait du rôle Owner.
- Les rôles et permissions sont relus en base à chaque requête : un changement de droits ou un retrait s’applique immédiatement, sans attendre l’expiration.
- Révocation : déconnexion, « toutes les autres sessions », changement de mot de passe (autres sessions), réinitialisation (toutes).
- **Même origine** : le dashboard appelle `/api/v1` sur son propre hôte, la passerelle routant `/api/*` vers l’API. Il n’y a donc ni CORS ni cookie partagé entre sous-domaines. Les Players utilisent l’hôte API dédié.

### CSRF et limitation de débit

- Toute requête `POST/PUT/PATCH/DELETE` sous `/api/v1` doit porter un en-tête `Origin` figurant dans `PIXLOVA_ALLOWED_ORIGINS`, en plus de `SameSite=Lax`.
- Fenêtres fixes, partagées via Redis en production (`REDIS_URL` obligatoire), en mémoire en test.

| Action | Limite |
|---|---|
| Connexion | 10 / 15 min par compte, 50 / 15 min par IP |
| Inscription | 10 / h par IP |
| Réinitialisation | 5 / h par compte, 20 / h par IP |
| Second facteur | 10 / 15 min par session |
| Invitations | 50 / h par organisation, 5 renvois / h par invitation |

### MFA

- TOTP RFC 6238 (SHA-1, 6 chiffres, 30 s, tolérance ±1 pas), implémenté sur `node:crypto`.
- Secret chiffré AES-256-GCM avec une clé applicative (`PIXLOVA_DATA_KEYS`, rotation par identifiant de clé, contexte d’usage authentifié).
- Un pas déjà utilisé est refusé (anti-rejeu).
- 10 codes de secours, affichés une fois, stockés hachés, à usage unique.
- Quand la MFA est active, la session reste « second facteur attendu » jusqu’à validation : seules `/auth/me`, `/auth/mfa/verify` et `/auth/logout` sont ouvertes.
- Politique IAM-007 : `PIXLOVA_REQUIRE_MFA_FOR_ADMINS=true` par défaut. Un Owner, un Admin ou un BillingManager sans MFA ne peut pas effectuer de gestion des membres ou d’invitations (`MFA_ENROLLMENT_REQUIRED`) ; les autres actions restent possibles, pour ne pas bloquer la première diffusion.

### Jetons à usage unique et emails

- Vérification d’email (24 h), réinitialisation (60 min), invitation (7 jours).
- Chaque jeton est aléatoire, stocké haché et consommé par un `UPDATE … WHERE used_at IS NULL` atomique. Un nouveau jeton invalide les précédents du même usage.
- Emails écrits dans `email_outbox` dans la transaction métier, contenu chiffré (liens à jeton), envoyés par un dispatcher (`FOR UPDATE SKIP LOCKED`, reprise exponentielle) puis purgés.
- Seul un transport console de développement existe ; il est refusé en production. Le fournisseur SMTP/API est à choisir avec L09-I.

### Audit

- Les actions de compte (connexion, MFA, mots de passe, sessions) sont journalisées sans organisation, par le rôle système.
- Les actions d’un tenant sont journalisées dans sa transaction.
- Les métadonnées dont la clé évoque un secret sont filtrées.

## Options évaluées

- **JWT sans état** : révocation immédiate impossible sans liste noire ; contraire à SEC-002.
- **Bibliothèque d’authentification complète** (Lucia, Auth.js) : utile pour OAuth, mais notre modèle (tenant par en-tête, grants par site, audit) reste à écrire ; le cœur (sessions opaques, Argon2id, TOTP) est court et testé.
- **WebAuthn** : souhaitable ensuite, non requis en V1 ; le modèle `mfa_credentials.type` le permet.

## Conséquences et validation

Tests d’intégration sur PostgreSQL réel (`apps/api/test/identity.integration.test.ts`) : parcours complet, attributs du cookie, empreinte seule en base, anti-énumération, mots de passe faibles, adresse non vérifiée, limitation, jeton de vérification consommé une fois sous concurrence, CSRF, révocations, expiration, réinitialisation, MFA (réauthentification, rejeu, secours), absence de secret dans l’audit.

À traiter : transport email de production (L09-I), durées définitives et politique de récupération de compte sans code de secours (procédure support : réinitialisation du second facteur par un SuperAdmin, [ADR-016](0016-administration-plateforme.md)), WebAuthn (post-V1).
