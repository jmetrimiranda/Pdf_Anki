// Vocabulary highlight in the EPUB reader (spec 12.7 for EPUB, 7.1): the word forms of the section on screen and the
// next one that the user doesn't know or is learning (`vocab_epub_marks`) are handed to the reader, which underlines
// their occurrences like PdfCraft's marks. Whether the highlight is on is the same per-book choice as for PDFs
// (VocabMarks keeps it); this only fetches (at most 5 sections per call), keeps what the reader shows (a click names
// the form) and asks again when the vocabulary changes. Framework-free (unit tested with fakes).
import type { EpubMarkWord, EpubSectionMarks } from '../../lib/core/types';

/** Sections that get marks: the one on screen and the next (the reader pre-renders it while paginating). */
export const EPUB_SECTIONS_AFTER = 1;
/** `vocab_epub_marks` takes at most this many sections per call. */
export const MAX_EPUB_MARK_SECTIONS = 5;

export interface EpubVocabDeps {
  /** vocab_epub_marks(uid, sections); `null` when the book was never scanned. */
  fetch(uid: string, sections: number[]): Promise<EpubSectionMarks[] | null>;
  /** The forms the reader underlines in `section` (`null` clears that section). */
  show(uid: string, section: number, words: EpubMarkWord[] | null): void;
  /** Clears every mark the reader shows. */
  clear(uid: string): void;
  isOn(uid: string): boolean;
  onError?(uid: string, e: unknown): void;
}

export class EpubVocab {
  private uid: string | null = null;
  private section = 0;
  private sectionCount = 0;
  private epoch = 0;
  private readonly held = new Map<number, EpubMarkWord[]>();
  private readonly pending = new Set<number>();

  constructor(private readonly deps: EpubVocabDeps) {}

  /** The book in the reader (null: none); a different book starts empty. */
  setBook(uid: string | null, sectionCount = 0) {
    if (uid !== this.uid) {
      this.uid = uid;
      this.section = 0;
      this.epoch++;
      this.held.clear();
      this.pending.clear();
    }
    if (sectionCount > 0) this.sectionCount = sectionCount;
  }

  /** The section on screen (`onSectionShown` / a location): marks for it and the next. */
  shown(uid: string, section: number, sectionCount?: number) {
    if (uid !== this.uid) this.setBook(uid, sectionCount ?? 0);
    else if (sectionCount && sectionCount > 0) this.sectionCount = sectionCount;
    this.section = section;
    if (this.deps.isOn(uid)) this.request(false);
  }

  /** The highlight was turned on or off for `uid`. */
  setOn(uid: string, on: boolean) {
    if (uid !== this.uid) return;
    this.epoch++;
    this.pending.clear();
    if (on) {
      this.held.clear();
      this.request(true);
      return;
    }
    const had = this.held.size > 0;
    this.held.clear();
    if (had) this.deps.clear(uid);
  }

  /** The marks may have changed (override, added word, rescan): ask again (`uid` absent: whichever book). */
  refresh(uid?: string) {
    if (this.uid === null || (uid !== undefined && uid !== this.uid) || !this.deps.isOn(this.uid)) return;
    this.epoch++;
    this.pending.clear();
    this.request(true);
  }

  /** The word the reader reported clicked (`form` as shown, any case), null when not underlined there. */
  markFor(section: number, form: string): EpubMarkWord | null {
    const key = form
      .normalize('NFC')
      .replace(/[‘’ʼ′`´＇]/g, "'")
      .toLowerCase();
    const list = this.held.get(section) ?? [...this.held.values()].flat();
    return list.find((w) => w.form === key) ?? null;
  }

  private windowSections(): number[] {
    const out: number[] = [];
    const last = this.sectionCount > 0 ? this.sectionCount - 1 : this.section + EPUB_SECTIONS_AFTER;
    for (let s = Math.max(0, this.section); s <= Math.min(last, this.section + EPUB_SECTIONS_AFTER); s++) out.push(s);
    return out;
  }

  private request(all: boolean) {
    const uid = this.uid;
    if (uid === null) return;
    const sections = this.windowSections()
      .filter((s) => !this.pending.has(s) && (all || !this.held.has(s)))
      .slice(0, MAX_EPUB_MARK_SECTIONS);
    if (sections.length === 0) return;
    for (const s of sections) this.pending.add(s);
    const epoch = this.epoch;
    void this.deps
      .fetch(uid, sections)
      .then((res) => {
        if (epoch !== this.epoch || uid !== this.uid || !this.deps.isOn(uid)) return;
        for (const s of sections) this.pending.delete(s);
        const got = new Map<number, EpubMarkWord[]>(sections.map((s) => [s, []]));
        for (const r of res ?? []) if (got.has(r.section)) got.set(r.section, r.words);
        // Keep only the window (bounded memory in the reader too); sections left behind are cleared there.
        const keep = new Set(this.windowSections());
        for (const s of [...this.held.keys()]) {
          if (keep.has(s) || got.has(s)) continue;
          this.held.delete(s);
          this.deps.show(uid, s, null);
        }
        for (const [s, words] of got) {
          if (!keep.has(s)) continue;
          this.held.set(s, words);
          this.deps.show(uid, s, words);
        }
      })
      .catch((e: unknown) => {
        if (epoch === this.epoch) for (const s of sections) this.pending.delete(s);
        this.deps.onError?.(uid, e);
      });
  }
}
