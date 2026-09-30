# ADR-002 — Backend : Fastify, Drizzle, PostgreSQL et jobs durables

- Statut : acceptée
- Date : 2026-09-29
- Ticket / lot : [L00 #1](https://github.com/clempasquiet/pixlovadev/issues/1)
- Exigences concernées : ARC-001, ARC-003, ARC-004, API-001, API-006, DATA-002, SEC-004, DEC-07
- Décision remplaçant / remplacée par : —

## Problème et contraintes

DEC-07 laisse ouverts NestJS/Fastify et Prisma/Drizzle. Contraintes structurantes :

- monolithe modulaire TypeScript, découpé en modules métier (ARC-001) ;
- routes publiques et internes sur des listeners distincts ; filtrer l’interface ne suffit pas (API-001) ;
- validation stricte des entrées par schéma, rejet des propriétés inconnues (API-003), partagée avec les contrats ;
- clés étrangères composites `(organization_id, id)`, index uniques partiels, éventuellement RLS (DATA-002, DATA-011, SEC-004) ;
- transactions et verrous explicites pour quotas, affectations, publication et billing (ARC-003, DATA-008) ;
- outbox PostgreSQL pour ne pas perdre une tâche si Redis disparaît (ARC-004).

## Décision

1. **Fastify 5** (5.12.5) comme framework HTTP de `apps/api`, sans NestJS. Les modules métier sont des plugins Fastify organisés par domaine (identité, organisations, contenus, diffusion, flotte, billing, exploitation) et exposent des services indépendants du transport, réutilisables par les workers.
2. **Deux instances Fastify par processus** : `buildPublicApp` (tunnel public : `/api/v1`, `/player/v1`, webhooks) et `buildInternalApp` (réseau privé : `/internal/v1`). Un hook refuse l’enregistrement d’une route `/internal` sur l’application publique ; un test le vérifie. Le listener interne écoute par défaut sur `127.0.0.1`.
3. **Validation par JSON Schema** (Ajv intégré à Fastify) : les schémas proviennent de `packages/contracts`, source unique partagée avec les Players (ADR-003).
4. **Drizzle ORM** (0.45.x) avec **migrations SQL générées puis relues et versionnées** (drizzle-kit). Le SQL des migrations fait foi ; les contraintes non exprimables dans le DSL (triggers, policies RLS) sont écrites en SQL dans des migrations dédiées.
5. **PostgreSQL 16+** pour les décisions durables ; **Redis + BullMQ** pour les files ; **outbox transactionnelle** écrite dans la même transaction que l’effet métier, relayée vers BullMQ par un dispatcher idempotent.
6. **Enveloppe d’erreur unique** (API-006) avec `request_id` généré côté serveur, renvoyé dans `x-request-id` ; aucun détail interne dans une réponse 5xx.

## Options évaluées

- **NestJS** : structure modulaire et DI utiles pour une grande équipe, mais décorateurs, métadonnées et couche d’abstraction supplémentaires ; la séparation de deux listeners et la validation JSON Schema native sont plus directes avec Fastify seul. NestJS sur adaptateur Fastify reste possible si la taille de l’équipe le justifie.
- **Prisma** : bonne ergonomie, mais support limité des FK composites vers des clés uniques non primaires, des index partiels et des policies RLS dans son schéma ; moteur séparé et requêtes SQL brutes plus fréquentes pour les verrous.
- **Kysely / SQL brut** : contrôle maximal, mais pas de schéma TypeScript déclaratif ni de génération de migrations.

## Conséquences et validation

- Les exigences d’isolation (DATA-002) et d’unicité (DATA-011) sont testées contre un PostgreSQL réel en CI, pas contre des mocks (ADR-004).
- Les modules ne partagent pas de connexions « tenant-less » : chaque accès aux données reçoit un contexte tenant explicite.
- Réexamen : si Drizzle 1.0 introduit une rupture de migration, ou si l’équipe dépasse le périmètre où l’absence de DI devient coûteuse.
