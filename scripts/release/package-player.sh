#!/bin/sh
# Construit l’archive d’un Player natif Linux à signer (ADR-012) :
#
#   scripts/release/package-player.sh <dossier-des-clés-publiques> <sortie.tar>
#
# Le dossier des clés contient manifest-keys.json, release-keys.json et command-keys.json
# (clés PUBLIQUES uniquement, trois clés distinctes). La signature des métadonnées se fait ensuite avec sign-release.mjs, dans
# l’environnement de release qui détient la clé privée ; jamais sur un poste de dev.
set -eu
root=$(cd "$(dirname "$0")/../.." && pwd)
trust=${1:?dossier des clés publiques}
output=${2:?archive de sortie}
for file in manifest-keys.json release-keys.json command-keys.json; do
  [ -f "$trust/$file" ] || { echo "$trust/$file absent" >&2; exit 1; }
done
if grep -qi '"seed\|private\|secret' "$trust"/*.json; then
  echo "le dossier des clés semble contenir une clé privée : refusé" >&2
  exit 1
fi
cd "$root"
cargo build --release --locked -p pixlova-agent -p pixlova-renderer
pnpm --filter @pixlova/player-shell... run build
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
install -m 0755 target/release/pixlova-agent target/release/pixlova-launcher target/release/pixlova-renderer "$stage/"
cp -R apps/player-shell/dist "$stage/player-shell"
mkdir "$stage/trust"
cp "$trust/manifest-keys.json" "$trust/release-keys.json" "$trust/command-keys.json" "$stage/trust/"
cp packaging/linux/install.sh packaging/linux/pixlova-launcher.service packaging/linux/pixlova-renderer.service "$stage/"
# Horodatages et propriétaires fixes : archive reproductible à contenu égal.
tar --sort=name --owner=0 --group=0 --numeric-owner --mtime='2026-01-01 00:00:00Z' \
  -C "$stage" -cf "$output" .
echo "$output"
