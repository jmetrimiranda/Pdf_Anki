//! Vocabulary scanning on the collection side (docs/PROJETO.md 12.1, 12.3 A, 12.6): the vocabulary folder (a root
//! deck and its subdecks) with its notetypes and sample field values, the known vocabulary (the mapped field of
//! each note and its best card status), the "Vocabulário · Livro" notes already created from a book, and the batch
//! creation of new vocabulary notes in reading order.
//!
//! Functions take `&mut Collection` so they run inside an [`crate::AnkiService`] job. Reads are plain SQL over
//! `cards`/`notes` (like [`crate::book::book_cards`]); nothing here knows the algorithm (`core-vocab`), the app maps
//! [`NoteStatusRaw`] to its own status.

use std::collections::{BTreeMap, HashMap, HashSet};

use anki::collection::Collection;
use anki::notes::AddNoteRequest;
use anki::prelude::{AnkiError, CardId, DeckId, DeckKind, NotetypeId};
use anki::scheduler::new::NewCardDueOrder;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::notetypes::VOCAB_BOOK;
use crate::service::AnkiService;
use crate::study::source::{SOURCE_FIELD, parse_source};

/// A deck of the vocabulary folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabFolderDeck {
    pub deck_id: i64,
    /// Full name ("Vocabulário::Oxford").
    pub name: String,
    /// 0 = the root.
    pub depth: u32,
    /// Cards whose home deck is this deck (subdecks not included).
    pub card_count: u32,
    /// Notes with at least one card in this deck (subdecks not included).
    pub note_count: u32,
}

/// The root of the vocabulary folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabFolderRoot {
    pub deck_id: i64,
    pub name: String,
}

/// A notetype used by notes of the folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabFolderNotetype {
    pub notetype_id: i64,
    pub name: String,
    pub fields: Vec<String>,
    /// Notes of this type with a card in the folder.
    pub note_count: u32,
}

/// The vocabulary folder: the root deck, every descendant (deck-tree order) and the notetypes of its notes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabFolderInfo {
    pub root: VocabFolderRoot,
    pub decks: Vec<VocabFolderDeck>,
    /// Ordered by name (case-insensitive), then id.
    pub notetypes: Vec<VocabFolderNotetype>,
}

/// Best status of a note's cards (mirrors `core_vocab::NoteStatus`; the app maps it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoteStatusRaw {
    /// A review card with interval ≥ the "known" threshold.
    Mature,
    /// Studied (learning, relearning or review with a smaller interval).
    Learning,
    /// Never studied.
    New,
    /// Every card is suspended.
    Suspended,
}

/// The ten fields of "Vocabulário · Livro", by name. `fonte` is already HTML (the app builds the `leitor://` link).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabBookFields {
    pub palavra: String,
    pub lema: String,
    pub classe: String,
    pub definicao: String,
    pub traducao: String,
    pub exemplo: String,
    pub fonte: String,
    pub frequencia: String,
    /// "learn" for a derivative of a known word ("Da família de: learn" on the back).
    pub familia: String,
    /// Non-empty enables the optional Português → Inglês card.
    pub card2: String,
}

impl VocabBookFields {
    /// `(field name, value)` in the notetype's field order.
    pub fn named(&self) -> [(&'static str, &str); 10] {
        [
            ("Palavra", &self.palavra),
            ("Lema", &self.lema),
            ("Classe", &self.classe),
            ("Definição", &self.definicao),
            ("Tradução", &self.traducao),
            ("Exemplo", &self.exemplo),
            (SOURCE_FIELD, &self.fonte),
            ("Frequência", &self.frequencia),
            ("Família", &self.familia),
            ("Card 2", &self.card2),
        ]
    }
}

/// One note to create.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabNoteSpec {
    /// Full deck name ("Vocabulário::Livros::Animal Farm::Cap 3"); created when missing.
    pub deck_name: String,
    pub fields: VocabBookFields,
    pub tags: Vec<String>,
}

/// Notes to create, in study order (reading or frequency order).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabNotesPlan {
    pub notes: Vec<VocabNoteSpec>,
}

const QUEUE_SUSPENDED: i64 = -1;
const CARD_TYPE_NEW: i64 = 0;
const CARD_TYPE_REVIEW: i64 = 2;

fn sql_err(e: impl Into<AnkiError>) -> Error {
    Error::from(e.into())
}

fn id_list(ids: impl IntoIterator<Item = i64>) -> String {
    ids.into_iter()
        .map(|i| i.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

/// Splits Anki's `\x1f`-separated fields.
fn split_fields(flds: &str) -> Vec<&str> {
    flds.split('\x1f').collect()
}

/// Deck-tree order key of a full name: its components, case-insensitively.
fn tree_key(name: &str) -> Vec<String> {
    name.split("::").map(str::to_lowercase).collect()
}

/// The vocabulary folder rooted at `root_deck_id`: the root and every descendant (recursively, deck-tree order)
/// with their card/note counts, and the notetypes of the notes in them (a note counts when any of its cards has
/// its home deck in the folder). `deck_not_found` when the root is missing or a filtered deck.
pub fn folder(col: &mut Collection, root_deck_id: i64) -> Result<VocabFolderInfo> {
    let root = col
        .get_deck(DeckId(root_deck_id))?
        .filter(|d| matches!(d.kind, DeckKind::Normal(_)))
        .ok_or(Error::DeckNotFound(root_deck_id))?;
    let root_name = root.human_name();
    let prefix = format!("{}::", root_name.to_lowercase());
    let mut decks: Vec<(i64, String)> = col
        .get_all_normal_deck_names(false)?
        .into_iter()
        .filter(|(id, name)| id.0 == root_deck_id || name.to_lowercase().starts_with(&prefix))
        .map(|(id, name)| (id.0, name))
        .collect();
    decks.sort_by_cached_key(|(id, name)| (tree_key(name), *id));
    let root_depth = root_name.split("::").count();

    let ids = id_list(decks.iter().map(|d| d.0));
    // Per deck: cards and distinct notes; per notetype: distinct notes.
    let mut cards_per_deck: HashMap<i64, u32> = HashMap::new();
    let mut notes_per_deck: HashMap<i64, u32> = HashMap::new();
    let mut notes_per_type: HashMap<i64, u32> = HashMap::new();
    {
        let db = col.storage.db();
        let sql = format!(
            "SELECT home, count(*), count(DISTINCT nid) FROM
                 (SELECT CASE WHEN odid != 0 THEN odid ELSE did END AS home, nid FROM cards)
             WHERE home IN ({ids}) GROUP BY home"
        );
        let mut stmt = db.prepare(&sql).map_err(sql_err)?;
        let mut rows = stmt.query([]).map_err(sql_err)?;
        while let Some(r) = rows.next().map_err(sql_err)? {
            let did: i64 = r.get(0).map_err(sql_err)?;
            let cards: i64 = r.get(1).map_err(sql_err)?;
            let notes: i64 = r.get(2).map_err(sql_err)?;
            cards_per_deck.insert(did, u32::try_from(cards).unwrap_or(u32::MAX));
            notes_per_deck.insert(did, u32::try_from(notes).unwrap_or(u32::MAX));
        }
        let sql = format!(
            "SELECT n.mid, count(*) FROM notes n WHERE n.id IN
                 (SELECT nid FROM cards WHERE (CASE WHEN odid != 0 THEN odid ELSE did END) IN ({ids}))
             GROUP BY n.mid"
        );
        let mut stmt = db.prepare(&sql).map_err(sql_err)?;
        let mut rows = stmt.query([]).map_err(sql_err)?;
        while let Some(r) = rows.next().map_err(sql_err)? {
            let mid: i64 = r.get(0).map_err(sql_err)?;
            let notes: i64 = r.get(1).map_err(sql_err)?;
            notes_per_type.insert(mid, u32::try_from(notes).unwrap_or(u32::MAX));
        }
    }

    let mut notetypes = Vec::with_capacity(notes_per_type.len());
    for (&mid, &note_count) in &notes_per_type {
        let Some(nt) = col.get_notetype(NotetypeId(mid))? else {
            continue;
        };
        notetypes.push(VocabFolderNotetype {
            notetype_id: mid,
            name: nt.name.clone(),
            fields: nt.fields.iter().map(|f| f.name.clone()).collect(),
            note_count,
        });
    }
    notetypes.sort_by_cached_key(|n| (n.name.to_lowercase(), n.notetype_id));

    Ok(VocabFolderInfo {
        root: VocabFolderRoot {
            deck_id: root_deck_id,
            name: root_name,
        },
        decks: decks
            .into_iter()
            .map(|(deck_id, name)| VocabFolderDeck {
                depth: u32::try_from(name.split("::").count().saturating_sub(root_depth))
                    .unwrap_or(u32::MAX),
                card_count: cards_per_deck.get(&deck_id).copied().unwrap_or(0),
                note_count: notes_per_deck.get(&deck_id).copied().unwrap_or(0),
                deck_id,
                name,
            })
            .collect(),
        notetypes,
    })
}

/// Raw HTML of field `field_index` of up to `n` notes of `notetype_id` with a card in `deck_ids` (home deck),
/// in note id order. Notes without that field are skipped.
pub fn field_samples(
    col: &mut Collection,
    deck_ids: &[i64],
    notetype_id: i64,
    field_index: usize,
    n: usize,
) -> Result<Vec<String>> {
    if deck_ids.is_empty() || n == 0 {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT flds FROM notes WHERE mid = ?1 AND id IN
             (SELECT nid FROM cards WHERE (CASE WHEN odid != 0 THEN odid ELSE did END) IN ({}))
         ORDER BY id",
        id_list(deck_ids.iter().copied())
    );
    let db = col.storage.db();
    let mut stmt = db.prepare(&sql).map_err(sql_err)?;
    let mut rows = stmt.query([notetype_id]).map_err(sql_err)?;
    let mut out = Vec::with_capacity(n.min(64));
    while let Some(r) = rows.next().map_err(sql_err)? {
        let flds: String = r.get(0).map_err(sql_err)?;
        if let Some(value) = split_fields(&flds).get(field_index) {
            out.push((*value).to_string());
            if out.len() >= n {
                break;
            }
        }
    }
    Ok(out)
}

/// The known vocabulary: for each note with a card in `deck_ids` (home deck) whose notetype is in `mapping`
/// (notetype id → field index), the raw HTML of the mapped field and the best status of the note's cards in those
/// decks. Suspended only when every such card is suspended; otherwise, among the other cards, Mature (review, interval
/// ≥ `known_ivl_days`) > Learning (studied) > New. In note id order.
pub fn known_notes(
    col: &mut Collection,
    deck_ids: &[i64],
    mapping: &HashMap<i64, usize>,
    known_ivl_days: u32,
) -> Result<Vec<(i64, String, NoteStatusRaw)>> {
    if deck_ids.is_empty() || mapping.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT n.id, n.mid, n.flds, c.queue, c.type, c.ivl FROM cards c JOIN notes n ON n.id = c.nid
         WHERE (CASE WHEN c.odid != 0 THEN c.odid ELSE c.did END) IN ({}) AND n.mid IN ({})
         ORDER BY n.id",
        id_list(deck_ids.iter().copied()),
        id_list(mapping.keys().copied())
    );
    let db = col.storage.db();
    let mut stmt = db.prepare(&sql).map_err(sql_err)?;
    let mut rows = stmt.query([]).map_err(sql_err)?;
    // (note id, field, best non-suspended rank, any non-suspended card)
    let mut out: Vec<(i64, String, NoteStatusRaw)> = Vec::new();
    let mut current: Option<(i64, Option<String>, Option<NoteStatusRaw>)> = None;
    let flush = |cur: Option<(i64, Option<String>, Option<NoteStatusRaw>)>,
                 out: &mut Vec<(i64, String, NoteStatusRaw)>| {
        if let Some((nid, Some(field), best)) = cur {
            out.push((nid, field, best.unwrap_or(NoteStatusRaw::Suspended)));
        }
    };
    while let Some(r) = rows.next().map_err(sql_err)? {
        let nid: i64 = r.get(0).map_err(sql_err)?;
        if current.as_ref().is_none_or(|c| c.0 != nid) {
            flush(current.take(), &mut out);
            let mid: i64 = r.get(1).map_err(sql_err)?;
            let flds: String = r.get(2).map_err(sql_err)?;
            let field = mapping
                .get(&mid)
                .and_then(|&i| split_fields(&flds).get(i).map(|f| (*f).to_string()));
            current = Some((nid, field, None));
        }
        let queue: i64 = r.get(3).map_err(sql_err)?;
        let ctype: i64 = r.get(4).map_err(sql_err)?;
        let ivl: i64 = r.get(5).map_err(sql_err)?;
        if queue == QUEUE_SUSPENDED {
            continue;
        }
        let status = if ctype == CARD_TYPE_REVIEW && ivl >= i64::from(known_ivl_days) {
            NoteStatusRaw::Mature
        } else if ctype != CARD_TYPE_NEW {
            NoteStatusRaw::Learning
        } else {
            NoteStatusRaw::New
        };
        if let Some(cur) = current.as_mut() {
            cur.2 = Some(match cur.2 {
                Some(best) if rank(best) >= rank(status) => best,
                _ => status,
            });
        }
    }
    flush(current, &mut out);
    Ok(out)
}

fn rank(s: NoteStatusRaw) -> u8 {
    match s {
        NoteStatusRaw::Suspended => 0,
        NoteStatusRaw::New => 1,
        NoteStatusRaw::Learning => 2,
        NoteStatusRaw::Mature => 3,
    }
}

/// "Vocabulário · Livro" notes created from the book (their `Fonte` links to `leitor://livro/<book_uid>`), anywhere
/// in the collection (even moved out of the vocabulary folder): `(note id, lemma, home deck of the first card)`. The
/// lemma is the plain, lowercase text of `Lema` (or of `Palavra` when `Lema` is empty). In note id order; empty when
/// the notetype doesn't exist.
pub fn book_vocab_notes(col: &mut Collection, book_uid: &str) -> Result<Vec<(i64, String, i64)>> {
    crate::book::validate_uid(book_uid)?;
    let Some(nt) = col.get_notetype_by_name(VOCAB_BOOK)? else {
        return Ok(Vec::new());
    };
    let index = |name: &str| nt.fields.iter().position(|f| f.name == name);
    let (Some(source), lemma, word) = (index(SOURCE_FIELD), index("Lema"), index("Palavra")) else {
        return Ok(Vec::new());
    };
    let needle = format!("leitor://livro/{book_uid}");
    let db = col.storage.db();
    let mut stmt = db
        .prepare_cached(
            "SELECT n.id, n.flds, (SELECT CASE WHEN c.odid != 0 THEN c.odid ELSE c.did END FROM cards c
                                   WHERE c.nid = n.id ORDER BY c.id LIMIT 1)
             FROM notes n WHERE n.mid = ?1 AND instr(n.flds, ?2) > 0 ORDER BY n.id",
        )
        .map_err(sql_err)?;
    let mut rows = stmt.query((nt.id.0, &needle)).map_err(sql_err)?;
    let mut out = Vec::new();
    while let Some(r) = rows.next().map_err(sql_err)? {
        let nid: i64 = r.get(0).map_err(sql_err)?;
        let flds: String = r.get(1).map_err(sql_err)?;
        let did: Option<i64> = r.get(2).map_err(sql_err)?;
        let fields = split_fields(&flds);
        let linked = fields
            .get(source)
            .and_then(|html| parse_source(html))
            .is_some_and(|l| l.book_uid == book_uid);
        if !linked {
            continue;
        }
        let plain = |i: Option<usize>| {
            i.and_then(|i| fields.get(i))
                .map(|f| plain_lower(f))
                .unwrap_or_default()
        };
        let mut lemma_text = plain(lemma);
        if lemma_text.is_empty() {
            lemma_text = plain(word);
        }
        out.push((nid, lemma_text, did.unwrap_or(0)));
    }
    Ok(out)
}

fn plain_lower(html: &str) -> String {
    anki::text::html_to_text_line(html, false)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// A tag as Anki stores it: trimmed, inner whitespace replaced by `_`. Empty → `None`.
fn clean_tag(tag: &str) -> Option<String> {
    let t: Vec<&str> = tag.split_whitespace().collect();
    (!t.is_empty()).then(|| t.join("_"))
}

/// Creates the plan's notes with the "Vocabulário · Livro" notetype, in the given order, and returns their ids.
///
/// - Missing decks are created (normal decks; `::` nests; blank components are refused before anything is written).
/// - Fields are matched by name, so a collection that still has the older type without `Família` (local test
///   collections, decision of 2026-10-23) keeps working: that field is just dropped. No user type is ever touched.
/// - The new cards are then repositioned (Anki's "Reposition", order preserved, `shift = false`) right after the
///   highest new-card position of the collection, so the deck studies them in the plan's order (reading order or
///   frequency) whatever the deck's "new card insertion order" is.
///
/// Undo: the notes are added as one undoable step ("Adicionar nota") and the reposition is a second one; decks are
/// created before, outside them (rslib has no public way to merge them into one step).
///
/// `vocab_prepare_needed` when the notetype is missing (the user hasn't run "Preparar coleção").
pub fn add_vocab_notes(col: &mut Collection, plan: &VocabNotesPlan) -> Result<Vec<i64>> {
    if plan.notes.is_empty() {
        return Ok(Vec::new());
    }
    let nt = col
        .get_notetype_by_name(VOCAB_BOOK)?
        .ok_or(Error::VocabPrepareNeeded)?;
    let field_names: Vec<&str> = nt.fields.iter().map(|f| f.name.as_str()).collect();
    if !field_names.contains(&"Palavra") {
        return Err(Error::VocabPrepareNeeded);
    }
    // Validate every deck name first, then create the missing ones.
    let mut deck_ids: BTreeMap<String, i64> = BTreeMap::new();
    for spec in &plan.notes {
        crate::decks::validate_name(&spec.deck_name)?;
    }
    for spec in &plan.notes {
        if !deck_ids.contains_key(&spec.deck_name) {
            let did = crate::decks::create(col, &spec.deck_name)?;
            deck_ids.insert(spec.deck_name.clone(), did);
        }
    }

    let mut requests = Vec::with_capacity(plan.notes.len());
    for spec in &plan.notes {
        let mut note = nt.new_note();
        for (name, value) in spec.fields.named() {
            if let Some(i) = field_names.iter().position(|f| *f == name) {
                note.set_field(i, value)?;
            }
        }
        note.tags = spec.tags.iter().filter_map(|t| clean_tag(t)).collect();
        let did = deck_ids
            .get(&spec.deck_name)
            .copied()
            .ok_or_else(|| Error::NotFound(format!("baralho {}", spec.deck_name)))?;
        requests.push(AddNoteRequest {
            note,
            deck_id: DeckId(did),
        });
    }
    // Highest new-card position before the new notes.
    let start = {
        let db = col.storage.db();
        let max: Option<i64> = db
            .query_row(
                "SELECT max(CASE WHEN odid != 0 THEN odue ELSE due END) FROM cards WHERE type = 0",
                [],
                |r| r.get(0),
            )
            .map_err(sql_err)?;
        u32::try_from(max.unwrap_or(0).max(0))
            .unwrap_or(u32::MAX - 1)
            .saturating_add(1)
    };
    col.add_notes(&mut requests)?;
    let nids: Vec<i64> = requests.iter().map(|r| r.note.id.0).collect();

    // Card ids in plan order (note by note, template order).
    let mut by_note: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    {
        let db = col.storage.db();
        let sql = format!(
            "SELECT nid, ord, id FROM cards WHERE nid IN ({})",
            id_list(nids.iter().copied())
        );
        let mut stmt = db.prepare(&sql).map_err(sql_err)?;
        let mut rows = stmt.query([]).map_err(sql_err)?;
        while let Some(r) = rows.next().map_err(sql_err)? {
            let nid: i64 = r.get(0).map_err(sql_err)?;
            let ord: i64 = r.get(1).map_err(sql_err)?;
            let cid: i64 = r.get(2).map_err(sql_err)?;
            by_note.entry(nid).or_default().push((ord, cid));
        }
    }
    let mut seen = HashSet::new();
    let mut cids: Vec<CardId> = Vec::new();
    for nid in &nids {
        if !seen.insert(*nid) {
            continue;
        }
        if let Some(cards) = by_note.get_mut(nid) {
            cards.sort_unstable();
            cids.extend(cards.iter().map(|&(_, cid)| CardId(cid)));
        }
    }
    if !cids.is_empty() {
        col.sort_cards(&cids, start, 1, NewCardDueOrder::Preserve, false)?;
    }
    Ok(nids)
}

impl AnkiService {
    /// [`folder`] on the actor.
    pub async fn vocab_folder(&self, root_deck_id: i64) -> Result<VocabFolderInfo> {
        self.call(move |col| folder(col, root_deck_id)).await
    }

    /// [`field_samples`] on the actor.
    pub async fn vocab_field_samples(
        &self,
        deck_ids: Vec<i64>,
        notetype_id: i64,
        field_index: usize,
        n: usize,
    ) -> Result<Vec<String>> {
        self.call(move |col| field_samples(col, &deck_ids, notetype_id, field_index, n))
            .await
    }

    /// [`known_notes`] on the actor.
    pub async fn vocab_known_notes(
        &self,
        deck_ids: Vec<i64>,
        mapping: HashMap<i64, usize>,
        known_ivl_days: u32,
    ) -> Result<Vec<(i64, String, NoteStatusRaw)>> {
        self.call(move |col| known_notes(col, &deck_ids, &mapping, known_ivl_days))
            .await
    }

    /// [`book_vocab_notes`] on the actor.
    pub async fn vocab_book_notes(&self, book_uid: String) -> Result<Vec<(i64, String, i64)>> {
        self.call(move |col| book_vocab_notes(col, &book_uid)).await
    }

    /// [`add_vocab_notes`] on the actor.
    pub async fn vocab_add_notes(&self, plan: VocabNotesPlan) -> Result<Vec<i64>> {
        self.call(move |col| add_vocab_notes(col, &plan)).await
    }
}
