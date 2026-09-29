# ADR-001 — Outillage, workspace et versions supportées

- Statut : acceptée
- Date : 2026-09-29
- Ticket / lot : [L00 #1](https://github.com/clempasquiet/pixlovadev/issues/1)
- Exigences concernées : ARC-007, ARC-018, DOC-003, DOC-020
- Décision remplaçant / remplacée par : —

## Problème et contraintes

Le dépôt doit accueillir un cloud TypeScript (API, workers, interfaces), des packages partagés (contrats, moteur de rendu) et un Player natif Rust. L’installation doit être reproductible depuis un clone vierge et vérifiée en CI (ARC-018). Le cahier des charges n’impose pas d’outil de monorepo (ARC-007).

## Décision

| Élément | Choix | Version épinglée | Où elle est fixée |
|---|---|---|---|
| Runtime JavaScript | Node.js LTS « Krypton » | 24.21.0 | `.nvmrc`, `engines` de `package.json` (`>=24.21.0 <25`) |
| Gestionnaire de paquets | pnpm workspaces, activé par Corepack | 12.8.1 | `packageManager` de `package.json`, `pnpm-lock.yaml` |
| Langage | TypeScript strict (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | 6.0.3 | `package.json`, `tsconfig.base.json` |
| Tests TypeScript | Vitest | 5.0.2 | `package.json` |
| Qualité TypeScript | ESLint (flat config) + typescript-eslint, Prettier | 10.11.0 / 8.71.0 / 3.9.9 | `package.json`, `eslint.config.js`, `.prettierrc.json` |
| Rust | Chaîne stable épinglée, édition 2024 | 1.94.1 | `rust-toolchain.toml`, `Cargo.toml`, `Cargo.lock` |

Organisation :

- `pnpm-workspace.yaml` déclare `apps/*` et `packages/*` ; le workspace Cargo racine déclare les crates de `native/`.
- Les dépendances sont enregistrées en version exacte (`savePrefix: ''`) ; `engineStrict` refuse une version de Node hors plage.
- TypeScript 7.0 (compilateur natif) est volontairement écarté : typescript-eslint 8.71 ne supporte que `<6.1`. À réexaminer quand l’écosystème de lint le supporte.
- Aucun orchestrateur de tâches (Turborepo, Nx) : `pnpm -r` suffit tant que la durée de CI reste acceptable.

## Commandes

```sh
corepack enable            # une fois par poste ; installe pnpm 12.8.1
pnpm install --frozen-lockfile
pnpm run check             # docs + format + lint + build + typecheck + tests
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

## Options évaluées

- **npm workspaces** : disponible sans installation mais sans isolation stricte des dépendances ; pnpm refuse les imports de paquets non déclarés, ce qui protège la frontière « aucun secret serveur dans un bundle navigateur » (ARC-007).
- **pnpm 10** : maintenu, mais 12 est la version courante ; la CI épingle la version exacte.
- **Bun / Deno** : runtimes moins alignés avec Fastify, BullMQ et l’écosystème Stripe côté serveur.

## Conséquences et validation

- La CI `CI` exécute les jobs TypeScript et Rust à chaque PR ; `Repository checks` reste inchangé.
- Toute montée de version passe par une PR qui met à jour cet ADR ou le lockfile avec des tests verts.
- Réexamen : fin de support Node 24, adoption de TypeScript 7 par typescript-eslint, durée de CI > 10 min.
