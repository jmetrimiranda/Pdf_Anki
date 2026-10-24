#!/usr/bin/env bash
# Writes a secret into .env without showing it (nothing on the screen, in the shell history or in a log).
#
#   ./set-secret.sh CLOUDFLARE_TUNNEL_TOKEN   asks for the value (paste it; it is not shown)
#   ./set-secret.sh ANKI_SYNC_PASSWORD        asks twice (a password you will type in the apps; 12+ characters)
#   ./set-secret.sh LIBRARY_SYNC_PASSWORD     the same, for the library login
set -euo pipefail
cd "$(dirname "$0")"
[ $# -eq 1 ] || { sed -n 2,6p "$0"; exit 2; }
key="$1"
case "$key" in
  CLOUDFLARE_TUNNEL_TOKEN | ANKI_SYNC_PASSWORD | LIBRARY_SYNC_PASSWORD) ;;
  *) echo "ERRO: só CLOUDFLARE_TUNNEL_TOKEN, ANKI_SYNC_PASSWORD ou LIBRARY_SYNC_PASSWORD." >&2; exit 2 ;;
esac
[ -f .env ] || { cp .env.example .env; }
chmod 600 .env
read -rsp "Valor de $key (não aparece na tela): " value
echo
if [ "$key" != CLOUDFLARE_TUNNEL_TOKEN ]; then
  read -rsp "Repita: " again
  echo
  [ "$value" = "$again" ] || { echo "ERRO: os dois valores são diferentes." >&2; exit 1; }
fi
[ -n "$value" ] || { echo "ERRO: valor vazio." >&2; exit 1; }
case "$value" in
  *$'\n'* | *' '*) echo "ERRO: o valor não pode ter espaços nem quebras de linha." >&2; exit 1 ;;
  # docker compose reads $ in .env as a variable, # as a comment, and strips quotes.
  *'$'* | *'#'* | *'"'* | *"'"* | *'\'*) echo "ERRO: não use \$, #, aspas nem barra invertida." >&2; exit 1 ;;
esac
if [ "$key" != CLOUDFLARE_TUNNEL_TOKEN ] && [ "${#value}" -lt 12 ]; then
  echo "ERRO: use pelo menos 12 caracteres." >&2
  exit 1
fi
tmp=$(mktemp .env.XXXXXX)
chmod 600 "$tmp"
# Every line but the key's, then the key (the value never goes through sed or a command line).
grep -v "^${key}=" .env >"$tmp" || true
printf '%s=%s\n' "$key" "$value" >>"$tmp"
mv "$tmp" .env
unset value again
echo "$key gravado em $(pwd)/.env (permissão 600)."
