# @pixlova/contracts

Contrats versionnés partagés entre le cloud, le Player Web et, via les schémas JSON et les fixtures, le Player natif Rust (`native/contracts`). Décision : [ADR-003](../../docs/architecture/adr/0003-contrats-signature-fixtures.md).

| Dossier | Rôle |
|---|---|
| `src/schemas/` | Source TypeBox des schémas et types |
| `schemas/` | JSON Schema 2020-12 générés — ne pas éditer |
| `fixtures/` | Vecteurs communs TypeScript/Rust générés — ne pas éditer ; clés **de test uniquement** |
| `src/` | JSON strict, JCS, signature Ed25519, vérification et acceptation des manifests et commandes |

```sh
pnpm --filter @pixlova/contracts test       # vecteurs, schémas, fraîcheur des artefacts
pnpm --filter @pixlova/contracts generate   # après modification d’un schéma ou d’un vecteur
cargo test -p pixlova-contracts             # mêmes vecteurs côté Rust
```
