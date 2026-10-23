//! "Gerar deck" (spec 12.6) and "Adicionar ao deck do livro" (12.7): "Vocabulário · Livro" notes from the report
//! rows, in the vocabulary folder (`<pasta>::Livros::<Título>`, a subdeck per range or per chapter), with tags, the
//! `leitor://` Fonte of the first occurrence, the family of derivatives and a WordNet definition.
//!
//! Without AI the definition comes from the bundled WordNet ([`WordNetEnricher`]); [`VocabEnricher`] is the Phase 8
//! hook for the AI enrichment (definition, translation, part of speech; `vocab_enrichment_cache` stays untouched).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use core_anki::vocab::{VocabBookFields, VocabNoteSpec, VocabNotesPlan};
use core_vocab::{
    BaseRef, Lexicon, Pos, ResolvedRange, RowGroup, RowOrder, Status, StatusSource, VocabNoteCtx,
    VocabRow,
};
use serde::{Deserialize, Serialize};

use crate::anki::{ChangeReason, UiEvent};
use crate::error::AppError;
use crate::state::AppState;

use super::normal_deck_name;

/// How the definition is filled (`ai` arrives with Phase 8).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EnrichMode {
    #[default]
    Wordnet,
    Ai,
}

/// `vocab_generate_deck` options.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VocabDeckOptions {
    pub order: RowOrder,
    /// One subdeck per chapter (`…::Cap 01`).
    pub per_chapter: bool,
    /// The optional Português → Inglês card.
    pub card2: bool,
    pub enrich: EnrichMode,
}

/// `vocab_generate_deck`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabDeckResult {
    /// The deck of the range (or of the book; the book deck with per-chapter subdecks).
    pub deck_id: i64,
    pub deck_name: String,
    /// Every deck that received cards (full names, in study order).
    pub decks: Vec<String>,
    pub created: u32,
    pub note_ids: Vec<i64>,
    /// Lemmas already in the vocabulary folder.
    pub skipped_existing: Vec<String>,
    /// Lemmas created by an earlier scan of this book (even if the note was moved out of the folder).
    pub skipped_previous: Vec<String>,
}

/// `vocab_add_word`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabWordAdded {
    pub note_id: i64,
    pub deck_id: i64,
    pub deck_name: String,
}

/// What an enricher adds to a note.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Enrichment {
    /// Part of speech and definition (first sense).
    pub definition: Option<(Pos, String)>,
    /// pt-BR translation (empty without AI).
    pub translation: Option<String>,
}

/// Fills the definition (and, with AI in Phase 8, the translation) of a new vocabulary note.
pub trait VocabEnricher: Send + Sync {
    fn enrich(&self, row: &VocabRow) -> Enrichment;
}

/// Offline: the first sense of the row's part of speech in the bundled Open English WordNet.
pub struct WordNetEnricher {
    pub lex: Arc<Lexicon>,
}

impl VocabEnricher for WordNetEnricher {
    fn enrich(&self, row: &VocabRow) -> Enrichment {
        Enrichment {
            definition: self.lex.definition(&row.lemma, row.pos),
            translation: None,
        }
    }
}

fn ai_unavailable() -> AppError {
    AppError::new("ai_unavailable", "A IA chega numa próxima versão.")
}

/// Rows already in the folder: their status comes from the deck.
fn in_folder(row: &VocabRow) -> bool {
    row.status_source == Some(StatusSource::Deck)
        && matches!(
            row.status,
            Status::Known | Status::Learning | Status::New | Status::Suspended
        )
}

/// The book a note comes from.
pub(crate) struct NoteBook<'a> {
    pub uid: &'a str,
    pub title: &'a str,
    /// Fill "Card 2" (the optional Português → Inglês card).
    pub card2: bool,
}

/// The note of a row.
pub(crate) fn note_spec(
    row: &VocabRow,
    book: &NoteBook<'_>,
    book_occurrences: u32,
    enrichment: Enrichment,
    deck_name: String,
    tags: Vec<String>,
) -> VocabNoteSpec {
    let (book_uid, title, card2) = (book.uid, book.title, book.card2);
    let ctx = VocabNoteCtx {
        book_uid: book_uid.to_owned(),
        title: title.to_owned(),
        defn: enrichment.definition,
        book_occurrences,
        card2,
    };
    let f = core_vocab::vocab_note_fields(row, &ctx);
    let fonte =
        core_anki::study::source::source_html(book_uid, title, f.fonte_page, &f.fonte_query);
    let traducao = match enrichment.translation {
        Some(t) if f.traducao.is_empty() => escape(&t),
        _ => f.traducao,
    };
    VocabNoteSpec {
        deck_name,
        fields: VocabBookFields {
            palavra: f.palavra,
            lema: f.lema,
            classe: f.classe,
            definicao: f.definicao,
            traducao,
            exemplo: f.exemplo,
            fonte,
            frequencia: f.frequencia,
            familia: f.familia,
            card2: f.card2,
        },
        tags,
    }
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

impl AppState {
    /// Lemma → occurrences in the whole book (the "Frequência" field), from the stored table.
    fn vocab_book_occurrences(&self, uid: &str) -> HashMap<String, u32> {
        self.with_store(|s| s.vocab_table_lemmas(uid))
            .map(|rows| rows.into_iter().map(|r| (r.lemma, r.occurrences)).collect())
            .unwrap_or_default()
    }

    /// Current name of the folder root, falling back to the name the report saw.
    fn vocab_root_name(&self, root_deck_id: i64, fallback: &str) -> Result<String, AppError> {
        let name = self
            .anki_handles()?
            .svc
            .call_blocking(move |col| normal_deck_name(col, root_deck_id))?;
        Ok(name.unwrap_or_else(|| fallback.to_owned()))
    }

    /// After notes were created: refresh the screens and arm the sync ("60 s after a change").
    fn vocab_notes_added(&self) {
        self.emit(UiEvent::AnkiChanged(ChangeReason::Vocab));
        self.sync_answered();
        self.vocab.invalidate_marks();
    }

    /// Creates the notes of `lemmas` from the scan `scan_uid` (spec 12.6), then rescans so the report shows them.
    pub fn vocab_generate_deck(
        self: &Arc<Self>,
        uid: &str,
        scan_uid: &str,
        lemmas: Vec<String>,
        options: VocabDeckOptions,
    ) -> Result<VocabDeckResult, AppError> {
        if options.enrich == EnrichMode::Ai {
            return Err(ai_unavailable());
        }
        let report = self
            .vocab_report_of(scan_uid)?
            .filter(|r| r.book_uid == uid)
            .ok_or_else(super::not_scanned)?;
        let lex = self.vocab_lexicon()?;
        let enricher = WordNetEnricher {
            lex: Arc::clone(&lex),
        };
        let wanted: HashSet<String> = lemmas.iter().map(|l| l.trim().to_lowercase()).collect();
        let previous = self.vocab_previous_notes(uid)?;
        let mut rows: Vec<VocabRow> = Vec::new();
        let mut skipped_existing = Vec::new();
        let mut skipped_previous = Vec::new();
        let mut seen = HashSet::new();
        for row in &report.rows {
            if !wanted.contains(&row.lemma) || !seen.insert(row.lemma.clone()) {
                continue;
            }
            if matches!(row.group, RowGroup::Proper) {
                continue;
            }
            if row.existing_note_id.is_some() || previous.contains_key(&row.lemma) {
                skipped_previous.push(row.lemma.clone());
            } else if in_folder(row) {
                skipped_existing.push(row.lemma.clone());
            } else {
                rows.push(row.clone());
            }
        }
        core_vocab::order_rows(&mut rows, options.order);
        let root = self.vocab_root_name(report.folder.root_deck_id, &report.folder.root_name)?;
        let names = core_vocab::vocab_deck_names(
            Some(&root),
            &report.title,
            &report.range,
            options.per_chapter,
        );
        let occurrences = self.vocab_book_occurrences(uid);
        let book_tag = core_vocab::book_tag(&report.title);
        let range_tag = core_vocab::range_tag(&report.range);
        let note_book = NoteBook {
            uid,
            title: &report.title,
            card2: options.card2,
        };
        let mut decks: Vec<String> = Vec::new();
        let notes: Vec<VocabNoteSpec> = rows
            .iter()
            .map(|row| {
                let deck = names.deck_for(row.chapter);
                if !decks.contains(&deck) {
                    decks.push(deck.clone());
                }
                let mut tags = vec![book_tag.clone()];
                if let Some(n) = row.chapter {
                    tags.push(core_vocab::chapter_tag(n));
                }
                tags.extend(range_tag.clone());
                note_spec(
                    row,
                    &note_book,
                    occurrences
                        .get(&row.lemma)
                        .copied()
                        .unwrap_or(row.occurrences),
                    enricher.enrich(row),
                    deck,
                    tags,
                )
            })
            .collect();
        let main_deck = if options.per_chapter {
            names.book.clone()
        } else {
            names.range.clone().unwrap_or_else(|| names.book.clone())
        };
        let svc = self.anki_handles()?.svc;
        let plan = VocabNotesPlan { notes };
        let lookup = main_deck.clone();
        let (note_ids, deck_id) = svc.call_blocking(move |col| {
            let ids = core_anki::vocab::add_vocab_notes(col, &plan)?;
            let deck = match core_anki::book::deck_by_name(col, &lookup)? {
                Some(id) => id,
                None => core_anki::decks::create(col, &lookup)?,
            };
            Ok((ids, deck))
        })?;
        if !note_ids.is_empty() {
            self.vocab_notes_added();
            // The report shows the new notes ("já no deck do livro") once the rescan ends.
            if let Err(e) = self.vocab_rescan(uid) {
                tracing::warn!(code = %e.code, "rescan after generating the deck failed: {e}");
            }
        }
        Ok(VocabDeckResult {
            deck_id,
            deck_name: main_deck,
            decks,
            created: u32::try_from(note_ids.len()).unwrap_or(u32::MAX),
            note_ids,
            skipped_existing,
            skipped_previous,
        })
    }

    /// "Adicionar ao deck do livro" (spec 12.7): one note in `<pasta>::Livros::<Título>` (no subdeck), the example of
    /// that page when the table has one, the Fonte at that page. A lemma already created from this book returns the
    /// existing note.
    pub fn vocab_add_word(
        &self,
        uid: &str,
        lemma: &str,
        page: u32,
        form: &str,
    ) -> Result<VocabWordAdded, AppError> {
        let lemma = lemma.trim().to_lowercase();
        let form = form.trim();
        if lemma.is_empty()
            || lemma.chars().count() > crate::book_panel::MAX_WORD_CHARS
            || form.chars().count() > crate::book_panel::MAX_WORD_CHARS
        {
            return Err(AppError::new("invalid_input", "Palavra inválida."));
        }
        let book = self.vocab_book(uid)?;
        let settings = self.with_store(|s| s.vocab_settings())?;
        let root_id = settings.root_deck_id.ok_or_else(super::folder_required)?;
        let root = self
            .anki_handles()?
            .svc
            .call_blocking(move |col| normal_deck_name(col, root_id))?
            .ok_or_else(super::folder_required)?;
        let deck_name =
            core_vocab::vocab_deck_names(Some(&root), &book.title, &ResolvedRange::all(1), false)
                .book;
        let svc = self.anki_handles()?.svc;
        // Already created from this book: that note.
        let previous = {
            let uid = uid.to_owned();
            svc.call_blocking(move |col| core_anki::vocab::book_vocab_notes(col, &uid))?
        };
        if let Some((nid, _, did)) = previous.into_iter().find(|(_, l, _)| *l == lemma) {
            let name = svc
                .call_blocking(move |col| normal_deck_name(col, did))?
                .unwrap_or_default();
            return Ok(VocabWordAdded {
                note_id: nid,
                deck_id: did,
                deck_name: name,
            });
        }
        let lex = self.vocab_lexicon()?;
        let row = self.vocab_word_row(&book, &lemma, page, form, &lex)?;
        let (count, outline) = self.vocab_outline_nodes(&book)?;
        let mut tags = vec![core_vocab::book_tag(&book.title)];
        let chapter = core_vocab::chapters(&outline, count)
            .into_iter()
            .find(|c| (c.start_page..=c.end_page).contains(&page));
        if let Some(c) = &chapter {
            tags.push(core_vocab::chapter_tag(c.index));
        }
        let occurrences = self
            .vocab_book_occurrences(uid)
            .get(&lemma)
            .copied()
            .unwrap_or(row.occurrences);
        let enrichment = WordNetEnricher { lex }.enrich(&row);
        let note_book = NoteBook {
            uid,
            title: &book.title,
            card2: false,
        };
        let spec = note_spec(
            &row,
            &note_book,
            occurrences,
            enrichment,
            deck_name.clone(),
            tags,
        );
        let lookup = deck_name.clone();
        let (ids, deck_id) = svc.call_blocking(move |col| {
            let ids =
                core_anki::vocab::add_vocab_notes(col, &VocabNotesPlan { notes: vec![spec] })?;
            let deck = core_anki::book::deck_by_name(col, &lookup)?.unwrap_or(0);
            Ok((ids, deck))
        })?;
        let note_id = ids
            .first()
            .copied()
            .ok_or_else(|| AppError::internal("no note created"))?;
        self.vocab_notes_added();
        Ok(VocabWordAdded {
            note_id,
            deck_id,
            deck_name,
        })
    }

    /// A report-like row for one word of the reading popover: the table's page row (example of that page, else the
    /// first one), the family from the latest report or the lexicon.
    fn vocab_word_row(
        &self,
        book: &core_store::Book,
        lemma: &str,
        page: u32,
        form: &str,
        lex: &Lexicon,
    ) -> Result<VocabRow, AppError> {
        let uid = book.book_uid.clone();
        let (page_row, lemma_row) = self.with_store(|s| {
            let page_row = s
                .vocab_table_pages(&uid, &[[page, page]])?
                .into_iter()
                .find(|r| r.lemma == lemma);
            let lemma_row = s
                .vocab_table_lemmas(&uid)?
                .into_iter()
                .find(|r| r.lemma == lemma);
            Ok((page_row, lemma_row))
        })?;
        let report_row = self
            .vocab_report(&book.book_uid)
            .ok()
            .flatten()
            .and_then(|r| r.rows.into_iter().find(|row| row.lemma == lemma));
        let family = match report_row.as_ref().and_then(|r| r.family.clone()) {
            Some(f) => Some(f),
            None => self.vocab_family_of(lemma, lex),
        };
        let span = |v: Option<serde_json::Value>| -> Option<[u32; 2]> {
            let v = v?;
            let inner = v.get("span").cloned().unwrap_or(v);
            serde_json::from_value(inner).ok()
        };
        let (example, example_span, example_page) = match (&page_row, &lemma_row) {
            (Some(p), _) if p.example.is_some() => {
                (p.example.clone(), span(p.example_span.clone()), Some(page))
            }
            (_, Some(l)) if l.example.is_some() => (
                l.example.clone(),
                span(l.example_span.clone()),
                Some(l.first_unit),
            ),
            _ => (None, None, None),
        };
        let pos = lemma_row
            .as_ref()
            .and_then(|l| l.pos.as_deref())
            .and_then(Pos::from_letter)
            .or_else(|| lex.parts_of_speech(lemma).first().copied());
        let form = if form.is_empty() {
            page_row
                .as_ref()
                .map(|p| p.form.clone())
                .unwrap_or_else(|| lemma.to_owned())
        } else {
            form.to_owned()
        };
        Ok(VocabRow {
            lemma: lemma.to_owned(),
            form,
            pos,
            group: RowGroup::Main,
            status: Status::Unknown,
            status_source: None,
            occurrences: lemma_row.as_ref().map_or(1, |l| l.occurrences),
            first_page: page,
            pages: vec![page],
            zipf: lex.zipf(lemma),
            rare: lex.zipf(lemma).is_none_or(|z| z < 2.5),
            example,
            example_span,
            example_page: example_page.or(Some(page)),
            base: None,
            family,
            existing_note_id: None,
            default_selected: true,
            chapter: None,
            position: 0,
        })
    }

    /// The known word a derivative comes from, with the cached known index of the folder.
    fn vocab_family_of(&self, lemma: &str, lex: &Lexicon) -> Option<BaseRef> {
        let known = lock_known(self)?;
        lex.family_bases(lemma).into_iter().find_map(|base| {
            let status = known.lemma_status(&base)?;
            Some(BaseRef {
                lemma: base,
                status: match status {
                    core_vocab::NoteStatus::Mature => Status::Known,
                    core_vocab::NoteStatus::Learning => Status::Learning,
                    core_vocab::NoteStatus::New => Status::New,
                    core_vocab::NoteStatus::Suspended => Status::Suspended,
                },
            })
        })
    }
}

fn lock_known(state: &AppState) -> Option<Arc<core_vocab::KnownIndex>> {
    crate::state::lock(&state.vocab.known)
        .as_ref()
        .map(|(_, k)| Arc::clone(k))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_default_to_reading_order_and_wordnet() {
        let o: VocabDeckOptions = serde_json::from_str("{}").unwrap();
        assert_eq!(o.order, RowOrder::Reading);
        assert_eq!(o.enrich, EnrichMode::Wordnet);
        let o: VocabDeckOptions = serde_json::from_str(
            r#"{"order":"frequency","perChapter":true,"card2":true,"enrich":"ai"}"#,
        )
        .unwrap();
        assert!(o.per_chapter && o.card2);
        assert_eq!(o.order, RowOrder::Frequency);
        assert_eq!(o.enrich, EnrichMode::Ai);
    }
}
