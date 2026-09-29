# Recette et preuves

La recette détaillée est dans le [chapitre 19](../spec/chapters/19.md), le PRA dans le [chapitre 20](../spec/chapters/20.md) et la définition de terminé dans le [chapitre 23](../spec/chapters/23.md).

## Invariants bloquants

- Aucune fuite entre tenants, scopes, jobs, assets ou canaux temps réel.
- Aucun manifest incomplet, falsifié, rejoué illégalement ou pour la mauvaise affectation.
- Aucun asset au checksum invalide lu par le Player.
- Aucun planning perdu au remplacement d’un Player.
- Aucune suppression de données lors d’un downgrade ou retour Free.
- Aucune commande sensible sans autorisation, audit, expiration et déduplication.
- Aucune mise à jour native non signée ; rollback local fonctionnel.

## Preuves par nature de changement

| Domaine | Vérifications requises |
|---|---|
| Auth/RBAC | Deux tenants, accès par ID, scope site, changement de droits, concurrence du dernier Owner |
| Quotas/affectations | Courses concurrentes sur dernier slot/output, transfert et retour d’un ancien Player |
| Médias | MIME réel, fichier tronqué/corrompu, pipeline rejoué, quota et suppression référencée |
| Planning | Priorités, égalités, DST, minuit, exclusions, cycle, override expiré et fenêtre offline |
| Player | Cache complet, Internet 24 h coupé, crash renderer, disque plein, reboot brutal, update interrompue |
| Web | Profil navigateur qualifié, cache évincé, autoplay, visibilité/page active et limites documentées |
| Billing | Webhooks doublés/inversés, paiement asynchrone, grâce, fin de période et données conservées |
| Infrastructure | Admin inaccessible publiquement, panne Redis/DB/tunnel, restauration RPO/RTO mesurée |

## Dossier de validation

Pour chaque preuve, conserver environnement et versions, données de test, procédure, résultat, logs expurgés et limites. Distinguer test automatisé, recette manuelle et test terrain. Une case cochée sans résultat reproductible ne vaut pas validation.

Les seules vérifications automatisées du dépôt de préparation sont documentaires. Chaque lot ajoute et documente les builds et tests qui lui correspondent.
