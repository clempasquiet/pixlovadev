# Contribuer à pixlova

## Ticket et branche

Partir du [backlog](docs/planning/BACKLOG.md) et des [consignes agents](AGENTS.md). Vérifier les dépendances ; documenter la prise en charge dans le ticket lorsque le mandat autorise cette coordination. Pour un lot trop large, créer des sous-tâches avec résultat observable, IDs d’exigence, exclusions, dépendances et preuves attendues.

Créer une branche depuis `main` à jour. Une PR doit rester relisible et présenter une tranche fonctionnelle ou technique cohérente. Ne pas inclure des restructurations sans lien avec le ticket.

## Décisions et contrats

Les spécifications priment sur les exemples isolés. En cas de contradiction, relever les sections et proposer une résolution explicite. Utiliser le [modèle ADR](docs/architecture/adr/TEMPLATE.md) pour les choix structurants ; distinguer décision technique du projet et validation commerciale/juridique.

## Validation

Aujourd’hui, les commandes disponibles sont :

```sh
node scripts/check-repository.mjs
node scripts/sync-spec.mjs --check
```

Chaque lot ajoute ses propres builds/tests et leur mode d’emploi. La [recette](docs/quality/ACCEPTANCE.md) précise les invariants. Les preuves terrain sont requises pour offline, codec, outputs, update et rollback ; un mock ne remplace pas ces résultats.

## Pull request

Renseigner le modèle fourni : problème, résultat, ticket, exigences, vérifications, risques et procédure de retour arrière si nécessaire. Relier avec `Closes #…` uniquement les tickets entièrement satisfaits ; sinon utiliser `Refs #…` et expliquer ce qui reste.

La fusion suit les autorisations et règles effectives du dépôt. Les protections serveur et revues obligatoires doivent être vérifiées dans GitHub ; un texte dans AGENTS.md ne les active pas.

## Confidentialité

Utiliser exclusivement des données de recette synthétiques ou autorisées. Un signalement de vulnérabilité suit [SECURITY.md](SECURITY.md). Une licence de distribution du logiciel sera décidée séparément ; la préparation du dépôt n’accorde pas une licence open source implicite.
