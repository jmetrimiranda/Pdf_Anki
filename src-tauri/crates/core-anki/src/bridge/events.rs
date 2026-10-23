//! Events the bridge sends to the app (close the page, refresh other screens, open the browser…).

use std::sync::Arc;

use anki_proto::collection::{NestedOpChanges, OpChanges, OpChangesOnly};
use prost::Message;
use serde::Serialize;

/// Receives every [`BridgeEvent`]. Called from whatever thread finished the work (the async
/// caller of [`super::Bridge::post`] or a background thread for `updateDeckConfigs`).
pub type EventSink = Arc<dyn Fn(BridgeEvent) + Send + Sync>;

/// Something the host must react to. Serialized as `{ "kind": "close" }`,
/// `{ "kind": "searchInBrowser", "search": "…" }` (the `anki://page` event payload).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BridgeEvent {
    /// The page asked to be closed (deck options saved, import dialog closed…).
    Close,
    /// Deck options finished loading; from now on closing must ask the page first.
    Ready,
    /// An import page finished importing.
    ImportDone,
    /// Open the Browse screen with this search.
    SearchInBrowser { search: String },
    /// The collection changed: other screens must refresh.
    Changed,
    /// Open an http(s) link in the system browser.
    OpenLink { url: String },
    /// A background operation started by a page failed (pt-BR message).
    Error { message: String },
}

/// Value of the `Anki-Op-Changes` header: how to read the op changes out of a reply
/// (`ts/lib/generated/post.ts`, `mediasrv.py` `raw_backend_request`).
pub(crate) fn op_changes_kind(header: Option<&str>) -> Option<u8> {
    match header.map(str::trim) {
        Some("1") => Some(1),
        Some("2") => Some(2),
        Some("3") => Some(3),
        _ => None,
    }
}

/// Decodes the op changes carried by a reply. `kind` 1 = `OpChanges`, 2 = `OpChangesOnly`
/// (any message whose field 1 is an `OpChanges`), 3 = `NestedOpChanges`. Decode errors → `None`.
pub(crate) fn decode_op_changes(kind: u8, output: &[u8]) -> Option<OpChanges> {
    match kind {
        1 => OpChanges::decode(output).ok(),
        2 => OpChangesOnly::decode(output).ok()?.changes,
        3 => NestedOpChanges::decode(output).ok()?.changes?.changes,
        _ => None,
    }
}

/// Whether any change flag is set.
pub(crate) fn has_changes(changes: &OpChanges) -> bool {
    let c = changes;
    c.card
        || c.note
        || c.deck
        || c.tag
        || c.notetype
        || c.config
        || c.deck_config
        || c.mtime
        || c.browser_table
        || c.browser_sidebar
        || c.note_text
        || c.study_queues
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialize_with_a_kind_tag() {
        let json = serde_json::to_string(&BridgeEvent::SearchInBrowser {
            search: "deck:x".into(),
        })
        .unwrap();
        assert_eq!(json, r#"{"kind":"searchInBrowser","search":"deck:x"}"#);
        assert_eq!(
            serde_json::to_string(&BridgeEvent::ImportDone).unwrap(),
            r#"{"kind":"importDone"}"#
        );
    }

    #[test]
    fn op_changes_are_unwrapped_by_kind() {
        let changes = OpChanges {
            note: true,
            ..Default::default()
        };
        let only = OpChangesOnly {
            changes: Some(changes),
        };
        let nested = NestedOpChanges {
            changes: Some(only),
        };
        let expected = Some(changes);
        assert_eq!(decode_op_changes(1, &changes.encode_to_vec()), expected);
        assert_eq!(decode_op_changes(2, &only.encode_to_vec()), expected);
        assert_eq!(decode_op_changes(3, &nested.encode_to_vec()), expected);
        assert_eq!(decode_op_changes(1, &[0xff, 0xff, 0xff]), None);
        assert!(has_changes(&changes));
        assert!(!has_changes(&OpChanges::default()));
        assert_eq!(op_changes_kind(Some("2")), Some(2));
        assert_eq!(op_changes_kind(Some("0")), None);
        assert_eq!(op_changes_kind(None), None);
    }
}
