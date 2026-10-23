#!/usr/bin/env python3
"""Writes a small text PDF titled "Animal Farm" for the real-app captures (scripts/capture.sh). Never committed.

    python3 -I scripts/sample-book-pdf.py OUT.pdf

40 Letter pages of Helvetica text (short paraphrases written for the captures, not the book's text). Page 1 has
"the windmill was finished" and "animals"; page 37 mentions the windmill too (the fixture's Fonte link points there).
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


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: sample-book-pdf.py OUT.pdf", file=sys.stderr)
        return 2
    objs: dict[int, bytes] = {}
    kids = " ".join(f"{4 + 2 * i} 0 R" for i in range(PAGES))
    objs[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
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
    info = 4 + 2 * PAGES
    objs[info] = b"<< /Title (Animal Farm) /Author (George Orwell) /Producer (Leitor de Estudos captures) >>"
    out = bytearray(b"%PDF-1.7\n")
    offsets = {}
    for n in sorted(objs):
        offsets[n] = len(out)
        out += b"%d 0 obj\n" % n + objs[n] + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (info + 1)
    for n in range(1, info + 1):
        out += b"%010d 00000 n \n" % offsets[n]
    out += b"trailer\n<< /Size %d /Root 1 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (info + 1, info, xref)
    with open(sys.argv[1], "wb") as f:
        f.write(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
