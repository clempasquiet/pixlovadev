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

## À traiter par lot

| Décision | Responsable du lot | Livrable |
|---|---|---|
| Renderer, IPC et profils Linux/Windows | L00 puis L06-N | Prototype mesuré, ADR, matrice de compatibilité |
| Schémas JSON, signature et fixtures communes | L00 puis L05/L06 | Contrats versionnés et tests croisés |
| Scopes de contenu et matrice RBAC détaillée | L01 | ADR, permissions et tests multi-tenant |
| Limites de médias, cache, timelines et vidéos simultanées | L03/L04/L05/L06 | Configuration bornée et résultats de qualification |
| Prix, quotas, grâce, downgrade et annulation sans sélection | L08 | Matrice des transitions ; validation produit avant activation payante |
| Domaines principaux, stockage/CDN, hébergement et secrets | L09-I | ADR de déploiement et configuration staging |
| Rétention, DPA, sous-traitants et effacement offline | L09-R | Politique validée et recette d’effacement |
| SLO, PRA, support et plateformes supportées | L09-R | Mesures réelles et engagement approuvé avant lancement |

## Écrire une décision

Copier [le modèle ADR](adr/TEMPLATE.md) dans un fichier numéroté. Statuts : proposée, acceptée, remplacée. Une décision acceptée explique sa portée, ses contraintes et ses critères de vérification. Les choix techniques courants peuvent être faits dans le mandat de développement ; les conditions commerciales, juridiques et de production nécessitent le mandat correspondant.
