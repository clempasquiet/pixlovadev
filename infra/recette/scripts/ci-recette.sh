#!/bin/sh
# Recette exercée de bout en bout sur une instance JETABLE (CI ou poste de développement) :
# construction des images, démarrage, parcours utilisateur, reprise du worker, arrêt propre
# et redémarrage, sauvegarde, perte totale des volumes, restauration.
# Refuse de s’exécuter si infra/recette/.env existe : il détruit les volumes à la fin.
set -eu
cd "$(dirname "$0")/../../.."
recette=infra/recette
compose() { docker compose -f "$recette/compose.yaml" "$@"; }
if [ -e "$recette/.env" ]; then
  echo "$recette/.env existe : instance réelle probable, recette jetable refusée." >&2
  exit 1
fi
work=$(mktemp -d)
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then compose logs --no-color --tail 80 || true; fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$recette/.env" "$recette/trust" "$recette/backups" "$work"
  exit "$status"
}
trap cleanup EXIT INT TERM

step() { printf '\n== %s\n' "$1"; }
step "Initialisation (secrets générés, sans tunnel)"
node "$recette/scripts/init-recette.mjs" --url http://localhost:8080 --no-tunnel

step "Construction et démarrage"
# PIXLOVA_RECETTE_BUILD=0 : images pixlova-*:local déjà construites (réseau filtré).
if [ "${PIXLOVA_RECETTE_BUILD:-1}" = 1 ]; then compose build; fi
compose up -d --wait --quiet-pull

step "Parcours utilisateur et reprise du worker"
node "$recette/scripts/smoke.mjs" --worker-restart --save-state "$work/state.json"

step "Administration plateforme (réseau privé, TOTP, révocation)"
node "$recette/scripts/admin-smoke.mjs"

step "Site public (conteneur séparé, isolé de l’API)"
node "$recette/scripts/site-smoke.mjs"

step "Arrêt propre puis redémarrage"
compose stop
for service in api worker admin; do
  code=$(docker inspect -f '{{.State.ExitCode}}' "$(compose ps -a -q "$service")")
  echo "$service arrêté avec le code $code"
  [ "$code" -eq 0 ]
done
compose up -d --wait
node "$recette/scripts/smoke.mjs" --check-state "$work/state.json"

step "Sauvegarde, perte des volumes et restauration"
"$recette/scripts/backup.sh"
compose down -v
compose up -d --wait
if node "$recette/scripts/smoke.mjs" --check-state "$work/state.json" >/dev/null 2>&1; then
  echo "données présentes après suppression des volumes : test invalide" >&2
  exit 1
fi
"$recette/scripts/restore.sh" "$(ls -d "$recette"/backups/*/ | tail -n 1)"
node "$recette/scripts/smoke.mjs" --check-state "$work/state.json"
node "$recette/scripts/smoke.mjs"

step "Recette de l’infrastructure réussie"
