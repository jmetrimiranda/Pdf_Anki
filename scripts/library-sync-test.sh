#!/usr/bin/env bash
# Library sync against the REAL server in a container (compose.dev.yml, profile "library"): two app clients (PC A,
# PC B) exchange a book over 100 MB in parts, positions and a conflict copy (cargo test -p leitor-estudos --test
# library_sync external). Run on the host, repo root: scripts/library-sync-test.sh. Outside CI (the CI runs the same
# flows against the server in process). The server is recreated empty first and removed with its volume on exit,
# unless KEEP_SERVER=1. Never talks to anything but the local container.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
COMPOSE=(docker compose -f "$ROOT/compose.dev.yml" --profile library)
SERVICE=library-sync-dev
status=0

teardown() {
  if [[ "${KEEP_SERVER:-0}" == 1 ]]; then
    echo "KEEP_SERVER=1: $SERVICE left running"
  else
    "${COMPOSE[@]}" rm -sfv "$SERVICE" >/dev/null 2>&1 || true
    docker volume rm -f leitor-dev_library-sync-dev-data >/dev/null 2>&1 || true
  fi
  if [[ $status == 0 ]]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; fi
}
trap teardown EXIT

"${COMPOSE[@]}" rm -sfv "$SERVICE" >/dev/null 2>&1 || true
docker volume rm -f leitor-dev_library-sync-dev-data >/dev/null 2>&1 || true
if ! "${COMPOSE[@]}" up -d --build --wait "$SERVICE"; then
  "${COMPOSE[@]}" logs --tail 50 "$SERVICE"
  status=1
  exit 1
fi
echo "server up: $SERVICE"

# shellcheck disable=SC2016 # expanded inside the container
LEITOR_DEV_NETWORK=leitor-dev scripts/dev.sh bash -c '
  set -euo pipefail
  export CARGO_INCREMENTAL=0
  export LEITOR_LIBRARY_TEST_URL=http://library-sync-dev:8090 LEITOR_LIBRARY_TEST_PASSWORD=senha-de-teste-longa
  cd src-tauri
  cargo test -j "${CARGO_BUILD_JOBS:-8}" -p leitor-estudos --test library_sync external -- --nocapture
' || status=$?
if [[ $status != 0 ]]; then
  "${COMPOSE[@]}" logs --tail 40 "$SERVICE"
fi
exit "$status"
