#!/usr/bin/env bash
# Extract the built Anki web assets (SvelteKit pages, reviewer, MathJax) from the pinned
# aqt wheel into src-tauri/resources/anki-web/ (docs/PROJETO.md 3.2 and 8.3).
# Layout and the file list: docs/tecnico/anki-web-and-reviewer.md §1. The editor bundle
# (js/editor.js, 3.6 MB) and the legacy Qt-screen assets are left out: the app doesn't use them.
#
# Usage: scripts/fetch-anki-web.sh [DEST] [--force]
# Idempotent: does nothing when DEST/.version already names this wheel. Needs curl and Python 3
# (Python does the hashing and unzipping, so it also runs under Git Bash on Windows).
set -euo pipefail

AQT_VERSION="26.9.3"
# From https://pypi.org/pypi/aqt/26.9.3/json (the only file of the release).
WHEEL_URL="https://files.pythonhosted.org/packages/5b/d0/ee07f6baf6ce68a8a80dc58f1ec9b958e405cfe075626e6c662b2e60f21d/aqt-26.9.3-py3-none-any.whl"
WHEEL_SHA256="83d60a2494939128138692435ab9c65579338c6902aaba88606bce6b5ccd22d3"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src-tauri/resources/anki-web"
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) DEST="$arg" ;;
  esac
done
STAMP="aqt==$AQT_VERSION sha256=$WHEEL_SHA256"

if [[ $FORCE -eq 0 && -f "$DEST/.version" && "$(cat "$DEST/.version")" == "$STAMP" ]]; then
  echo "anki-web: $DEST is up to date (aqt==$AQT_VERSION)"
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
WHEEL="$WORK/aqt.whl"

echo "anki-web: fetching aqt==$AQT_VERSION"
curl -sSfL --retry 3 -o "$WHEEL" "$WHEEL_URL"

mkdir -p "$(dirname "$DEST")"
STAGE="$(dirname "$DEST")/.anki-web.partial"
rm -rf "$STAGE"

"$PY" -I - "$WHEEL" "$WHEEL_SHA256" "$STAGE" <<'PY'
import hashlib, os, sys, zipfile

wheel, want, out = sys.argv[1:4]
with open(wheel, "rb") as f:
    got = hashlib.sha256(f.read()).hexdigest()
if got != want:
    sys.exit(f"error: wheel SHA-256 mismatch (expected {want}, got {got})")

PREFIX = "_aqt/data/web/"
# Directories copied whole, then single files (paths relative to PREFIX).
DIRS = ("sveltekit/", "js/vendor/mathjax/", "imgs/")
FILES = {
    "js/reviewer.js", "js/mathjax.js", "js/webview.js",
    "css/reviewer.css", "css/webview.css",
}

count = size = 0
with zipfile.ZipFile(wheel) as z:
    for info in z.infolist():
        name = info.filename
        if info.is_dir() or not name.startswith(PREFIX):
            continue
        rel = name[len(PREFIX):]
        if not (rel in FILES or rel.startswith(DIRS)):
            continue
        parts = rel.split("/")
        if any(p in ("", ".", "..") for p in parts) or "\\" in rel:
            sys.exit(f"error: unsafe path in wheel: {name}")
        target = os.path.join(out, *parts)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with z.open(info) as src, open(target, "wb") as dst:
            data = src.read()
            dst.write(data)
        count += 1
        size += len(data)

if not os.path.isfile(os.path.join(out, "sveltekit", "index.html")):
    sys.exit("error: sveltekit/index.html not found in the wheel")
print(f"anki-web: extracted {count} files ({size / 1e6:.1f} MB)")
PY

cat > "$STAGE/NOTICE.txt" <<EOF
These files are unmodified build outputs of Anki (https://apps.ankiweb.net), taken from
the aqt==$AQT_VERSION wheel on PyPI ($WHEEL_URL).
Anki is Copyright Ankitects Pty Ltd and contributors, licensed under the GNU AGPL,
version 3 or later (https://github.com/ankitects/anki/blob/26.09.3/LICENSE).
Bundled MathJax: Apache-2.0 (https://github.com/mathjax/MathJax).
EOF
printf '%s\n' "$STAMP" > "$STAGE/.version"

rm -rf "$DEST"
mv "$STAGE" "$DEST"
echo "anki-web: ready at $DEST"
