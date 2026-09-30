# Qualification matérielle du Player natif

Procédure de recette du Player natif sur machine réelle ([ADR-012](../architecture/adr/0012-player-natif-agent-cache-mises-a-jour.md), NAT-001 à NAT-015, TST-052, TST-053). Elle complète les tests automatisés du dépôt. Ceux-ci ne remplacent pas une mesure sur matériel : ni la sortie HDMI, ni une coupure de courant, ni une journée hors ligne ne sont simulables en CI.

Chaque essai consigne dans `docs/quality/preuves/` :

- la machine : modèle, processeur, mémoire, disque ;
- le système et le compositeur ;
- la version de l’agent et du renderer ;
- la date ;
- le résultat observé, les journaux expurgés et les limites.

Une case cochée sans résultat reproductible ne vaut pas validation.

## Statut

| Plateforme | Implémentation | Qualification |
|---|---|---|
| Linux x86_64 (Debian 13 / Ubuntu 24.04, session kiosk Wayland ou X11) | Disponible (L06-N) ; vérifiée en CI sous Xvfb, sans matériel | À mesurer |
| Windows 11 x64 | [Conception seulement](../architecture/player-natif-windows.md) | Non commencée |

## Installation d’essai

1. Construire un paquet : `scripts/release/package-player.sh <clés-publiques> pixlova.tar` (voir `native/README.md`), l’extraire sur la machine.
2. `sudo ./install.sh --api-url https://…` : compte `pixlova`, service `pixlova-launcher`, unité utilisateur `pixlova-renderer`.
3. Configurer l’ouverture de session automatique du compte `pixlova` sur une session graphique minimale (par exemple GDM `AutomaticLogin` ou `cage`), puis redémarrer.
4. Le code d’appairage s’affiche en plein écran.

## Essais

| # | Essai | Procédure | Résultat attendu |
|---|---|---|---|
| 1 | Installation neuve | Installer le paquet, démarrer, appairer depuis le dashboard | Code affiché à l’écran, Player appairé, écran d’attente puis contenu |
| 2 | Clone d’image | Cloner le disque d’un Player appairé sans `identity/`, démarrer | Nouvelle identité et nouvel enregistrement, l’original n’est pas affecté |
| 3 | Deux sorties | Deux écrans affectés à deux Displays différents | Chaque écran diffuse son programme, plein écran sur la bonne sortie |
| 4 | HDMI débranché puis rebranché | Débrancher 2 min | Sortie remontée `connected: false`, diffusion reprise au rebranchement, l’autre sortie continue |
| 5 | 24 h hors ligne | Couper le réseau 24 h avec un programme qui change d’heure en heure | Changements respectés à l’heure locale, aucun écran noir, livraison déclarée à la reconnexion |
| 6 | Coupure de courant pendant téléchargement | Couper l’alimentation pendant le téléchargement d’un gros asset | Au redémarrage : ancien contenu diffusé, téléchargement repris, aucun fichier partiel lu |
| 7 | Coupure de courant pendant activation | Couper juste après la publication d’un manifest | Ancien ou nouveau contenu complet, jamais un mélange ; intention résolue au démarrage |
| 8 | Crash du renderer | `kill -9` du renderer | Relance automatique, reprise sans cloud, heartbeat `degraded` puis `ok` |
| 9 | Renderer figé | `kill -STOP` du renderer | Arrêt forcé après le délai du watchdog puis relance |
| 10 | Disque plein | Remplir le disque jusqu’à la réserve, publier un contenu lourd | `DISK_FULL` déclaré, diffusion courante maintenue, rien d’actif supprimé |
| 11 | Mise à jour valide | `pixlova-agent update apply` avec un paquet signé | Nouvelle version active après redémarrage, marqueur de santé posé |
| 12 | Mise à jour défectueuse | Paquet signé dont le renderer ne démarre pas | Retour automatique à la version précédente, release bloquée, diffusion reprise |
| 13 | Paquet altéré ou non signé | Modifier un octet du paquet | Refus avant extraction, aucune modification des versions installées |
| 14 | Horloge invalide | Régler l’horloge en 2020, redémarrer | Diffusion validée maintenue, aucune nouvelle activation, dérive signalée |
| 15 | Révocation | Révoquer le Player depuis le dashboard | Plus aucune synchronisation, état révoqué dans `diagnose` |
| 16 | Endurance | 7 jours de diffusion avec vidéos et changements fréquents | Mémoire et descripteurs stables, journaux bornés à 7 fichiers |

## Commandes utiles

```sh
sudo -u pixlova /var/lib/pixlova/versions/active/pixlova-agent diagnose   # rapport JSON sans secret
journalctl -u pixlova-launcher -f                     # journaux du service
systemctl --user -M pixlova@ status pixlova-renderer  # renderer de la session kiosk
sudo -u pixlova /var/lib/pixlova/versions/active/pixlova-agent update apply --release release.json --package pixlova.tar
sudo systemctl restart pixlova-launcher               # essai de la version installée
```
