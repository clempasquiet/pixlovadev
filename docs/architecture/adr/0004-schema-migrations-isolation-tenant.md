# ADR-004 — Premier schéma, migrations et isolation tenant en base

- Statut : acceptée
- Date : 2026-09-29
- Ticket / lot : [L00 #1](https://github.com/clempasquiet/pixlovadev/issues/1)
- Exigences concernées : DATA-001, DATA-002, DATA-004, DATA-006, DATA-011, SEC-003, SEC-004, SEC-016, ARC-003, ARC-004, ARC-014, TST-002
- Décision remplaçant / remplacée par : —

## Problème et contraintes

L’organisation est le tenant. Les contrôles applicatifs restent la première barrière (PROD-005), mais la base doit empêcher structurellement les associations inter-tenants (DATA-002) et le cahier des charges propose d’évaluer PostgreSQL RLS comme défense complémentaire (SEC-004), à condition qu’elle fonctionne avec le pool de connexions et les jobs.

## Décision

### Schéma initial (`packages/db`)

Tables : `organizations`, `users`, `memberships`, `sites`, `players`, `player_outputs`, `displays`, `display_assignments`, `display_groups`, `display_group_members`, `audit_logs`, `outbox_events`. Les tables RBAC détaillées (`roles`, `membership_grants`…) arrivent avec L01, le reste du modèle (§16) avec les lots métier.

Conventions : UUID, `timestamptz`, `bigint` pour les générations et versions, contraintes `CHECK` pour les énumérations, dimensions et orientations, `deleted_at` sur les objets restaurables.

### Isolation structurelle

- Chaque table possédée par un client porte `organization_id` et une contrainte unique `(organization_id, id)`.
- Les références entre objets d’un tenant sont des **clés étrangères composites** `(organization_id, x_id) → parent(organization_id, id)` : un UUID valide d’un autre tenant est refusé, même par un rôle qui contourne RLS.
- **Affectations** : index uniques partiels « une affectation active par Display » et « par sortie » (`WHERE ended_at IS NULL`), unicité `(display_id, generation)` : une ancienne génération ne peut pas être rouverte.

### RLS et rôles

| Rôle | Usage | RLS |
|---|---|---|
| `pixlova_owner` | Propriétaire du schéma ; exécute les migrations | Propriétaire (non soumis) |
| `pixlova_app` | API et workers sous contexte tenant | **Soumis** : `organization_id = pixlova.organization_id` |
| `pixlova_system` | Opérations explicitement inter-tenants : authentification Player avant tenant, relais outbox, webhooks Stripe, administration privée | `BYPASSRLS` |

- Les rôles sont créés par `packages/db/sql/bootstrap-roles.sql` (administrateur, une fois par cluster), jamais par les migrations ; `LOGIN` et mots de passe viennent des secrets d’environnement.
- `withTenant(db, organizationId, work)` ouvre une transaction et appelle `set_config('pixlova.organization_id', …, true)` : le réglage expire avec la transaction et ne fuit pas vers la connexion suivante du pool. Sans contexte, aucune ligne n’est visible (fail closed).
- Droits minimaux : `audit_logs` n’accorde que `SELECT, INSERT` aux rôles applicatifs (ajout seul) ; pas de `DELETE` sauf sur les tables de jointure qui en ont besoin.
- Un test vérifie que **toute table portant `organization_id` a RLS activé et une policy** : une migration future qui l’oublie casse la CI.

### Migrations

- Drizzle Kit génère le SQL depuis `src/schema` ; le SQL est relu et versionné dans `packages/db/migrations`. Les droits et objets hors DSL passent par des migrations `--custom` (ex. `0001_role_grants.sql`).
- La CI applique toutes les migrations sur une base vierge avant les tests, exécute `drizzle-kit check` et échoue si `drizzle-kit generate` produit une migration non commitée.
- Règle ARC-014 : migrations additives, retrait différé des colonnes, aucune migration destructive déclenchée implicitement au démarrage des réplicas ; l’exécution des migrations est une étape de déploiement distincte, sous `pixlova_owner`.

## Options évaluées

- **Contrôles applicatifs seuls** : une requête oubliant son filtre `organization_id` fuit silencieusement ; les FK simples acceptent un UUID d’un autre tenant.
- **Une base ou un schéma par tenant** : isolation forte, mais migrations et exploitation multipliées, inadaptées à un parc Free nombreux.
- **RLS avec `FORCE` sur le propriétaire** : inutile ici, l’application ne se connecte jamais avec le rôle propriétaire.

## Conséquences et validation

Tests exécutés contre PostgreSQL 16 réel (`packages/db/test/isolation.test.ts`) : lecture croisée et accès direct par ID, absence de contexte, écriture pour un autre tenant, contexte non conservé par une connexion du pool, FK composites en rôle système, formats LED et contraintes, audit en ajout seul, affectations concurrentes au même Display (une seule réussit), sortie déjà occupée, remplacement avec clôture, génération incrémentée et historique conservé.

Limites et suites :

- L’usage de `pixlova_system` doit rester confiné à des fonctions nommées et auditées (revue de code L01/L02).
- Les policies par site (scopes, IAM-005) restent applicatives en V1 ; RLS ne couvre que le tenant.
- Le digest de l’image PostgreSQL de CI et la version cible de production sont à épingler avec L09-I.
