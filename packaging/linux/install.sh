#!/bin/sh
# Installation du Player natif pixlova sur Linux (ADR-012), à exécuter en root depuis le
# dossier d’un paquet extrait :
#
#   sudo ./install.sh [--api-url https://api.exemple]
#
# Crée le compte `pixlova`, installe le lanceur et la version du paquet, les clés de
# confiance, puis active le service système et l’unité utilisateur du renderer. La
# session graphique automatique (kiosk) du compte `pixlova` reste à configurer selon la
# distribution : voir docs/quality/PLAYER-NATIF.md.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
api_url=""
while [ $# -gt 0 ]; do
  case "$1" in
    --api-url) api_url="$2"; shift 2 ;;
    *) echo "option inconnue : $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "à exécuter en root" >&2; exit 1; }
for file in pixlova-agent pixlova-launcher pixlova-renderer release.json player-shell/index.html trust/manifest-keys.json trust/release-keys.json trust/command-keys.json; do
  [ -e "$here/$file" ] || { echo "paquet incomplet : $file absent" >&2; exit 1; }
done
version=$("$here/pixlova-agent" version | awk '{print $2}')

id pixlova >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/pixlova --shell /usr/sbin/nologin pixlova

install -d -m 0755 /usr/lib/pixlova /usr/lib/pixlova/trust
install -m 0755 "$here/pixlova-launcher" /usr/lib/pixlova/pixlova-launcher
install -m 0644 "$here/trust/release-keys.json" /usr/lib/pixlova/trust/release-keys.json

install -d -o pixlova -g pixlova -m 0700 /var/lib/pixlova /var/lib/pixlova/versions
target=/var/lib/pixlova/versions/$version
if [ ! -d "$target" ]; then
  tmp="$target.tmp"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  cp -R "$here/pixlova-agent" "$here/pixlova-renderer" "$here/player-shell" "$here/trust" "$here/release.json" "$tmp/"
  chown -R pixlova:pixlova "$tmp"
  mv "$tmp" "$target"
fi
ln -sfn "$version" /var/lib/pixlova/versions/active
chown -h pixlova:pixlova /var/lib/pixlova/versions/active

if [ -n "$api_url" ]; then
  printf '{\n  "api_url": "%s"\n}\n' "$api_url" > /var/lib/pixlova/config.json
  chown pixlova:pixlova /var/lib/pixlova/config.json
  chmod 0600 /var/lib/pixlova/config.json
fi

install -m 0644 "$here/pixlova-launcher.service" /etc/systemd/system/pixlova-launcher.service
install -d /etc/systemd/user
install -m 0644 "$here/pixlova-renderer.service" /etc/systemd/user/pixlova-renderer.service
systemctl daemon-reload
systemctl enable --now pixlova-launcher.service
# Activée pour la session du compte pixlova (lancée par sa session graphique).
install -d -o pixlova -g pixlova /home/pixlova/.config/systemd/user/graphical-session.target.wants
ln -sfn /etc/systemd/user/pixlova-renderer.service /home/pixlova/.config/systemd/user/graphical-session.target.wants/pixlova-renderer.service
chown -h pixlova:pixlova /home/pixlova/.config/systemd/user/graphical-session.target.wants/pixlova-renderer.service

echo "pixlova $version installé. Diagnostic : sudo -u pixlova /var/lib/pixlova/versions/active/pixlova-agent diagnose"
