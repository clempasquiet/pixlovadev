# Architecture de référence

Voir les [chapitres 14 à 17](../spec/INDEX.md) pour les règles complètes.

## Structure cible

```text
apps/
  marketing/       site public dans son propre conteneur
  dashboard/       interface client
  admin/           interface plateforme privée
  player-web/      Player navigateur
  api/             monolithe modulaire TypeScript
  workers/         médias, compilation, notifications et billing
packages/
  contracts/       schémas versionnés et fixtures Rust/TypeScript
  render-engine/   rendu partagé preview/Web/natif
  ui/ auth/ permissions/ config/
native/
  agent/          agent Rust et SQLite
  renderer/       processus graphique isolé
infra/            Docker, staging, tunnel et exploitation
tests/            intégration, contrats, E2E et protocoles terrain
```

Cette arborescence est une cible. L00 crée les workspaces réels, leurs commandes et leurs versions après décision ; aucun dossier vide n’est présenté comme une application implémentée.

## Frontières

- PostgreSQL porte les décisions métier durables. Redis porte des projections et jobs récupérables.
- Stockage S3 compatible, uploads directs autorisés, pipeline média asynchrone.
- Les APIs publiques ne portent pas les routes internes d’administration.
- La programmation est compilée au cloud ; les Players appliquent des manifests signés et des assets vérifiés.
- Le renderer partage le moteur visuel et ne reçoit pas les credentials de l’agent.
- Les domaines pixlova.com et pixlova.fr sont confirmés. Domaine principal, redirections et sous-domaines restent à choisir.

## Décider avant d’implémenter

Le [registre](DECISIONS.md) et les ADR conservent les choix. Les propositions du cahier des charges donnent une base de travail, pas une permission de présenter des prix, un SLA ou une compatibilité matérielle comme acquis.
