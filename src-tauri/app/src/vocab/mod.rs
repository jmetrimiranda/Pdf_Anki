//! Vocabulary scanning in the app (spec 12, 15 "Vocabulário"): the wizard's data (folder, field mapping, the
//! "Trecho" outline and range check), the scan job ([`scan`]), the report, the deck generation ([`deck`]), the
//! reading-time marks and popover actions ([`marks`]) and the data pack ([`data`]).
//!
//! Everything is a plain [`AppState`] method that blocks (the commands run them on the blocking pool, the scan on
//! its own thread); the collection is reached only through `AnkiService::call_blocking`.

pub mod data;
pub mod deck;
pub mod marks;
pub mod scan;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use core_anki::vocab::{VocabFolderDeck, VocabFolderInfo, VocabFolderRoot};
use core_store::{Book, BookFormat, VocabMappingRow, VocabOverrideStatus};
use core_vocab::{
    DerivedPolicy, KnownIndex, OutlineNode, OutlineRangeItem, RangeSpec, ResolvedRange, ScanConfig,
    SuspendedPolicy,
};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::jobs::JobRegistry;
use crate::state::{AppState, lock};

pub use data::{VocabData, VocabDataInfo, VocabDataSource};

/// Example words shown per notetype in the "Campos" step.
pub const SAMPLE_WORDS: usize = 5;
/// Most pages per `vocab_marks` call.
pub const MAX_MARK_PAGES: usize = 20;
/// Most sections per `vocab_epub_marks` call.
pub const MAX_EPUB_MARK_SECTIONS: usize = 5;

/// `vocab_settings_get`/`vocab_settings_set`: the wizard's defaults (the last scan's choices).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabSettings {
    pub root_deck_id: Option<i64>,
    /// Full name of the root deck; `None` when unset or deleted.
    pub root_name: Option<String>,
    pub excluded_deck_ids: Vec<i64>,
    pub config: ScanConfig,
}

/// Partial update of [`VocabSettings`]: a missing field is left alone; `rootDeckId: null` clears it.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VocabSettingsPatch {
    #[serde(deserialize_with = "double_option")]
    pub root_deck_id: Option<Option<i64>>,
    pub excluded_deck_ids: Option<Vec<i64>>,
    pub config: Option<ScanConfig>,
}

fn double_option<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// A notetype of the folder with its mapping (the "Campos" step).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabFolderNotetype {
    pub notetype_id: i64,
    pub name: String,
    pub fields: Vec<String>,
    pub note_count: u32,
    /// The saved mapping (`notetype_mapping`, role `vocab`), when it names a field of the type.
    pub mapped_field: Option<String>,
    /// The automatic suggestion by field name (spec 12.1 step 3).
    pub suggested_field: String,
    /// Up to [`SAMPLE_WORDS`] cleaned words of the mapped (else suggested) field.
    pub samples: Vec<String>,
}

/// `vocab_folder`: the folder's decks (root first, tree order) and notetypes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabFolder {
    pub root: VocabFolderRoot,
    pub decks: Vec<VocabFolderDeck>,
    pub notetypes: Vec<VocabFolderNotetype>,
}

/// `vocab_outline`: the "Trecho" tree of the current version of the book.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabOutline {
    pub page_count: u32,
    pub items: Vec<OutlineRangeItem>,
}

/// Manual status of `vocab_override_set` (`null` removes it).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OverrideArg {
    Known,
    Ignored,
    Proper,
}

impl From<OverrideArg> for VocabOverrideStatus {
    fn from(a: OverrideArg) -> Self {
        match a {
            OverrideArg::Known => Self::Known,
            OverrideArg::Ignored => Self::Ignored,
            OverrideArg::Proper => Self::Proper,
        }
    }
}

/// Cache key of a known-vocabulary index: what it was read from.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct KnownKey {
    pub deck_ids: Vec<i64>,
    pub mapping: Vec<(i64, usize)>,
    pub known_ivl_days: u32,
    pub config: String,
    /// `col.mod`: any change of the collection bumps it.
    pub col_mod: i64,
}

/// The vocabulary side of [`AppState`].
#[derive(Default)]
pub struct VocabHub {
    pub(crate) data: VocabData,
    pub(crate) jobs: JobRegistry,
    /// Whole-book text extractions done by this run (tests assert that a range rescan reads no PDF).
    pub(crate) text_extractions: AtomicU64,
    /// `file_hash` → text fingerprint of that file (hashing the content streams costs a read of the file).
    pub(crate) fingerprints: Mutex<HashMap<String, String>>,
    /// The last known-vocabulary index.
    pub(crate) known: Mutex<Option<(KnownKey, Arc<KnownIndex>)>>,
    /// Bumped by every override change (the marks cache keys on it).
    pub(crate) overrides_generation: AtomicU64,
    /// Marks oracles per book (see [`marks`]).
    pub(crate) oracles: Mutex<Vec<marks::CachedOracle>>,
    /// The last parsed report (reports are immutable once done).
    pub(crate) report: Mutex<Option<Arc<scan::VocabReport>>>,
}

impl VocabHub {
    pub(crate) fn invalidate_marks(&self) {
        self.overrides_generation.fetch_add(1, Ordering::Relaxed);
        lock(&self.oracles).clear();
    }
}

pub(crate) fn not_scanned() -> AppError {
    AppError::new(
        "vocab_not_scanned",
        "Escaneie o vocabulário deste livro primeiro.",
    )
}

pub(crate) fn folder_required() -> AppError {
    AppError::new(
        "vocab_folder_required",
        "Escolha a pasta de vocabulário antes de escanear.",
    )
}

pub(crate) fn invalid_range(e: &core_vocab::RangeError) -> AppError {
    AppError::new("vocab_invalid_range", e.to_string())
}

pub(crate) fn vocab_error(e: core_vocab::VocabError) -> AppError {
    match e {
        core_vocab::VocabError::Unavailable => data::missing(),
        core_vocab::VocabError::Range(r) => invalid_range(&r),
        core_vocab::VocabError::Cancelled => AppError::new("cancelled", e.to_string()),
        other => AppError::new("vocab_data_invalid", other.to_string()),
    }
}

/// The scan options as the store keeps them.
pub(crate) fn config_from_store(s: &core_store::VocabSettings) -> ScanConfig {
    ScanConfig {
        known_ivl_days: s.known_ivl_days,
        count_young: s.count_young,
        suspended_policy: match s.suspended_policy {
            core_store::VocabSuspendedPolicy::Ignore => SuspendedPolicy::Ignore,
            core_store::VocabSuspendedPolicy::Known => SuspendedPolicy::Known,
        },
        function_words_known: s.function_words_known,
        derived_policy: match s.derived_policy {
            core_store::VocabDerivedPolicy::Card => DerivedPolicy::Card,
            core_store::VocabDerivedPolicy::Known => DerivedPolicy::Known,
        },
    }
}

fn apply_config(s: &mut core_store::VocabSettings, c: &ScanConfig) {
    s.known_ivl_days = c.known_ivl_days.max(1);
    s.count_young = c.count_young;
    s.suspended_policy = match c.suspended_policy {
        SuspendedPolicy::Ignore => core_store::VocabSuspendedPolicy::Ignore,
        SuspendedPolicy::Known => core_store::VocabSuspendedPolicy::Known,
    };
    s.function_words_known = c.function_words_known;
    s.derived_policy = match c.derived_policy {
        DerivedPolicy::Card => core_store::VocabDerivedPolicy::Card,
        DerivedPolicy::Known => core_store::VocabDerivedPolicy::Known,
    };
}

/// Name of an existing normal deck, `None` when missing.
pub(crate) fn normal_deck_name(
    col: &mut core_anki::Collection,
    deck_id: i64,
) -> core_anki::Result<Option<String>> {
    use core_anki::anki::prelude::{DeckId, DeckKind};
    Ok(col
        .get_deck(DeckId(deck_id))?
        .filter(|d| matches!(d.kind, DeckKind::Normal(_)))
        .map(|d| d.human_name()))
}

/// The notetype → field index map of a scan: the saved mapping when it names a field of the type, else the
/// suggestion by field name (so a type the wizard never showed still counts).
pub(crate) fn field_mapping(
    info: &VocabFolderInfo,
    saved: &[VocabMappingRow],
) -> HashMap<i64, usize> {
    info.notetypes
        .iter()
        .map(|nt| {
            let saved_index = saved
                .iter()
                .find(|m| m.notetype_id == nt.notetype_id)
                .and_then(|m| nt.fields.iter().position(|f| *f == m.field));
            let index = saved_index.unwrap_or_else(|| core_vocab::suggest_field(&nt.fields));
            (nt.notetype_id, index)
        })
        .collect()
}

/// The folder's deck ids minus the excluded ones (the root always stays).
pub(crate) fn included_decks(info: &VocabFolderInfo, excluded: &[i64]) -> Vec<i64> {
    let excluded: HashSet<i64> = excluded.iter().copied().collect();
    info.decks
        .iter()
        .map(|d| d.deck_id)
        .filter(|id| *id == info.root.deck_id || !excluded.contains(id))
        .collect()
}

/// Cleaned, distinct words of raw field values, at most `n`.
pub(crate) fn sample_words(values: &[String], n: usize) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for v in values {
        for w in core_vocab::clean_field(v) {
            if !out.contains(&w) {
                out.push(w);
                if out.len() >= n {
                    return out;
                }
            }
        }
    }
    out
}

/// What the units of a book are called in range labels and errors: pages (PDF) or chapters (EPUB sections).
pub(crate) fn unit_word(book: &Book) -> core_vocab::UnitWord {
    match book.format {
        BookFormat::Pdf => core_vocab::UnitWord::Page,
        BookFormat::Epub => core_vocab::UnitWord::Chapter,
    }
}

pub(crate) fn outline_nodes(items: &[core_pdf::OutlineItem]) -> Vec<OutlineNode> {
    items
        .iter()
        .map(|i| OutlineNode {
            title: i.title.clone(),
            page: i.page.and_then(|p| u32::try_from(p).ok()),
            children: outline_nodes(&i.children),
        })
        .collect()
}

impl AppState {
    /// The vocabulary hub (data pack, jobs, caches).
    pub fn vocab_hub(&self) -> &VocabHub {
        &self.vocab
    }

    /// Whole-book text extractions done by this run (tests: a range rescan must not read the PDF).
    pub fn vocab_text_extractions(&self) -> u64 {
        self.vocab.text_extractions.load(Ordering::Relaxed)
    }

    /// The running scan of a book, if any.
    pub fn vocab_running_job(&self, uid: &str) -> Option<crate::jobs::JobProgress> {
        self.vocab
            .jobs
            .running_for(crate::jobs::JobKind::VocabScan, uid)
    }

    /// Uses `lexicon` instead of the data pack (tests without `data/generated/vocab`).
    pub fn set_vocab_lexicon(&self, lexicon: Arc<core_vocab::Lexicon>) {
        self.vocab.data.set_lexicon(lexicon);
    }

    /// The app's resource dir, where the bundled `vocab/` lives (set once at startup).
    pub fn set_vocab_resource_dir(&self, dir: std::path::PathBuf) {
        self.vocab.data.set_resource_dir(dir);
    }

    pub fn vocab_lexicon(&self) -> Result<Arc<core_vocab::Lexicon>, AppError> {
        self.vocab.data.lexicon()
    }

    pub fn vocab_data_info(&self) -> VocabDataInfo {
        self.vocab.data.info()
    }

    pub(crate) fn vocab_book(&self, uid: &str) -> Result<Book, AppError> {
        self.with_store(|s| {
            s.get_book(uid)?
                .ok_or_else(|| core_store::StoreError::BookNotFound(uid.to_owned()))
        })
    }

    pub fn vocab_settings_get(&self) -> Result<VocabSettings, AppError> {
        let stored = self.with_store(|s| s.vocab_settings())?;
        let root_name = match stored.root_deck_id {
            Some(id) => self
                .anki_handles()?
                .svc
                .call_blocking(move |col| normal_deck_name(col, id))?,
            None => None,
        };
        Ok(VocabSettings {
            root_deck_id: stored.root_deck_id.filter(|_| root_name.is_some()),
            root_name,
            excluded_deck_ids: stored.excluded_deck_ids.clone(),
            config: config_from_store(&stored),
        })
    }

    pub fn vocab_settings_set(&self, patch: VocabSettingsPatch) -> Result<VocabSettings, AppError> {
        if let Some(Some(id)) = patch.root_deck_id {
            let exists = self
                .anki_handles()?
                .svc
                .call_blocking(move |col| normal_deck_name(col, id))?
                .is_some();
            if !exists {
                return Err(AppError::new(
                    "deck_not_found",
                    "O deck escolhido não existe mais.",
                ));
            }
        }
        self.with_store(|s| {
            let mut v = s.vocab_settings()?;
            if let Some(root) = patch.root_deck_id {
                v.root_deck_id = root;
            }
            if let Some(excluded) = &patch.excluded_deck_ids {
                v.excluded_deck_ids = excluded.clone();
            }
            if let Some(config) = &patch.config {
                apply_config(&mut v, config);
            }
            s.set_vocab_settings(&v)
        })?;
        self.vocab_settings_get()
    }

    /// The folder rooted at `root_deck_id` (step 1 and step 3 of the wizard).
    pub fn vocab_folder(&self, root_deck_id: i64) -> Result<VocabFolder, AppError> {
        let saved = self.with_store(|s| s.vocab_mappings())?;
        let folder = self.anki_handles()?.svc.call_blocking(move |col| {
            let info = core_anki::vocab::folder(col, root_deck_id)?;
            let deck_ids: Vec<i64> = info.decks.iter().map(|d| d.deck_id).collect();
            let mut notetypes = Vec::with_capacity(info.notetypes.len());
            for nt in &info.notetypes {
                let mapped_field = saved
                    .iter()
                    .find(|m| m.notetype_id == nt.notetype_id)
                    .map(|m| m.field.clone())
                    .filter(|f| nt.fields.contains(f));
                let suggested = core_vocab::suggest_field(&nt.fields);
                let index = mapped_field
                    .as_ref()
                    .and_then(|f| nt.fields.iter().position(|x| x == f))
                    .unwrap_or(suggested);
                let raw = core_anki::vocab::field_samples(
                    col,
                    &deck_ids,
                    nt.notetype_id,
                    index,
                    SAMPLE_WORDS * 4,
                )?;
                notetypes.push(VocabFolderNotetype {
                    notetype_id: nt.notetype_id,
                    name: nt.name.clone(),
                    fields: nt.fields.clone(),
                    note_count: nt.note_count,
                    mapped_field,
                    suggested_field: nt.fields.get(suggested).cloned().unwrap_or_default(),
                    samples: sample_words(&raw, SAMPLE_WORDS),
                });
            }
            Ok(VocabFolder {
                root: info.root,
                decks: info.decks,
                notetypes,
            })
        })?;
        Ok(folder)
    }

    /// Five cleaned words of `field` of a notetype in the folder (live preview while choosing the field).
    pub fn vocab_mapping_samples(
        &self,
        root_deck_id: i64,
        excluded_deck_ids: Vec<i64>,
        notetype_id: i64,
        field: String,
    ) -> Result<Vec<String>, AppError> {
        let raw = self.anki_handles()?.svc.call_blocking(move |col| {
            let info = core_anki::vocab::folder(col, root_deck_id)?;
            let deck_ids = included_decks(&info, &excluded_deck_ids);
            let fields = notetype_fields(col, notetype_id)?;
            let Some(index) = fields.iter().position(|f| *f == field) else {
                return Ok(None);
            };
            core_anki::vocab::field_samples(col, &deck_ids, notetype_id, index, SAMPLE_WORDS * 4)
                .map(Some)
        })?;
        match raw {
            Some(raw) => Ok(sample_words(&raw, SAMPLE_WORDS)),
            None => Err(unknown_field()),
        }
    }

    pub fn vocab_mapping_get(&self) -> Result<Vec<VocabMappingRow>, AppError> {
        self.with_store(|s| s.vocab_mappings())
    }

    /// Saves the field with the English word of a notetype; refused for a type with a code role.
    pub fn vocab_mapping_set(&self, notetype_id: i64, field: String) -> Result<(), AppError> {
        let name = field.clone();
        let fields = self
            .anki_handles()?
            .svc
            .call_blocking(move |col| notetype_fields(col, notetype_id))?;
        if fields.is_empty() {
            return Err(AppError::new(
                "notetype_not_found",
                "O tipo de nota não existe mais.",
            ));
        }
        if !fields.contains(&name) {
            return Err(unknown_field());
        }
        self.with_store(|s| s.set_vocab_mapping(notetype_id, &field))?;
        self.vocab.invalidate_marks();
        Ok(())
    }

    /// The outline of the current version (with the bookmarks the user created in PdfCraft) and the page count; for
    /// an EPUB, its table of contents (`page` = 0-based section) and the section count.
    pub(crate) fn vocab_outline_nodes(
        &self,
        book: &Book,
    ) -> Result<(u32, Vec<OutlineNode>), AppError> {
        if book.format == BookFormat::Epub {
            return self.epub_outline_nodes(book);
        }
        let doc = self.book_doc(book)?;
        let info = self.pdf().info(doc)?;
        let outline = self.pdf().outline(doc)?;
        let count = u32::try_from(info.page_count).unwrap_or(u32::MAX);
        Ok((count, outline_nodes(&outline)))
    }

    pub fn vocab_outline(&self, uid: &str) -> Result<VocabOutline, AppError> {
        let book = self.vocab_book(uid)?;
        let (page_count, nodes) = self.vocab_outline_nodes(&book)?;
        Ok(VocabOutline {
            page_count,
            items: core_vocab::outline_ranges(&nodes, page_count),
        })
    }

    pub(crate) fn vocab_resolve(
        &self,
        book: &Book,
        range: &RangeSpec,
    ) -> Result<(ResolvedRange, Vec<OutlineNode>, u32), AppError> {
        let (page_count, nodes) = self.vocab_outline_nodes(book)?;
        let resolved = core_vocab::resolve_range_in(range, &nodes, page_count, unit_word(book))
            .map_err(|e| invalid_range(&e))?;
        Ok((resolved, nodes, page_count))
    }

    pub fn vocab_range_check(
        &self,
        uid: &str,
        range: &RangeSpec,
    ) -> Result<ResolvedRange, AppError> {
        let book = self.vocab_book(uid)?;
        Ok(self.vocab_resolve(&book, range)?.0)
    }

    /// "Já sei" / "Ignorar" / "Nome próprio" (or `None`: back to automatic), for every book.
    pub fn vocab_override_set(
        &self,
        lemmas: Vec<String>,
        status: Option<OverrideArg>,
    ) -> Result<(), AppError> {
        if lemmas.len() > 10_000 {
            return Err(AppError::new(
                "invalid_input",
                "Palavras demais de uma vez.",
            ));
        }
        self.with_store(|s| s.set_vocab_overrides(&lemmas, status.map(Into::into)))?;
        self.vocab.invalidate_marks();
        Ok(())
    }
}

fn unknown_field() -> AppError {
    AppError::new("invalid_input", "Esse campo não existe no tipo de nota.")
}

/// Field names of a notetype (empty when it doesn't exist).
pub(crate) fn notetype_fields(
    col: &mut core_anki::Collection,
    notetype_id: i64,
) -> core_anki::Result<Vec<String>> {
    use core_anki::anki::prelude::NotetypeId;
    Ok(col
        .get_notetype(NotetypeId(notetype_id))?
        .map(|nt| nt.fields.iter().map(|f| f.name.clone()).collect())
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_patch_tells_missing_from_null() {
        let p: VocabSettingsPatch = serde_json::from_str(r#"{"rootDeckId":null}"#).unwrap();
        assert_eq!(p.root_deck_id, Some(None));
        assert!(p.config.is_none());
        let p: VocabSettingsPatch =
            serde_json::from_str(r#"{"excludedDeckIds":[3],"config":{"countYoung":true}}"#)
                .unwrap();
        assert_eq!(p.root_deck_id, None);
        assert_eq!(p.excluded_deck_ids, Some(vec![3]));
        assert!(p.config.unwrap().count_young);
    }

    #[test]
    fn samples_are_cleaned_and_distinct() {
        let raw = vec![
            "<b>learn</b> [sound:a.mp3]".to_string(),
            "happy / glad".to_string(),
            "learn".to_string(),
        ];
        assert_eq!(sample_words(&raw, 5), vec!["learn", "happy", "glad"]);
        assert_eq!(sample_words(&raw, 2), vec!["learn", "happy"]);
    }
}
