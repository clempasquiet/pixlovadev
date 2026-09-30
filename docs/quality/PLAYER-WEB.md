# Qualification du Player Web

Procédure et matrice de compatibilité du Player Web ([ADR-013](../architecture/adr/0013-player-web.md), PLY-006, WEBPLY-001 à 005, TST-043).

Le Player Web **n’offre pas les garanties du Player natif**. Le navigateur peut :

- évincer ses données ;
- suspendre l’onglet ou le service worker ;
- refuser le plein écran ou l’autoplay ;
- perdre l’identité si le profil est effacé.

Les résultats ci-dessous ne valent que pour le navigateur, sa version, l’OS et les préconditions indiqués.

## Préconditions de la recette hors ligne

1. Player appairé, Display affecté, programme publié.
2. Page ouverte, « Démarrer la diffusion » activé (plein écran).
3. Stockage persistant accordé (affiché dans l’état du Player).
4. Amorçage complet : l’écran indique le manifest appliqué et tous les assets en cache.
5. Onglet laissé au premier plan, veille de l’écran désactivée.

## Matrice

| Navigateur / OS | Codecs (H.264/AAC) | Autoplay muet | Son | Plein écran | Stockage persistant | Quota typique | Reprise hors ligne après rechargement | État |
|---|---|---|---|---|---|---|---|---|
| Chromium 141 headless / Linux (CI) | Selon build* | Oui | Non testé | Non applicable | Non testé | Mesuré en test | Oui (test automatisé) | Vérifié en CI |
| Chrome stable / Windows 11 | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À qualifier |
| Chrome stable / ChromeOS (kiosk) | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À qualifier |
| Edge stable / Windows 11 | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À qualifier |
| Firefox stable / Linux | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À qualifier |
| Safari / macOS | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À mesurer | À qualifier |

\* Le Chromium de test de Playwright ne contient pas toujours de décodeur H.264 propriétaire : le Player déclare alors ne pas le supporter, et le compilateur refuse les vidéos (`UNSUPPORTED_VIDEO_PROFILE`).

Protection de la clé : non extractible avec WebCrypto Ed25519 (Chrome ≥ 137, Firefox ≥ 129, Safari ≥ 17) ; sinon graine conservée par la page. La valeur observée est affichée dans l’état du Player.

## Essais par navigateur

| # | Essai | Résultat attendu |
|---|---|---|
| 1 | Premier lancement | Code d’appairage affiché ; après appairage, écran d’attente puis contenu |
| 2 | Fermeture de l’onglet puis réouverture | Reprise sans nouvel appairage, contenu restauré avant tout accès réseau |
| 3 | Réseau coupé 24 h (préconditions ci-dessus) | Programmation respectée à l’heure locale ; résultat publié tel quel, sans garantie universelle |
| 4 | Rechargement hors ligne | Application et contenu servis depuis le cache |
| 5 | Effacement des données du site | Nouvelle installation, nouvel appairage (remplacement de l’ancien Player) |
| 6 | Quota dépassé | `STORAGE_QUOTA_EXCEEDED` remonté ; contenu courant conservé |
| 7 | Stockage non persistant | Avertissement affiché ; capacité `persistent_storage: denied` |
| 8 | Autoplay refusé | Message et bouton de reprise |
| 9 | Plein écran refusé | Message expliquant l’action ou la politique kiosk requise |
| 10 | Nouvelle version de l’application | Activée seulement au rechargement suivant, jamais pendant une lecture |

Consigner chaque essai dans `docs/quality/preuves/` : navigateur, version, OS, date, résultat, limites.
