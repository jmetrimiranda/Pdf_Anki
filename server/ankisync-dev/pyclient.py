#!/usr/bin/env python3
"""Official Anki Python client (pylib, same wheel as the server) against the LOCAL test sync server only.

Local stand-in for the spec's "[VPS] review in the app -> shows up in Anki desktop" criterion: Anki desktop syncs
through exactly this pylib/rslib code. Runs inside the ankisync-dev container (docs/tecnico/anki-sync-dev.md):

  docker compose -f compose.dev.yml exec -T ankisync-dev \
    python /opt/ankisync/pyclient.py --url http://ankisync-dev:8080/ --user t12 --password test \
    --dir /tmp/pyclient download-and-report

Commands (all start from a fresh collection in --dir, which is wiped first):
  download-and-report   full download from the server, media sync, print a JSON report
  review-first-due      download, answer the first due card "Good", normal sync (uploads the review), print the report
  seed-upload           only for an account whose server collection is EMPTY: create 3 Basic notes (one with an image)
                        in deck "Leitor crosscheck", full upload + media sync (self-test of this harness; --notes N)

Refuses every host other than ankisync-dev, ankisync-dev-tls, localhost and 127.0.0.1 (never AnkiWeb).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from urllib.parse import urlsplit

ALLOWED_HOSTS = {"ankisync-dev", "ankisync-dev-tls", "localhost", "127.0.0.1"}


def fail(message: str, code: int = 2) -> None:
    print(json.dumps({"ok": False, "error": message}), flush=True)
    sys.exit(code)


def checked_endpoint(url: str) -> str:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if parts.scheme not in ("http", "https") or host not in ALLOWED_HOSTS:
        fail(f"refusing non-local sync endpoint {url!r}; allowed hosts: {sorted(ALLOWED_HOSTS)}")
    return url if url.endswith("/") else url + "/"


def wait_media_sync(col, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    # media_sync_status() raises if the background media sync failed.
    while col.media_sync_status().active:
        if time.monotonic() > deadline:
            fail("media sync timed out", 3)
        time.sleep(0.1)


def report(col, endpoint: str, user: str, action: str, required: str, extra: dict | None = None) -> dict:
    latest = col.db.first("select id, cid, ease from revlog order by id desc limit 1")
    media_dir = col.media.dir()
    media_files = sorted(
        name for name in os.listdir(media_dir) if os.path.isfile(os.path.join(media_dir, name))
    )
    out = {
        "ok": True,
        "action": action,
        "endpoint": endpoint,
        "user": user,
        "required": required,
        "cardCount": col.card_count(),
        "noteCount": col.note_count(),
        "revlogCount": col.db.scalar("select count() from revlog"),
        "latestRevlogId": latest[0] if latest else None,
        "latestRevlogCardId": latest[1] if latest else None,
        "latestRevlogEase": latest[2] if latest else None,
        "decks": sorted(d.name for d in col.decks.all_names_and_ids()),
        "mediaFiles": media_files,
    }
    if extra:
        out.update(extra)
    return out


# 1x1 transparent PNG
PNG_1X1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000"
    "1f15c4890000000d49444154789c6360000002000005000108d0b2e7"
    "0000000049454e44ae426082"
)
MEDIA_NAME = "leitor-crosscheck.png"


def seed(col, notes: int) -> None:
    deck_id = col.decks.id("Leitor crosscheck")
    model = col.models.by_name("Basic")
    stored = col.media.write_data(MEDIA_NAME, PNG_1X1)
    for i in range(notes):
        note = col.new_note(model)
        note["Front"] = f"Pergunta {i + 1}" + (f' <img src="{stored}">' if i == 0 else "")
        note["Back"] = f"Resposta {i + 1}"
        col.add_note(note, deck_id)


def first_due_card(col):
    """First card the scheduler would show, trying every deck (the current deck may be an empty Default)."""
    for deck in [col.decks.current()["id"]] + [d.id for d in col.decks.all_names_and_ids()]:
        col.decks.select(deck)
        card = col.sched.getCard()
        if card is not None:
            return card
    return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", required=True, help="local sync endpoint, e.g. http://ankisync-dev:8080/")
    parser.add_argument("--user", required=True)
    parser.add_argument("--password", required=True)
    parser.add_argument("--dir", required=True, help="scratch directory (wiped)")
    parser.add_argument("--media-timeout", type=float, default=120.0)
    parser.add_argument("--notes", type=int, default=3, help="seed-upload: number of notes")
    parser.add_argument("command", choices=["download-and-report", "review-first-due", "seed-upload"])
    args = parser.parse_args()

    endpoint = checked_endpoint(args.url)
    from anki.collection import Collection  # imported late: argument errors stay fast
    from anki.sync import SyncOutput

    shutil.rmtree(args.dir, ignore_errors=True)
    os.makedirs(args.dir, exist_ok=True)
    col = Collection(os.path.join(args.dir, "collection.anki2"))
    try:
        auth = col.sync_login(username=args.user, password=args.password, endpoint=endpoint)
        auth.endpoint = endpoint  # sync_login returns no endpoint; without it the backend would use AnkiWeb

        if args.command == "seed-upload":
            seed(col, max(1, args.notes))
        out = col.sync_collection(auth, False)
        required = SyncOutput.ChangesRequired.Name(out.required)
        if out.new_endpoint:
            fail(f"server asked to move to {out.new_endpoint!r}; refusing", 3)
        if args.command == "seed-upload":
            if out.required != out.FULL_UPLOAD:
                fail(f"seed-upload needs an empty server collection for {args.user!r} (got {required})", 3)
            col.close_for_full_sync()
            col.full_upload_or_download(auth=auth, server_usn=None, upload=True)
            col.reopen(after_full_sync=True)
        elif out.required in (out.FULL_SYNC, out.FULL_DOWNLOAD):
            col.close_for_full_sync()
            col.full_upload_or_download(auth=auth, server_usn=None, upload=False)
            col.reopen(after_full_sync=True)
        elif out.required == out.FULL_UPLOAD:
            pass  # the server has no collection: nothing to download, never upload from here
        col.sync_media(auth)
        wait_media_sync(col, args.media_timeout)

        extra: dict = {}
        if args.command == "review-first-due":
            card = first_due_card(col)
            if card is None:
                fail("no due card to review", 4)
            col.sched.answerCard(card, 3)
            extra["reviewedCardId"] = card.id
            after = col.sync_collection(auth, False)
            extra["requiredAfterReview"] = SyncOutput.ChangesRequired.Name(after.required)
            if after.required not in (after.NO_CHANGES, after.NORMAL_SYNC):
                fail(f"unexpected sync state after review: {extra['requiredAfterReview']}", 3)

        print(json.dumps(report(col, endpoint, args.user, args.command, required, extra)), flush=True)
    finally:
        if col.db:
            col.close()


if __name__ == "__main__":
    main()
