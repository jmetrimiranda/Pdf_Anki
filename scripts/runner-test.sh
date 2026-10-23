#!/usr/bin/env bash
# Isolation tests of the C++ runner (server/runner) against the LOCAL runner of compose.dev.yml (profile "runner").
# Run on the host, repo root:
#   scripts/runner-test.sh [all|core-cpp|app]     (default: all)
#     core-cpp   cargo test -p core-cpp --test remote (the isolation suite, through runner-dev-proxy)
#     app        cargo test -p leitor-estudos --test code remote (the app's gated runner tests)
#     all        both, plus the host-side checks below
# Host-side checks (always): runner-dev is only on the internal network, its root filesystem is read-only, the
# server runs as 10001 with no capability but SETUID/SETGID (to start jobs as 10002). The containers are always removed at the end (trap).
# Docs: docs/tecnico/runner.md. The token is the throwaway dev value of compose.dev.yml.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
WHAT="${1:-all}"
case "$WHAT" in
  all | core-cpp | app) ;;
  *) echo "usage: $0 [all|core-cpp|app]" >&2; exit 2 ;;
esac
COMPOSE=(docker compose -f "$ROOT/compose.dev.yml" --profile runner)
SERVICES=(runner-dev runner-dev-proxy)
TOKEN="${LEITOR_RUNNER_DEV_TOKEN:-dev-runner-token}"
RESULTS=()
FAILED=0

record() { # <name> <status>
  if [[ $2 == 0 ]]; then RESULTS+=("PASS  $1"); else RESULTS+=("FAIL  $1"); FAILED=1; fi
}

teardown() {
  local status=$?
  if [[ "${KEEP_RUNNER:-0}" == 1 ]]; then
    echo "KEEP_RUNNER=1: runner left running (docker compose -f compose.dev.yml --profile runner rm -sfv runner-dev runner-dev-proxy)"
  else
    "${COMPOSE[@]}" rm -sfv "${SERVICES[@]}" >/dev/null 2>&1 || true
    # The internal network goes too when nothing else uses it.
    docker network rm leitor-runner-internal >/dev/null 2>&1 || true
  fi
  echo
  echo "=== runner-test summary ($WHAT) ==="
  printf '%s\n' "${RESULTS[@]}"
  if [[ $FAILED == 0 && $status == 0 ]]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; exit 1; fi
}
trap teardown EXIT

"${COMPOSE[@]}" rm -sfv "${SERVICES[@]}" >/dev/null 2>&1 || true
if ! "${COMPOSE[@]}" up -d --build --wait "${SERVICES[@]}"; then
  "${COMPOSE[@]}" logs --tail 50 "${SERVICES[@]}"
  record "runner up (compose.dev.yml, profile runner)" 1
  exit 1
fi
record "runner up (compose.dev.yml, profile runner)" 0

# --- Host-side checks of the runner container.
cid="$("${COMPOSE[@]}" ps -q runner-dev)"
networks="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$cid" | xargs)"
[[ "$networks" == "leitor-runner-internal" ]]
record "runner-dev only on leitor-runner-internal (got: $networks)" $?
internal="$(docker network inspect -f '{{.Internal}}' leitor-runner-internal)"
[[ "$internal" == "true" ]]
record "leitor-runner-internal is internal: true" $?
readonly_root="$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$cid")"
[[ "$readonly_root" == "true" ]]
record "runner-dev root filesystem is read-only" $?
caps="$(docker inspect -f '{{.HostConfig.CapDrop}} {{.HostConfig.CapAdd}}' "$cid")"
[[ "$caps" =~ ^\[(CAP_)?ALL\]\ \[(CAP_)?(SETUID\ (CAP_)?SETGID|SETGID\ (CAP_)?SETUID)\]$ ]]
record "runner-dev: cap_drop ALL, cap_add only SETUID SETGID (got: $caps)" $?
# The server itself runs as 10001 (the setpriv entrypoint drops root at once); jobs run as 10002 (remote.rs t11..t13).
# (docker top needs the pid column.)
server_uid="$(docker top "$cid" -eo pid,uid,args | awk 'NF == 3 && $3 == "/usr/local/bin/runner" { print $2 }' | xargs)"
[[ "$server_uid" == 10001 ]]
record "runner-dev server process runs as uid 10001 (got: ${server_uid:-none})" $?
ports="$(docker inspect -f '{{json .NetworkSettings.Ports}}' "$cid")"
[[ "$ports" != *HostPort* ]]
record "runner-dev publishes no port (only the proxy does)" $?
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${LEITOR_RUNNER_PROXY_PORT:-28090}/health" || true)"
[[ "$code" == 200 ]]
record "proxy /health from the host (127.0.0.1:${LEITOR_RUNNER_PROXY_PORT:-28090}) → $code" $?

run_cargo() { # <label> <cargo test args…>
  local label="$1"
  shift
  LEITOR_DEV_NETWORK=leitor-dev \
    LEITOR_RUNNER_TEST_URL=http://runner-dev-proxy:8080 \
    LEITOR_RUNNER_TEST_TOKEN="$TOKEN" \
    scripts/dev.sh bash -c 'cd src-tauri && CARGO_INCREMENTAL=0 cargo test -j "${CARGO_BUILD_JOBS:-8}" "$@"' _ "$@"
  record "$label" $?
}

if [[ $WHAT == all || $WHAT == core-cpp ]]; then
  run_cargo "core-cpp remote isolation suite (through runner-dev-proxy)" -p core-cpp --test remote -- --test-threads=1
fi
if [[ $WHAT == all || $WHAT == app ]]; then
  if [[ -f src-tauri/app/tests/code.rs ]]; then
    run_cargo "app code commands against the runner" -p leitor-estudos --test code remote -- --test-threads=1
  else
    RESULTS+=("SKIP  app code commands (src-tauri/app/tests/code.rs not present)")
  fi
fi
