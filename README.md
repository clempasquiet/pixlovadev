# pixlova

SaaS d’affichage dynamique pour moniteurs et installations LED. Domaines du projet : **pixlova.com** et **pixlova.fr**.

Ce dépôt contient le cadre de développement, le cahier des charges et le workspace applicatif en construction (lot L00). L’application et les Players restent à implémenter.

## Commencer

1. Lire [AGENTS.md](AGENTS.md), puis le [guide de démarrage](docs/agents/START_HERE.md).
2. Choisir un lot dans le [backlog](docs/planning/BACKLOG.md) dont les dépendances sont terminées.
3. Lire les chapitres utiles du [cahier des charges](docs/spec/INDEX.md), puis le [registre des décisions](docs/architecture/DECISIONS.md).
4. Créer une branche et une pull request limitée au ticket, avec ses preuves de validation.

## Essayer en local

Le parcours compte → organisation → membres est utilisable sur un poste de développement : [docs/dev/LANCER-EN-LOCAL.md](docs/dev/LANCER-EN-LOCAL.md).

## Références

| Document | Usage |
|---|---|
| [Cahier des charges maître v1.1](docs/spec/cahier-des-charges.md) | Source de vérité produit et exigences |
| [Index par chapitre](docs/spec/INDEX.md) | Lecture ciblée pour limiter le contexte des agents |
| [Roadmap et dépendances](docs/planning/ROADMAP.md) | Ordre des travaux V1, V1.5 et V2 |
| [Architecture](docs/architecture/README.md) | Modules, frontières et structure cible |
| [Décisions ouvertes](docs/architecture/DECISIONS.md) | Choix techniques et commerciaux encore à fixer |
| [Contribution](CONTRIBUTING.md) | Branches, PR, tests et définition de terminé |
| [Recette](docs/quality/ACCEPTANCE.md) | Invariants et preuves attendues |

## Vérifications disponibles

Prérequis : Node.js 24.21 (`.nvmrc`), Corepack et Rust 1.94.1 (`rust-toolchain.toml`). Détails dans l’[ADR-001](docs/architecture/adr/0001-outillage-workspace-versions.md).

```sh
# Documentation (aucune dépendance)
node scripts/check-repository.mjs
node scripts/sync-spec.mjs --check

# Workspace TypeScript
corepack enable
pnpm install --frozen-lockfile
pnpm run check

# Workspace Rust
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Après modification du cahier des charges, régénérer ses chapitres et son index :

```sh
node scripts/sync-spec.mjs
```

Deux workflows s’exécutent sur chaque PR : `Repository checks` (documentation, liens, JSON, synchronisation du cahier des charges) et `CI` (format, lint, build, typecheck et tests TypeScript et Rust). Ils vérifient ce qui est implémenté ; ils ne certifient pas le produit, et les tests terrain restent hors CI.

## Premiers travaux

Commencer par **L00 — Fondations techniques et contrats**. Le choix final du framework backend, de l’ORM, du moteur de rendu et des profils matériels reste à consigner avant leur implémentation. Le modèle commercial est déjà fixé autour de l’organisation et des licences de **Display**, avec un Player natif Rust et un Player Web.
