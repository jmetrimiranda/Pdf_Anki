//! Vocabulary scanning (docs/PROJETO.md 12): the offline English lexicon (Open English WordNet + a Zipf list +
//! function words, built by `scripts/build-wordnet.sh`), text cleanup and tokens (12.3 B–C), lemmatization (D),
//! proper nouns (E), the per-page lemma table (F), the comparison with the user's Anki vocabulary (A, G), word forms
//! and families (I), phrasal verbs (H), metrics and report rows (12.4/12.5), ranges of the book (12.1 step 2), deck,
//! tag and field naming (12.6), the reading-time marks oracle (12.7) and the manual-check sampler (12.8).
//!
//! Pure Rust: no Anki, PDF or app-store dependencies and no desktop-only APIs (it must run on iOS later). Nothing here
//! panics on any input; user-facing error messages are pt-BR. Pages are 0-based everywhere in data; only display
//! strings are 1-based. Page numbers are physical pages (not `/PageLabels`).

mod compare;
mod error;
mod known;
mod legacy;
mod lemmatize;
mod lexicon;
mod naming;
mod notes;
mod oracle;
mod pos;
mod ranges;
mod sample;
mod table;
mod text;

pub use compare::{
    BaseRef, ChapterCoverage, CompareInput, CurvePoint, Metrics, OverrideStatus, RowGroup,
    RowOrder, ScanResult, Status, StatusSource, VocabRow, compare, order_rows,
};
pub use error::{RangeError, VocabError};
pub use known::{
    DerivedPolicy, KnownIndex, KnownNote, NoteStatus, ScanConfig, SuspendedPolicy, clean_field,
    suggest_field,
};
pub use legacy::{MAX_WORD_CHARS, lemma, single_word};
pub use lemmatize::{Lemma, lemma_with, lemmatize};
pub use lexicon::{DataInfo, Lexicon, SourceInfo, TestLexicon};
pub use naming::{
    VocabDeckNames, book_tag, chapter_subdeck, chapter_tag, range_tag, slug, vocab_deck_names,
};
pub use notes::{VocabNoteCtx, VocabNoteFields, vocab_note_fields};
pub use oracle::{MarkKind, MarkStatus, StatusOracle};
pub use pos::{Pos, pos_label_pt};
pub use ranges::{
    Chapter, MAX_RANGE_ITEMS, OutlineAnchor, OutlineNode, OutlineRangeItem, RangeKind, RangeSpec,
    ResolvedRange, chapters, outline_anchors, outline_ranges, parse_pages, rematch_outline_items,
    resolve_range,
};
pub use sample::{SampleRow, sample_tokens, to_csv};
pub use table::{BookLemma, BookLemmaPage, BookTable, FormCount, build_book_table};
pub use text::{CleanPage, PageInput, clean_pages, noise_spans, repeated_lines};

/// Version of the table algorithm (tokens, lemmas, proper nouns, examples). Bumping it invalidates every cached
/// book table (`book_lemma`/`book_lemma_page`), so the next scan re-reads the book.
pub const ALGO_VERSION: u32 = 1;

/// File name of the lexicon inside the data directory (`data/generated/vocab/`, bundled as a Tauri resource).
pub const DATA_FILE: &str = "vocab-en.sqlite";

/// Name of the JSON with the data sources and versions next to [`DATA_FILE`].
pub const DATA_INFO_FILE: &str = "vocab-data.json";

/// The schema version of [`DATA_FILE`] this crate reads (`meta.schema_version`).
pub const DATA_SCHEMA_VERSION: u32 = 1;

/// Environment variable that points tests and dev builds at a data directory.
pub const DATA_DIR_ENV: &str = "LEITOR_VOCAB_DATA_DIR";
