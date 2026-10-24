#!/usr/bin/env bash
# Vendor the pinned foliate-js subset (the EPUB reader, docs/PROJETO.md 7.1) into web/vendor/foliate-js/, unmodified.
# foliate-js has no releases: we pin a commit of https://github.com/johnfactotum/foliate-js (MIT) and copy only the
# EPUB path: view.js, epub.js, epubcfi.js, paginator.js, fixed-layout.js, overlayer.js, progress.js, text-walker.js,
# search.js, vendor/zip.js (zip.js, BSD-3-Clause), vendor/fflate.js (fflate, MIT) and LICENSE. Never vendor/pdfjs.
# The minified zip.js/fflate bundles carry no licence text, so their LICENSE files come from the npm packages of
# the versions foliate's package-lock.json pins (sha256-checked as well). Details: docs/tecnico/foliate.md.
#
# Usage: scripts/fetch-foliate.sh          download, verify (tarball and every file) and copy into web/vendor/foliate-js/
#        scripts/fetch-foliate.sh --check  verify the committed copy against the pinned hashes (no network)
#        scripts/fetch-foliate.sh --check-dist web/dist
#                                          after `vite build`: no pdf.js (or other unsupported foliate format) and no
#                                          file over 1 MB coming from foliate in the build output
# Needs curl, tar and sha256sum.
set -euo pipefail

COMMIT="78914aef4466eb960965702401634c2cb348e9b1"
TARBALL_URL="https://github.com/johnfactotum/foliate-js/archive/$COMMIT.tar.gz"
TARBALL_SHA256="4878cd5f04073af5046ea543da73a963a7f9e1a4b30ddc63ac86cea5adf02f38"
ZIPJS_URL="https://registry.npmjs.org/@zip.js/zip.js/-/zip.js-2.8.22.tgz"
ZIPJS_SHA256="33861767acfb736702739a267a9324bf4bc7ef57e83aa10089767a4056dc8c54"
FFLATE_URL="https://registry.npmjs.org/fflate/-/fflate-0.8.2.tgz"
FFLATE_SHA256="61fd5061e2fc8e5e3e3129f7f2fec7bd78a313e1bf4becbf1cc1cc9998d141dc"

# path inside web/vendor/foliate-js  sha256
FILES="
view.js e0093af921feb03bb58fb51aeedc321fa108a4158d215f6913ecf7925415c945
epub.js dfe347495039e9b5991478986ec6b7713cf9efbcd8f475a77ef7b967c5176298
epubcfi.js e1a688ad5c84bf31f33cef467f92c7a6d060a0f17ec37c1d3c048e9c7b1cf645
paginator.js 51cec81572d5d182e231fe68ce9c3b5489a0976b36172060516336ba893565ea
fixed-layout.js 7aee1d15d8e0479b8a6c59a20304b250dafc4c7dc158147a2b2c6bed9e180b4c
overlayer.js d3d3396e3083277ccbd4f17c407621159b22a407107e43ce75ca3014578094fb
progress.js 544f5e90babc0cb31c5caf971a5f06dd6249ec06600cb62f672fa7179811fde1
text-walker.js 4ad740ab6142b5be428700ef4d270253cef6649cf6e047ae7d2698a7aec65e92
search.js 31e846bdc095a645de0e94f7baa2c9e136561a363a2f774d4032e72cfa1fb0ef
vendor/zip.js 2a0d43157e4a447c6e43351225758795b75a33e8dfec10c6767248df2182949a
vendor/fflate.js e63bcc21f83a43e5f71d5cbefd351ff4d4dbd57bef8b29ad65c8bd65752f6e6b
LICENSE b621ffc351fe263bc9b09dd0bc1c9332fda9c462a3904c1e4f0b4d3236b9c28c
vendor/LICENSE.zip.js 1b7ebc8d7889ed25491484ab2b102370742ca6c0b26650a0c62cc2269b579b84
vendor/LICENSE.fflate 805f6cb28bb8b6d3a0badd83c93bccd9671fa01a3b4b92b7042b0743325ac243
"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/web/vendor/foliate-js"
CHECK=0
case "${1:-}" in
  --check) CHECK=1 ;;
  --check-dist)
    DIST="${2:?uso: $0 --check-dist <dist>}"
    [[ -d "$DIST" ]] || { echo "foliate: $DIST não existe" >&2; exit 1; }
    bad=0
    # pdf.js (and the other formats view.js imports on demand) must never be bundled.
    if grep -rlE "pdfjs-dist|pdf\.worker|GlobalWorkerOptions" "$DIST" >/dev/null 2>&1; then
      echo "foliate: o build contém código de formato não suportado:" >&2
      grep -rlE "pdfjs-dist|pdf\.worker|GlobalWorkerOptions" "$DIST" >&2
      bad=1
    fi
    while IFS= read -r f; do
      if grep -qE "foliate-(view|paginator|fxl)" "$f"; then echo "foliate: $f passa de 1 MB" >&2; bad=1; fi
    done < <(find "$DIST" -type f -size +1M)
    [[ $bad -eq 0 ]] && echo "foliate: $DIST sem pdf.js e sem arquivo do foliate acima de 1 MB"
    exit $bad
    ;;
  "") ;;
  -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
  *) echo "uso: $0 [--check | --check-dist <dist>]" >&2; exit 2 ;;
esac

# verify_tree <dir>: every pinned file present with its hash, and nothing else (except README.leitor.md).
verify_tree() {
  local dir="$1" bad=0 path want got
  while read -r path want; do
    [[ -n "$path" ]] || continue
    if [[ ! -f "$dir/$path" ]]; then echo "foliate: faltando $path" >&2; bad=1; continue; fi
    got="$(sha256sum "$dir/$path" | cut -d' ' -f1)"
    if [[ "$got" != "$want" ]]; then echo "foliate: hash diferente em $path ($got)" >&2; bad=1; fi
  done <<<"$FILES"
  local extra
  extra="$(cd "$dir" && find . -type f ! -name README.leitor.md | sed 's|^\./||' | sort)"
  local expected
  expected="$(awk 'NF { print $1 }' <<<"$FILES" | sort)"
  if [[ "$extra" != "$expected" ]]; then
    echo "foliate: arquivos inesperados em $dir:" >&2
    comm -23 <(echo "$extra") <(echo "$expected") >&2
    bad=1
  fi
  return $bad
}

if [[ $CHECK -eq 1 ]]; then
  verify_tree "$DEST" || { echo "foliate: a cópia em web/vendor/foliate-js não confere com o commit $COMMIT" >&2; exit 1; }
  echo "foliate: web/vendor/foliate-js confere com o commit ${COMMIT:0:12}"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fetch() { # fetch <url> <sha256> <out>
  curl -sSfL --retry 3 -o "$3" "$1"
  local got
  got="$(sha256sum "$3" | cut -d' ' -f1)"
  [[ "$got" == "$2" ]] || { echo "error: SHA-256 mismatch for $1 (expected $2, got $got)" >&2; exit 1; }
}

echo "foliate: fetching foliate-js ${COMMIT:0:12}"
fetch "$TARBALL_URL" "$TARBALL_SHA256" "$WORK/foliate.tar.gz"
fetch "$ZIPJS_URL" "$ZIPJS_SHA256" "$WORK/zipjs.tgz"
fetch "$FFLATE_URL" "$FFLATE_SHA256" "$WORK/fflate.tgz"

mkdir -p "$WORK/src" "$WORK/zipjs" "$WORK/fflate"
tar -xzf "$WORK/foliate.tar.gz" -C "$WORK/src" --strip-components=1
tar -xzf "$WORK/zipjs.tgz" -C "$WORK/zipjs" package/LICENSE
tar -xzf "$WORK/fflate.tgz" -C "$WORK/fflate" package/LICENSE

STAGE="$WORK/stage"
mkdir -p "$STAGE/vendor"
while read -r path _; do
  [[ -n "$path" ]] || continue
  case "$path" in
    vendor/LICENSE.zip.js) cp "$WORK/zipjs/package/LICENSE" "$STAGE/$path" ;;
    vendor/LICENSE.fflate) cp "$WORK/fflate/package/LICENSE" "$STAGE/$path" ;;
    *) cp "$WORK/src/$path" "$STAGE/$path" ;;
  esac
done <<<"$FILES"
verify_tree "$STAGE"

mkdir -p "$DEST"
# Keep our README; replace everything else.
find "$DEST" -type f ! -name README.leitor.md -delete
cp -R "$STAGE/." "$DEST/"
echo "foliate: web/vendor/foliate-js atualizado (commit ${COMMIT:0:12})"
