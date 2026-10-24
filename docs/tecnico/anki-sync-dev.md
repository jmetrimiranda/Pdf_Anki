# Local Anki sync server for development and tests

Spec: 9 (sync), 18 (secrets), 21 (Phase 0 TLS criterion, Phase 3, `compose.dev.yml`), Appendix A.1-A.3.

**Hard rule: the app, the tests and every script in this repo only ever sync with this local test server.** Never
AnkiWeb, never the user's real collection, never another project's server/network (e.g. the sibling `painel-estudos-dev`
network and images are off-limits). The accounts and passwords below are throwaway local test credentials.

## What runs

`compose.dev.yml` (compose project `leitor-dev`):

| Service | Image | Inside the network | On the host | What |
|---|---|---|---|---|
| `ankisync-dev` | `leitor-ankisync-dev:26.9.3` (built from `server/ankisync-dev/Dockerfile`) | `http://ankisync-dev:8080/` | `http://127.0.0.1:28080/` (`LEITOR_ANKISYNC_HTTP_PORT`) | Official server `python -m anki.syncserver` from PyPI `anki==26.9.3` (pylib `anki.buildinfo.version == "26.09.3"`, same rslib as the app) |
| `ankisync-dev-tls` | `caddy:2` | `https://ankisync-dev-tls:8443/` | `https://127.0.0.1:28443/` (`LEITOR_ANKISYNC_TLS_PORT`) | TLS terminator (TLS 1.2 + 1.3, spec A.3) with the dev certificate, `reverse_proxy ankisync-dev:8080`, no body size limit, admin API off |

- Network: `leitor-dev` (created by compose with that exact name). The devcontainer has no host network, so tests run
  with `LEITOR_DEV_NETWORK=leitor-dev scripts/dev.sh …` and reach the server by service name.
- Data: named volume `leitor-dev_ankisync-dev-data` mounted at `/data` (`SYNC_BASE`); `down -v` deletes it.
- Health: `GET /health` (200) on both endpoints; both services have healthchecks, so `up --wait` returns when ready.
- Accounts (`SYNC_USER1..15`, spec A.2), all with password `test`:
  - `test` — manual use (the running app, Configurações → Anki e sincronização).
  - `t1` … `t10` — the Rust integration suites (one account per test, so tests never share a server collection).
  - `t11` — reserved for the `pyclient.py` harness self-test (must stay unused by the Rust suites).
  - `t12` — optionally seeded by a Rust test (e.g. a review made by the app's client) and then read by the official
    Python client in `scripts/sync-test.sh crosscheck`.
  - `t13` (core suite) and `t14` (app suite) — the dropped-download tests (a proxy cuts the connection in the middle
    of the first full download).

## Up / down

```bash
scripts/ankisync-dev-certs.sh                           # once (idempotent; --force regenerates)
docker compose -f compose.dev.yml up -d --build --wait
docker compose -f compose.dev.yml exec -T ankisync-dev python -c 'import anki.buildinfo as b; print(b.version)'  # 26.09.3
LEITOR_DEV_NETWORK=leitor-dev scripts/dev.sh bash -c '
  curl -sf http://ankisync-dev:8080/health &&
  curl -sf --cacert server/ankisync-dev/certs/ca.crt https://ankisync-dev-tls:8443/health &&
  ! curl -sf https://ankisync-dev-tls:8443/health'       # untrusted without the dev CA
docker compose -f compose.dev.yml down -v               # always remove the volume when done
```

## Dev certificate

`scripts/ankisync-dev-certs.sh` writes into `server/ankisync-dev/certs/` (gitignored except `.gitkeep`):

| File | What |
|---|---|
| `ca.crt` / `ca.key` | Dev CA "Leitor de Estudos - CA de desenvolvimento" (EC P-256, 825 days) |
| `server.crt` / `server.key` | Server certificate signed by the dev CA, SAN `DNS:ankisync-dev-tls, DNS:localhost, IP:127.0.0.1`, `serverAuth` |
| `untrusted-ca.crt` / `.key` | Unrelated CA, only for the negative test (a client trusting it must reject the server) |

The keys are mode 0644 so the Caddy container can read them: this is throwaway local material, never reuse it.
`.dockerignore` keeps them out of the server image.

### Making the app trust it

- **In the app (recommended):** Configurações → Anki e sincronização → Certificado → choose
  `server/ankisync-dev/certs/ca.crt` (or paste its PEM). The PEM (public data) is stored in the setting
  `anki_sync_ca_cert` and added as an extra root to the rslib `reqwest` client (`use_rustls_tls()` +
  `add_root_certificate`, exactly one PEM certificate as upstream requires). Server URL
  `https://localhost:28443/` from the host (or `https://ankisync-dev-tls:8443/` inside the network), user `test`,
  password `test`.
- **System trust store:** rslib is built with `rustls-tls-native-roots`, so installing `ca.crt` system-wide also works
  (Debian/Ubuntu: copy to `/usr/local/share/ca-certificates/leitor-dev-ca.crt` and run `update-ca-certificates`;
  remove it afterwards). Not needed for the tests.
- Plain `http://localhost:28080/` also works for quick manual checks; the TLS path is the one the tests must cover.

## Keychain in the container

The hkey (never the password) lives in the system keychain via the `keyring` crate (Linux: Secret Service).
`scripts/with-keyring.sh <cmd…>` runs a command under `dbus-run-session` with a fresh, unlocked gnome-keyring (password
`test`, XDG dirs in a temp dir that is deleted afterwards) and exports `LEITOR_TEST_KEYRING=1` so the keychain tests
run. `scripts/with-keyring.sh --selftest` does a store → lookup → clear roundtrip through libsecret. It works as the
`dev` user and as root (CI).

## Tests

```bash
scripts/sync-test.sh            # all: core-anki + app suites + official-client cross-check
scripts/sync-test.sh core-anki  # cargo test -p core-anki --test sync_server -- --nocapture
scripts/sync-test.sh app        # cargo test -p leitor-estudos --test sync
scripts/sync-test.sh crosscheck # pyclient.py only
KEEP_SERVER=1 scripts/sync-test.sh core-anki   # leave the server running afterwards
```

`sync-test.sh` (host side): generates certs if missing → `down -v` → `up -d --build --wait` → checks the server
version (`anki==26.9.3`, buildinfo `26.09.3`) → runs the suites inside the dev image on network `leitor-dev` under
`with-keyring.sh` with:

| Variable | Value |
|---|---|
| `LEITOR_SYNC_TEST_URL` | `http://ankisync-dev:8080/` |
| `LEITOR_SYNC_TEST_TLS_URL` | `https://ankisync-dev-tls:8443/` |
| `LEITOR_SYNC_TEST_CA` | `<repo>/server/ankisync-dev/certs/ca.crt` |
| `LEITOR_SYNC_TEST_UNTRUSTED_CA` | `<repo>/server/ankisync-dev/certs/untrusted-ca.crt` |
| `LEITOR_TEST_KEYRING` | `1` (set by `with-keyring.sh`) |

The gated tests skip (pass with a note) when these are unset, so a plain `cargo test --workspace` stays offline.
`scripts/dev.sh` forwards `LEITOR_SYNC_TEST_*` and `LEITOR_TEST_KEYRING` from the host when they are set. The script
always ends with `down -v` (trap) unless `KEEP_SERVER=1`, and prints a PASS/FAIL summary.

CI (`.github/workflows/ci.yml`, job `linux`): step "Anki sync dev server" brings compose up and checks the version, the
big `docker run` joins `--network leitor-dev` with the variables above and runs
`timeout 75m ../scripts/with-keyring.sh cargo test -j 2 --workspace`, then the official-client cross-check, and
`down -v` runs with `if: always()`.

### Official client cross-check (`server/ankisync-dev/pyclient.py`)

Local stand-in for the `[VPS]` criterion "a review made in the app shows up in Anki desktop": Anki desktop syncs with
the same pylib/rslib code, so the official Python client from the same wheel is used. It runs inside the server
container and refuses any host other than `ankisync-dev`, `ankisync-dev-tls`, `localhost`, `127.0.0.1`:

```bash
docker compose -f compose.dev.yml exec -T ankisync-dev python /opt/ankisync/pyclient.py \
  --url http://ankisync-dev:8080/ --user t12 --password test --dir /tmp/x download-and-report
```

Commands (each starts from a wiped `--dir`): `download-and-report` (full download + media sync, JSON with
`cardCount`, `noteCount`, `revlogCount`, `latestRevlogId`, `latestRevlogCardId`, `decks`, `mediaFiles`),
`review-first-due` (download, answer the first due card Good, normal sync — uploads the review), `seed-upload`
(only for an empty server collection: 3 Basic notes, one with an image, full upload + media; harness self-test).

Manual procedure for the app → official client check: `KEEP_SERVER=1 scripts/sync-test.sh core-anki` (or log into
`t12` in the running app, review a card and sync), then run `download-and-report` for `t12` and compare
`latestRevlogId`/`revlogCount` with the review just made. The reverse direction: `review-first-due` on the account,
then sync in the app and check the card's history.

## Disk

Image sizes: `leitor-ankisync-dev:26.9.3` ≈ 234 MB (on top of `python:3.12-slim-bookworm`, shared layers; the pip
cache and `__pycache__` are not kept), `caddy:2` ≈ 93 MB. The data volume is tiny and removed by `down -v`.
Remove the image with `docker image rm leitor-ankisync-dev:26.9.3` when not needed.
