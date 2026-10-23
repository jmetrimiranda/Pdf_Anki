#!/usr/bin/env bash
# Records the first request body of every /_anki/ method the reused Anki pages call (deck options,
# statistics, card info, congrats, change notetype, import) into
# src-tauri/crates/core-anki/tests/fixtures/bridge/<method>.bin (+ .json with the headers), and
# saves the seeded fixture collection there as fixture.colpkg, for the bridge tests (spec 20).
# Debug build + Xvfb, inside the devcontainer:  scripts/dev.sh scripts/record-anki-posts.sh
exec "$(dirname "$0")/anki-real-app.sh" record
