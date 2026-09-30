# Registre des décisions

Source complète : [chapitre 24](../spec/chapters/24.md). Ne pas créer un second cahier des charges divergent dans ce registre.

## Acté

- Nom **pixlova**, domaines **pixlova.com** et **pixlova.fr**.
- Offre d’organisation + entitlements + licences de Display ; Free avec un Display actif et un utilisateur.
- Player natif Rust et Player Web ; identité installation/machine/Player distincte.
- Display durable, manifests signés et activation atomique, cache et rollback.
- Administration privée, services Docker séparés, exposition publique via Cloudflare Tunnel.
- PostgreSQL, stockage S3 compatible, Redis et traitements asynchrones.

## ADR acceptés

| ADR | Sujet | Lot |
|---|---|---|
| [ADR-001](adr/0001-outillage-workspace-versions.md) | Node 24, pnpm workspaces, TypeScript, Rust épinglés | L00 |
| [ADR-002](adr/0002-backend-api-orm-jobs.md) | Fastify, Drizzle, PostgreSQL, BullMQ + outbox, listeners public/interne | L00 |
| [ADR-003](adr/0003-contrats-signature-fixtures.md) | Contrats TypeBox/JSON Schema, JCS + Ed25519, fixtures TypeScript/Rust | L00 |
| [ADR-004](adr/0004-schema-migrations-isolation-tenant.md) | Schéma initial, FK composites, RLS et rôles PostgreSQL, migrations | L00 |
| [ADR-006](adr/0006-authentification-sessions.md) | Argon2id, sessions opaques par cookie, CSRF, TOTP, jetons à usage unique, outbox email | L01 |
| [ADR-007](adr/0007-rbac-scopes.md) | Rôles V1, permissions nommées, scopes par site, délégation, dernier Owner | L01 |
| [ADR-008](adr/0008-appairage-players-displays.md) | Appairage par code, clé Ed25519 et jeton court des Players, slots sous verrou, affectations générationnelles, idempotence | L02 |
| [ADR-009](adr/0009-bibliotheque-media-stockage-pipeline.md) | Stockage objet abstrait (S3 ou local signé), upload en quarantaine, file de tâches PostgreSQL à bail, pipeline sharp/FFmpeg, quota sur les originaux, corbeille, visibilité par site | L03 |
| [ADR-010](adr/0010-compositions-editeur-templates.md) | Document d’édition distinct du document résolu, six polices OFL empaquetées, brouillon à concurrence optimiste, versions immuables, validation avant publication, templates versionnés avec le code, comparaison Chromium / WebKitGTK | L04 |
| [ADR-011](adr/0011-programmation-compilation-manifests.md) | Playlists et programmes (planning, campagne, override) en brouillon + versions immuables, heures locales et DST, arbitrage unique, compilation idempotente par révision désirée, préflight, états désiré/préparé/appliqué | L05 |
| [ADR-012](adr/0012-player-natif-agent-cache-mises-a-jour.md) | Player natif : agent et renderer séparés, SQLite additive, cache SHA-256 épinglé, activation atomique confirmée par la première image, IPC local authentifié, watchdog, mises à jour signées avec lanceur A/B et retour arrière | L06-N |
| [ADR-013](adr/0013-player-web.md) | Player Web : identité par profil navigateur (clé WebCrypto non extractible), clés de confiance livrées avec l’application, IndexedDB et Cache API vérifiée, quota et éviction, service worker d’application versionné, lecture partagée avec le natif (`@pixlova/player-core`), limites assumées | L06-W |
| [ADR-014](adr/0014-supervision-commandes-alertes.md) | Supervision : signaux distincts (présence, santé, rendu, sortie, capture), commandes signées par une clé dédiée via HTTPS (WSS reporté), captures privées à rétention courte, timeline corrélée, incidents dédupliqués avec maintenance et corrélation plateforme, métriques à cardinalité bornée | L07 |

## ADR proposés (en attente de preuves)

| ADR | Sujet | Condition d’acceptation |
|---|---|---|
| [ADR-005](adr/0005-renderer-natif-webview.md) | Moteur de rendu TypeScript unique, renderer natif sur WebView système (wry) | Mesures du [protocole de qualification](../quality/QUALIFICATION-RENDU.md) sur Linux et Windows |

## À traiter par lot

| Décision | Responsable du lot | Livrable |
|---|---|---|
| Renderer, IPC et profils Linux/Windows | L00 (prototype, ADR-005 proposée) puis L06-N | Mesures matérielles, acceptation de l’ADR-005, matrice de compatibilité |
| Racine de confiance, rotation des clés, challenge Player | L02/L05/L06 | Extension de l’ADR-003 et vecteurs croisés |
| Matrice RBAC : confirmation produit des valeurs de l’ADR-007 | Responsable produit | Validation ou PR du catalogue |
| Limites de médias (proposées par l’ADR-009, à valider), cache, timelines et vidéos simultanées | L03/L04/L05/L06 | Configuration bornée et résultats de qualification |
| Prix, quotas, grâce, downgrade et annulation sans sélection | L08 | Matrice des transitions ; validation produit avant activation payante |
| Domaines principaux, stockage/CDN, hébergement et secrets | L09-I | ADR de déploiement et configuration staging |
| Rétention, DPA, sous-traitants et effacement offline | L09-R | Politique validée et recette d’effacement |
| SLO, PRA, support et plateformes supportées | L09-R | Mesures réelles et engagement approuvé avant lancement |

## Écrire une décision

Copier [le modèle ADR](adr/TEMPLATE.md) dans un fichier numéroté. Statuts : proposée, acceptée, remplacée. Une décision acceptée explique sa portée, ses contraintes et ses critères de vérification. Les choix techniques courants peuvent être faits dans le mandat de développement ; les conditions commerciales, juridiques et de production nécessitent le mandat correspondant.
