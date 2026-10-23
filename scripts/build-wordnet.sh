#!/usr/bin/env bash
# Builds the offline vocabulary data pack (docs/PROJETO.md 12.2) into data/generated/vocab/ from pinned sources,
# each verified by SHA-256 (details, licences and schema: docs/tecnico/vocab-data.md):
#   - Open English WordNet 2025 (WN-LMF XML, CC-BY-4.0): lemmas, irregular forms, derivation/pertainym links,
#     first-sense definitions, phrasal verbs;
#   - wordfreq 3.1.1 sdist (data CC-BY-SA-4.0; code Apache-2.0, not used): Zipf of the 100k most frequent English
#     words (large_en.msgpack.gz);
#   - Snowball's English stop word list (BSD-3-Clause), pinned commit.
# Output: vocab-en.sqlite, vocab-data.json, CREDITS.txt and LICENSES/. Downloads are cached in
# data/generated/cache/<source>/ and never executed; the converter runs with `python3 -I` from scripts/vocab-data/.
#
# Usage: scripts/build-wordnet.sh [--force]
# Idempotent: prints "up to date" when the stamp (script + converter + source hashes) matches.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GEN="$ROOT/data/generated"
CACHE="$GEN/cache"
OUT="$GEN/vocab"
CONVERTER="$ROOT/scripts/vocab-data/build_vocab_db.py"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

OEWN_RELEASE="2025"
OEWN_URL="https://github.com/globalwordnet/english-wordnet/releases/download/2025-edition/english-wordnet-2025.xml.gz"
OEWN_SHA="9ca6d1dcb75f822fdd66617f7d9da48142ace38dd544d6ad5e2feca1674ad3fe"
WORDFREQ_RELEASE="3.1.1"
WORDFREQ_URL="https://files.pythonhosted.org/packages/4c/cd/9581ff0ea2c581012d0caae4bba024f3ff6b46e030a55ddec1ce545e2caf/wordfreq-3.1.1.tar.gz"
WORDFREQ_SHA="7943098975f25c2a70e1151ee5a62083b14a5f86f6cc5703cc9526f716ceb408"
SNOWBALL_COMMIT="dc14fb462784e5bdf90f3210022b0f91d3881ffd"
SNOWBALL_URL="https://raw.githubusercontent.com/snowballstem/snowball-website/$SNOWBALL_COMMIT/algorithms/english/stop.txt"
SNOWBALL_SHA="06b8b14bbe6f6e0b64c0830813819416d96a71bec1655668d83b3e602a651db6"
SNOWBALL_LICENCE_URL="https://raw.githubusercontent.com/snowballstem/snowball-website/$SNOWBALL_COMMIT/license.tt"
SNOWBALL_LICENCE_SHA="f629f037a1849c71ecbea77f5916a6433c9854db5e0298dc90556eba94c0773b"
CC_BY_URL="https://creativecommons.org/licenses/by/4.0/legalcode.txt"
CC_BY_SHA="9ba9550ad48438d0836ddab3da480b3b69ffa0aac7b7878b5a0039e7ab429411"
CC_BY_SA_URL="https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt"
CC_BY_SA_SHA="28a9529c7d0bb4dc51f4bf5c116a3d16ef247a052f7591466768ddf563fd1cf5"

if command -v sha256sum >/dev/null; then
  sha() { sha256sum "$1" | cut -d' ' -f1; }
  sha_stdin() { sha256sum | cut -d' ' -f1; }
else
  sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
  sha_stdin() { shasum -a 256 | cut -d' ' -f1; }
fi

fetch_verified() { # url path sha256
  local url="$1" path="$2" want="$3"
  mkdir -p "$(dirname "$path")"
  if [[ -f "$path" && "$(sha "$path")" == "$want" ]]; then return 0; fi
  echo "build-wordnet: fetching $url"
  curl -sSfL --retry 3 -o "$path.part" "$url"
  local got
  got="$(sha "$path.part")"
  if [[ "$got" != "$want" ]]; then
    rm -f "$path.part"
    echo "error: $url: SHA-256 mismatch (expected $want, got $got)" >&2
    exit 1
  fi
  mv "$path.part" "$path"
}

STAMP_WANT="$( {
  sha "$ROOT/scripts/build-wordnet.sh"
  sha "$CONVERTER"
  echo "$OEWN_SHA $WORDFREQ_SHA $SNOWBALL_SHA $SNOWBALL_LICENCE_SHA $CC_BY_SHA $CC_BY_SA_SHA"
} | sha_stdin)"
STAMP_FILE="$OUT/.stamp"
if [[ $FORCE == 0 && -f "$STAMP_FILE" && -f "$OUT/vocab-en.sqlite" && "$(cat "$STAMP_FILE")" == "$STAMP_WANT" ]]; then
  echo "build-wordnet: up to date ($OUT)"
  exit 0
fi

# Each download in its own directory.
OEWN_FILE="$CACHE/oewn/english-wordnet-$OEWN_RELEASE.xml.gz"
WORDFREQ_FILE="$CACHE/wordfreq/wordfreq-$WORDFREQ_RELEASE.tar.gz"
SNOWBALL_FILE="$CACHE/snowball/stop.txt"
SNOWBALL_LICENCE_FILE="$CACHE/snowball-licence/license.tt"
CC_BY_FILE="$CACHE/cc-by/legalcode.txt"
CC_BY_SA_FILE="$CACHE/cc-by-sa/legalcode.txt"
fetch_verified "$OEWN_URL" "$OEWN_FILE" "$OEWN_SHA"
fetch_verified "$WORDFREQ_URL" "$WORDFREQ_FILE" "$WORDFREQ_SHA"
fetch_verified "$SNOWBALL_URL" "$SNOWBALL_FILE" "$SNOWBALL_SHA"
fetch_verified "$SNOWBALL_LICENCE_URL" "$SNOWBALL_LICENCE_FILE" "$SNOWBALL_LICENCE_SHA"
fetch_verified "$CC_BY_URL" "$CC_BY_FILE" "$CC_BY_SHA"
fetch_verified "$CC_BY_SA_URL" "$CC_BY_SA_FILE" "$CC_BY_SA_SHA"

PYTHON="$(command -v python3 || command -v python || true)"
if [[ -z "$PYTHON" ]]; then
  echo "error: python3 is required (scripts/vocab-data/build_vocab_db.py, stdlib only)" >&2
  exit 1
fi

STAGE="$GEN/vocab.staging"
rm -rf "$STAGE"
mkdir -p "$STAGE/LICENSES"
# Run from a neutral directory: nothing from the downloads is ever on Python's path.
(cd "$ROOT/scripts/vocab-data" && "$PYTHON" -I "$CONVERTER" \
  --oewn "$OEWN_FILE" --wordfreq "$WORDFREQ_FILE" --stopwords "$SNOWBALL_FILE" --out "$STAGE" \
  --meta "wordnet_name=Open English WordNet" --meta "wordnet_release=$OEWN_RELEASE" \
  --meta "wordnet_sha256=$OEWN_SHA" --meta "wordnet_license=CC-BY-4.0" \
  --meta "wordnet_url=https://github.com/globalwordnet/english-wordnet" \
  --meta "frequency_name=wordfreq (large_en, 100 mil palavras mais frequentes)" \
  --meta "frequency_release=$WORDFREQ_RELEASE" --meta "frequency_sha256=$WORDFREQ_SHA" \
  --meta "frequency_license=CC-BY-SA-4.0" --meta "frequency_url=https://github.com/rspeer/wordfreq" \
  --meta "stopwords_name=Snowball English stop word list" --meta "stopwords_release=$SNOWBALL_COMMIT" \
  --meta "stopwords_sha256=$SNOWBALL_SHA" --meta "stopwords_license=BSD-3-Clause" \
  --meta "stopwords_url=https://snowballstem.org/algorithms/english/stop.txt" \
  --meta "built_from=scripts/build-wordnet.sh")

cp "$CC_BY_FILE" "$STAGE/LICENSES/CC-BY-4.0.txt"
cp "$CC_BY_SA_FILE" "$STAGE/LICENSES/CC-BY-SA-4.0.txt"
sed -e 's/<[^>]*>//g' -e '/^\[%.*%\]$/d' "$SNOWBALL_LICENCE_FILE" >"$STAGE/LICENSES/Snowball-BSD-3-Clause.txt"
cat >"$STAGE/CREDITS.txt" <<EOF
Dados de vocabulário do Leitor de Estudos (escaneamento de vocabulário, offline, sem IA)
Vocabulary data of Leitor de Estudos (offline vocabulary scanning, no AI)

Open English WordNet $OEWN_RELEASE — https://github.com/globalwordnet/english-wordnet
  pt-BR: Léxico, formas irregulares, relações de derivação e definições: Open English WordNet $OEWN_RELEASE,
         de John P. McCrae e colaboradores, licença CC BY 4.0. Convertido para SQLite (só lemas, classes,
         formas, relações derivation/pertainym, phrasal verbs e a definição do primeiro sentido).
  en:    Lexicon, irregular forms, derivation links and definitions: Open English WordNet $OEWN_RELEASE by
         John P. McCrae et al., licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/;
         LICENSES/CC-BY-4.0.txt). Converted to SQLite (lemmas, parts of speech, forms, derivation/pertainym
         links, phrasal verbs and first-sense definitions). Based on Princeton WordNet 3.0.

wordfreq $WORDFREQ_RELEASE (large_en) — https://github.com/rspeer/wordfreq
  pt-BR: Frequência geral (escala Zipf) das 100 mil palavras inglesas mais frequentes, extraída dos dados
         do wordfreq de Robyn Speer, licença CC BY-SA 4.0 (este arquivo de dados é distribuído sob a
         mesma licença). Fontes do wordfreq: Google Books Ngrams, Leeds Internet Corpus, Wikipedia,
         ParaCrawl, OpenSubtitles 2018, SUBTLEX (Brysbaert et al.; dados livremente disponíveis), Twitter.
  en:    General frequency (Zipf scale) of the 100,000 most frequent English words, extracted from the data
         of wordfreq by Robyn Speer, licensed under CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/;
         LICENSES/CC-BY-SA-4.0.txt); this data file is shared under the same licence. wordfreq's sources:
         Google Books Ngram Viewer (http://books.google.com/ngrams), the Leeds Internet Corpus (University of
         Leeds Centre for Translation Studies), Wikipedia, ParaCrawl, OPUS OpenSubtitles 2018 (data from the
         OpenSubtitles project), the SUBTLEX lists by Marc Brysbaert et al. (SUBTLEX is freely available data)
         and Twitter word statistics. Citation: Robyn Speer (2022), rspeer/wordfreq v3.0, doi:10.5281/zenodo.7199437.

Snowball English stop word list — https://snowballstem.org/algorithms/english/stop.txt
  pt-BR: Lista de palavras funcionais do Snowball (Martin Porter e Richard Boulton), licença BSD de 3 cláusulas.
  en:    Snowball English stop word list, Copyright (c) 2001 Dr Martin Porter, (c) 2002 Richard Boulton,
         3-clause BSD licence (LICENSES/Snowball-BSD-3-Clause.txt).
EOF
echo "$STAMP_WANT" >"$STAGE/.stamp"
rm -rf "$OUT"
mv "$STAGE" "$OUT"
echo "build-wordnet: ready at $OUT"
