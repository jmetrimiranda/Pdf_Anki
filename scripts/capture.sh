#!/usr/bin/env bash
# Screenshot the real app (debug build + Vite dev server) under Xvfb, one PNG per route.
# Run inside the devcontainer:  scripts/dev.sh scripts/capture.sh docs/capturas/fase-0 /dev/ui /anki ...
# Each route runs in a fresh process with LEITOR_START_ROUTE; data lives in a throwaway dir unless
# LEITOR_DATA_DIR is set. Optional LEITOR_CAPTURE_SETUP is a command run once before the captures.
# LEITOR_CAPTURE_SEED=1 first seeds the Anki fixture collection (decks, media, cloze, MathJax…)
# into $LEITOR_DATA_DIR/anki and exports LEITOR_FIXTURE_JSON (its FixtureInfo: deck and card ids)
# for LEITOR_CAPTURE_SETUP. Routes may carry a query ('?', '&'): they become '-' in file names.
# With the seed, '{deck:<full name>}' and '{card:<full name>}' in a route become that deck's id and
# the id of its first card (e.g. /anki/opcoes/{deck:5000 palavras}); the file name keeps the
# placeholder's text ('deck-5000-palavras').
set -euo pipefail
OUT="$1"; shift
mkdir -p "$OUT"
export LEITOR_DATA_DIR="${LEITOR_DATA_DIR:-$(mktemp -d)}"
export XDG_DATA_HOME=/tmp/xdg/data XDG_CACHE_HOME=/tmp/xdg/cache XDG_CONFIG_HOME=/tmp/xdg/config
(cd src-tauri && cargo build -q -p leitor-estudos)
BIN=src-tauri/target/debug/leitor-estudos
if [[ "${LEITOR_CAPTURE_SEED:-}" == 1 ]]; then
  bash scripts/fetch-anki-web.sh >/dev/null
  (cd src-tauri && cargo build -q -p core-anki --example seed_fixture)
  export LEITOR_FIXTURE_JSON="$LEITOR_DATA_DIR/fixture.json"
  src-tauri/target/debug/examples/seed_fixture "$LEITOR_DATA_DIR/anki" --force >"$LEITOR_FIXTURE_JSON"
  echo "fixture seeded: $LEITOR_FIXTURE_JSON"
fi
pnpm --dir web exec vite --port 5173 --strictPort >/tmp/vite.log 2>&1 &
VITE=$!
trap 'kill $VITE 2>/dev/null || true' EXIT
for _ in $(seq 60); do curl -sf http://localhost:5173 >/dev/null && break; sleep 0.5; done
[[ -n "${LEITOR_CAPTURE_SETUP:-}" ]] && bash -c "$LEITOR_CAPTURE_SETUP"
resolve() {
  [[ -n "${LEITOR_FIXTURE_JSON:-}" && "$1" == *"{"* ]] || { echo "$1"; return; }
  python3 -I -c '
import json, re, sys
info = json.load(open(sys.argv[1]))
table = {"deck": info["decks"], "card": info["firstCard"]}
print(re.sub(r"\{(deck|card):([^}]+)\}", lambda m: str(table[m.group(1)][m.group(2)]), sys.argv[2]))
' "$LEITOR_FIXTURE_JSON" "$1"
}
for spec in "$@"; do
  route=$(resolve "$spec")
  name=$(echo "${spec#/}" | tr -d '{}' | tr '/?=&%: ' '-------'); name=${name:-root}
  ROUTE="$route" xvfb-run -a -s "-screen 0 1280x820x24" bash -c "
    LEITOR_START_ROUTE=\"\$ROUTE\" $BIN >/tmp/app-\$\$.log 2>&1 &
    APP=\$!; sleep \${LEITOR_CAPTURE_WAIT:-8}
    import -window root '$OUT/$name.png'
    kill \$APP 2>/dev/null; wait \$APP 2>/dev/null || true"
  echo "captured $route -> $OUT/$name.png"
done
