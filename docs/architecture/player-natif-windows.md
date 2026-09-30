# Player natif sous Windows — conception

Complément de l’[ADR-012](adr/0012-player-natif-agent-cache-mises-a-jour.md). En V1, l’agent, le lanceur et le packaging sont implémentés et testés pour **Linux**. Le renderer WebView2 est mesuré (ADR-005) mais le portage Windows de l’agent reste à faire : `pixlova-agent` refuse de compiler hors Unix plutôt que de livrer un comportement non vérifié.

## Répartition des processus

| Élément | Linux (implémenté) | Windows (à implémenter) |
|---|---|---|
| Lanceur et agent | service systemd, compte `pixlova` | service Windows, compte virtuel dédié (`NT SERVICE\pixlova`) |
| Renderer | unité `systemd --user` de la session kiosk | tâche planifiée « à l’ouverture de session » du compte kiosk (Assigned Access ou Shell Launcher) |
| IPC | socket Unix `0600`, pair par `SO_PEERCRED` | Named Pipe `\\.\pipe\pixlova-agent`, DACL limitée au compte kiosk et au service ; pair vérifié par `GetNamedPipeClientProcessId` puis jeton du processus |
| Arrêt forcé du renderer | `kill -KILL` du PID vérifié | `TerminateProcess` via un handle ouvert sur le PID vérifié ; droits accordés au service |
| Clé de l’appareil | fichier `0600` | fichier chiffré par DPAPI (portée machine), ACL service seulement |
| Données | `/var/lib/pixlova` | `%ProgramData%\pixlova` (ACL service ; `cache\blobs` en lecture pour le compte kiosk) |
| Journaux | journald + fichiers quotidiens | journal d’événements + fichiers quotidiens |
| Remplacement atomique | `rename` + `fsync` du dossier | `MoveFileExW(MOVEFILE_REPLACE_EXISTING \| MOVEFILE_WRITE_THROUGH)` |
| Lien de version active | lien symbolique `versions/active` | fichier `versions\active.txt` lu par la tâche du renderer (les liens exigent un privilège) |
| Sorties | `/sys/class/drm` | `EnumDisplayDevices` / DXGI, nom de moniteur stable |
| Mise à jour | archive tar signée | même format ; binaires signés Authenticode en plus |

Le renderer sous Windows sert les fichiers par `http://pixlova.app/` et `http://pixlova.asset/<sha256>` (convention WebView2 des protocoles personnalisés), déjà prise en compte par `pixlova-renderer` et la CSP de la page de lecture.

## Points à qualifier

- Démarrage sans session interactive et reconnexion après verrouillage.
- Mises à jour Windows et redémarrages imposés : reprise sur l’état local.
- Antivirus : exclusions éventuelles de `cache\tmp` sans exclure `cache\blobs` des contrôles.
- WebView2 Evergreen : version minimale et comportement hors ligne.

Ces essais rejoignent la procédure [PLAYER-NATIF](../quality/PLAYER-NATIF.md) avant toute annonce de disponibilité Windows.
