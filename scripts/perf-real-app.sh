#!/usr/bin/env bash
# Phase 1 acceptance 4 in the REAL app (WebKitGTK under Xvfb; run inside the devcontainer):
# PdfCraft web alone (web/e2e/bridge/harness.html, iframe sized like the app's) vs the app's Leitor,
# same webview, same 500-page PDF, same synthetic wheel input. Timings come from the debug bridge
# probe in perf mode (LEITOR_BRIDGE_PROBE=perf, src-tauri/app/src/lib.rs).
#
#   scripts/dev.sh bash -c 'cd src-tauri && cargo build -p leitor-estudos'   # debug build
#   scripts/dev.sh bash -c 'LEITOR_PERF=1 pnpm --dir web e2e:perf'           # generates perf-500.pdf
#   scripts/dev.sh scripts/perf-real-app.sh                                 # ROUNDS="0 1 2 3" by default
#
# Round 0 is a warm-up and is not counted. Logs and summary: web/test-results/realapp/.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
OUT=web/test-results/realapp
BIN=${CARGO_TARGET_DIR:-src-tauri/target}/debug/leitor-estudos
PDF=web/test-results/e2e-fixtures/perf-500.pdf
ROUNDS=${ROUNDS:-0 1 2 3}
[ -x "$BIN" ] || { echo "missing $BIN (cargo build -p leitor-estudos)" >&2; exit 1; }
[ -f "$PDF" ] || { echo "missing $PDF (LEITOR_PERF=1 pnpm --dir web e2e:perf)" >&2; exit 1; }
mkdir -p "$OUT"

# The UI from Vite (devUrl), without hot reload so nothing remounts mid-run.
(cd web && LEITOR_PERF=1 exec pnpm exec vite --port 5173 --strictPort >"../$OUT/vite.log" 2>&1) &
VITE=$!
export DISPLAY=:77
Xvfb :77 -screen 0 1400x1000x24 >/dev/null 2>&1 &
XV=$!
trap 'kill $XV $VITE 2>/dev/null || true' EXIT
for _ in $(seq 60); do curl -sf http://localhost:5173/ >/dev/null && break; sleep 1; done

run() {
  local name=$1
  shift
  local data
  data=$(mktemp -d)
  (LEITOR_DATA_DIR=$data LEITOR_BRIDGE_PROBE=perf "$@" >"$OUT/$name.log" 2>&1) &
  local pid=$!
  # Startup + open + 4 s + 1200 wheel notches (~20 s) + 3 s of quiet before the summary line.
  sleep 55
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -rf "$data"
}

ID=$(printf 'f%.0s' $(seq 64))
for round in $ROUNDS; do
  LEITOR_START_ROUTE="/e2e/bridge/harness.html?file=/__e2e__/perf-500.pdf&w=960&h=776&id=$ID" \
    run "harness-$round" "$BIN"
  run "app-$round" "$BIN" "$ROOT/$PDF"
done

python3 -I - "$OUT" $ROUNDS <<'EOF' | tee "$OUT/summary.txt"
import re, statistics, sys
out, rounds = sys.argv[1], sys.argv[2:]
rows = {}
for scenario in ("harness", "app"):
    for r in rounds:
        t = re.sub(r"\x1b\[[0-9;]*m", "", open(f"{out}/{scenario}-{r}.log", encoding="utf-8", errors="replace").read())
        op = re.search(r"open-received id=\w+ abs=([\d.]+)", t)
        act = re.search(r"pdfcraft:active .*? id=\w+ page=\d+ pageCount=\d+ .*?abs=([\d.]+)", t)
        sc = re.search(r"perf scroll ms=(\d+) pageMsgs=\d+ frames=(\d+) p50=([\d.]+) p95=([\d.]+) long=(\d+)", t)
        size = re.search(r"perf iframe (\S+)", t)
        pages = re.findall(r"pdfcraft:page .*? page=(\d+)", t)
        row = {
            "openToActiveMs": float(act.group(1)) - float(op.group(1)) if op and act else None,
            "scrollP50": float(sc.group(3)) if sc else None,
            "scrollP95": float(sc.group(4)) if sc else None,
            "longFrames": int(sc.group(5)) if sc else None,
            "lastPage": int(pages[-1]) if pages else None,
            "iframe": size.group(1) if size else None,
        }
        print(f"{scenario}-{r}", row)
        if r != "0":
            rows.setdefault(scenario, []).append(row)
for scenario, rs in rows.items():
    med = {k: statistics.median([x[k] for x in rs if x[k] is not None] or [float("nan")])
           for k in ("openToActiveMs", "scrollP50", "scrollP95", "longFrames", "lastPage")}
    print(f"median {scenario}", med)
EOF
