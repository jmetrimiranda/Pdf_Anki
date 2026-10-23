#!/usr/bin/env python3
"""Writes a small text PDF titled "Animal Farm" for the real-app captures (scripts/capture.sh). Never committed.

    python3 -I scripts/sample-book-pdf.py OUT.pdf

40 Letter pages of Helvetica text (short paraphrases written for the captures, not the book's text). Page 1 has
"the windmill was finished" and "animals"; page 37 mentions the windmill too (the fixture's Fonte link points there).
The PDF has an outline (bookmarks) for the vocabulary "Trecho" step: Chapter One (p. 1), Chapter Two (p. 11) with the
child "The Meeting" (p. 13), Chapter Three (p. 21) and Chapter Four (p. 31). Page texts don't depend on it.
"""
import sys

PAGES = 40
W, H = 612, 792
P1 = [
    "Chapter One",
    "",
    "On the farm the animals met in the big barn after dark.",
    "Old Major spoke of a better life for all animals,",
    "and the young pigs listened more closely than anyone.",
    "",
    "Months later the windmill was finished, and every animal",
    "came to see the sails turn for the first time.",
    "Boxer said he would work harder still.",
]
FILLER = [
    "The animals worked in the fields from morning until evening,",
    "and in the evenings they gathered to sing and to listen.",
    "The pigs kept the records, and the hens kept the eggs.",
    "Benjamin said little, and remembered everything.",
]
# (title, 1-based page, children) — the bookmarks of the outline.
OUTLINE = [
    ("Chapter One", 1, []),
    ("Chapter Two", 11, [("The Meeting", 13)]),
    ("Chapter Three", 21, []),
    ("Chapter Four", 31, []),
]
P37 = [
    "Chapter Six",
    "",
    "Snowball proposed building the windmill on the small hill,",
    "where the wind was strongest all through the year.",
    "Napoleon said nothing at the meeting, but he was watching.",
]


def esc(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def page_text(n: int) -> list[str]:
    if n == 1:
        return P1
    if n == 37:
        return P37
    return [f"Page {n}", ""] + FILLER * 3


def page_ref(n: int) -> str:
    """The page object of a 1-based page."""
    return f"{4 + 2 * (n - 1)} 0 R"


def add_outline(objs: dict[int, bytes], root: int) -> None:
    """Writes the /Outlines tree (objects root, root+1, …): top-level items, then each item's children."""
    top = [root + 1 + i for i in range(len(OUTLINE))]
    nxt = top[-1] + 1
    objs[root] = f"<< /Type /Outlines /First {top[0]} 0 R /Last {top[-1]} 0 R /Count {len(top)} >>".encode()
    for i, (title, page, children) in enumerate(OUTLINE):
        parts = [f"/Title ({esc(title)}) /Parent {root} 0 R /Dest [{page_ref(page)} /Fit]"]
        if i > 0:
            parts.append(f"/Prev {top[i - 1]} 0 R")
        if i + 1 < len(top):
            parts.append(f"/Next {top[i + 1]} 0 R")
        if children:
            kids = list(range(nxt, nxt + len(children)))
            nxt += len(children)
            parts.append(f"/First {kids[0]} 0 R /Last {kids[-1]} 0 R /Count {len(kids)}")
            for j, (ctitle, cpage) in enumerate(children):
                c = [f"/Title ({esc(ctitle)}) /Parent {top[i]} 0 R /Dest [{page_ref(cpage)} /Fit]"]
                if j > 0:
                    c.append(f"/Prev {kids[j - 1]} 0 R")
                if j + 1 < len(kids):
                    c.append(f"/Next {kids[j + 1]} 0 R")
                objs[kids[j]] = ("<< " + " ".join(c) + " >>").encode()
        objs[top[i]] = ("<< " + " ".join(parts) + " >>").encode()


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: sample-book-pdf.py OUT.pdf", file=sys.stderr)
        return 2
    objs: dict[int, bytes] = {}
    kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(PAGES))
    info = 4 + 2 * PAGES
    outlines = info + 1
    objs[1] = b"<< /Type /Catalog /Pages 2 0 R /Outlines %d 0 R >>" % outlines
    objs[2] = f"<< /Type /Pages /Count {PAGES} /Kids [{kids}] >>".encode()
    objs[3] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
    for i in range(PAGES):
        lines = page_text(i + 1)
        s = "BT\n/F1 13 Tf\n19 TL\n72 700 Td\n" + "".join(f"({esc(l)}) Tj\nT*\n" for l in lines) + "ET\n"
        objs[4 + 2 * i] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] "
            f"/Resources << /Font << /F1 3 0 R >> >> /Contents {5 + 2 * i} 0 R >>"
        ).encode()
        data = s.encode("latin-1")
        objs[5 + 2 * i] = b"<< /Length %d >>\nstream\n" % len(data) + data + b"endstream"
    add_outline(objs, outlines)
    objs[info] = b"<< /Title (Animal Farm) /Author (George Orwell) /Producer (Leitor de Estudos captures) >>"
    out = bytearray(b"%PDF-1.7\n")
    offsets = {}
    for n in sorted(objs):
        offsets[n] = len(out)
        out += b"%d 0 obj\n" % n + objs[n] + b"\nendobj\n"
    xref = len(out)
    size = max(objs) + 1
    out += b"xref\n0 %d\n0000000000 65535 f \n" % size
    for n in range(1, size):
        out += b"%010d 00000 n \n" % offsets[n]
    out += b"trailer\n<< /Size %d /Root 1 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, info, xref)
    with open(sys.argv[1], "wb") as f:
        f.write(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
