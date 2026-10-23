//! "Painel Anki do livro" (spec 10.1, 10.2, 12.7): the book's decks with today's counts, the per-book preferences of
//! this device (last deck/kind used for "＋ Card da seleção", the "Revisar aqui" deck), the cards whose Fonte links
//! to the book ("Cards desta página") and "Definir palavra".
//!
//! The vocabulary deck of a book is `<pasta de vocabulário>::Livros::<Título>`; until the vocabulary folder is chosen
//! (Phase 6) it falls back to the top-level `Livros::<Título>` (docs/decisoes.md). Everything about the collection is
//! read in one job on the Anki actor, so the panel opens fast (< 50 ms on the fixture).

use core_anki::book::{self, BookCard, VocabNote};
use core_anki::study::QueueCounts;
use core_store::setting_keys as keys;
use core_store::{BookPatch, BookPrefsPatch};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::state::AppState;

/// Longest word "Definir palavra" accepts, in chars.
pub const MAX_WORD_CHARS: usize = 64;

/// Card types of "＋ Card da seleção" (stored as `core_store::CARD_KINDS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BookCardKind {
    Basic,
    Cloze,
    CodeCommand,
    CodeProgram,
    Vocab,
}

impl BookCardKind {
    pub const ALL: [BookCardKind; 5] = [
        Self::Basic,
        Self::Cloze,
        Self::CodeCommand,
        Self::CodeProgram,
        Self::Vocab,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Basic => "basic",
            Self::Cloze => "cloze",
            Self::CodeCommand => "codeCommand",
            Self::CodeProgram => "codeProgram",
            Self::Vocab => "vocab",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BookDeckRole {
    Vocab,
    Content,
}

/// One of the book's decks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookDeckInfo {
    pub role: BookDeckRole,
    /// `None` when the deck does not exist (yet).
    pub deck_id: Option<i64>,
    /// Full name with `::` (empty for a content deck that was deleted).
    pub name: String,
    pub exists: bool,
    /// Today's counts including subdecks (the deck list's numbers); `None` when the deck is missing.
    pub counts: Option<QueueCounts>,
}

/// `book_panel_info` / `book_panel_set`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookPanelInfo {
    pub book_uid: String,
    pub title: String,
    /// The vocabulary folder (setting `vocab_root_deck_id`) when chosen and still in the collection.
    pub vocab_root_deck_id: Option<i64>,
    pub vocab_root_name: Option<String>,
    pub vocab_deck: BookDeckInfo,
    /// `book.content_deck_id`; `None` when not set.
    pub content_deck: Option<BookDeckInfo>,
    /// Deck last used to add a card from the book (`None` when unset or deleted).
    pub last_deck_id: Option<i64>,
    pub last_kind: Option<BookCardKind>,
    /// Deck last reviewed with "Revisar aqui" (`None` when unset or deleted).
    pub review_deck_id: Option<i64>,
}

/// Partial update of the panel: a missing field is left alone; `null` clears it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BookPanelPatch {
    #[serde(deserialize_with = "double_option")]
    pub content_deck_id: Option<Option<i64>>,
    #[serde(deserialize_with = "double_option")]
    pub last_deck_id: Option<Option<i64>>,
    #[serde(deserialize_with = "double_option")]
    pub last_kind: Option<Option<BookCardKind>>,
    #[serde(deserialize_with = "double_option")]
    pub review_deck_id: Option<Option<i64>>,
}

fn double_option<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// "Definir palavra" (spec 12.7): the lemma and the vocabulary note of the word, if there is one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordDefinition {
    pub word: String,
    pub lemma: String,
    pub vocab_root_deck_id: Option<i64>,
    pub vocab_root_name: Option<String>,
    pub note: Option<VocabNote>,
}

/// What the collection says about the book's decks (computed on the actor in one job).
struct DeckFacts {
    root: Option<(i64, String)>,
    vocab: BookDeckInfo,
    content: Option<BookDeckInfo>,
    last_deck_alive: bool,
    review_deck_alive: bool,
}

fn deck_not_found() -> AppError {
    AppError::new("deck_not_found", "O deck escolhido não existe mais.")
}

/// The vocabulary deck's full name for a book (decision recorded in docs/decisoes.md).
pub fn vocab_deck_name(root_name: Option<&str>, title: &str) -> String {
    match root_name {
        Some(root) => format!("{root}::Livros::{title}"),
        None => format!("Livros::{title}"),
    }
}

/// Name of an existing normal deck, `None` when missing.
fn deck_name(col: &mut core_anki::Collection, deck_id: i64) -> core_anki::Result<Option<String>> {
    use core_anki::anki::prelude::{DeckId, DeckKind};
    Ok(col
        .get_deck(DeckId(deck_id))?
        .filter(|d| matches!(d.kind, DeckKind::Normal(_)))
        .map(|d| d.human_name()))
}

fn deck_exists(col: &mut core_anki::Collection, deck_id: Option<i64>) -> core_anki::Result<bool> {
    Ok(match deck_id {
        Some(id) => col
            .get_deck(core_anki::anki::prelude::DeckId(id))?
            .is_some(),
        None => false,
    })
}

impl AppState {
    fn vocab_root_setting(&self) -> Result<Option<i64>, AppError> {
        self.with_store(|s| s.setting_as::<Option<i64>>(keys::VOCAB_ROOT_DECK_ID))
    }

    /// The book's decks, counts and preferences (spec 10.1).
    pub async fn book_panel_info(&self, uid: &str) -> Result<BookPanelInfo, AppError> {
        let (book, prefs, root_id) = self.with_store(|s| {
            let book = s
                .get_book(uid)?
                .ok_or_else(|| core_store::StoreError::BookNotFound(uid.to_owned()))?;
            let prefs = s.book_prefs(uid)?;
            let root = s.setting_as::<Option<i64>>(keys::VOCAB_ROOT_DECK_ID)?;
            Ok((book, prefs, root))
        })?;
        let title = book.title.clone();
        let content_id = book.content_deck_id;
        let (last_id, review_id) = (prefs.last_card_deck_id, prefs.review_deck_id);
        let facts = self
            .anki_handles()?
            .svc
            .call(move |col| {
                let root = match root_id {
                    Some(id) => deck_name(col, id)?.map(|name| (id, name)),
                    None => None,
                };
                let name = vocab_deck_name(root.as_ref().map(|(_, n)| n.as_str()), &title);
                let vocab_id = book::deck_by_name(col, &name)?;
                let vocab = match vocab_id {
                    Some(id) => BookDeckInfo {
                        role: BookDeckRole::Vocab,
                        deck_id: Some(id),
                        name: deck_name(col, id)?.unwrap_or(name),
                        exists: true,
                        counts: book::deck_counts(col, id)?,
                    },
                    None => BookDeckInfo {
                        role: BookDeckRole::Vocab,
                        deck_id: None,
                        name,
                        exists: false,
                        counts: None,
                    },
                };
                let content = match content_id {
                    None => None,
                    Some(id) => Some(match deck_name(col, id)? {
                        Some(name) => BookDeckInfo {
                            role: BookDeckRole::Content,
                            deck_id: Some(id),
                            name,
                            exists: true,
                            counts: book::deck_counts(col, id)?,
                        },
                        None => BookDeckInfo {
                            role: BookDeckRole::Content,
                            deck_id: Some(id),
                            name: String::new(),
                            exists: false,
                            counts: None,
                        },
                    }),
                };
                Ok(DeckFacts {
                    root,
                    vocab,
                    content,
                    last_deck_alive: deck_exists(col, last_id)?,
                    review_deck_alive: deck_exists(col, review_id)?,
                })
            })
            .await?;
        Ok(BookPanelInfo {
            book_uid: book.book_uid,
            title: book.title,
            vocab_root_deck_id: facts.root.as_ref().map(|(id, _)| *id),
            vocab_root_name: facts.root.map(|(_, name)| name),
            vocab_deck: facts.vocab,
            content_deck: facts.content,
            last_deck_id: last_id.filter(|_| facts.last_deck_alive),
            last_kind: prefs
                .last_card_kind
                .as_deref()
                .and_then(BookCardKind::parse),
            review_deck_id: review_id.filter(|_| facts.review_deck_alive),
        })
    }

    /// Sets the content deck (`book.content_deck_id`) and the device preferences; every deck must exist.
    pub async fn book_panel_set(
        &self,
        uid: &str,
        patch: BookPanelPatch,
    ) -> Result<BookPanelInfo, AppError> {
        // The book first (a clear "book not found" beats a deck error).
        self.with_store(|s| {
            s.get_book(uid)?
                .ok_or_else(|| core_store::StoreError::BookNotFound(uid.to_owned()))
        })?;
        let decks: Vec<i64> = [
            patch.content_deck_id,
            patch.last_deck_id,
            patch.review_deck_id,
        ]
        .into_iter()
        .filter_map(|d| d.flatten())
        .collect();
        if !decks.is_empty() {
            let all_exist = self
                .anki_handles()?
                .svc
                .call(move |col| {
                    for id in decks {
                        if deck_name(col, id)?.is_none() {
                            return Ok(false);
                        }
                    }
                    Ok(true)
                })
                .await?;
            if !all_exist {
                return Err(deck_not_found());
            }
        }
        let prefs = BookPrefsPatch {
            last_card_deck_id: patch.last_deck_id,
            last_card_kind: patch.last_kind.map(|k| k.map(|k| k.as_str().to_string())),
            review_deck_id: patch.review_deck_id,
        };
        let content = patch.content_deck_id;
        self.with_store(|s| {
            if let Some(content_deck_id) = content {
                let book_patch = BookPatch {
                    content_deck_id: Some(content_deck_id),
                    ..BookPatch::default()
                };
                s.update_book(uid, &book_patch)?;
            }
            if prefs != BookPrefsPatch::default() {
                s.set_book_prefs(uid, &prefs)?;
            }
            Ok(())
        })?;
        self.book_panel_info(uid).await
    }

    /// Notes whose Fonte links to the book, by page ("Cards desta página").
    pub async fn anki_book_cards(&self, uid: String) -> Result<Vec<BookCard>, AppError> {
        Ok(self.anki_handles()?.svc.book_cards(uid).await?)
    }

    /// "Definir palavra" (spec 12.7): one word only; the lemma (provisional rules until Phase 6) and the note of the
    /// vocabulary folder. Until the folder is chosen (Phase 6), or when it was deleted, the note is looked up in the
    /// book's vocabulary deck the panel uses (`Livros::<Título>`), when `book_uid` names a library book.
    pub async fn vocab_define(
        &self,
        word: &str,
        book_uid: Option<&str>,
    ) -> Result<WordDefinition, AppError> {
        let trimmed = word.trim();
        let single = (trimmed.chars().count() <= MAX_WORD_CHARS)
            .then(|| core_vocab::single_word(trimmed))
            .flatten()
            .ok_or_else(|| AppError::new("invalid_input", "Selecione uma só palavra."))?;
        let lemma = core_vocab::lemma(&single);
        let root_id = self.vocab_root_setting()?;
        // A malformed or unknown uid only loses the fallback (the word and lemma still answer).
        let book_title = match book_uid {
            Some(uid) => {
                self.with_store(|s| Ok(s.get_book(uid).ok().flatten().map(|b| b.title)))?
            }
            None => None,
        };
        let (root, note) = if root_id.is_none() && book_title.is_none() {
            (None, None)
        } else {
            let (word, lemma) = (single.clone(), lemma.clone());
            self.anki_handles()?
                .svc
                .call(move |col| {
                    let root = match root_id {
                        Some(id) => deck_name(col, id)?.map(|name| (id, name)),
                        None => None,
                    };
                    let search = match (&root, &book_title) {
                        (Some((id, _)), _) => Some(*id),
                        (None, Some(title)) => {
                            book::deck_by_name(col, &vocab_deck_name(None, title))?
                        }
                        (None, None) => None,
                    };
                    let note = match search {
                        Some(id) => book::vocab_lookup(col, id, &word, &lemma)?,
                        None => None,
                    };
                    Ok((root, note))
                })
                .await?
        };
        Ok(WordDefinition {
            word: single,
            lemma,
            vocab_root_deck_id: root.as_ref().map(|(id, _)| *id),
            vocab_root_name: root.map(|(_, name)| name),
            note,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_match_the_store() {
        let ours: Vec<&str> = BookCardKind::ALL.iter().map(|k| k.as_str()).collect();
        assert_eq!(ours, core_store::CARD_KINDS);
        for k in BookCardKind::ALL {
            assert_eq!(
                serde_json::to_value(k).unwrap(),
                serde_json::Value::String(k.as_str().into())
            );
            assert_eq!(BookCardKind::parse(k.as_str()), Some(k));
        }
        assert_eq!(BookCardKind::parse("Basic"), None);
    }

    #[test]
    fn patch_tells_missing_from_null() {
        let p: BookPanelPatch =
            serde_json::from_str(r#"{"contentDeckId":null,"lastKind":"cloze"}"#).unwrap();
        assert_eq!(p.content_deck_id, Some(None));
        assert_eq!(p.last_kind, Some(Some(BookCardKind::Cloze)));
        assert_eq!(p.last_deck_id, None);
        assert_eq!(p.review_deck_id, None);
        assert!(serde_json::from_str::<BookPanelPatch>(r#"{"lastKind":"nope"}"#).is_err());
    }

    #[test]
    fn vocab_deck_names() {
        assert_eq!(
            vocab_deck_name(Some("Inglês::Vocabulário"), "Animal Farm"),
            "Inglês::Vocabulário::Livros::Animal Farm"
        );
        assert_eq!(vocab_deck_name(None, "Animal Farm"), "Livros::Animal Farm");
    }
}
