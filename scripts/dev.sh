#!/usr/bin/env bash
# Run a command inside the devcontainer image without VS Code (same volumes as devcontainer.json).
#   scripts/dev.sh cargo test --workspace         (from the repo root)
#   scripts/dev.sh --gui pnpm --dir web tauri dev (forwards the host X display)
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
TTY=()
[[ -t 0 && -t 1 ]] && TTY=(-it)
exec docker run --rm "${TTY[@]}" "${GUI[@]}" \
  --shm-size=2g ${LEITOR_DEV_NETWORK:+--network "$LEITOR_DEV_NETWORK"} \
  -v "$ROOT":/workspaces/leitor-estudos \
  -v leitor-cargo-registry:/usr/local/cargo/registry \
  -v leitor-cargo-git:/usr/local/cargo/git \
  -v leitor-target:/workspaces/leitor-estudos/src-tauri/target \
  -v leitor-pnpm-store:/home/dev/.local/share/pnpm \
  -e CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-12}" \
  -w /workspaces/leitor-estudos \
  "$IMAGE" bash -c 'sudo chown dev:dev /usr/local/cargo/registry /usr/local/cargo/git src-tauri/target /home/dev/.local/share/pnpm 2>/dev/null; exec "$@"' _ "$@"
