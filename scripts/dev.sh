#!/usr/bin/env bash
# Run a command inside the devcontainer image without VS Code (same volumes as devcontainer.json).
#   scripts/dev.sh cargo test --workspace         (from the repo root)
#   scripts/dev.sh --gui pnpm --dir web tauri dev (forwards the host X display)
# LEITOR_DEV_NETWORK=<net> joins a docker network (leitor-dev: compose.dev.yml); LEITOR_SYNC_TEST_*,
# LEITOR_RUNNER_TEST_* and LEITOR_TEST_KEYRING are forwarded into the container when set.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${LEITOR_DEV_IMAGE:-leitor-dev:latest}"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -t "$IMAGE" "$ROOT/.devcontainer"
fi
GUI=()
if [[ "${1:-}" == "--gui" ]]; then
  shift
  GUI=(-e "DISPLAY=${DISPLAY:-:0}" -v /tmp/.X11-unix:/tmp/.X11-unix)
fi
# Forward the sync-test and runner-test variables when set on the host (scripts/sync-test.sh, scripts/runner-test.sh).
FWD=()
while IFS= read -r name; do
  FWD+=(-e "$name")
done < <(compgen -e | grep -E '^(LEITOR_SYNC_TEST_[A-Z0-9_]+|LEITOR_RUNNER_TEST_[A-Z0-9_]+|LEITOR_TEST_KEYRING)$' || true)
TTY=()
[[ -t 0 && -t 1 ]] && TTY=(-it)
# --init: a real PID 1 (tini) forwards signals and reaps orphans (Xvfb left by xvfb-run), so a timeout or Ctrl+C
# stops the whole container.
exec docker run --rm --init "${TTY[@]}" "${GUI[@]}" "${FWD[@]}" \
  --shm-size=2g --ulimit core=0 ${LEITOR_DEV_NETWORK:+--network "$LEITOR_DEV_NETWORK"} \
  -v "$ROOT":/workspaces/leitor-estudos \
  -v leitor-cargo-registry:/usr/local/cargo/registry \
  -v leitor-cargo-git:/usr/local/cargo/git \
  -v leitor-target:/workspaces/leitor-estudos/src-tauri/target \
  -v leitor-pnpm-store:/home/dev/.local/share/pnpm \
  -e CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-12}" \
  -w /workspaces/leitor-estudos \
  "$IMAGE" bash -c 'sudo chown dev:dev /usr/local/cargo/registry /usr/local/cargo/git src-tauri/target /home/dev/.local/share/pnpm 2>/dev/null; exec "$@"' _ "$@"
