# Backlog de développement pixlova

Les tickets GitHub sont la source de suivi opérationnel (prise en charge, avancement, PRs). Cette liste décrit le découpage initial ; elle ne déclare aucun lot livré. [tasks.json](tasks.json) conserve périmètres, exigences, dépendances et critères de recette pour les agents.

## Commencer

Prendre **[L00 — Fondations et contrats (#1)](https://github.com/clempasquiet/pixlovadev/issues/1)**. Lire [AGENTS.md](../../AGENTS.md), le [guide de démarrage](../agents/START_HERE.md), les [décisions ouvertes](../architecture/DECISIONS.md) et les chapitres indiqués dans le ticket.

## Lots

| Lot | Ticket | Prérequis d’intégration |
| --- | --- | --- |
| L00 | [#1 — Fondations du monorepo, décisions et contrats partagés](https://github.com/clempasquiet/pixlovadev/issues/1) | Aucun |
| L01 | [#2 — Comptes, organisations, authentification, RBAC et audit](https://github.com/clempasquiet/pixlovadev/issues/2) | L00 |
| L02 | [#3 — Displays, slots, appairage et remplacement des Players](https://github.com/clempasquiet/pixlovadev/issues/3) | L01 |
| L03 | [#4 — Bibliothèque média et pipeline de préparation](https://github.com/clempasquiet/pixlovadev/issues/4) | L01 |
| L04 | [#5 — Moteur de rendu partagé, créateur et templates V1](https://github.com/clempasquiet/pixlovadev/issues/5) | L00, L03 |
| L05 | [#6 — Playlists, planning, campagnes, overrides et compilation](https://github.com/clempasquiet/pixlovadev/issues/6) | L02, L04 |
| L06-N | [#7 — Player natif Rust : cache, rendu, watchdog et mises à jour](https://github.com/clempasquiet/pixlovadev/issues/7) | L00, L02 |
| L06-W | [#8 — Player Web : appairage, rendu et cache navigateur](https://github.com/clempasquiet/pixlovadev/issues/8) | L00, L02 |
| L07 | [#9 — Supervision, commandes, alertes et observabilité](https://github.com/clempasquiet/pixlovadev/issues/9) | L05, L06-N, L06-W |
| L08 | [#10 — Abonnements Stripe, entitlements et codes promotionnels](https://github.com/clempasquiet/pixlovadev/issues/10) | L01, L02 |
| L09-I | [#11 — Infrastructure Docker, réseau privé et déploiement de recette](https://github.com/clempasquiet/pixlovadev/issues/11) | L00 |
| L09-A | [#12 — Administration privée de la plateforme et support audité](https://github.com/clempasquiet/pixlovadev/issues/12) | L01 |
| L09-M | [#13 — Site pixlova, domaines et parcours commercial](https://github.com/clempasquiet/pixlovadev/issues/13) | L08 |
| L09-R | [#14 — Recette V1, PRA, RGPD, documentation et dossier de livraison](https://github.com/clempasquiet/pixlovadev/issues/14) | L07, L08, L09-I, L09-A, L09-M |
| V15 | [#15 — Épic V1.5 : exploitation avancée et intégrations](https://github.com/clempasquiet/pixlovadev/issues/15) | L09-R |
| V2 | [#16 — Épic V2 : murs, synchronisation et fonctions entreprise](https://github.com/clempasquiet/pixlovadev/issues/16) | V15 |

## Coordination

- Réserver un lot dans son ticket avant de modifier des fichiers ; une prise en charge n’est pas une autorisation de travailler sur tous les autres lots.
- Décomposer les grands lots en PRs et, si utile, en sous-tickets avec une seule responsabilité observable.
- Après L00, les prototypes de rendu et Players peuvent utiliser les fixtures partagées. La clôture exige l’intégration avec le compilateur et le moteur de rendu réels.
- La roadmap représente les dépendances principales ; les détails d’intégration restent dans les critères des tickets.
- Les contrats, migrations et fichiers partagés ont un responsable de modification explicite. Préférer une PR de contrat commune avant des implémentations parallèles.
- Ne pas fermer un ticket pour un simple squelette. Conserver les preuves de validation et une [passation](../agents/HANDOFF.md).
- V1.5 et V2 sont des épics futurs à décomposer après les retours terrain et arbitrages ; ils ne doivent pas gonfler le périmètre V1.
