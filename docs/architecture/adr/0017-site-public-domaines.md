# ADR-017 — Site public : génération statique, conteneur dédié et répartition des domaines

- Statut : **acceptée**. La répartition des domaines a été validée par le responsable produit le 2026-10-01.
- Date : 2026-10-01
- Ticket / lot : [L09-M #13](https://github.com/clempasquiet/pixlovadev/issues/13)
- Exigences concernées : WEB-001, WEB-002, WEB-003, WEB-004, ARC-008, DEC-01, DOC-010 (comparaison des Players avant installation), PAR-001 (liens d’inscription)
- Décision remplaçant / remplacée par : complète l’[ADR-015](0015-infrastructure-recette.md) (service `site` de la recette)

## Problème et contraintes

Le site marketing doit avoir sa propre application et son propre conteneur, déployables sans toucher au dashboard ni aux Players (WEB-001). Astro et Next.js étaient laissés ouverts.

D’autres contraintes s’ajoutent :

- les tarifs affichés ne doivent pas diverger de Checkout (WEB-001) ;
- aucune fonction V1.5/V2, aucun essai ni remise annuelle ne doit être présenté comme disponible (WEB-003) ;
- accessibilité clavier, responsive, métadonnées, sitemap et page d’erreur sont exigés (WEB-004) ;
- le domaine principal entre pixlova.com et pixlova.fr devait être choisi (DEC-01).

La maquette de la page d’accueil a été validée en PNG par le responsable produit le 2026-10-01, avec la charte de la marque (plaquette pixlova).

## Décision

### Application `apps/site`

**Rendu.** Les pages sont des composants React rendus **au build** (`renderToStaticMarkup`) :

- Vite compile le générateur `src/build.tsx` en mode SSR ;
- `node build/ssr/build.js` écrit le HTML dans `dist/`.

**Navigateur.** Aucun React n’est envoyé au navigateur. Un script sans dépendance (`src/site.js`) gère :

- le menu mobile ;
- le calculateur de tarifs ;
- le dessin du mur LED (canvas, avec un équivalent textuel).

Sans JavaScript, les pages restent complètes et navigables.

**Feuilles et scripts** : nommés par empreinte (`/assets/site.<sha256>.css`), donc mis en cache sans limite.

**Polices** : Archivo (titres), Instrument Sans (texte) et IBM Plex Mono (étiquettes), sous licence SIL OFL 1.1.

- Elles viennent de Fontsource et sont auto-hébergées, avec leur licence copiée dans `dist/fonts/`.
- Elles servent la marque : elles ne font pas partie des polices qualifiées pour le rendu des compositions ([ADR-010](0010-compositions-editeur-templates.md)).

**Couleurs** : celles de la charte.

- Les textes secondaires utilisent `#6c6d7a` : le `#9c9dac` de la charte n’atteint que 2,7:1 sur le fond `#fffff2`.
- Un bouton rose portant du texte blanc courant utilise `#d6336f` (4,6:1) : le rose de la charte (`#e9457f`) reste réservé aux titres, aux aplats et aux textes foncés.

### Configuration au build

| Variable | Rôle | Défaut |
|---|---|---|
| `PIXLOVA_SITE_ORIGIN` | Liens canoniques, sitemap | `https://www.pixlova.com` |
| `PIXLOVA_SITE_APP_URL` | Liens « Connexion » (`/login`) et « Créer un compte » (`/register`) | `https://app.pixlova.com` |
| `PIXLOVA_SITE_STATUS_URL` | Lien « État du service » | absent : aucun lien n’est affiché |
| `PIXLOVA_SITE_INDEXABLE` | `true` autorise l’indexation | `false` : `noindex` sur toutes les pages et `robots.txt` refuse tout |

L’indexation doit être activée explicitement, pour la seule production : une recette ou une préproduction ne peut pas être indexée par erreur.

### Pages et promesses

**Pages livrées** : accueil, fonctionnalités, Player natif & Web, cas d’usage, tarifs, FAQ, mentions légales, CGV, confidentialité, accord de traitement des données, et 404.

**Pages légales.** Ce sont des modèles génériques (`src/legal.tsx`), demandés par le responsable produit le 2026-10-01 en attendant les textes définitifs. L’identité de l’éditeur, l’hébergeur, les durées et le plafond de responsabilité y sont des champs entre crochets, visibles dans la page : aucune identité juridique n’est inventée. Les clauses reprennent les règles du cahier des charges (renouvellement, diminution à échéance, résiliation vers Free sans suppression des données, rôle de sous-traitant). Les pages restent `noindex` et hors du sitemap jusqu’aux textes validés.

**Pages reportées.** La documentation produit et l’état du service ne sont pas livrés :

- l’état du service doit être hébergé indépendamment (WEB-002) ;
- la documentation suivra le guide utilisateur (DOC-010).

**Tarifs.** Le site lit un catalogue unique, `src/catalog.ts` :

- tant que L08 ne publie pas son catalogue contrôlé, il contient les prix **indicatifs** du cahier des charges (§ 11.2), affichés avec la mention « Tarifs indicatifs, en cours de validation » ;
- le calculateur est précalculé au build (une valeur par nombre d’écrans), ce qui évite de dupliquer la règle de prix dans le navigateur ;
- l’essai de 14 jours et la remise annuelle ne sont pas affichés ;
- le nombre d’utilisateurs de Business est affiché « À définir ».

Le branchement sur la publication L08 ne change que la source de `SITE_CATALOG`.

**Fonctionnalités.** Elles se limitent à la V1. La FAQ dit explicitement que la synchronisation de plusieurs sorties et le découpage d’un contenu sur plusieurs écrans (V2) ne sont pas proposés.

### Conteneur et séparation des surfaces

| Surface | Origine | Conteneur | Réseau |
|---|---|---|---|
| Site public | `www`, rôle ARC-008 | `site` (Caddy, port 8090, fichiers statiques) | `edge` seulement : n’atteint ni l’API, ni la base, ni le stockage |
| Dashboard, Player Web, API | `app` (origine unique, [ADR-015](0015-infrastructure-recette.md)) | `gateway`, `api` | `front`, `data` |
| Administration plateforme | aucune origine publique ([ADR-016](0016-administration-plateforme.md)) | `admin` | `mgmt` ; jamais liée depuis le site |

**Sécurité de la passerelle du site.** Caddy applique une CSP stricte :

- pas de script ni de feuille en ligne ;
- seuls les attributs `style` des frises sont autorisés ;
- `frame-ancestors 'none'`.

S’y ajoutent HSTS, `nosniff`, `Referrer-Policy` et `Permissions-Policy`.

**Cache et erreurs.** Les pages sont revalidées à chaque visite, les ressources à empreinte sont immuables, et une page 404 dédiée est servie.

Le site ne pose aucun cookie et ne charge aucun outil de mesure d’audience. Leur choix relève de la conception RGPD (WEB-004).

### Répartition des domaines — validée le 2026-10-01

| Hostname | Rôle |
|---|---|
| `www.pixlova.com` | Site public, origine canonique |
| `pixlova.com` | Redirection 301 vers `https://www.pixlova.com`, chemin conservé |
| `pixlova.fr`, `www.pixlova.fr` | Redirection 301 vers `https://www.pixlova.com`, chemin conservé |
| `app.pixlova.com` | Dashboard |
| `player.pixlova.com` | Player Web |
| `api.pixlova.com` | API HTTP et canal WSS des Players (PROTO-005) |
| `update.pixlova.com` | Distribution des mises à jour signées du Player natif (SEC-011) |
| `status.pixlova.com` | État du service, hébergé hors du serveur principal (fournisseur à choisir) |

Les redirections se configurent chez Cloudflare (règles de redirection), sans serveur supplémentaire. Une seule origine canonique évite le contenu dupliqué ; le `.fr` reste protégé et utile en communication, sans second site à maintenir.

Cette répartition reprend les rôles `www`, `app`, `api` et `player` d’ARC-008. Elle diffère de la recette, où dashboard, Player Web et API partagent une origine unique ([ADR-015](0015-infrastructure-recette.md)). Séparer ces origines en production demande un travail hors de ce lot, à mener avant la mise en production :

- politique CORS explicite de l’API pour `app` et `player` ;
- portée des cookies de session et protection CSRF entre origines ;
- configuration des URL d’API dans le dashboard, le Player Web et l’agent natif ;
- routes du tunnel et certificats pour chaque hostname.

Le site public ne dépend que de `app.pixlova.com` (`/login`, `/register`) et, quand elle existera, de `status.pixlova.com`.

Aucune publication DNS, aucun certificat et aucun achat n’est réalisé par ce lot.

## Options évaluées

- **Astro** : très adapté aux sites statiques, mais un framework et un compilateur de plus à maintenir et à épingler (ADR-001). Rien ici ne demande ses îlots ni son routage par fichiers : une dizaine de pages et trois comportements en JavaScript.
- **Next.js** : export statique possible, mais un framework lourd pour des pages sans données dynamiques. Un serveur Node serait tentant pour le site, ce qui irait à l’encontre d’un conteneur minimal.
- **Vite multipage + React côté client** : le contenu serait rendu par le navigateur, au détriment du référencement, du premier affichage et de la CSP.
- **Rendu statique React au build (retenu)** : mêmes outils que le reste du dépôt (React 19, Vite 8, Vitest, Playwright), HTML complet à la livraison, aucun runtime serveur. Image Caddy identique à la passerelle de recette.

## Conséquences et validation

**Tests automatisés.**

- `pnpm --filter @pixlova/site test` vérifie :
  - le calcul BILL-004 (14 écrans en Pro = 55 € HT) et le refus d’un second écran en Free ;
  - une seule `h1` et les métadonnées de chaque page ;
  - l’absence de lien interne cassé ;
  - les liens d’inscription et de connexion ;
  - l’absence d’essai ou de remise annuelle ;
  - le `noindex` des pages légales et hors production ;
  - le sitemap et `robots.txt`.
- `pnpm --filter @pixlova/site test:browser` (Chromium) vérifie :
  - l’absence de défilement horizontal à 390 px et 1440 px sur chaque page ;
  - l’absence d’erreur dans la console ;
  - le lien d’évitement, le menu mobile (Entrée, Échap, retour du focus) et le calculateur au clavier ;
  - le dessin du mur LED.
- `infra/recette/scripts/site-smoke.mjs`, exécuté par `ci-recette.sh`, vérifie à travers le conteneur :
  - les liens vers le dashboard de la recette ;
  - la CSP, la 404 et `robots.txt` ;
  - l’isolement réseau : API et base injoignables depuis le conteneur.

**À valider par le responsable produit** :

- les prix, quotas et libellés commerciaux (« 1 écran gratuit, sans carte bancaire », mise en avant de Pro) ;
- les textes légaux définitifs et l’identité de l’éditeur ;
- l’hébergement de la page d’état.

**Réexamen** si le site doit servir du contenu dynamique (blog éditable, documentation versionnée), si le catalogue L08 impose une publication à chaud sans rebuild, ou si la répartition des domaines change.
