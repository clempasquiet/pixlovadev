# Player natif

Composants Rust du Player natif ([ADR-012](../docs/architecture/adr/0012-player-natif-agent-cache-mises-a-jour.md)) :

| Crate | Binaires | Rôle |
|---|---|---|
| `contracts` | — | JSON strict, JCS, signatures, manifests, commandes, releases, protocole IPC local |
| `agent` | `pixlova-agent`, `pixlova-launcher` | identité, API Player, SQLite, cache vérifié, activation atomique, supervision, mises à jour, lanceur A/B |
| `renderer` | `pixlova-renderer` | WebView système hébergeant `apps/player-shell` ; modes Player, `--headless` et laboratoire |

## Commandes

```sh
cargo build -p pixlova-agent -p pixlova-renderer
pnpm --filter @pixlova/player-shell... run build          # page de lecture

# Agent contre une API locale, renderer lancé par l’agent (développement)
target/debug/pixlova-agent run --data-dir work/player --api-url http://127.0.0.1:3000 \
  --trust-dir work/player-trust \
  --renderer-program target/debug/pixlova-renderer \
  --renderer-arg --shell-dir --renderer-arg apps/player-shell/dist --renderer-arg --windowed \
  --virtual-output HDMI-1:1920x1080

target/debug/pixlova-agent diagnose --data-dir work/player   # rapport JSON sans secret
```

`work/player-trust/manifest-keys.json` contient la clé **publique** de signature des manifests du worker : `{"keys":[{"kid":"<PIXLOVA_MANIFEST_KEY_ID>","public_key":"<base64url>"}]}`. Voir [Lancer en local](../docs/dev/LANCER-EN-LOCAL.md#essayer-le-player-natif-linux).

## Tests

```sh
cargo test --workspace
# Avec le vrai renderer (sans affichage : watchdog, relance, restauration)
cargo build -p pixlova-renderer
PIXLOVA_TEST_RENDERER=$PWD/target/debug/pixlova-renderer cargo test -p pixlova-agent --test renderer
# WebKitGTK jusqu’à la première image
PIXLOVA_TEST_RENDERER=$PWD/target/debug/pixlova-renderer PIXLOVA_TEST_SHELL_DIR=$PWD/apps/player-shell/dist \
  xvfb-run -a cargo test -p pixlova-agent --test renderer
# Bout en bout avec API, worker et PostgreSQL réels
PIXLOVA_TEST_DATABASE_URL=… node apps/api/scripts/e2e-native-player.mjs [--webview]
```

## Paquets et mises à jour

```sh
scripts/release/package-player.sh <dossier-des-clés-publiques> pixlova-0.2.0.tar
PIXLOVA_RELEASE_KEY_ID=… PIXLOVA_RELEASE_SIGNING_KEY=… \
  node scripts/release/sign-release.mjs --package pixlova-0.2.0.tar --version 0.2.0 > release.json
pixlova-agent update apply --release release.json --package pixlova-0.2.0.tar   # sur le Player
```

Installation Linux : `packaging/linux/install.sh` (compte `pixlova`, service `pixlova-launcher`, unité utilisateur `pixlova-renderer`). La signature des releases n’a lieu que dans l’environnement de release ; aucune clé privée n’est versionnée.
