#!/usr/bin/env bash
# The full local suite required before every commit (Linux + Web): Rust fmt/clippy/tests, the local C++ runner as
# root (refusal, like CI) and as a normal user, the PdfCraft fork checks when it has changes, web lint/tests, the
# PdfCraft web build, Playwright (mocked, bridge, perf) on Chromium and WebKit, the C++ runner isolation suite and
# the Anki sync tests. Run from anywhere; each step takes the machine-wide heavy lock (scripts/heavy.sh) only while
# it runs. Every step's real exit code counts (pipefail inside every container); output goes to
# ${LEITOR_SUITE_LOGS:-/tmp/leitor-suite}/<step>.log and the summary to stdout. Exit code 0 only if all steps pass.
set -uo pipefail
cd "$(dirname "$0")/.."
LOGS="${LEITOR_SUITE_LOGS:-/tmp/leitor-suite}"
rm -rf "$LOGS"; mkdir -p "$LOGS"
failed=()

# step <name> '<shell command>' [minutes]: runs under the heavy lock (bash -o pipefail, with dev/as_root
# available), logs everything and keeps the real exit code. Wall-clock limit (default 90 min): the commands inside
# the containers (dev/as_root) stop at that limit (TERM, then KILL), and heavy.sh stops the whole step 5 min later,
# so a hung step (e.g. Xvfb) fails with code 124/137 and never keeps the heavy lock.
step() {
  local name="$1" cmd="$2" minutes="${3:-90}"
  echo "=== $name"
  STEP_LIMIT="${minutes}m" LEITOR_HEAVY_MAX_SECONDS=$(( (minutes + 5) * 60 )) \
    scripts/heavy.sh "suíte: $name" -- bash -o pipefail -c "$cmd" >"$LOGS/$name.log" 2>&1
  local rc=$?
  (( rc == 124 || rc == 137 )) && echo "--- $name passou do limite de ${minutes} min" | tee -a "$LOGS/$name.log"
  grep -hE "^test result|FAILED|panicked|^error|Tests +[0-9]|[0-9]+ (passed|failed|flaky)|RESULT|lint-ok|build-pdfcraft-web" \
    "$LOGS/$name.log" | grep -vE "ok\. 0 passed; 0 failed" | tail -12
  if (( rc != 0 )); then failed+=("$name (código $rc)"); echo "--- FALHOU: $name (código $rc), log em $LOGS/$name.log"; fi
}

dev() { scripts/dev.sh timeout --kill-after=60s "${STEP_LIMIT:-90m}" bash -o pipefail -c "$1"; }

# Same docker invocation as scripts/dev.sh, but as root (CI runs the tests as root).
as_root() {
  docker run --rm --init --ulimit core=0 --user 0 -e HOME=/root -e CARGO_INCREMENTAL=0 \
    -v "$PWD":/workspaces/leitor-estudos -v leitor-cargo-registry:/usr/local/cargo/registry \
    -v leitor-cargo-git:/usr/local/cargo/git -v leitor-target:/workspaces/leitor-estudos/src-tauri/target \
    -w /workspaces/leitor-estudos/src-tauri leitor-dev:latest \
    timeout --kill-after=60s "${STEP_LIMIT:-90m}" bash -o pipefail -c "$1"
}
export -f dev as_root

# Light preparation (no heavy lock): the OCR models (sha256-checked, nothing downloaded when they match) and the
# committed foliate-js copy checked against its pinned hashes (no network).
echo "=== prep"
if ! { scripts/fetch-ocr-models.sh && scripts/fetch-foliate.sh --check; } >"$LOGS/prep.log" 2>&1; then
  failed+=("prep"); echo "--- FALHOU: prep, log em $LOGS/prep.log"
fi

step rust "dev 'cd src-tauri && export CARGO_INCREMENTAL=0 LEITOR_REQUIRE_VOCAB_DATA=1 LEITOR_REQUIRE_OCR_MODELS=1 && cargo fmt --all --check \
  && cargo clippy -j 12 --workspace --all-targets -- -D warnings \
  && ../scripts/with-keyring.sh cargo test -j 12 --workspace'" 150

# Release timing tests (ignored in the normal run): vocabulary engine, the 300-page scan, the PDF text extraction,
# OCR time per page (spec 7.2) and the EPUB open + text extraction.
step perf "dev 'cd src-tauri && export CARGO_INCREMENTAL=0 LEITOR_REQUIRE_VOCAB_DATA=1 LEITOR_REQUIRE_OCR_MODELS=1 \
  && cargo test -j 12 --release -p core-vocab -- --ignored \
  && cargo test -j 12 --release -p leitor-estudos --test vocab_perf -- --ignored --nocapture \
  && cargo test -j 12 --release -p core-pdf --test book_text -- --ignored \
  && cargo test -j 12 --release -p core-pdf --features testkit --test ocr -- --ignored --nocapture \
  && cargo test -j 12 --release -p core-epub --test text -- --ignored --nocapture'" 90

step cpp-root-and-user "as_root 'cargo test -j 12 -p core-cpp \
  && chown -R dev:dev /usr/local/cargo/registry /usr/local/cargo/git \
  && setpriv --reuid=1000 --regid=1000 --init-groups env HOME=/home/dev CARGO_HOME=/usr/local/cargo \
     CARGO_TARGET_DIR=/tmp/target-dev cargo test -j 12 --locked -p core-cpp --test local'" 60

if [[ -n "$(git -C third_party/pdfcraft status --porcelain)" ]]; then
  step fork "dev 'cd third_party/pdfcraft && export CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/workspaces/leitor-estudos/src-tauri/target/fork && cargo fmt --all --check \
    && cargo clippy -j 12 -p pdfcraft-ui-egui -p pdfcraft-web --all-targets -- -D warnings \
    && cargo test -j 12 -p pdfcraft-ui-egui -p pdfcraft-web \
    && cargo check --target wasm32-unknown-unknown -p pdfcraft-web'" 90
fi

# The production build is checked for foliate-js leftovers (no pdf.js, no foliate chunk over 1 MB).
step web "dev 'pnpm install --frozen-lockfile && pnpm -r lint && echo lint-ok && pnpm -r test \
  && pnpm --dir web exec vite build && scripts/fetch-foliate.sh --check-dist web/dist'" 45

step pdfcraft-web 'dev scripts/build-pdfcraft-web.sh' 60

# Playwright: keep the exit code, then clean the artifacts (traces/videos only on failure, but don't keep them).
# Each run has its own limit (t): a hung xvfb-run/Xvfb ends the run with 124/137 instead of blocking the step.
# The OCR bridge test needs the core-generated scanned PDF and its OCR'd version (ocr_fixture example).
step playwright "dev 't() { timeout --kill-after=30s 30m \"\$@\"; }; export LEITOR_OCR_FIXTURE_DIR=/workspaces/leitor-estudos/src-tauri/target/fixtures/ocr; \
  (cd src-tauri && CARGO_INCREMENTAL=0 cargo run -j 12 -p core-pdf --features testkit --example ocr_fixture -- \"\$LEITOR_OCR_FIXTURE_DIR\") || exit 1; \
  cd web && rc=0; t pnpm e2e:mock --reporter=line || rc=\$?; \
  [ \$rc -eq 0 ] && { t xvfb-run -a pnpm e2e:bridge --reporter=line || rc=\$?; }; \
  [ \$rc -eq 0 ] && { echo \"bridge: 2nd run, flakiness check\"; t xvfb-run -a pnpm e2e:bridge --reporter=line || rc=\$?; }; \
  [ \$rc -eq 0 ] && { t xvfb-run -a pnpm e2e:perf --reporter=line || rc=\$?; }; \
  rm -rf test-results playwright-report; exit \$rc'" 120

step runner 'scripts/runner-test.sh all' 45
step sync 'scripts/sync-test.sh all' 45

# Build volume size (rule: clean it at the end of a phase when it is over 30 GB).
size="$(docker run --rm -v leitor-target:/t alpine du -sh /t 2>/dev/null | cut -f1)"
echo
echo "volume leitor-target: ${size:-?} · livre: $(df -h --output=avail / | tail -1 | tr -d ' ')"
if (( ${#failed[@]} )); then
  echo "SUÍTE: FALHOU — ${failed[*]}"; exit 1
fi
echo "SUÍTE: OK"
