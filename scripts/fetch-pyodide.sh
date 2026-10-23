#!/usr/bin/env bash
# Vendor the pinned Pyodide core (CPython compiled to WebAssembly) into src-tauri/resources/pyodide/ for the Python
# code cards (docs/PROJETO.md 11.4): the web build copies it to dist/pyodide/ (web/vite-plugin-pyodide.ts), so the
# desktop app embeds it and runs Python offline, with no download at run time.
# Only what core Python needs is extracted: pyodide.mjs (loader), pyodide.asm.mjs + pyodide.asm.wasm (the
# interpreter), python_stdlib.zip (the standard library), pyodide-lock.json (package index, read at start-up) and
# package.json (version and license). No packages (numpy…): the cards use the standard library only.
#
# Usage: scripts/fetch-pyodide.sh [DEST] [--force]
# Idempotent: does nothing when DEST/.version already names this release. Needs curl and Python 3 (Python does the
# hashing and the extraction, run with -I).
set -euo pipefail

PYODIDE_VERSION="314.0.7"
# The official release asset (https://github.com/pyodide/pyodide/releases/tag/314.0.7). License: MPL-2.0.
TARBALL_URL="https://github.com/pyodide/pyodide/releases/download/$PYODIDE_VERSION/pyodide-core-$PYODIDE_VERSION.tar.bz2"
TARBALL_SHA256="2abdcc2e35208af406e07724cffa85bc582ced97e9028383ecf5462541393f95"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src-tauri/resources/pyodide"
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) DEST="$arg" ;;
  esac
done
STAMP="pyodide-core==$PYODIDE_VERSION sha256=$TARBALL_SHA256"

if [[ $FORCE -eq 0 && -f "$DEST/.version" && "$(cat "$DEST/.version")" == "$STAMP" ]]; then
  echo "pyodide: $DEST is up to date ($PYODIDE_VERSION)"
  exit 0
fi

PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 8))' 2>/dev/null; then
    PY="$candidate"; break
  fi
done
[[ -n "$PY" ]] || { echo "error: Python 3.8+ is required" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
TARBALL="$WORK/pyodide-core.tar.bz2"

echo "pyodide: fetching pyodide-core $PYODIDE_VERSION"
curl -sSfL --retry 3 -o "$TARBALL" "$TARBALL_URL"

mkdir -p "$(dirname "$DEST")"
STAGE="$(dirname "$DEST")/.pyodide.partial"
rm -rf "$STAGE"

"$PY" -I - "$TARBALL" "$TARBALL_SHA256" "$STAGE" <<'PY'
import hashlib, os, sys, tarfile

tarball, want, out = sys.argv[1:4]
h = hashlib.sha256()
with open(tarball, "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        h.update(chunk)
got = h.hexdigest()
if got != want:
    sys.exit(f"error: pyodide-core SHA-256 mismatch (expected {want}, got {got})")

FILES = {
    "pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip",
    "pyodide-lock.json", "package.json",
}
os.makedirs(out, exist_ok=True)
found = set()
size = 0
with tarfile.open(tarball, "r:bz2") as t:
    for member in t:
        if not member.isfile():
            continue
        parts = member.name.split("/")
        # Every file is at pyodide/<name>: nothing nested, nothing else extracted.
        if len(parts) != 2 or parts[0] != "pyodide" or parts[1] not in FILES:
            continue
        src = t.extractfile(member)
        if src is None:
            continue
        data = src.read()
        with open(os.path.join(out, parts[1]), "wb") as dst:
            dst.write(data)
        found.add(parts[1])
        size += len(data)

missing = FILES - found
if missing:
    sys.exit(f"error: missing in the tarball: {', '.join(sorted(missing))}")
print(f"pyodide: extracted {len(found)} files ({size / 1e6:.1f} MB)")
PY

cat > "$STAGE/NOTICE.txt" <<EOF
These files are unmodified build outputs of Pyodide $PYODIDE_VERSION (https://pyodide.org), taken from
the official release asset $TARBALL_URL
(SHA-256 $TARBALL_SHA256).
Pyodide is licensed under the Mozilla Public License 2.0 (https://github.com/pyodide/pyodide/blob/main/LICENSE).
It bundles CPython (PSF License) and its standard library.
EOF
printf '%s\n' "$STAMP" > "$STAGE/.version"

rm -rf "$DEST"
mv "$STAGE" "$DEST"
echo "pyodide: ready at $DEST"
