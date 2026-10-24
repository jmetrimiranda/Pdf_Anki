//! The book panel (docs/PROJETO.md 10.1, 10.2, 12.7): the book's decks and their counts, the cards created from the
//! book ("Cards desta página", found through their `Fonte` link) and the vocabulary note of a word ("Definir
//! palavra"). Functions take `&mut Collection` so they run inside an [`crate::AnkiService`] job.

use std::collections::HashMap;

use anki::collection::Collection;
use anki::prelude::{AnkiError, DeckId, DeckKind, NoteId, Notetype, NotetypeId, TimestampSecs};
use anki::search::SearchNode;
use anki_proto::decks::DeckTreeNode;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::service::AnkiService;
use crate::study::QueueCounts;
use crate::study::source::{SOURCE_FIELD, parse_source};

/// Longest [`BookCard::preview`] / [`VocabNote::preview`], in chars.
pub const PREVIEW_CHARS: usize = 120;

/// A note created from the book: its cards, where it points in the book and a one-line preview.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookCard {
    pub note_id: i64,
    pub card_ids: Vec<i64>,
    /// Home deck of the note's first card.
    pub deck_id: i64,
    pub notetype: String,
    /// 1-based, as written in the link: a PDF page or an EPUB chapter (`unit`).
    pub page: u32,
    pub unit: crate::study::SourceUnit,
    /// The EPUB position of the link, when it has a valid one.
    pub cfi: Option<String>,
    pub query: Option<String>,
    /// Sort field as plain text, whitespace collapsed, at most [`PREVIEW_CHARS`] chars (a cut one ends with "…").
    pub preview: String,
}

/// The vocabulary note of a word (spec 12.7 "Definir palavra").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VocabNote {
    pub note_id: i64,
    /// Full name of the deck of the note's first card.
    pub deck_name: String,
    pub notetype: String,
    /// Plain text of the note's "Definição"/"Definition" field, when it has a non-empty one.
    pub definition: Option<String>,
    pub preview: String,
}

/// Id of the normal deck with that full name ("A::B"), compared case-insensitively like Anki. Filtered decks and
/// blank names give `None`.
pub fn deck_by_name(col: &mut Collection, full_name: &str) -> Result<Option<i64>> {
    let parts: Vec<&str> = full_name.split("::").map(str::trim).collect();
    if parts.iter().any(|p| p.is_empty()) {
        return Ok(None);
    }
    let Some(did) = col.get_deck_id(&parts.join("::"))? else {
        return Ok(None);
    };
    Ok(col
        .get_deck(did)?
        .filter(|d| matches!(d.kind, DeckKind::Normal(_)))
        .map(|d| d.id.0))
}

/// Today's counts of a deck including its subdecks, limits applied: the numbers of the deck list. `None` when the
/// deck does not exist (or is the hidden empty Default deck).
pub fn deck_counts(col: &mut Collection, deck_id: i64) -> Result<Option<QueueCounts>> {
    let root = col.deck_tree(Some(TimestampSecs::now()))?;
    Ok(find_node(&root, deck_id).map(|n| QueueCounts {
        new: n.new_count,
        learn: n.learn_count,
        review: n.review_count,
    }))
}

fn find_node(node: &DeckTreeNode, deck_id: i64) -> Option<&DeckTreeNode> {
    if node.deck_id == deck_id && node.level > 0 {
        return Some(node);
    }
    node.children.iter().find_map(|c| find_node(c, deck_id))
}

pub(crate) fn validate_uid(book_uid: &str) -> Result<()> {
    if book_uid.len() == 64
        && book_uid
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(Error::InvalidInput(
            "identificador de livro inválido (esperados 64 caracteres hexadecimais minúsculos)."
                .into(),
        ))
    }
}

/// Notes whose `Fonte` links to `book_uid` (spec 10.1 "Cards desta página"), sorted by (page, note id).
pub fn book_cards(col: &mut Collection, book_uid: &str) -> Result<Vec<BookCard>> {
    validate_uid(book_uid)?;
    // The notes of the Anki search `"Fonte:*leitor://livro/<uid>*"`, found with one substring scan (links are
    // lowercase, see `parse_link`); the Fonte field itself is checked below.
    let needle = format!("leitor://livro/{book_uid}");
    // One scan: every card of the matching notes, grouped by note (ascending note id, then card id).
    let mut notes: Vec<(i64, i64, String)> = Vec::new();
    let mut cards: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    {
        let db = col.storage.db();
        let mut stmt = db
            .prepare_cached(
                "SELECT n.id, n.mid, n.flds, c.id, CASE WHEN c.odid != 0 THEN c.odid ELSE c.did END
                 FROM notes n JOIN cards c ON c.nid = n.id
                 WHERE instr(n.flds, ?1) > 0 ORDER BY n.id, c.id",
            )
            .map_err(AnkiError::from)?;
        let mut rows = stmt.query([&needle]).map_err(AnkiError::from)?;
        while let Some(r) = rows.next().map_err(AnkiError::from)? {
            let nid: i64 = r.get(0).map_err(AnkiError::from)?;
            let cid: i64 = r.get(3).map_err(AnkiError::from)?;
            let did: i64 = r.get(4).map_err(AnkiError::from)?;
            if notes.last().is_none_or(|n| n.0 != nid) {
                let mid: i64 = r.get(1).map_err(AnkiError::from)?;
                let flds: String = r.get(2).map_err(AnkiError::from)?;
                notes.push((nid, mid, flds));
            }
            cards.entry(nid).or_default().push((cid, did));
        }
    }
    if notes.is_empty() {
        return Ok(Vec::new());
    }
    let mut notetypes = NotetypeCache::default();
    let mut out = Vec::with_capacity(notes.len());
    for (nid, mid, flds) in notes {
        let Some(nt) = notetypes.get(col, mid)? else {
            continue;
        };
        let fields: Vec<&str> = flds.split('\x1f').collect();
        let Some(link) = field_index(&nt, SOURCE_FIELD)
            .and_then(|i| fields.get(i))
            .and_then(|html| parse_source(html))
            .filter(|l| l.book_uid == book_uid)
        else {
            continue;
        };
        let Some(note_cards) = cards.get(&nid) else {
            continue;
        };
        let sort_idx = nt.config.sort_field_idx as usize;
        out.push(BookCard {
            note_id: nid,
            card_ids: note_cards.iter().map(|c| c.0).collect(),
            deck_id: note_cards.first().map_or(0, |c| c.1),
            notetype: nt.name.clone(),
            page: link.page,
            unit: link.unit,
            cfi: link.cfi,
            query: link.query,
            preview: preview(fields.get(sort_idx).copied().unwrap_or_default()),
        });
    }
    out.sort_by_key(|c| (c.page, c.note_id));
    Ok(out)
}

/// The first note (by id) under the root deck (subdecks included) whose `Lema` or `Palavra` field (or `Lemma`/`Word`,
/// or the sort field for the user's own types) equals `lemma` or `word` (case-insensitive, HTML stripped). `None` when the root
/// deck does not exist.
pub fn vocab_lookup(
    col: &mut Collection,
    root_deck_id: i64,
    word: &str,
    lemma: &str,
) -> Result<Option<VocabNote>> {
    let wanted: Vec<String> = [word, lemma]
        .iter()
        .map(|w| normalize(w))
        .filter(|w| !w.is_empty())
        .collect();
    if wanted.is_empty() || col.get_deck(DeckId(root_deck_id))?.is_none() {
        return Ok(None);
    }
    let mut nids = col.search_notes_unordered(SearchNode::from_deck_id(root_deck_id, true))?;
    if nids.is_empty() {
        return Ok(None);
    }
    nids.sort();
    let mut notetypes = NotetypeCache::default();
    for (nid, mid, flds) in notes_by_id(col, &nids)? {
        let Some(nt) = notetypes.get(col, mid)? else {
            continue;
        };
        let fields: Vec<&str> = flds.split('\x1f').collect();
        let sort_idx = nt.config.sort_field_idx as usize;
        let mut keys: Vec<usize> = ["Lema", "Palavra", "Lemma", "Word"]
            .iter()
            .filter_map(|name| field_index(&nt, name))
            .collect();
        keys.push(sort_idx);
        let hit = keys
            .iter()
            .filter_map(|&i| fields.get(i))
            .any(|f| wanted.contains(&normalize(f)));
        if !hit {
            continue;
        }
        let definition = ["Definição", "Definition"]
            .iter()
            .filter_map(|name| field_index(&nt, name))
            .filter_map(|i| fields.get(i))
            .map(|f| plain(f))
            .find(|d| !d.is_empty());
        let deck_name = match cards_by_note(col, &[NoteId(nid)])?
            .get(&nid)
            .and_then(|c| c.first())
        {
            Some(&(_, did)) => col
                .get_deck(DeckId(did))?
                .map(|d| d.human_name())
                .unwrap_or_default(),
            None => String::new(),
        };
        return Ok(Some(VocabNote {
            note_id: nid,
            deck_name,
            notetype: nt.name.clone(),
            definition,
            preview: preview(fields.get(sort_idx).copied().unwrap_or_default()),
        }));
    }
    Ok(None)
}

#[derive(Default)]
struct NotetypeCache(HashMap<i64, Option<std::sync::Arc<Notetype>>>);

impl NotetypeCache {
    fn get(&mut self, col: &mut Collection, mid: i64) -> Result<Option<std::sync::Arc<Notetype>>> {
        if let Some(nt) = self.0.get(&mid) {
            return Ok(nt.clone());
        }
        let nt = col.get_notetype(NotetypeId(mid))?;
        self.0.insert(mid, nt.clone());
        Ok(nt)
    }
}

fn field_index(nt: &Notetype, name: &str) -> Option<usize> {
    let name = name.to_lowercase();
    nt.fields.iter().position(|f| f.name.to_lowercase() == name)
}

/// Plain text of a field: HTML removed, entities decoded, whitespace collapsed.
fn plain(html: &str) -> String {
    anki::text::html_to_text_line(html, false)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize(text: &str) -> String {
    plain(text).to_lowercase()
}

fn preview(html: &str) -> String {
    let text = plain(html);
    if text.chars().count() <= PREVIEW_CHARS {
        return text;
    }
    match text.char_indices().nth(PREVIEW_CHARS - 1) {
        Some((cut, _)) => {
            let mut short = text[..cut].trim_end().to_string();
            short.push('…');
            short
        }
        None => text,
    }
}

fn id_list<T: Copy>(ids: &[T], id: impl Fn(T) -> i64) -> String {
    ids.iter()
        .map(|&i| id(i).to_string())
        .collect::<Vec<_>>()
        .join(",")
}

/// `(note id, notetype id, fields)` of the notes, in ascending id order.
fn notes_by_id(col: &mut Collection, nids: &[NoteId]) -> Result<Vec<(i64, i64, String)>> {
    let sql = format!(
        "SELECT id, mid, flds FROM notes WHERE id IN ({}) ORDER BY id",
        id_list(nids, |n| n.0)
    );
    let db = col.storage.db();
    let mut stmt = db.prepare(&sql).map_err(AnkiError::from)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(AnkiError::from)?;
    let mut out = Vec::with_capacity(nids.len());
    for row in rows {
        out.push(row.map_err(AnkiError::from)?);
    }
    Ok(out)
}

/// Note id → `(card id, home deck id)` of its cards, ascending by card id.
fn cards_by_note(col: &mut Collection, nids: &[NoteId]) -> Result<HashMap<i64, Vec<(i64, i64)>>> {
    let sql = format!(
        "SELECT id, nid, CASE WHEN odid != 0 THEN odid ELSE did END FROM cards \
         WHERE nid IN ({}) ORDER BY id",
        id_list(nids, |n| n.0)
    );
    let db = col.storage.db();
    let mut stmt = db.prepare(&sql).map_err(AnkiError::from)?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(AnkiError::from)?;
    let mut out: HashMap<i64, Vec<(i64, i64)>> = HashMap::with_capacity(nids.len());
    for row in rows {
        let (cid, nid, did) = row.map_err(AnkiError::from)?;
        out.entry(nid).or_default().push((cid, did));
    }
    Ok(out)
}

impl AnkiService {
    /// [`deck_by_name`] on the actor.
    pub async fn book_deck_by_name(&self, full_name: String) -> Result<Option<i64>> {
        self.call(move |col| deck_by_name(col, &full_name)).await
    }

    /// [`deck_counts`] on the actor.
    pub async fn book_deck_counts(&self, deck_id: i64) -> Result<Option<QueueCounts>> {
        self.call(move |col| deck_counts(col, deck_id)).await
    }

    /// [`book_cards`] on the actor.
    pub async fn book_cards(&self, book_uid: String) -> Result<Vec<BookCard>> {
        self.call(move |col| book_cards(col, &book_uid)).await
    }

    /// [`vocab_lookup`] on the actor.
    pub async fn vocab_lookup(
        &self,
        root_deck_id: i64,
        word: String,
        lemma: String,
    ) -> Result<Option<VocabNote>> {
        self.call(move |col| vocab_lookup(col, root_deck_id, &word, &lemma))
            .await
    }
}
