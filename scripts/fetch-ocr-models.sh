#!/usr/bin/env bash
# Fetch the OCR models used by pdfcraft-ocr (ocrs, CC-BY-SA-4.0), verified by SHA-256, into
# src-tauri/resources/ocr-models/ (docs/PROJETO.md 7.2). Mirrors `cargo xtask models` of the pinned
# PdfCraft (third_party/pdfcraft/xtask/src/assets.rs) and the [[fetched]] kind = "model" entries of
# third_party/pdfcraft/ATTRIBUTION.toml. Re-diff both whenever the submodule moves.
#
# Usage: scripts/fetch-ocr-models.sh [DEST]
# Idempotent: files whose hash already matches are not downloaded again.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/src-tauri/resources/ocr-models}"
mkdir -p "$DEST"

LICENCE_URL="https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt"
LICENCE_SHA="28a9529c7d0bb4dc51f4bf5c116a3d16ef247a052f7591466768ddf563fd1cf5"
MODELS=(
  "text-detection.rten|https://ocrs-models.s3-accelerate.amazonaws.com/text-detection.rten|f15cfb56bd02c4bf478a20343986504a1f01e1665c2b3a0ad66340f054b1b5ca"
  "text-recognition.rten|https://ocrs-models.s3-accelerate.amazonaws.com/text-recognition.rten|e484866d4cce403175bd8d00b128feb08ab42e208de30e42cd9889d8f1735a6e"
)

if command -v sha256sum >/dev/null; then
  sha() { sha256sum "$1" | cut -d' ' -f1; }
else
  sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

fetch_verified() { # url path sha256
  local url="$1" path="$2" want="$3"
  if [[ -f "$path" && "$(sha "$path")" == "$want" ]]; then return 0; fi
  echo "ocr-models: fetching $url"
  curl -sSfL --retry 3 -o "$path.part" "$url"
  if [[ "$(sha "$path.part")" != "$want" ]]; then
    rm -f "$path.part"
    echo "error: $url: SHA-256 mismatch (expected $want)" >&2
    exit 1
  fi
  mv "$path.part" "$path"
}

for m in "${MODELS[@]}"; do
  IFS='|' read -r file url want <<<"$m"
  fetch_verified "$url" "$DEST/$file" "$want"
  fetch_verified "$LICENCE_URL" "$DEST/$file.LICENCE.txt" "$LICENCE_SHA"
done

# Same text `cargo xtask models` writes (models_attribution), with our app's name.
cat > "$DEST/ATTRIBUTION.txt" <<'EOF'
Leitor de Estudos' text recognition (OCR, via PdfCraft's pdfcraft-ocr and ocrs) uses these models, unmodified.

text-detection.rten
  Ocrs text detection model
  by Robert Knight (ocrs-models; trained on HierText, CC-BY-SA-4.0)
  from https://github.com/robertknight/ocrs-models (the models ocrs downloads; model card: https://huggingface.co/robertknight/ocrs, cc-by-sa-4.0)
  licence: CC-BY-SA-4.0 (https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt; full text in text-detection.rten.LICENCE.txt)

text-recognition.rten
  Ocrs text recognition model
  by Robert Knight (ocrs-models; trained on HierText, CC-BY-SA-4.0)
  from https://github.com/robertknight/ocrs-models (the models ocrs downloads; model card: https://huggingface.co/robertknight/ocrs, cc-by-sa-4.0)
  licence: CC-BY-SA-4.0 (https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt; full text in text-recognition.rten.LICENCE.txt)
EOF
echo "ocr-models: ready at $DEST"
