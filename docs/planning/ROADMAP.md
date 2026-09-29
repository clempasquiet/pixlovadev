# Roadmap et dépendances

La [roadmap produit](../spec/chapters/18.md) fixe les versions. Le [backlog GitHub](BACKLOG.md) contient les tickets exécutables.

## Ordre de réalisation

```mermaid
flowchart TD
  L00[Fondations et contrats] --> L01[Identités et isolation]
  L00 --> L04[Rendu et créateur]
  L00 --> L06N[Player natif]
  L00 --> L06W[Player Web]
  L01 --> L02[Displays et appairage]
  L01 --> L03[Médias]
  L03 --> L04
  L02 --> L05[Programmation et manifests]
  L04 --> L05
  L02 --> L06N
  L02 --> L06W
  L05 --> L07[Supervision et commandes]
  L06N --> L07
  L06W --> L07
  L01 --> L08[Stripe et licences]
  L02 --> L08
  L00 --> L09I[Infrastructure privée et staging]
  L01 --> L09A[Administration plateforme]
  L08 --> L09M[Site marketing]
  L07 --> L09R[Recette et mise en service]
  L08 --> L09R
  L09I --> L09R
  L09A --> L09R
  L09M --> L09R
```

Les prototypes peuvent avancer contre les fixtures stabilisées de L00. Une livraison intégrée exige les dépendances API réelles. Les tickets précisent les dépendances de fin de lot ; les travaux sur contrats communs doivent être coordonnés.

## V1

L00 à L09-R livrent ensemble le parcours complet : compte, appairage, Display, média, programmation, manifest, lecture native/Web, supervision et paiement. L09-R ferme uniquement lorsque toutes les preuves de lancement sont présentes.

## V1.5

API publique, webhooks, proof of play, diagnostics enrichis, captures automatiques, rôles personnalisés, templates d’organisation, déploiement progressif, multi-output renforcé et premiers outils intégrateur.

## V2

Canvas distribué, mapping LED, synchronisation qualifiée NTP/PTP, widgets/datasources, HTML isolé, marque blanche, templates intégrateur, SSO/SCIM et SLA avancés.

Les epics V1.5/V2 sont des réserves de périmètre. Ils ne sont pas nécessaires pour finir une tranche V1 et ne doivent pas être commencés par défaut.
