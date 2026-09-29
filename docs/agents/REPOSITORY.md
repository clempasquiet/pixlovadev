# Exploitation du dépôt

## Préparation incluse

- Cahier des charges maître v1.1, chapitres et index générés.
- Consignes agents, roadmap, registre de décisions et critères de recette.
- Tickets GitHub liés dans le backlog, avec dépendances et critères de sortie.
- Modèles de tickets et PR.
- Workflow `Repository checks` : contrôles documentaires sur push de `main` et pull requests.
- Actions GitHub épinglées par SHA, permissions de lecture seule, aucun secret de production nécessaire.

## Réglages à appliquer au démarrage du développement

Leur présence ici est une recommandation ; elle ne signifie pas qu’ils sont activés côté GitHub.

1. Protéger `main` par PR et exiger `Repository checks / documentation`, puis les checks de build/test ajoutés par L00.
2. Définir les responsables de revue et, lorsque les équipes sont connues, un fichier CODEOWNERS exact.
3. Définir les environnements staging/production et leurs secrets minimaux au lot infrastructure.
4. Activer les protections de secrets et le signalement privé selon les fonctions disponibles pour ce dépôt privé.
5. Décider des règles de fusion adaptées à l’équipe. Ne pas créer de comptes, permissions ou reviewers supposés.

La CI documentaire ne déploie rien. Les actions applicatives ou releases seront ajoutées avec leurs tests et permissions minimales dans les lots correspondants.
