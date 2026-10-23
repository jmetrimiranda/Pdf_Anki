#!/usr/bin/env bash
# Run a command with a private D-Bus session and an unlocked gnome-keyring (Secret Service), for the keychain tests.
# Inside the devcontainer (or the CI dev image):
#   scripts/with-keyring.sh cargo test -p leitor-estudos --test sync
#   scripts/with-keyring.sh --selftest          store → lookup → delete roundtrip through libsecret
# Everything (XDG dirs, the keyring file) lives in a temp dir removed on exit; the keyring password is the throwaway
# "test". Exports LEITOR_TEST_KEYRING=1 so keyring-gated tests run. Exits with the command's status.
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <command…> | --selftest" >&2
  exit 2
fi

if [[ -z "${LEITOR_KEYRING_INNER:-}" ]]; then
  for tool in dbus-run-session gnome-keyring-daemon; do
    command -v "$tool" >/dev/null || { echo "$tool not found (run inside the devcontainer)" >&2; exit 1; }
  done
  KR_TMP="$(mktemp -d "${TMPDIR:-/tmp}/leitor-keyring.XXXXXX")"
  trap 'rm -rf "$KR_TMP"' EXIT
  mkdir -p "$KR_TMP/data" "$KR_TMP/config" "$KR_TMP/cache" "$KR_TMP/runtime"
  chmod 700 "$KR_TMP/runtime"
  status=0
  # Not exec: the trap must clean the temp dir. dbus-run-session ends the bus (and the daemon with it) on exit.
  XDG_DATA_HOME="$KR_TMP/data" XDG_CONFIG_HOME="$KR_TMP/config" XDG_CACHE_HOME="$KR_TMP/cache" \
    XDG_RUNTIME_DIR="$KR_TMP/runtime" LEITOR_KEYRING_INNER=1 \
    dbus-run-session -- "$0" "$@" || status=$?
  exit "$status"
fi

# --- inside the private D-Bus session ---
# --unlock with a password on stdin creates (first run) and unlocks the "login" keyring; --start then attaches the
# secrets component to this bus and prints the env (GNOME_KEYRING_CONTROL…).
printf 'test' | gnome-keyring-daemon --unlock --components=secrets >/dev/null
eval "$(gnome-keyring-daemon --start --components=secrets 2>/dev/null)"
export GNOME_KEYRING_CONTROL LEITOR_TEST_KEYRING=1
unset LEITOR_KEYRING_INNER

# Wait until org.freedesktop.secrets answers on the bus.
ready=0
for _ in $(seq 1 50); do
  if dbus-send --session --print-reply --dest=org.freedesktop.DBus / org.freedesktop.DBus.NameHasOwner \
    string:org.freedesktop.secrets 2>/dev/null | grep -q 'boolean true'; then
    ready=1
    break
  fi
  sleep 0.1
done
if [[ $ready != 1 ]]; then
  echo "with-keyring: org.freedesktop.secrets did not appear on the session bus" >&2
  exit 1
fi

if [[ "$1" == "--selftest" ]]; then
  # libsecret through ctypes (no secret-tool / python bindings in the image): a real Secret Service roundtrip.
  exec python3 - <<'PY'
import ctypes, ctypes.util, sys

secret = ctypes.CDLL(ctypes.util.find_library("secret-1") or "libsecret-1.so.0")
glib = ctypes.CDLL(ctypes.util.find_library("glib-2.0") or "libglib-2.0.so.0")

class Attr(ctypes.Structure):
    _fields_ = [("name", ctypes.c_char_p), ("type", ctypes.c_int)]

class Schema(ctypes.Structure):
    _fields_ = [("name", ctypes.c_char_p), ("flags", ctypes.c_int), ("attributes", Attr * 32),
                ("reserved", ctypes.c_int)] + [(f"reserved{i}", ctypes.c_void_p) for i in range(1, 8)]

class GError(ctypes.Structure):
    _fields_ = [("domain", ctypes.c_uint32), ("code", ctypes.c_int), ("message", ctypes.c_char_p)]

schema = Schema()
schema.name = b"io.leitor.KeyringSelftest"
schema.attributes[0] = Attr(b"service", 0)  # SECRET_SCHEMA_ATTRIBUTE_STRING
schema.attributes[1] = Attr(b"account", 0)

glib.g_hash_table_new.restype = ctypes.c_void_p
glib.g_hash_table_new.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
glib.g_hash_table_insert.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
str_hash = ctypes.cast(glib.g_str_hash, ctypes.c_void_p)
str_equal = ctypes.cast(glib.g_str_equal, ctypes.c_void_p)
keep = []

def attrs():
    table = glib.g_hash_table_new(str_hash, str_equal)
    for k, v in ((b"service", b"leitor-estudos-selftest"), (b"account", b"selftest")):
        kb, vb = ctypes.create_string_buffer(k), ctypes.create_string_buffer(v)
        keep.extend((kb, vb))
        glib.g_hash_table_insert(table, kb, vb)
    return table

err = ctypes.POINTER(GError)()
def check(what):
    if err:
        sys.exit(f"keyring selftest: {what} failed: {err.contents.message.decode()}")

secret.secret_password_storev_sync.restype = ctypes.c_int
secret.secret_password_storev_sync.argtypes = [ctypes.POINTER(Schema), ctypes.c_void_p, ctypes.c_char_p,
    ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p, ctypes.POINTER(ctypes.POINTER(GError))]
secret.secret_password_lookupv_sync.restype = ctypes.c_void_p
secret.secret_password_lookupv_sync.argtypes = [ctypes.POINTER(Schema), ctypes.c_void_p, ctypes.c_void_p,
    ctypes.POINTER(ctypes.POINTER(GError))]
secret.secret_password_clearv_sync.restype = ctypes.c_int
secret.secret_password_clearv_sync.argtypes = [ctypes.POINTER(Schema), ctypes.c_void_p, ctypes.c_void_p,
    ctypes.POINTER(ctypes.POINTER(GError))]

value = b"selftest-value-\xc3\xa7"
ok = secret.secret_password_storev_sync(ctypes.byref(schema), attrs(), None, b"Leitor selftest", value, None,
                                        ctypes.byref(err))
check("store")
ptr = secret.secret_password_lookupv_sync(ctypes.byref(schema), attrs(), None, ctypes.byref(err))
check("lookup")
got = ctypes.string_at(ptr) if ptr else None
secret.secret_password_clearv_sync(ctypes.byref(schema), attrs(), None, ctypes.byref(err))
check("clear")
ptr = secret.secret_password_lookupv_sync(ctypes.byref(schema), attrs(), None, ctypes.byref(err))
check("lookup after clear")
if not ok or got != value or ptr:
    sys.exit(f"keyring selftest: FAIL (stored={ok}, lookup={got!r}, after clear={ptr})")
print("keyring selftest: OK (Secret Service store/lookup/clear roundtrip)")
PY
fi

exec "$@"
