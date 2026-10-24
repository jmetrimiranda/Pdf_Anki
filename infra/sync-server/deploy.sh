#!/usr/bin/env bash
# Deploy with rollback of the Leitor sync stack on the H110 (README.md). In /opt/leitor-sync/infra/sync-server:
#
#   ./deploy.sh            builds the images tagged with the current commit, starts them, checks health;
#                          if the health check fails, goes back to the previous version by itself
#   ./deploy.sh voltar     goes back to the previous version's images, without rebuilding
#   ./deploy.sh versoes    lists the published versions (the last one is up)
#   ./deploy.sh saude      checks the health of what is up
#
# History in .deploy-history: "<tag> <date>". The images of the last 3 versions are kept. Data lives in named
# volumes (ankisync-data, library-data) and is never touched by a deploy or a rollback.
set -euo pipefail
cd "$(dirname "$0")"
HIST=.deploy-history
KEEP=3
MIN_GB=5
dc() { LEITOR_SYNC_VERSION="$1" docker compose "${@:2}"; }

die() { echo "ERRO: $*" >&2; exit 1; }
[ -f .env ] || die "falta .env (copie de .env.example e preencha com ./set-secret.sh)."
[ "$(stat -c %a .env)" = 600 ] || die ".env precisa de permissão 600: chmod 600 .env"
for k in ANKI_SYNC_PASSWORD LIBRARY_SYNC_PASSWORD CLOUDFLARE_TUNNEL_TOKEN; do
  grep -q "^$k=." .env || die "$k está vazio no .env (./set-secret.sh $k)."
done
touch "$HIST"

host_of() { grep "^$1=" .env | cut -d= -f2-; }

healthy() {  # both services answer through Caddy by their hostnames, inside the Docker network
  local tag="$1" anki lib
  anki=$(host_of ANKI_HOST)
  lib=$(host_of LIBRARY_HOST)
  for _ in $(seq 1 60); do
    if dc "$tag" exec -T caddy wget -qO- --header "Host: $anki" http://localhost/health >/dev/null 2>&1 &&
      dc "$tag" exec -T caddy wget -qO- --header "Host: $lib" http://localhost/v1/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

set_version() {  # manual `docker compose logs/exec` use the version that is up (compose reads .env)
  local tmp
  tmp=$(mktemp .env.XXXXXX)
  chmod 600 "$tmp"
  grep -v '^LEITOR_SYNC_VERSION=' .env >"$tmp" || true
  printf 'LEITOR_SYNC_VERSION=%s\n' "$1" >>"$tmp"
  mv "$tmp" .env
}

prune_images() {
  local keep
  keep=$(tail -n "$KEEP" "$HIST" | cut -d' ' -f1)
  for img in leitor-ankisync leitor-library-sync; do
    docker image ls "$img" --format '{{.Tag}}' | while read -r t; do
      grep -qx "$t" <<<"$keep" || docker image rm "$img:$t" >/dev/null 2>&1 || true
    done
  done
}

start() {  # <tag>: up and healthy, without stopping the script on the way (set -e)
  dc "$1" up -d --remove-orphans && healthy "$1"
}

voltar() {  # the version before the last one in the history becomes the one that is up
  local prev prev_tag cur_tag
  [ "$(wc -l <"$HIST")" -ge 2 ] || die "não há versão anterior registrada em $HIST."
  prev=$(tail -n 2 "$HIST" | head -n 1)
  prev_tag=${prev%% *}
  echo "Voltando para $prev_tag."
  docker image inspect "leitor-library-sync:$prev_tag" >/dev/null 2>&1 || die "a imagem leitor-library-sync:$prev_tag não existe mais."
  if ! start "$prev_tag"; then
    # The version that was up comes back (the history still lists it as up).
    cur_tag=$(tail -n 1 "$HIST" | cut -d' ' -f1)
    echo "A versão $prev_tag não respondeu; religando $cur_tag." >&2
    start "$cur_tag" || die "nem $prev_tag nem $cur_tag responderam. Veja: docker compose logs"
    set_version "$cur_tag"
    die "a volta para $prev_tag falhou; no ar continua $cur_tag."
  fi
  sed -i '$ d' "$HIST"
  set_version "$prev_tag"
  echo "No ar: $prev_tag."
}

case "${1:-deploy}" in
  deploy)
    git -C ../.. diff --quiet && git -C ../.. diff --cached --quiet || die "há mudanças não commitadas em /opt/leitor-sync."
    avail=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
    [ "$avail" -ge "$MIN_GB" ] || die "só ${avail} GB livres (mínimo ${MIN_GB})."
    tag=$(git -C ../.. rev-parse --short=12 HEAD)
    last=$(tail -n 1 "$HIST" | cut -d' ' -f1)
    [ "$tag" != "$last" ] || die "a versão $tag já está no ar."
    echo "Construindo $tag…"
    dc "$tag" build
    echo "Subindo $tag…"
    if start "$tag"; then
      echo "$tag $(date -Is)" >>"$HIST"
      set_version "$tag"
      prune_images
      echo "No ar: $tag."
    else
      echo "A versão $tag não subiu ou não respondeu." >&2
      dc "$tag" logs --tail 40 caddy ankisync library-sync >&2 || true
      [ -n "$last" ] || die "primeira versão sem resposta; nada para voltar. Veja: docker compose logs"
      # Back to the version that was up; the history only ever lists versions that came up healthy.
      echo "Voltando para $last."
      start "$last" || die "a versão $last também não respondeu. Veja: docker compose logs"
      set_version "$last"
      die "deploy de $tag desfeito; no ar continua $last."
    fi
    ;;
  voltar) voltar ;;
  versoes) cat "$HIST" ;;
  saude)
    tag=$(tail -n 1 "$HIST" | cut -d' ' -f1)
    [ -n "$tag" ] || die "nada no ar ainda."
    healthy "$tag" && echo "OK: Anki e biblioteca respondem pelo Caddy." || die "sem resposta."
    ;;
  *) sed -n 2,10p "$0"; exit 2 ;;
esac
