# Démarrer un travail

## Ordre de lecture

1. [AGENTS.md](../../AGENTS.md) et le ticket ciblé dans le [backlog](../planning/BACKLOG.md).
2. [Décisions](../architecture/DECISIONS.md) : confirmer les hypothèses nécessaires au lot.
3. [Index de la spécification](../spec/INDEX.md), puis les seuls chapitres utiles. Les fichiers par chapitre sont générés depuis le maître.
4. [Recette](../quality/ACCEPTANCE.md) et [contribution](../../CONTRIBUTING.md).

## Première mission

**L00** est le point d’entrée : versions/outillage, structure du monorepo, choix backend/ORM, prototype renderer et premiers contrats. Le dépôt de préparation utilise Node.js 24 sans dépendances ; cela ne tranche pas encore le framework ni le gestionnaire de packages du produit.

L00 doit produire une installation reproductible et des décisions explicites. Ensuite, L01 permet de construire des domaines tenant indépendants. Les contrats de L00 débloquent les premiers prototypes de rendu et Players ; leur intégration réelle attend les APIs correspondantes.

## Mission type à donner à un agent

> Prends le ticket indiqué dans le backlog pixlova. Lis AGENTS.md, les dépendances et les chapitres référencés. Implémente une tranche revue et testable sur une branche dédiée. Garde les propositions distinctes des décisions acquises. Mets à jour contrats, tests et documentation nécessaires, puis ouvre une PR avec les preuves de validation et les limites restantes.

Le numéro du ticket doit être choisi par le responsable de la session ; ne pas distribuer automatiquement le même lot à plusieurs agents.

## Contextes à préserver

- Branches, commits et fichiers déjà modifiés.
- Exigences et critères réellement couverts.
- Choix proposés versus validés.
- Résultats des commandes réellement exécutées.
- Prochaine étape indépendante et blocage concret éventuel.

Utiliser [HANDOFF.md](HANDOFF.md) pour une reprise.
