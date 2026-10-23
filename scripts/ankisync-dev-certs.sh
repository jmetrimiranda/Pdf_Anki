#!/usr/bin/env bash
# Development TLS material for the local Anki sync server (compose.dev.yml, docs/tecnico/anki-sync-dev.md).
#   scripts/ankisync-dev-certs.sh          create what is missing (idempotent)
#   scripts/ankisync-dev-certs.sh --force  regenerate everything
# Output (gitignored): server/ankisync-dev/certs/
#   ca.crt / ca.key                 dev CA ("Leitor de Estudos - CA de desenvolvimento") — trust ca.crt in the app
#   server.crt / server.key         cert for ankisync-dev-tls, localhost, 127.0.0.1 signed by the dev CA (Caddy)
#   untrusted-ca.crt / .key         an unrelated CA, only for the "untrusted certificate is rejected" tests
# Throwaway material for a local test server only: never reuse it anywhere else.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/server/ankisync-dev/certs"
FORCE=0
case "${1:-}" in
  --force) FORCE=1 ;;
  "") ;;
  *) echo "usage: $0 [--force]" >&2; exit 2 ;;
esac
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
mkdir -p "$DIR"

if [[ $FORCE == 0 && -s $DIR/ca.crt && -s $DIR/server.crt && -s $DIR/server.key && -s $DIR/untrusted-ca.crt ]] &&
  openssl verify -CAfile "$DIR/ca.crt" "$DIR/server.crt" >/dev/null 2>&1 &&
  openssl x509 -checkend 86400 -noout -in "$DIR/server.crt" >/dev/null 2>&1; then
  echo "dev certificates up to date: $DIR"
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
umask 022

new_ca() { # <key> <crt> <CN>
  openssl req -x509 -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "$1" -out "$2" -days 825 -sha256 -subj "/CN=$3" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" 2>/dev/null
}

new_ca "$TMP/ca.key" "$TMP/ca.crt" "Leitor de Estudos - CA de desenvolvimento"
new_ca "$TMP/untrusted-ca.key" "$TMP/untrusted-ca.crt" "Leitor de Estudos - CA nao confiavel (testes)"

openssl req -new -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout "$TMP/server.key" -out "$TMP/server.csr" -subj "/CN=ankisync-dev-tls" 2>/dev/null
cat >"$TMP/server.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:ankisync-dev-tls,DNS:localhost,IP:127.0.0.1
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid
EOF
openssl x509 -req -in "$TMP/server.csr" -CA "$TMP/ca.crt" -CAkey "$TMP/ca.key" -CAcreateserial \
  -out "$TMP/server.crt" -days 825 -sha256 -extfile "$TMP/server.ext" 2>/dev/null
openssl verify -CAfile "$TMP/ca.crt" "$TMP/server.crt" >/dev/null

for f in ca.crt ca.key server.crt server.key untrusted-ca.crt untrusted-ca.key; do
  install -m 0644 "$TMP/$f" "$DIR/$f" # keys must be readable by the Caddy container (dev only)
done
echo "dev certificates written to $DIR"
echo "  trust in the app: Configurações → Anki e sincronização → Certificado → $DIR/ca.crt"
