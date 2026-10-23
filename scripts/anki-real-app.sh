#!/usr/bin/env bash
# Real-app probes of the Anki tab: debug build + Vite dev server, WebKitGTK under Xvfb, the
# fixture collection in a throwaway LEITOR_DATA_DIR. Run inside the devcontainer:
#   scripts/dev.sh scripts/anki-real-app.sh isolation   # card iframe isolation (spec 8.4)
#   scripts/dev.sh scripts/anki-real-app.sh pages       # Anki's own pages over the anki protocol
#   scripts/dev.sh scripts/anki-real-app.sh record      # = scripts/record-anki-posts.sh
#                                                       #   (LEITOR_RECORD_DEST=<dir> to record elsewhere)
# Summary and logs: web/test-results/anki-realapp/. Exit status 0 only if every check passed.
set -euo pipefail
MODE="${1:?usage: anki-real-app.sh isolation|pages|record}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="$ROOT/web/test-results/anki-realapp"
rm -rf "$OUT" && mkdir -p "$OUT"
SUMMARY="$OUT/summary.txt"
: >"$SUMMARY"
say() { echo "$*" | tee -a "$SUMMARY"; }

export XDG_DATA_HOME=/tmp/xdg/data XDG_CACHE_HOME=/tmp/xdg/cache XDG_CONFIG_HOME=/tmp/xdg/config
export RUST_LOG="${RUST_LOG:-info,leitor_app=info,leitor_ui=info}"
WAIT="${LEITOR_PROBE_WAIT:-45}"

bash scripts/fetch-anki-web.sh >/dev/null
(cd src-tauri && cargo build -q -p leitor-estudos && cargo build -q -p leitor-estudos --example anki_realapp \
  && cargo build -q -p core-anki --example seed_fixture)
BIN="$ROOT/src-tauri/target/debug/leitor-estudos"
EX="$ROOT/src-tauri/target/debug/examples"

DATA="$(mktemp -d)"
export LEITOR_DATA_DIR="$DATA"
"$EX/seed_fixture" "$DATA/anki" --isolation-probe >"$OUT/fixture.json"
"$EX/anki_realapp" prep "$DATA/anki" "$DATA/out" >"$OUT/prep.json"
json() { python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2], {'d': d}))" "$@"; }

pnpm --dir web exec vite --port 5173 --strictPort >"$OUT/vite.log" 2>&1 &
VITE=$!
trap 'kill $VITE 2>/dev/null || true' EXIT
for _ in $(seq 120); do curl -sf http://localhost:5173 >/dev/null && break; sleep 0.5; done

# run_route <name> <route> <grep -E pattern that ends the wait>
run_route() {
  local name="$1" route="$2" until="$3" log="$OUT/$1.log"
  LEITOR_START_ROUTE="$route" LEITOR_WEBKIT_CONSOLE=1 LEITOR_BRIDGE_PROBE=1 \
    xvfb-run -a -s "-screen 0 1280x820x24" bash -c "
      '$BIN' >'$log' 2>&1 &
      APP=\$!
      for _ in \$(seq $((WAIT * 2))); do
        grep -Eq '$until' '$log' && break
        sleep 0.5
      done
      sleep 2
      kill \$APP 2>/dev/null; wait \$APP 2>/dev/null || true" || true
}

csp_violations() { grep -E "Content Security Policy|Refused to (load|execute|connect|frame)|probe: csp" "$1" || true; }

isolation() {
  run_route isolation "/anki/estudar?nome=Isolamento%20(teste)" 'leitor-isolation-probe|card pycmd: probe:'
  local line
  line="$(grep -oE '(probe:|leitor-isolation-probe )\{.*\}' "$OUT/isolation.log" | head -1 || true)"
  if [[ -z "$line" ]]; then
    say "isolation: FAIL (no probe report in the log)"
    return 1
  fi
  local result="${line#probe:}"
  result="${result#leitor-isolation-probe }"
  echo "$result" >"$OUT/isolation.json"
  say "isolation: $result"
  local status=0
  python3 -I - "$OUT/isolation.json" >"$OUT/isolation-checks.txt" <<'PY' || status=$?
import json, sys
r = json.load(open(sys.argv[1]))
def non_2xx(v):
    return v == "blocked" or (isinstance(v, int) and not 200 <= v < 300)
checks = [
    ("tauri == 'undefined'", r.get("tauri") == "undefined"),
    ("parentInvoke == 'blocked'", r.get("parentInvoke") == "blocked"),
    ("addNote == 403", r.get("addNote") == 403),
    ("ankiFetch blocked/non-2xx", non_2xx(r.get("ankiFetch"))),
    ("ipc == 'blocked'", r.get("ipc") == "blocked"),
    ("i18n == 200", r.get("i18n") == 200),
    ("img > 0", isinstance(r.get("img"), int) and r["img"] > 0),
    ("mathjax", r.get("mathjax") is True),
]
ok = True
for name, passed in checks:
    print(f"  {'ok  ' if passed else 'FAIL'} {name}")
    ok = ok and passed
sys.exit(0 if ok else 1)
PY
  tee -a "$SUMMARY" <"$OUT/isolation-checks.txt"
  local csp
  csp="$(csp_violations "$OUT/isolation.log" | grep -v "anki://localhost/_anki/addNote\|ipc://localhost/anki_deck_tree\|http://anki.localhost\|http://ipc.localhost" || true)"
  if [[ -n "$csp" ]]; then
    say "  note: other CSP messages (expected ones for the probe's blocked fetches are filtered):"
    echo "$csp" | head -20 | tee -a "$SUMMARY"
  fi
  [[ $status -eq 0 ]] && say "isolation: PASS" || say "isolation: FAIL"
  return $status
}

# check_page <name> <route> <methods…>: the first POST of each method returned 200/204, no POST
# returned 403/404/500, no CSP violation.
check_page() {
  local name="$1" route="$2"; shift 2
  local last="${*: -1}"
  run_route "$name" "$route" "anki-post caller=page method=$last "
  local log="$OUT/$name.log" ok=0
  for m in "$@"; do
    local s
    s="$(grep -oE "anki-post caller=page method=$m status=[0-9]+" "$log" | head -1 | grep -oE '[0-9]+$' || true)"
    if [[ "$s" == 200 || "$s" == 204 ]]; then
      say "  $name: $m $s"
    else
      say "  $name: FAIL $m status=${s:-none}"
      ok=1
    fi
  done
  local bad
  bad="$(grep -E 'anki-post caller=page method=[A-Za-z0-9]+ status=(403|404|500)' "$log" || true)"
  if [[ -n "$bad" ]]; then say "  $name: FAIL error replies:"; echo "$bad" | tee -a "$SUMMARY"; ok=1; fi
  local csp
  csp="$(csp_violations "$log")"
  if [[ -n "$csp" ]]; then say "  $name: FAIL CSP:"; echo "$csp" | head -20 | tee -a "$SUMMARY"; ok=1; fi
  local n
  n="$(grep -c 'anki-post caller=page' "$log" || true)"
  say "  $name: $n POSTs"
  return $ok
}

pages() {
  local deck card ntid apkg enc fail=0
  deck="$(json "$OUT/fixture.json" "d['decks']['5000 palavras']")"
  card="$(json "$OUT/fixture.json" "d['firstCard']['5000 palavras']")"
  ntid="$(json "$OUT/prep.json" "d['notetypeId']")"
  apkg="$(json "$OUT/prep.json" "d['apkg']")"
  enc="$(python3 -I -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$apkg")"
  check_page deck-options "/anki/opcoes/$deck" i18nResources getDeckConfigsForUpdate || fail=1
  check_page graphs "/anki/estatisticas" i18nResources getGraphPreferences graphs || fail=1
  check_page card-info "/anki/info/$card" i18nResources cardStats || fail=1
  check_page congrats "/anki/pagina/congrats" i18nResources congratsInfo || fail=1
  check_page change-notetype "/anki/pagina/change-notetype/$ntid" i18nResources getChangeNotetypeInfo || fail=1
  check_page import-anki-package "/anki/pagina/import-anki-package/$enc" i18nResources getImportAnkiPackagePresets || fail=1
  [[ $fail -eq 0 ]] && say "pages: PASS" || say "pages: FAIL"
  return $fail
}

record() {
  # LEITOR_RECORD_DEST overrides the destination (e.g. a scratch folder to try the script).
  local dest="${LEITOR_RECORD_DEST:-$ROOT/src-tauri/crates/core-anki/tests/fixtures/bridge}"
  mkdir -p "$dest"
  export LEITOR_RECORD_ANKI_POSTS="$dest"
  pages || true
  unset LEITOR_RECORD_ANKI_POSTS
  "$EX/anki_realapp" colpkg "$DATA/anki" "$dest/fixture.colpkg" >/dev/null
  say "record: $(find "$dest" -name '*.bin' | wc -l) recorded methods, fixture.colpkg in $dest"
  ls "$dest" | tee -a "$SUMMARY"
}

case "$MODE" in
  isolation) isolation ;;
  pages) pages ;;
  record) record ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
