#!/usr/bin/env bash
# Builds the reading screen: the web build of the PdfCraft fork (third_party/pdfcraft/apps/pdfcraft-web, WebAssembly
# via trunk) into src-tauri/resources/pdfcraft-web/, which the UI serves at /pdfcraft/ (docs/PROJETO.md 3.2 and 6.1).
#
#   scripts/build-pdfcraft-web.sh            build if the fork changed since the last build (idempotent)
#   scripts/build-pdfcraft-web.sh --force    always rebuild
#   OUT=/some/dir scripts/build-pdfcraft-web.sh
#
# Needs trunk 0.22.0, wasm-bindgen-cli 0.2.129 (PdfCraft's Cargo.lock), wasm-opt (binaryen version_131) and the
# wasm32-unknown-unknown target (all in the devcontainer). With wasm-opt on PATH trunk runs --offline and never
# downloads a tool; without it, trunk fetches binaryen version_131 itself (needs network).
# The stamp (OUT/.build-stamp) covers the submodule commit, its uncommitted changes and the tool versions, so the
# core and the screen can't silently drift apart.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUB="$ROOT/third_party/pdfcraft"
APP="$SUB/apps/pdfcraft-web"
OUT="${OUT:-$ROOT/src-tauri/resources/pdfcraft-web}"
TARGET_DIR="${PDFCRAFT_WEB_TARGET_DIR:-$ROOT/src-tauri/target/pdfcraft-web}"

TRUNK_WANT=0.22.0
WASM_BINDGEN_WANT=0.2.129
WASM_OPT_WANT=131

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h | --help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "uso / usage: $0 [--force]" >&2; exit 2 ;;
  esac
done

die() { echo "build-pdfcraft-web: $*" >&2; exit 1; }

# Windows (Git Bash): cargo and trunk want native paths.
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }

# --- toolchain checks ---------------------------------------------------------------------------------------------
[[ -f "$APP/Cargo.toml" && -f "$APP/index.html" ]] ||
  die "submódulo do PdfCraft ausente; rode 'git submodule update --init --recursive' / PdfCraft submodule missing"

command -v trunk >/dev/null 2>&1 ||
  die "trunk não encontrado; instale o trunk $TRUNK_WANT / trunk not found (install trunk $TRUNK_WANT)"
TRUNK_VERSION="$(trunk --version 2>/dev/null | awk '{print $2}')"
[[ "$TRUNK_VERSION" == "$TRUNK_WANT" ]] ||
  die "trunk $TRUNK_WANT necessário, encontrado '$TRUNK_VERSION' / trunk $TRUNK_WANT required, found '$TRUNK_VERSION'"

command -v wasm-bindgen >/dev/null 2>&1 ||
  die "wasm-bindgen não encontrado; 'cargo install --locked wasm-bindgen-cli --version $WASM_BINDGEN_WANT' / wasm-bindgen not found"
WASM_BINDGEN_VERSION="$(wasm-bindgen --version | awk '{print $2}')"
[[ "$WASM_BINDGEN_VERSION" == "$WASM_BINDGEN_WANT" ]] ||
  die "wasm-bindgen $WASM_BINDGEN_WANT necessário (Cargo.lock do PdfCraft), encontrado '$WASM_BINDGEN_VERSION' / wasm-bindgen $WASM_BINDGEN_WANT required, found '$WASM_BINDGEN_VERSION'"

# wasm-opt: the system binary when it is the right version (offline build); otherwise trunk downloads binaryen
# version_$WASM_OPT_WANT into its cache, which needs network (an older dev image, a machine outside the container).
OFFLINE=(--offline)
WASM_OPT_VERSION="$(wasm-opt --version 2>/dev/null | awk '{print $3}' || true)"
if [[ "$WASM_OPT_VERSION" != "$WASM_OPT_WANT" ]]; then
  echo "build-pdfcraft-web: aviso: wasm-opt version_$WASM_OPT_WANT não está no PATH (encontrado: '${WASM_OPT_VERSION:-nenhum}'); o trunk vai baixá-lo (precisa de rede) / warning: wasm-opt version_$WASM_OPT_WANT not on PATH, trunk will download it" >&2
  OFFLINE=()
  WASM_OPT_VERSION="$WASM_OPT_WANT (trunk cache)"
fi

SYSROOT="$(rustc --print sysroot)"
[[ -d "$SYSROOT/lib/rustlib/wasm32-unknown-unknown" ]] ||
  die "alvo wasm32 ausente; rode 'rustup target add wasm32-unknown-unknown' / wasm32-unknown-unknown target missing"

# One build at a time per output dir (others wait, then usually find it up to date). flock is absent on Git Bash.
mkdir -p "$(dirname "$OUT")"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$(dirname "$OUT")/.pdfcraft-web.lock"
  flock 9
fi

# --- stamp --------------------------------------------------------------------------------------------------------
sha() { sha256sum | awk '{print $1}'; }
untracked_hashes() {
  local files
  files="$(git -C "$SUB" ls-files --others --exclude-standard -- apps/pdfcraft-web crates/ui-egui)"
  [[ -z "$files" ]] && return 0
  (cd "$SUB" && printf '%s\n' "$files" | sort | while IFS= read -r f; do sha256sum -- "$f"; done)
}
COMMIT="$(git -C "$SUB" rev-parse HEAD)"
DIFF_HASH="$(git -C "$SUB" diff HEAD --binary | sha)"
UNTRACKED_HASH="$(untracked_hashes | sha)"
STAMP="commit=$COMMIT
diff=$DIFF_HASH
untracked=$UNTRACKED_HASH
trunk=$TRUNK_VERSION
wasm-bindgen=$WASM_BINDGEN_VERSION
wasm-opt=$WASM_OPT_VERSION"

if [[ $FORCE -eq 0 && -f "$OUT/index.html" && -f "$OUT/.build-stamp" ]] && [[ "$(cat "$OUT/.build-stamp")" == "$STAMP" ]]; then
  echo "build-pdfcraft-web: up to date ($OUT, PdfCraft ${COMMIT:0:12})"
  exit 0
fi

# --- build into a temp dir next to OUT, then swap -----------------------------------------------------------------
mkdir -p "$(dirname "$OUT")" "$TARGET_DIR"
TMP="$(mktemp -d "$(dirname "$OUT")/.pdfcraft-web.tmp.XXXXXX")"
trap 'rm -rf "$TMP" "$OUT.old.$$"' EXIT

echo "build-pdfcraft-web: building PdfCraft ${COMMIT:0:12}$([[ -n "$(git -C "$SUB" status --porcelain)" ]] && echo ' (+ local changes)') → $OUT"
START=$SECONDS
(
  cd "$APP"
  # Trunk.toml's dist is ../../dist/web (inside the submodule); always pass --dist so nothing lands in third_party.
  CARGO_TARGET_DIR="$(native_path "$TARGET_DIR")" \
    TRUNK_TOOLS_WASM_OPT="version_$WASM_OPT_WANT" \
    TRUNK_TOOLS_WASM_BINDGEN="$WASM_BINDGEN_WANT" \
    trunk build --release "${OFFLINE[@]}" --dist "$(native_path "$TMP")" --public-url ./
)

[[ -f "$TMP/index.html" ]] || die "trunk terminou sem index.html / trunk produced no index.html"
compgen -G "$TMP/*.wasm" >/dev/null || die "trunk terminou sem .wasm / trunk produced no .wasm"
rm -rf "$TMP/.stage" "$TMP/.trunk-lock"
chmod 755 "$TMP" # mktemp -d creates it 0700
printf '%s\n' "$STAMP" >"$TMP/.build-stamp"

if [[ -e "$OUT" ]]; then mv "$OUT" "$OUT.old.$$"; fi
mv "$TMP" "$OUT"
rm -rf "$OUT.old.$$"

WASM_SIZE="$(du -ch "$OUT"/*.wasm | tail -1 | awk '{print $1}')"
echo "build-pdfcraft-web: done in $((SECONDS - START)) s · total $(du -sh "$OUT" | awk '{print $1}') · wasm $WASM_SIZE"
