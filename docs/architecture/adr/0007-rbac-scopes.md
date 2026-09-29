# ADR-007 — Rôles V1, permissions nommées et scopes par site

- Statut : acceptée (matrice initiale ; valeurs à confirmer par le responsable produit, modifiables sans migration)
- Date : 2026-09-29
- Ticket / lot : [L01 #2](https://github.com/clempasquiet/pixlovadev/issues/2)
- Exigences concernées : IAM-001 à IAM-006, PROD-005, DATA-004, BILL-003, TST-021
- Décision remplaçant / remplacée par : —

## Décision

1. **Catalogue unique** `@pixlova/permissions`, partagé par l’API (décision) et le dashboard (affichage) :
   - 21 permissions nommées (`content.publish`, `player.command`, `screenshots.read`, `audit.read`, `override.emergency`, `billing.manage`…) ;
   - les rôles `Owner`, `Admin`, `ContentManager`, `Operator`, `Technician`, `Viewer`, conformes à la matrice [PROPOSITION] du §10.2 ;
   - un rôle complémentaire `BillingManager`, par lequel un Admin obtient `billing.manage` (IAM-004 : la facturation n’est pas implicite).
2. **Grants** : une appartenance porte un ou plusieurs grants `(rôle, scope)`.
   - Scope `organization` ou `sites` (liste normalisée dans `membership_grant_sites`).
   - `Owner`, `Admin` et `BillingManager` n’existent qu’au niveau organisation.
   - Les rôles V1 sont définis dans le code. Les tables `roles`/`permissions` du modèle de référence arriveront avec les rôles personnalisés (V1.5), et une contrainte `CHECK` testée garantit l’alignement SQL/catalogue.
3. **Évaluation** (`can`, `siteFilter`, `canAll`) :
   - un grant de site couvre les ressources de ses sites, jamais une ressource de niveau organisation, ni une permission marquée `orgScopeOnly` (membres, sites, audit, facturation, paramètres) ;
   - les listes sont filtrées côté serveur et l’accès direct par identifiant est revérifié ;
   - une opération atomique multi-cibles est refusée si une cible sort du périmètre.
4. **Délégation** (IAM-006) : attribuer ou retirer un grant exige `members.manage` et la détention de chaque permission du rôle sur tout le scope visé. Seul un Owner attribue ou retire `Owner`, et doit s’être réauthentifié récemment.
5. **Dernier Owner** (DATA-004) : chaque modification verrouille la ligne de l’organisation (`SELECT … FOR UPDATE`) puis vérifie qu’au moins un Owner actif subsiste. Deux rétrogradations concurrentes ne peuvent pas supprimer tous les Owners (testé).
6. **Tenant** : l’organisation active vient de l’en-tête `x-organization-id`, confronté aux appartenances actives. Une organisation dont l’utilisateur n’est pas membre répond `404`, sans divulgation.
7. **Quota d’utilisateurs** : membres actifs + invitations en attente, revérifié à l’acceptation. Source : interface `EntitlementsProvider`, avec en attendant L08 l’offre Free à un utilisateur (BILL-003). `PIXLOVA_DEV_MAX_USERS` n’est accepté qu’hors production.

## Options évaluées

- **Rôles en base dès V1** : prépare V1.5 mais crée deux sources de vérité tant que les rôles ne sont pas éditables.
- **Scope par groupe de Displays** : prévu après V1 (IAM-003).

## Conséquences et validation

Tests :

- 25 tests unitaires de la matrice, des scopes et de la délégation (`packages/permissions`) ;
- tests d’intégration (`apps/api/test/tenancy.integration.test.ts`) :
  - accès croisé entre deux organisations sur chaque route (404) ;
  - quota Free ;
  - invitation par site, acceptation concurrente, adresse différente, renvoi, révocation, expiration ;
  - délégation refusée à un Admin ;
  - rôle d’organisation limité à un site refusé, site d’un autre tenant refusé ;
  - dernier Owner, y compris sous concurrence ;
  - droits appliqués immédiatement ;
  - pagination et cloisonnement de l’audit ;
  - MFA exigée des administrateurs.

La matrice peut être modifiée par une PR du catalogue sans migration, sauf ajout ou retrait d’un rôle (contrainte `CHECK`).
