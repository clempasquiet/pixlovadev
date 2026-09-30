# ADR-008 — Appairage, authentification des Players, slots et affectations

- Statut : acceptée
- Date : 2026-09-29
- Ticket / lot : [L02 #3](https://github.com/clempasquiet/pixlovadev/issues/3)
- Exigences concernées : PLY-001 à PLY-003, DSP-001 à DSP-006, PROTO-001 à PROTO-004, SEC-005 à SEC-007, DATA-005, DATA-006, BILL-002 à BILL-004, API-005, PAR-002
- Décision remplaçant / remplacée par : —

## Décision

### Appairage (PROTO-001)

1. Le Player génère son `installation_id` et une paire **Ed25519** ; la clé privée reste sur l’appareil.
2. Enregistrement : `POST /player/v1/register` (clé publique, capacités validées par le contrat, sorties). Le serveur renvoie :
   - un code lisible `XXXX-XXXX` (alphabet sans 0/O/1/I/L), **5 minutes** ;
   - un `poll_secret` de 256 bits.

   Seules les empreintes du code et du secret sont stockées. Aucun tenant n’est choisi à ce stade.
3. Réclamation : `POST /api/v1/players/pair` (`code`, `name`, `site_id`, en-tête `Idempotency-Key`).
   - Permission `player.pair` sur le site.
   - Sous verrou de la session d’appairage (rôle système) : création du Player, de ses sorties et de son credential génération 1, marquage « réclamé ».
   - Une seconde réclamation, concurrente ou tardive, échoue (`PAIRING_CODE_INVALID`) ; un code expiré → `PAIRING_EXPIRED`.
   - Limitation : 10 tentatives / 10 min par utilisateur, 30 par organisation.
4. Récupération : `POST /player/v1/pair` avec le `poll_secret`. Seul l’appareil qui a reçu le secret obtient `player_id` et `organization_id`. Les reprises sont idempotentes.
5. Une empreinte machine identique à un Player existant n’est qu’une **suggestion** de réinstallation renvoyée à l’utilisateur ; elle ne transfère aucun droit (PLY-003).

### Authentification (PROTO-002, PROTO-003)

- `POST /player/v1/token/challenge` émet un challenge à usage unique (60 s). Il est typé `PIXLOVA_PLAYER_AUTH_V1`, d’audience `pixlova-player-api`, et contient un nonce, le Player et l’installation.
- Le Player signe le JCS du challenge. `POST /player/v1/token/refresh` vérifie la signature (Ed25519 strict) avec la clé enregistrée, consomme le challenge et émet un **jeton opaque de 15 minutes**, stocké haché.
- Chaque requête revérifie l’état du Player et du credential : une révocation prend effet immédiatement. Elle est signalée par `403 PLAYER_REVOKED`, distinct d’un jeton expiré (`401`).
- Signature et vérification sont implémentées et testées à l’identique en TypeScript et en Rust (`player-auth-vectors.json` : Rust reproduit la signature TypeScript).
- Choix pour le Player Web : même mécanisme, clé Ed25519 non exportable via WebCrypto. Son profil de sécurité et les navigateurs qualifiés relèvent de L06-W (PROTO-002).

### Displays et slots

- Display : résolution libre 1–32767 px, orientation 0/90/180/270, fuseau optionnel (hérité du site puis de l’organisation), mode de repli `standby_screen` en attendant les contenus de repli (L05).
- **Slots** : chaque Display `active` consomme un slot. La création et la réactivation vérifient la capacité **sous verrou de l’organisation**, donc sans course sur le dernier slot. Au-delà, `409 DISPLAY_LIMIT_REACHED` avec `allowed` et `active` : jamais de création facturable implicite.
- La désactivation libère le slot sans supprimer ni le Display ni sa programmation. La capacité vient de `EntitlementsProvider.displaySlots` (Free = 1) ; les licences et achats relèvent de L08.
- Compatibilité déclarée (`max_canvas`) exposée sur la fiche (`ok`, `exceeds_max_canvas`, `unknown`) ; le blocage à la publication relève de L05.

### Affectations et remplacement (DATA-006)

`PUT /api/v1/displays/:id/assignment` (`Idempotency-Key`), dans une transaction tenant :

1. verrou du Display et de la sortie cible ;
2. refus explicite d’une sortie occupée (`ASSIGNMENT_CONFLICT`), sans vol d’affectation ;
3. clôture de l’affectation courante ;
4. génération incrémentée, nouvelle affectation, événement outbox `display.assignment_changed`, audit.

Les index uniques partiels restent la garantie finale (ADR-004). Le `display_id`, les groupes et l’historique sont conservés, et les autres sorties de l’ancien Player ne sont pas touchées.

Un ancien Player qui annonce une génération périmée dans son heartbeat reçoit `stale_displays` : l’affectation n’est jamais rouverte. La révocation d’un Player clôt ses affectations, révoque credentials et jetons, et conserve les Displays.

### Présence

Heartbeat nominal 30 s ; présence `online` si le dernier contact reçu date de moins de 90 s, sinon `offline` avec horodatage, `unknown` sans contact. L’heure serveur fait foi. Le WebSocket et la supervision détaillée relèvent de L07.

### Idempotence (API-005)

Table `idempotency_keys` par (organisation, acteur, opération, clé) avec empreinte canonique de la requête. Même clé et même requête renvoient le résultat enregistré ; même clé et corps différent renvoient `409 IDEMPOTENCY_CONFLICT`. Appliquée à l’appairage et aux affectations ; à étendre aux publications (L05), commandes (L07) et changements d’abonnement (L08).

## Conséquences et validation

Tests d’intégration sur PostgreSQL réel (`apps/api/test/fleet.integration.test.ts`, 17 tests) :

- appairage nominal et idempotent, code réutilisé, clé manquante, réclamation concurrente par deux organisations, expiration côté utilisateur et Player ;
- secret de suivi erroné, challenge rejoué, expiré ou signé par une autre clé, jeton expiré ;
- résolutions libres et valeurs invalides, slots sous concurrence (trois créations, une seule réussit), désactivation ;
- sortie occupée sous concurrence, remplacement avec génération, historique et autre sortie intacte ;
- ancien Player reconnecté, présence datée, révocation ;
- isolation inter-tenant, technicien limité à un site, groupes.

Limites et suites :

- Rotation du credential Player et récupération d’un appareil réinstallé (nouvelle génération) : L06-N.
- Le paramètre de durée du code et du jeton reste une [PROPOSITION] configurable (DEC-12).
