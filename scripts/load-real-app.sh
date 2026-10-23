#!/usr/bin/env bash
# The Leitor tab's first and later openings in the REAL app (WebKitGTK under Xvfb; run inside the devcontainer).
# Each run is a fresh app process at /biblioteca; the bridge probe in load mode (LEITOR_BRIDGE_PROBE=load,
# src-tauri/app/src/lib.rs) clicks the Leitor tab, logs click → pdfcraft:ready and window.__leitorTimings, then
# 5 round trips through Biblioteca/Anki (click → a frame painted in the iframe) and checks the iframe never reloaded.
#
#   scripts/dev.sh scripts/load-real-app.sh                    # debug build, UI from Vite (devUrl)
#   BIN=src-tauri/target/release/leitor-estudos scripts/dev.sh scripts/load-real-app.sh
#       (release built with `cargo build --release -p leitor-estudos --features bridge-probe`, frontend embedded)
#   CACHE=warm: one webview profile (XDG dirs) shared by every run, after an uncounted warm-up run;
#   CACHE=cold (default): a fresh profile per run.  RUNS=5 by default.
# Logs and summary: web/test-results/realapp-load/.  No GPU in the devcontainer: WebGL is software (Mesa).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
BIN=${BIN:-${CARGO_TARGET_DIR:-src-tauri/target}/debug/leitor-estudos}
RUNS=${RUNS:-5}
CACHE=${CACHE:-cold}
NAME=${NAME:-$(basename "$(dirname "$BIN")")-$CACHE}
OUT=web/test-results/realapp-load
[ -x "$BIN" ] || { echo "missing $BIN" >&2; exit 1; }
mkdir -p "$OUT"

PIDS=()
trap 'kill "${PIDS[@]}" 2>/dev/null || true' EXIT
if [[ "$BIN" == */debug/* ]]; then
  (cd web && exec pnpm exec vite --port 5173 --strictPort >"../$OUT/vite.log" 2>&1) &
  PIDS+=($!)
  for _ in $(seq 60); do curl -sf http://localhost:5173/ >/dev/null && break; sleep 1; done
  # Vite transforms the app's modules on the first request: do it before timing anything.
  curl -sf http://localhost:5173/src/main.tsx >/dev/null || true
fi
export DISPLAY=:78
Xvfb :78 -screen 0 1400x1000x24 >/dev/null 2>&1 &
PIDS+=($!)
sleep 1

SHARED=$(mktemp -d)
run() {
  local log=$1 profile
  if [[ "$CACHE" == warm ]]; then profile=$SHARED; else profile=$(mktemp -d); fi
  (
    export XDG_DATA_HOME=$profile/data XDG_CACHE_HOME=$profile/cache XDG_CONFIG_HOME=$profile/config
    LEITOR_DATA_DIR=$profile/leitor LEITOR_START_ROUTE=/biblioteca LEITOR_BRIDGE_PROBE=load exec "$BIN"
  ) >"$log" 2>&1 &
  local pid=$!
  for _ in $(seq 120); do grep -q 'probe: load done\|probe: load .*timeout\|probe: load no' "$log" && break; sleep 1; done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  [[ "$CACHE" == warm ]] || rm -rf "$profile"
}

[[ "$CACHE" == warm ]] && run "$OUT/$NAME-warmup.log"
for i in $(seq "$RUNS"); do run "$OUT/$NAME-$i.log"; done
rm -rf "$SHARED"

python3 -I - "$OUT" "$NAME" "$RUNS" <<'EOF' | tee "$OUT/$NAME-summary.txt"
import re, statistics, sys
out, name, runs = sys.argv[1], sys.argv[2], int(sys.argv[3])
cols = {}
checks = []
for i in range(1, runs + 1):
    t = re.sub(r"\x1b\[[0-9;]*m", "", open(f"{out}/{name}-{i}.log", encoding="utf-8", errors="replace").read())
    m = re.search(r"probe: load first (.*)", t)
    if m:
        for k, v in re.findall(r"(\w+)=(\S+)", m.group(1)):
            if v not in ("null", "none") and re.fullmatch(r"-?[\d.]+", v):
                cols.setdefault(f"first {k}", []).append(float(v))
    for k, v in re.findall(r"probe: load again via=\w+ clickToPaint=([\d.]+) activateToPaint=([\d.]+)", t):
        cols.setdefault("again clickToPaint", []).append(float(k))
        cols.setdefault("again activateToPaint", []).append(float(v))
    c = re.search(r"probe: load reload-check (.*)", t)
    checks.append(c.group(1) if c else "missing")
print(f"{name}: {runs} runs (WebKitGTK, software WebGL under Xvfb)")
for k, xs in cols.items():
    print(f"{k:28s} n={len(xs):2d} median={statistics.median(xs):8.1f} min={min(xs):8.1f} max={max(xs):8.1f}")
for i, c in enumerate(checks, 1):
    print(f"run {i} reload-check: {c}")
EOF
