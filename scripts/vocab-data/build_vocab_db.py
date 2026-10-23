#!/usr/bin/env python3
"""Builds vocab-en.sqlite (docs/PROJETO.md 12.2; schema in docs/tecnico/vocab-data.md) from pinned, already
downloaded and SHA-256-verified sources. Run with `python3 -I` (stdlib only); never imports anything from the
download directories.

  build_vocab_db.py --oewn english-wordnet-2025.xml.gz --wordfreq wordfreq-3.1.1.tar.gz \
      --stopwords stop.txt --out data/generated/vocab [--meta key=value ...]
  build_vocab_db.py --self-test

Outputs in --out: vocab-en.sqlite and vocab-data.json. Deterministic: rows are inserted sorted, then VACUUM and
ANALYZE.
"""

import argparse
import gzip
import hashlib
import io
import json
import os
import sqlite3
import struct
import sys
import tarfile
import tempfile
import xml.etree.ElementTree as ET

SCHEMA_VERSION = 1
FREQ_WORDS = 100_000
PARTICLES = {
    "up", "down", "in", "out", "on", "off", "over", "away", "back", "through", "about", "around", "along",
    "across", "by", "forward", "together", "apart", "aside",
}
POS = {"n": "n", "v": "v", "a": "a", "s": "a", "r": "r"}
WORDFREQ_MEMBER = "wordfreq/data/large_en.msgpack.gz"

SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE lemma (
  id INTEGER PRIMARY KEY,
  word TEXT NOT NULL,
  pos TEXT NOT NULL CHECK (pos IN ('n', 'v', 'a', 'r')),
  sense_count INTEGER NOT NULL,
  definition TEXT,
  UNIQUE (word, pos)
);
CREATE INDEX lemma_lower ON lemma (lower(word));
CREATE TABLE form (form TEXT NOT NULL, lemma_id INTEGER NOT NULL, PRIMARY KEY (form, lemma_id)) WITHOUT ROWID;
CREATE TABLE relation (
  from_id INTEGER NOT NULL,
  to_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('derivation', 'pertainym')),
  PRIMARY KEY (from_id, to_id, kind)
) WITHOUT ROWID;
CREATE TABLE freq (word TEXT PRIMARY KEY, zipf REAL NOT NULL) WITHOUT ROWID;
CREATE TABLE stopword (word TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE phrasal (lemma_id INTEGER PRIMARY KEY, verb TEXT NOT NULL, particle TEXT NOT NULL);
"""


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# --- Open English WordNet (WN-LMF XML) -------------------------------------------------------------------------


def parse_oewn(fileobj):
    """Returns (entries, synset_definitions). entries: list of dicts in file order with word, pos, forms,
    senses [(sense_id, synset_id)], relations [(kind, target_sense_id)]."""
    entries = []
    definitions = {}
    entry = None
    synset_id = None
    synset_def = None
    for event, el in ET.iterparse(fileobj, events=("start", "end")):
        tag = el.tag
        if event == "start":
            if tag == "LexicalEntry":
                entry = {"word": None, "pos": None, "forms": [], "senses": [], "relations": []}
            elif tag == "Synset":
                synset_id = el.get("id")
                synset_def = None
            elif entry is not None and tag == "Sense":
                entry["senses"].append((el.get("id"), el.get("synset")))
            continue
        # end events
        if entry is not None:
            if tag == "Lemma":
                entry["word"] = el.get("writtenForm")
                entry["pos"] = POS.get(el.get("partOfSpeech", ""))
            elif tag == "Form":
                form = el.get("writtenForm")
                if form:
                    entry["forms"].append(form)
            elif tag == "SenseRelation":
                kind = el.get("relType")
                if kind in ("derivation", "pertainym") and entry["senses"]:
                    entry["relations"].append((entry["senses"][-1][0], kind, el.get("target")))
            elif tag == "LexicalEntry":
                if entry["word"] and entry["pos"]:
                    entries.append(entry)
                entry = None
                el.clear()
        elif tag == "Definition" and synset_id is not None and synset_def is None:
            synset_def = " ".join((el.text or "").split())
        elif tag == "Synset":
            if synset_id and synset_def:
                definitions[synset_id] = synset_def
            synset_id = None
            el.clear()
        elif tag == "Lexicon":
            el.clear()
    return entries, definitions


def build_lexicon(entries, definitions):
    """Merges entries per (word, pos) and returns the rows of lemma/form/relation/phrasal."""
    merged = {}
    order = []
    for e in entries:
        key = (e["word"], e["pos"])
        if key not in merged:
            first = e["senses"][0][1] if e["senses"] else None
            merged[key] = {"senses": 0, "definition": definitions.get(first), "forms": set()}
            order.append(key)
        m = merged[key]
        m["senses"] += max(1, len(e["senses"]))
        m["forms"].update(f for f in e["forms"] if f != e["word"])
    keys = sorted(merged)
    ids = {k: i + 1 for i, k in enumerate(keys)}
    lemma_rows = [(ids[k], k[0], k[1], merged[k]["senses"], merged[k]["definition"]) for k in keys]

    form_rows = set()
    for k in keys:
        for f in merged[k]["forms"]:
            form_rows.add((f, ids[k]))

    sense_owner = {}
    for e in entries:
        for sid, _ in e["senses"]:
            sense_owner[sid] = ids[(e["word"], e["pos"])]
    rel_rows = set()
    for e in entries:
        src = ids[(e["word"], e["pos"])]
        for _sid, kind, target in e["relations"]:
            dst = sense_owner.get(target)
            if dst is None or dst == src:
                continue
            rel_rows.add((src, dst, kind))
            if kind == "derivation":
                rel_rows.add((dst, src, kind))

    phrasal_rows = []
    for k in keys:
        word, pos = k
        parts = word.split(" ")
        if pos == "v" and len(parts) == 2 and parts[1] in PARTICLES and parts[0].isalpha():
            phrasal_rows.append((ids[k], parts[0], parts[1]))
    return lemma_rows, sorted(form_rows), sorted(rel_rows), phrasal_rows


# --- wordfreq (cBpack msgpack) -----------------------------------------------------------------------------------


class Unpacker:
    """The small subset of MessagePack wordfreq's cBpack files use (arrays, maps, strings, ints, nil, bools)."""

    def __init__(self, data):
        self.d = data
        self.i = 0

    def take(self, n):
        if self.i + n > len(self.d):
            raise ValueError("truncated msgpack")
        b = self.d[self.i:self.i + n]
        self.i += n
        return b

    def unpack(self, depth=0):
        if depth > 8:
            raise ValueError("msgpack nesting too deep")
        b = self.take(1)[0]
        if b <= 0x7F:
            return b
        if 0x80 <= b <= 0x8F:
            return self.map(b & 0x0F, depth)
        if 0x90 <= b <= 0x9F:
            return self.array(b & 0x0F, depth)
        if 0xA0 <= b <= 0xBF:
            return self.take(b & 0x1F).decode("utf-8")
        if b == 0xC0:
            return None
        if b in (0xC2, 0xC3):
            return b == 0xC3
        if b == 0xCC:
            return self.take(1)[0]
        if b == 0xCD:
            return struct.unpack(">H", self.take(2))[0]
        if b == 0xCE:
            return struct.unpack(">I", self.take(4))[0]
        if b == 0xD9:
            return self.take(self.take(1)[0]).decode("utf-8")
        if b == 0xDA:
            return self.take(struct.unpack(">H", self.take(2))[0]).decode("utf-8")
        if b == 0xDB:
            return self.take(struct.unpack(">I", self.take(4))[0]).decode("utf-8")
        if b == 0xDC:
            return self.array(struct.unpack(">H", self.take(2))[0], depth)
        if b == 0xDD:
            return self.array(struct.unpack(">I", self.take(4))[0], depth)
        if b == 0xDE:
            return self.map(struct.unpack(">H", self.take(2))[0], depth)
        if b >= 0xE0:
            return b - 0x100
        raise ValueError("unsupported msgpack byte 0x%02x" % b)

    def array(self, n, depth):
        return [self.unpack(depth + 1) for _ in range(n)]

    def map(self, n, depth):
        out = {}
        for _ in range(n):
            k = self.unpack(depth + 1)
            out[k] = self.unpack(depth + 1)
        return out


def zipf_from_cbpack(raw, limit=FREQ_WORDS):
    """cBpack: [header {format: 'cB', version: 1}, bucket0, bucket1, ...]; bucket i holds the words whose
    frequency is 10^(-i/100), i.e. Zipf = 9 - i/100. Keeps the `limit` most frequent words with a letter and no
    digit."""
    data = Unpacker(raw).unpack()
    if not isinstance(data, list) or not data or not isinstance(data[0], dict):
        raise ValueError("not a cBpack file")
    header = data[0]
    if header.get("format") != "cB" or header.get("version") != 1:
        raise ValueError("unexpected cBpack header %r" % (header,))
    out = {}
    for i, bucket in enumerate(data[1:]):
        if not isinstance(bucket, list):
            continue
        zipf = round(9 - i / 100, 2)
        for word in bucket:
            if not isinstance(word, str) or word in out:
                continue
            if not any(c.isalpha() for c in word) or any(c.isdigit() for c in word):
                continue
            out[word] = zipf
            if len(out) >= limit:
                return out
    return out


def read_wordfreq(path):
    with tarfile.open(path, "r:gz") as tar:
        member = None
        for m in tar.getmembers():
            if m.name.endswith("/" + WORDFREQ_MEMBER) and m.isfile():
                member = m
                break
        if member is None:
            raise ValueError("%s not found in %s" % (WORDFREQ_MEMBER, path))
        raw = gzip.decompress(tar.extractfile(member).read())
    return zipf_from_cbpack(raw)


# --- Snowball stop list ------------------------------------------------------------------------------------------


def parse_stopwords(text):
    words = set()
    for line in text.splitlines():
        body = line.split("|", 1)[0].strip()
        if body:
            words.add(body.split()[0].lower())
    return sorted(words)


# --- Output ------------------------------------------------------------------------------------------------------


def write_db(path, lexicon, freq, stopwords, meta):
    lemma_rows, form_rows, rel_rows, phrasal_rows = lexicon
    if os.path.exists(path):
        os.remove(path)
    con = sqlite3.connect(path)
    con.executescript("PRAGMA page_size = 4096; PRAGMA journal_mode = OFF;")
    con.executescript(SCHEMA)
    con.executemany("INSERT INTO meta VALUES (?, ?)", sorted(meta.items()))
    con.executemany("INSERT INTO lemma VALUES (?, ?, ?, ?, ?)", lemma_rows)
    con.executemany("INSERT INTO form VALUES (?, ?)", form_rows)
    con.executemany("INSERT INTO relation VALUES (?, ?, ?)", rel_rows)
    con.executemany("INSERT INTO freq VALUES (?, ?)", sorted(freq.items()))
    con.executemany("INSERT INTO stopword VALUES (?)", [(w,) for w in stopwords])
    con.executemany("INSERT INTO phrasal VALUES (?, ?, ?)", phrasal_rows)
    con.commit()
    con.execute("ANALYZE")
    con.commit()
    con.execute("VACUUM")
    con.close()


def counts(lexicon, freq, stopwords):
    lemma_rows, form_rows, rel_rows, phrasal_rows = lexicon
    return {
        "lemmas": len(lemma_rows),
        "forms": len(form_rows),
        "relations": len(rel_rows),
        "phrasal": len(phrasal_rows),
        "freq": len(freq),
        "stopwords": len(stopwords),
    }


def build(args):
    meta_args = dict(kv.split("=", 1) for kv in args.meta or [])
    with gzip.open(args.oewn, "rb") as f:
        entries, definitions = parse_oewn(f)
    lexicon = build_lexicon(entries, definitions)
    freq = read_wordfreq(args.wordfreq)
    with open(args.stopwords, encoding="utf-8") as f:
        stopwords = parse_stopwords(f.read())
    meta = {"schema_version": str(SCHEMA_VERSION)}
    meta.update(meta_args)
    meta.setdefault("wordnet_sha256", sha256(args.oewn))
    meta.setdefault("frequency_sha256", sha256(args.wordfreq))
    meta.setdefault("stopwords_sha256", sha256(args.stopwords))
    os.makedirs(args.out, exist_ok=True)
    db = os.path.join(args.out, "vocab-en.sqlite")
    tmp = db + ".part"
    write_db(tmp, lexicon, freq, stopwords, meta)
    os.replace(tmp, db)
    c = counts(lexicon, freq, stopwords)
    info = {
        "schemaVersion": SCHEMA_VERSION,
        "wordnet": source_json(meta, "wordnet"),
        "frequency": source_json(meta, "frequency"),
        "stopwords": source_json(meta, "stopwords"),
        "builtFrom": meta.get("built_from", ""),
        "counts": c,
        "sqliteSha256": sha256(db),
        "sqliteBytes": os.path.getsize(db),
    }
    with open(os.path.join(args.out, "vocab-data.json"), "w", encoding="utf-8") as f:
        json.dump(info, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    print("vocab-data: %s (%.1f MB) %s" % (db, os.path.getsize(db) / 1e6, json.dumps(c, sort_keys=True)))


def source_json(meta, prefix):
    return {k: meta.get("%s_%s" % (prefix, k), "") for k in ("name", "release", "sha256", "license", "url")}


# --- Self-test ---------------------------------------------------------------------------------------------------

FIXTURE_LMF = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE LexicalResource SYSTEM "http://globalwordnet.github.io/schemas/WN-LMF-1.3.dtd">
<LexicalResource xmlns:dc="https://globalwordnet.github.io/schemas/dc/">
  <Lexicon id="oewn" label="Open English Wordnet" language="en" email="x@example.org"
           license="https://creativecommons.org/licenses/by/4.0" version="2025" url="https://example.org">
    <LexicalEntry id="oewn-go-v">
      <Lemma writtenForm="go" partOfSpeech="v"/>
      <Form writtenForm="went"/><Form writtenForm="gone"/>
      <Sense id="oewn-go__2.38.00.." synset="oewn-1-v"/>
      <Sense id="oewn-go__2.38.01.." synset="oewn-2-v"/>
    </LexicalEntry>
    <LexicalEntry id="oewn-learn-v">
      <Lemma writtenForm="learn" partOfSpeech="v"/>
      <Sense id="oewn-learn__2.31.00.." synset="oewn-3-v"/>
    </LexicalEntry>
    <LexicalEntry id="oewn-learner-n">
      <Lemma writtenForm="learner" partOfSpeech="n"/>
      <Sense id="oewn-learner__1.18.00.." synset="oewn-4-n">
        <SenseRelation relType="derivation" target="oewn-learn__2.31.00.."/>
        <SenseRelation relType="hypernym" target="oewn-go__2.38.00.."/>
      </Sense>
    </LexicalEntry>
    <LexicalEntry id="oewn-quick-s">
      <Lemma writtenForm="quick" partOfSpeech="s"/>
      <Sense id="oewn-quick__5.00.00.fast.01" synset="oewn-5-s"/>
    </LexicalEntry>
    <LexicalEntry id="oewn-quickly-r">
      <Lemma writtenForm="quickly" partOfSpeech="r"/>
      <Sense id="oewn-quickly__4.02.00.." synset="oewn-6-r">
        <SenseRelation relType="pertainym" target="oewn-quick__5.00.00.fast.01"/>
      </Sense>
    </LexicalEntry>
    <LexicalEntry id="oewn-Napoleon-n">
      <Lemma writtenForm="Napoleon" partOfSpeech="n"/>
      <Sense id="oewn-Napoleon__1.18.00.." synset="oewn-7-n"/>
    </LexicalEntry>
    <LexicalEntry id="oewn-look_up-v">
      <Lemma writtenForm="look up" partOfSpeech="v"/>
      <Sense id="oewn-look_up__2.32.00.." synset="oewn-8-v"/>
    </LexicalEntry>
    <LexicalEntry id="oewn-look_for-v">
      <Lemma writtenForm="look for" partOfSpeech="v"/>
      <Sense id="oewn-look_for__2.32.00.." synset="oewn-8-v"/>
    </LexicalEntry>
    <Synset id="oewn-1-v" partOfSpeech="v" members="oewn-go-v"><Definition>change location;  move</Definition>
      <Definition>second definition</Definition></Synset>
    <Synset id="oewn-2-v" partOfSpeech="v" members="oewn-go-v"><Definition>follow a procedure</Definition></Synset>
    <Synset id="oewn-3-v" partOfSpeech="v" members="oewn-learn-v"><Definition>gain knowledge</Definition></Synset>
    <Synset id="oewn-4-n" partOfSpeech="n" members="oewn-learner-n"><Definition>someone who is learning</Definition></Synset>
    <Synset id="oewn-5-s" partOfSpeech="s" members="oewn-quick-s"><Definition>moving fast</Definition></Synset>
    <Synset id="oewn-6-r" partOfSpeech="r" members="oewn-quickly-r"><Definition>with speed</Definition></Synset>
    <Synset id="oewn-7-n" partOfSpeech="n" members="oewn-Napoleon-n"><Definition>French emperor</Definition></Synset>
    <Synset id="oewn-8-v" partOfSpeech="v" members="oewn-look_up-v"><Definition>seek information</Definition></Synset>
  </Lexicon>
</LexicalResource>
"""


def pack_str(s):
    b = s.encode("utf-8")
    if len(b) < 32:
        return bytes([0xA0 | len(b)]) + b
    return b"\xd9" + bytes([len(b)]) + b


def pack_array(items):
    n = len(items)
    head = bytes([0x90 | n]) if n < 16 else b"\xdc" + struct.pack(">H", n)
    return head + b"".join(items)


def self_test():
    # cBpack: bucket 0 = zipf 9.0 (empty), bucket 200 = zipf 7.0, bucket 450 = 4.5.
    buckets = [pack_array([]) for _ in range(500)]
    buckets[200] = pack_array([pack_str("the"), pack_str("3rd"), pack_str("...")])
    buckets[450] = pack_array([pack_str("learn"), pack_str("the")])
    header = b"\x82" + pack_str("format") + pack_str("cB") + pack_str("version") + b"\x01"
    raw = pack_array([header] + buckets)
    with tempfile.TemporaryDirectory() as tmp:
        oewn = os.path.join(tmp, "oewn.xml.gz")
        with gzip.open(oewn, "wb") as f:
            f.write(FIXTURE_LMF.encode("utf-8"))
        wf = os.path.join(tmp, "wordfreq-0.tar.gz")
        with tarfile.open(wf, "w:gz") as tar:
            payload = gzip.compress(raw)
            ti = tarfile.TarInfo("wordfreq-0/" + WORDFREQ_MEMBER)
            ti.size = len(payload)
            tar.addfile(ti, io.BytesIO(payload))
        stop = os.path.join(tmp, "stop.txt")
        with open(stop, "w", encoding="utf-8") as f:
            f.write(" | comment\ni   | subject\nThe\n\n| us  | commented out\nof | x\n")
        out = os.path.join(tmp, "out")
        args = argparse.Namespace(
            oewn=oewn, wordfreq=wf, stopwords=stop, out=out,
            meta=["wordnet_name=Open English WordNet", "wordnet_release=2025"],
        )
        build(args)
        con = sqlite3.connect(os.path.join(out, "vocab-en.sqlite"))
        q = lambda sql, *p: con.execute(sql, p).fetchall()
        assert q("SELECT value FROM meta WHERE key='schema_version'") == [("1",)]
        assert q("SELECT word, pos, sense_count, definition FROM lemma WHERE word='go'") == [
            ("go", "v", 2, "change location; move")], q("SELECT * FROM lemma")
        assert q("SELECT pos, definition FROM lemma WHERE word='quick'") == [("a", "moving fast")]
        assert q("SELECT word FROM lemma WHERE word='Napoleon'") == [("Napoleon",)]
        assert sorted(q("SELECT f.form FROM form f JOIN lemma l ON l.id=f.lemma_id WHERE l.word='go'")) == [
            ("gone",), ("went",)]
        rel = set(q("SELECT a.word, b.word, r.kind FROM relation r JOIN lemma a ON a.id=r.from_id "
                    "JOIN lemma b ON b.id=r.to_id"))
        assert rel == {("learner", "learn", "derivation"), ("learn", "learner", "derivation"),
                       ("quickly", "quick", "pertainym")}, rel
        assert q("SELECT word, zipf FROM freq ORDER BY word") == [("learn", 4.5), ("the", 7.0)]
        assert q("SELECT word FROM stopword ORDER BY word") == [("i",), ("of",), ("the",)]
        assert q("SELECT verb, particle FROM phrasal") == [("look", "up")]
        con.close()
        info = json.load(open(os.path.join(out, "vocab-data.json"), encoding="utf-8"))
        assert info["schemaVersion"] == 1 and info["wordnet"]["release"] == "2025", info
        # Deterministic output.
        first = sha256(os.path.join(out, "vocab-en.sqlite"))
        build(args)
        assert sha256(os.path.join(out, "vocab-en.sqlite")) == first, "output is not deterministic"
    # Bad msgpack never crashes beyond a ValueError.
    for bad in [b"", b"\xc1", b"\xdc\xff\xff", pack_array([pack_str("x")])]:
        try:
            zipf_from_cbpack(bad)
        except ValueError:
            pass
        else:
            raise AssertionError("accepted bad cbpack %r" % bad)
    print("build_vocab_db: self-test ok")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--self-test", action="store_true")
    p.add_argument("--oewn")
    p.add_argument("--wordfreq")
    p.add_argument("--stopwords")
    p.add_argument("--out")
    p.add_argument("--meta", action="append", help="key=value stored in the meta table")
    args = p.parse_args()
    if args.self_test:
        self_test()
        return 0
    for name in ("oewn", "wordfreq", "stopwords", "out"):
        if not getattr(args, name):
            p.error("--%s is required" % name)
    build(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
