# ADR-003 — Contrats partagés, signature JCS/Ed25519 et fixtures croisées

- Statut : acceptée
- Date : 2026-09-29
- Ticket / lot : [L00 #1](https://github.com/clempasquiet/pixlovadev/issues/1)
- Exigences concernées : API-003, API-006, PROTO-005, PROTO-007 à PROTO-017, PROTO-019, PROTO-021, SEC-008, SEC-010, PLN-008, DATA-001
- Décision remplaçant / remplacée par : —

## Problème et contraintes

Le cloud (TypeScript), le Player Web (TypeScript) et le Player natif (Rust) doivent interpréter exactement de la même façon les manifests, commandes et messages temps réel. Le cahier des charges impose : schémas versionnés dans `packages/contracts`, aucune duplication manuelle incompatible entre Rust et TypeScript, signature Ed25519 sur JSON canonique JCS, rejet des clés dupliquées et des données hors schéma, fixtures communes (PROTO-021).

## Décision

### Source unique et artefacts

- Les schémas sont écrits en **TypeBox** (`packages/contracts/src/schemas`), qui fournit à la fois les types TypeScript (`Static<>`) et le JSON Schema.
- Les schémas racines sont publiés en JSON **draft 2020-12** dans `packages/contracts/schemas/*.json` (`$id` sous `https://schemas.pixlova.com/v1/`, identifiant jamais téléchargé). La crate Rust `pixlova-contracts` les intègre à la compilation et les valide avec `jsonschema` ; TypeScript utilise Ajv 2020 en mode strict.
- Les formats sont exprimés par des expressions régulières simples (ni `\d`, ni assertion arrière) plutôt que par `format`, dont l’interprétation diffère entre validateurs.
- `pnpm --filter @pixlova/contracts generate` régénère schémas et fixtures ; le test `generated.test.ts` échoue si les fichiers commités divergent.

### Contrats couverts en L00

| Fichier | Contenu |
|---|---|
| `error.json` | Enveloppe d’erreur API-006 et codes minimum |
| `organization.json` | Organisation (tenant) ; en-tête `x-organization-id` |
| `display.json`, `display-assignment.json` | Display logique, affectation historisée et génération |
| `player-capabilities.json` | Capacités tri-état (`supported`/`unsupported`/`unknown`) |
| `composition.json` | Document de composition **résolu** (assets et contenus du manifest) |
| `manifest-payload.json`, `manifest.json` | Payload PROTO-009 et enveloppe signée |
| `command-payload.json`, `command.json`, `command-result.json` | Commandes V1, enveloppe signée, résultat |
| `heartbeat.json`, `ws-message.json` | Heartbeat et un schéma par type de message WebSocket |
| `player-event-batch.json` | Événements offline dédupliqués (PROTO-019) |

### Règles d’interprétation communes

1. **JSON strict** : clés dupliquées, nombres de valeur absolue > 2^53−1, substituts Unicode isolés, profondeur > 64 conteneurs et contenu après la valeur sont refusés. En Rust, un nombre flottant entier (`1.0`, `-0`) est normalisé en entier, comme en JavaScript.
2. **Octets signés** : JCS (RFC 8785) de `{protected, payload}` ; signature Ed25519 en base64url sans remplissage, forme canonique exigée. Bibliothèques : `canonicalize` et `@noble/curves` (`zip215: false`) ; `serde_json_canonicalizer` et `ed25519-dalek` (`verify_strict`).
3. **Ordre de vérification** et codes : taille/JSON (`MALFORMED_JSON`) → forme et type d’enveloppe, algorithme, `kid` (`ENVELOPE_INVALID`) → clé de confiance (`UNKNOWN_KEY`) → signature (`SIGNATURE_INVALID`) → `schema_version` (`UNSUPPORTED_SCHEMA`) → schéma (`SCHEMA_INVALID`) → cohérence (`SEMANTIC_INVALID` + motif). `protected.type` sépare manifests (`SIGNAGE_MANIFEST_V1`) et commandes (`SIGNAGE_COMMAND_V1`) ; les trust stores manifest et commande sont distincts.
4. **Cohérence d’un manifest** (ordre fixe) : fenêtre `valid_from ≤ activate_before ≤ schedule_until`, identifiants uniques, assets et contenus référencés existants et de la bonne famille, aucun cycle, timeline triée en intervalles `[début, fin)` non chevauchants dans la fenêtre, priorités dans leur bande (planning 0–19, campagne 20–79, override 80–99, urgence 100), fallback existant.
5. **Acceptation d’un manifest** (PROTO-013) : organisation, Player et Display de l’association locale ; génération inférieure → `STALE_ASSIGNMENT`, supérieure → `ASSIGNMENT_AHEAD` (rafraîchir `/config` d’abord) ; version inférieure → `VERSION_REPLAYED` ; même version et même empreinte → sans effet ; même version et autre empreinte → `VERSION_CONFLICT` ; `activate_before` dépassé → `ACTIVATION_WINDOW_EXPIRED`. L’empreinte est le SHA-256 du JCS du payload.
6. **Décision sur une commande** (PROTO-008) : doublon d’un identifiant déjà inscrit → résultat connu sans ré-exécution (même après expiration) ; même identifiant, autre contenu → `COMMAND_CONFLICT` ; expirée → `COMMAND_EXPIRED` ; génération d’affectation différente → `STALE_ASSIGNMENT` ; capacité non `supported` pour `REBOOT_HOST`/`TAKE_SCREENSHOT` → `CAPABILITY_UNSUPPORTED`. Validité maximale : 24 h.
7. **Temps** : instants RFC 3339 UTC (`Z`), convertis en microsecondes par une fonction identique dans les deux langages ; versions et générations en chaînes décimales (≤ 19 chiffres).

### Fixtures

`packages/contracts/fixtures` contient des clés **de test uniquement** dérivées d’une graine publique, 35 manifests et 11 commandes signés (valides, rotation de clé, ordre des clés, version maximale, altération, clé dupliquée, JSON tronqué, nombre hors plage, substitut isolé, clé inconnue, signature malléable ou non canonique, mauvais type d’enveloppe, schéma inconnu, propriété inconnue, 12 incohérences, rejeu, conflit, ancienne affectation, fenêtre expirée), ainsi que des vecteurs JCS, JSON strict et instants. `vectors.test.ts` et `native/contracts/tests/vectors.rs` doivent produire les mêmes décisions.

## Options évaluées

- **JSON Schema écrit à la main + génération de types** (json-schema-to-typescript) : types générés moins précis pour les unions discriminées et références externes à résoudre ; TypeBox évite une étape de génération côté TypeScript.
- **Types Rust générés (typify)** : dépendance de génération supplémentaire ; les structures Rust ne portent que les champs nécessaires aux règles, la conformité étant garantie par la validation du schéma publié et les vecteurs communs.
- **Protobuf/CBOR** : compact, mais le cahier des charges fixe JSON + JCS pour les documents signés.

## Conséquences et validation

- Toute évolution de contrat modifie TypeBox, régénère les artefacts et, si un comportement change, ajoute un vecteur rejoué par les deux implémentations.
- Changement incompatible → nouvelle version majeure du schéma ou du type d’enveloppe (PROTO-020) ; N et N−1 maintenus selon la matrice de compatibilité à publier.
- Limites connues et suivis :
  - Ajv compile ses validateurs avec `new Function` ; le Player Web (CSP sans `unsafe-eval`) utilisera des validateurs précompilés (L06-W).
  - Le schéma d’édition des compositions (références de bibliothèque) relève de L04 ; le schéma publié ici est la forme résolue du rendu.
  - La racine de confiance et la rotation des clés (PROTO-012, DEC-12), l’enveloppe du challenge d’authentification Player (PROTO-002) et les tombstones de purge (DEC-23) restent à spécifier avec L02/L05/L06.
