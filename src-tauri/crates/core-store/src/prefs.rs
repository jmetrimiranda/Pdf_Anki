//! Per-book preferences of this device (docs/PROJETO.md 10.1, 10.2): the deck and card type last used for a card
//! created from the book and the deck chosen for "Revisar aqui". Device-local: the `book_prefs` table never syncs.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::library::{check_uid, double_option};
use crate::{Result, Store, StoreError, now_ms};

/// Card types of the "Card da seleção" form (spec 10.2), as stored in `last_card_kind`.
pub const CARD_KINDS: [&str; 5] = ["basic", "cloze", "codeCommand", "codeProgram", "vocab"];

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookPrefs {
    pub last_card_deck_id: Option<i64>,
    /// One of [`CARD_KINDS`].
    pub last_card_kind: Option<String>,
    pub review_deck_id: Option<i64>,
}

/// Partial update: a missing field (outer `None`) is left alone; an explicit `null` (`Some(None)`) clears it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BookPrefsPatch {
    #[serde(deserialize_with = "double_option")]
    pub last_card_deck_id: Option<Option<i64>>,
    #[serde(deserialize_with = "double_option")]
    pub last_card_kind: Option<Option<String>>,
    #[serde(deserialize_with = "double_option")]
    pub review_deck_id: Option<Option<i64>>,
}

fn require_live_book(conn: &rusqlite::Connection, uid: &str) -> Result<()> {
    let live: Option<bool> = conn
        .query_row(
            "SELECT deleted = 0 FROM book WHERE book_uid = ?1",
            params![uid],
            |r| r.get(0),
        )
        .optional()?;
    match live {
        Some(true) => Ok(()),
        _ => Err(StoreError::BookNotFound(uid.to_owned())),
    }
}

fn read(conn: &rusqlite::Connection, uid: &str) -> Result<BookPrefs> {
    Ok(conn
        .query_row(
            "SELECT last_card_deck_id, last_card_kind, review_deck_id FROM book_prefs
             WHERE book_uid = ?1",
            params![uid],
            |r| {
                Ok(BookPrefs {
                    last_card_deck_id: r.get(0)?,
                    last_card_kind: r.get(1)?,
                    review_deck_id: r.get(2)?,
                })
            },
        )
        .optional()?
        .unwrap_or_default())
}

impl Store {
    /// The book's preferences (all `None` when nothing was saved yet). Unknown or removed book → `BookNotFound`.
    pub fn book_prefs(&self, book_uid: &str) -> Result<BookPrefs> {
        check_uid(book_uid)?;
        require_live_book(&self.conn, book_uid)?;
        read(&self.conn, book_uid)
    }

    /// Applies `patch` and returns the stored preferences.
    pub fn set_book_prefs(&mut self, book_uid: &str, patch: &BookPrefsPatch) -> Result<BookPrefs> {
        check_uid(book_uid)?;
        if let Some(Some(kind)) = &patch.last_card_kind
            && !CARD_KINDS.contains(&kind.as_str())
        {
            return Err(StoreError::InvalidInput(format!(
                "tipo de card desconhecido: {kind:?}."
            )));
        }
        let tx = self.conn.transaction()?;
        require_live_book(&tx, book_uid)?;
        let mut prefs = read(&tx, book_uid)?;
        if let Some(deck) = patch.last_card_deck_id {
            prefs.last_card_deck_id = deck;
        }
        if let Some(kind) = &patch.last_card_kind {
            prefs.last_card_kind = kind.clone();
        }
        if let Some(deck) = patch.review_deck_id {
            prefs.review_deck_id = deck;
        }
        tx.execute(
            "INSERT INTO book_prefs (book_uid, last_card_deck_id, last_card_kind, review_deck_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (book_uid) DO UPDATE SET
                 last_card_deck_id = excluded.last_card_deck_id,
                 last_card_kind = excluded.last_card_kind,
                 review_deck_id = excluded.review_deck_id,
                 updated_at = excluded.updated_at",
            params![
                book_uid,
                prefs.last_card_deck_id,
                prefs.last_card_kind,
                prefs.review_deck_id,
                now_ms()
            ],
        )?;
        tx.commit()?;
        Ok(prefs)
    }
}
