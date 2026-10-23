#!/usr/bin/env bash
# Anki sync integration tests against the LOCAL official sync server (compose.dev.yml). Run on the host, repo root:
#   scripts/sync-test.sh [all|core-anki|app|crosscheck]     (default: all)
#     core-anki   cargo test -p core-anki --test sync_server   (rslib client: A/B sync, media, full sync, TLS…)
#     app         cargo test -p leitor-estudos --test sync     (commands, keychain, policy)
#     crosscheck  official Anki Python client (pyclient.py) against the same server (local proxy of the [VPS]
#                 "shows up in Anki desktop" criterion)
#     all         the three above
# The server is recreated empty (down -v) first and removed with its volume on exit, unless KEEP_SERVER=1.
# Accounts (compose.dev.yml): test (manual), t1..t10 (Rust tests), t11 (crosscheck self-test, must stay unused by
# the Rust suites), t12 (Rust test that leaves a review for the crosscheck, optional).
# Never talks to anything but the local server. Docs: docs/tecnico/anki-sync-dev.md.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
WHAT="${1:-all}"
case "$WHAT" in
  all | core-anki | app | crosscheck) ;;
  *) echo "usage: $0 [all|core-anki|app|crosscheck]" >&2; exit 2 ;;
esac
EXPECTED_PIP_VERSION="26.9.3"   # spec A.1 (PyPI spelling)
EXPECTED_BUILD_VERSION="26.09.3" # anki.buildinfo.version (git tag spelling)
COMPOSE=(docker compose -f "$ROOT/compose.dev.yml")
RESULTS=()
FAILED=0

record() { # <name> <status>
  if [[ $2 == 0 ]]; then RESULTS+=("PASS  $1"); else RESULTS+=("FAIL  $1"); FAILED=1; fi
}

summary() {
  echo
  echo "=== sync-test summary ($WHAT) ==="
  printf '%s\n' "${RESULTS[@]}"
  if [[ $FAILED == 0 ]]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; fi
}

teardown() {
  local status=$?
  if [[ "${KEEP_SERVER:-0}" == 1 ]]; then
    echo "KEEP_SERVER=1: server left running (docker compose -f compose.dev.yml down -v to remove it)"
  else
    "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  summary
  [[ $FAILED == 0 && $status == 0 ]] || exit 1
}
trap teardown EXIT

scripts/ankisync-dev-certs.sh || { record "dev certificates" 1; exit 1; }
"${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
if ! "${COMPOSE[@]}" up -d --build --wait; then
  "${COMPOSE[@]}" logs --tail 50
  record "server up (compose.dev.yml)" 1
  exit 1
fi
record "server up (compose.dev.yml)" 0

versions="$("${COMPOSE[@]}" exec -T ankisync-dev python -c \
  'import importlib.metadata as m, anki.buildinfo as b; print(m.version("anki"), b.version)' 2>&1)"
if [[ "$versions" == "$EXPECTED_PIP_VERSION $EXPECTED_BUILD_VERSION" ]]; then
  record "server version anki==$EXPECTED_PIP_VERSION ($EXPECTED_BUILD_VERSION)" 0
else
  echo "unexpected server version: $versions" >&2
  record "server version (got: $versions)" 1
  exit 1
fi

run_cargo() { # <label> <cargo test args…>
  local label="$1"
  shift
  # shellcheck disable=SC2016 # expanded inside the container
  LEITOR_DEV_NETWORK=leitor-dev scripts/dev.sh bash -c '
    set -euo pipefail
    export LEITOR_SYNC_TEST_URL=http://ankisync-dev:8080/
    export LEITOR_SYNC_TEST_TLS_URL=https://ankisync-dev-tls:8443/
    export LEITOR_SYNC_TEST_CA="$PWD/server/ankisync-dev/certs/ca.crt"
    export LEITOR_SYNC_TEST_UNTRUSTED_CA="$PWD/server/ankisync-dev/certs/untrusted-ca.crt"
    cd src-tauri
    exec ../scripts/with-keyring.sh cargo test -j "${CARGO_BUILD_JOBS:-8}" "$@"
  ' _ "$@"
  record "$label" $?
}

if [[ $WHAT == all || $WHAT == core-anki ]]; then
  run_cargo "core-anki sync_server (rslib client, plain + TLS)" -p core-anki --test sync_server -- --nocapture
fi
if [[ $WHAT == all || $WHAT == app ]]; then
  run_cargo "app sync (commands, keychain, policy)" -p leitor-estudos --test sync
fi

pyclient() { # <user> <dir> <command>
  "${COMPOSE[@]}" exec -T ankisync-dev python /opt/ankisync/pyclient.py \
    --url http://ankisync-dev:8080/ --user "$1" --password test --dir "/tmp/pyclient-$2" "$3"
}
json_field() { # <json> <python expression on d>
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print(eval(sys.argv[2]))' "$1" "$2"
}

if [[ $WHAT == all || $WHAT == crosscheck ]]; then
  # 1) Harness self-test on t11: seed + upload, review on a second client, a third client sees the review and media.
  ok=0
  seeded="$(pyclient t11 a seed-upload)" &&
    reviewed="$(pyclient t11 b review-first-due)" &&
    report="$(pyclient t11 c download-and-report)" || ok=1
  if [[ $ok == 0 ]]; then
    echo "pyclient report (t11): $report"
    python3 - "$seeded" "$reviewed" "$report" <<'PY' || ok=1
import json, sys
seeded, reviewed, report = (json.loads(a) for a in sys.argv[1:4])
checks = {
    "one review on the server": report["revlogCount"] == 1,
    "same review as the reviewing client": report["latestRevlogId"] == reviewed["latestRevlogId"] is not None,
    "same cards as seeded": report["cardCount"] == seeded["cardCount"] > 0,
    "media synced": "leitor-crosscheck.png" in report["mediaFiles"],
}
for name, good in checks.items():
    print(("  ok   " if good else "  FAIL ") + name)
sys.exit(0 if all(checks.values()) else 1)
PY
  fi
  record "crosscheck: official Python client review → other client (t11, revlog + media)" $ok

  # 2) What the Rust suites left on t12 (if a test seeded it), as the official client sees it.
  if t12="$(pyclient t12 d download-and-report)"; then
    echo "pyclient report (t12): $t12"
    if [[ "$(json_field "$t12" 'd["cardCount"]')" == 0 ]]; then
      RESULTS+=("SKIP  crosscheck t12 (no collection left on t12 by the Rust suites)")
    else
      record "crosscheck t12: official client downloads the app's collection (revlog: $(json_field "$t12" 'd["revlogCount"]'))" 0
    fi
  else
    record "crosscheck t12 download" 1
  fi
fi
