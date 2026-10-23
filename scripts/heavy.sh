#!/usr/bin/env bash
# Runs one heavy task (cargo build/test, Playwright suites, docker build, trunk) under the machine-wide lock
# ~/.agent-heavy.lock, shared with the other projects on this machine (Painel etc.): one heavy task at a time, and
# never with less than 25 GB free for the normal user. See the incident rules in CLAUDE.md.
#
#   scripts/heavy.sh "fase 6: cargo test" -- scripts/dev.sh bash -o pipefail -c 'cd src-tauri && cargo test'
#
# Waits while another task holds the lock (polling; LEITOR_HEAVY_WAIT_MAX seconds, default 4 h), refuses to start
# below LEITOR_HEAVY_MIN_GB (default 25) free, and always releases the lock, also on failure or interruption.
# The task gets at most LEITOR_HEAVY_MAX_SECONDS (default 4 h; 0 = no limit): then it is stopped (TERM, KILL 60 s
# later) and the lock released, so a hung task (e.g. Xvfb in a container) never keeps the lock.
# A lock left by a dead process of this project (same host, recorded pid gone) is taken over; locks of other projects
# are never broken.
# Queue (machine rule, 2026-10-23): while ~/.agent-heavy.next names another project, don't take the lock — wait until
# that agent has had its turn and deleted the file. After releasing the lock, the Leitor waits at least 2 minutes
# before taking it again (LEITOR_HEAVY_COOLDOWN seconds), so whoever is queued gets the turn.
set -uo pipefail

LOCK="${HOME}/.agent-heavy.lock"
NEXT="${HOME}/.agent-heavy.next"
LAST="${XDG_RUNTIME_DIR:-/tmp}/leitor-heavy.last-release"
COOLDOWN="${LEITOR_HEAVY_COOLDOWN:-120}"
MIN_GB="${LEITOR_HEAVY_MIN_GB:-25}"
WAIT_MAX="${LEITOR_HEAVY_WAIT_MAX:-14400}"
MAX_SECONDS="${LEITOR_HEAVY_MAX_SECONDS:-14400}"

[[ $# -ge 3 && "$2" == "--" ]] || { echo "uso: $0 \"<descrição>\" -- <comando…>" >&2; exit 2; }
DESC="$1"; shift 2

stale_own_lock() {
  # Our format: "leitor <iso date> pid=<pid> <description>". Other projects' locks are never stale for us.
  local pid
  pid="$(sed -n 's/^leitor [^ ]* pid=\([0-9]*\) .*/\1/p' "$LOCK" 2>/dev/null)"
  [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null
}

queued_other() { [[ -s "$NEXT" ]] && ! grep -q '^leitor' "$NEXT" 2>/dev/null; }
cooling() {
  [[ -f "$LAST" ]] || return 1
  (( $(date +%s) - $(cat "$LAST" 2>/dev/null || echo 0) < COOLDOWN ))
}

waited=0
while [[ -e "$LOCK" ]] || queued_other || cooling; do
  if [[ -e "$LOCK" ]] && stale_own_lock; then
    echo "heavy: trava antiga do Leitor (processo morto) assumida: $(cat "$LOCK")" >&2
    rm -f "$LOCK"
    continue
  fi
  if (( waited == 0 )); then
    if [[ -e "$LOCK" ]]; then echo "heavy: esperando a trava: $(cat "$LOCK" 2>/dev/null)" >&2
    elif queued_other; then echo "heavy: outro agente na fila (.next): $(cat "$NEXT" 2>/dev/null); esperando a vez dele" >&2
    else echo "heavy: pausa de ${COOLDOWN}s depois da última tarefa do Leitor (vez de quem está na fila)" >&2; fi
  fi
  if (( waited >= WAIT_MAX )); then echo "heavy: desisti depois de ${WAIT_MAX}s esperando a trava" >&2; exit 75; fi
  sleep 30; waited=$((waited + 30))
done

avail_gb="$(df -BG --output=avail / | tail -1 | tr -dc '0-9')"
if (( avail_gb < MIN_GB )); then
  echo "heavy: só ${avail_gb} GB livres (mínimo ${MIN_GB} GB); não comecei \"$DESC\". Avise o usuário." >&2
  exit 75
fi

# noclobber: if two tasks race for a free lock, only one creates it.
if ! ( set -o noclobber; echo "leitor $(date -Is) pid=$$ $DESC" >"$LOCK" ) 2>/dev/null; then
  echo "heavy: outra tarefa pegou a trava agora; tente de novo" >&2
  exit 75
fi
child=""
trap 'rm -f "$LOCK"; date +%s >"$LAST"' EXIT
# The task runs in the background so these traps fire at once (bash defers traps while a foreground child runs).
trap '[[ -n "$child" ]] && kill -TERM "$child" 2>/dev/null; exit 130' INT TERM

echo "heavy: ${avail_gb} GB livres; trava pega: $DESC" >&2
# Background jobs get /dev/null as stdin unless it is redirected explicitly: keep the caller's stdin.
exec 3<&0
# With a terminal, --foreground keeps the task in the terminal's process group (otherwise it would be stopped when
# it reads the terminal); timeout then signals only the task itself.
FG=()
[[ -t 0 ]] && FG=(--foreground)
if (( MAX_SECONDS > 0 )); then
  timeout "${FG[@]}" --kill-after=60s "$MAX_SECONDS" "$@" 0<&3 3<&- &
else
  "$@" 0<&3 3<&- &
fi
child=$!
wait "$child"
rc=$?
(( MAX_SECONDS > 0 && (rc == 124 || rc == 137) )) && echo "heavy: \"$DESC\" passou de ${MAX_SECONDS}s e foi interrompida" >&2
echo "heavy: fim (código $rc), $(df -BG --output=avail / | tail -1 | tr -dc '0-9') GB livres; trava solta" >&2
exit $rc
