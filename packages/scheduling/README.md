# @pixlova/scheduling

Programmation pixlova ([ADR-011](../../docs/architecture/adr/0011-programmation-compilation-manifests.md)).

- **Moteur pur** (`@pixlova/scheduling`, sans base de données, utilisable dans le navigateur) :
  - heures locales IANA via la base tz d’`Intl` : heures absentes omises, heures répétées prises à leur première occurrence ;
  - occurrences de créneaux, y compris au-delà de minuit, et exceptions datées ;
  - ciblage avec exclusions, borné au site du programme ;
  - arbitrage priorité → début le plus récent → identifiant en ordre lexical ;
  - timeline fusionnée et explication des règles masquées.
- **Compilateur** (`@pixlova/scheduling/compiler`) :
  - snapshot cohérent d’un Display et empreinte d’entrée ;
  - contenus du manifest et variantes selon les capacités du Player ;
  - préflight, signature Ed25519 et vérification comme un Player ;
  - enregistrement sous verrou si la révision est encore désirée ;
  - renouvellement de l’horizon.

## Fixtures

`fixtures/*.json` décrit des cas exécutables : fenêtre, sources, timeline et explications attendues. Ils couvrent :

- conflits de priorité et égalités ;
- créneaux traversant minuit ;
- changements d’heure à Paris et New York ;
- fin et expiration d’override, urgence ;
- playlist devenue vide ;
- exceptions datées ;
- fuseau imposé.

## Tests

```sh
pnpm --filter @pixlova/scheduling test   # tests d’intégration : PIXLOVA_TEST_DATABASE_URL (voir packages/db)
```
