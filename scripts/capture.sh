#!/usr/bin/env bash
# Screenshot the real app (debug build + Vite dev server) under Xvfb, one PNG per route.
# Run inside the devcontainer:  scripts/dev.sh scripts/capture.sh docs/capturas/fase-0 /dev/ui /anki ...
# Each route runs in a fresh process with LEITOR_START_ROUTE; data lives in a throwaway dir unless
# LEITOR_DATA_DIR is set. Optional LEITOR_CAPTURE_SETUP is a command run once before the captures.
set -euo pipefail
OUT="$1"; shift
mkdir -p "$OUT"
export LEITOR_DATA_DIR="${LEITOR_DATA_DIR:-$(mktemp -d)}"
export XDG_DATA_HOME=/tmp/xdg/data XDG_CACHE_HOME=/tmp/xdg/cache XDG_CONFIG_HOME=/tmp/xdg/config
(cd src-tauri && cargo build -q -p leitor-estudos)
BIN=src-tauri/target/debug/leitor-estudos
pnpm --dir web exec vite --port 5173 --strictPort >/tmp/vite.log 2>&1 &
VITE=$!
trap 'kill $VITE 2>/dev/null || true' EXIT
for _ in $(seq 60); do curl -sf http://localhost:5173 >/dev/null && break; sleep 0.5; done
[[ -n "${LEITOR_CAPTURE_SETUP:-}" ]] && bash -c "$LEITOR_CAPTURE_SETUP"
for route in "$@"; do
  name=$(echo "${route#/}" | tr '/?=&' '----'); name=${name:-root}
  xvfb-run -a -s "-screen 0 1280x820x24" bash -c "
    LEITOR_START_ROUTE='$route' $BIN >/tmp/app-\$\$.log 2>&1 &
    APP=\$!; sleep \${LEITOR_CAPTURE_WAIT:-8}
    import -window root '$OUT/$name.png'
    kill \$APP 2>/dev/null; wait \$APP 2>/dev/null || true"
  echo "captured $route -> $OUT/$name.png"
done
