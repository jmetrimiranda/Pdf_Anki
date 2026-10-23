//! Who may call what (spec 8.3/8.4, `mediasrv.py` `_check_dynamic_request_permissions`).

use super::{Caller, PostReply, PostRequest};

/// The only accepted `Content-Type` (exact match, like Anki).
pub const CONTENT_TYPE: &str = "application/binary";

/// Origins of the Anki pages (`anki://localhost` on Linux/macOS, `http://anki.localhost` on Windows).
pub const ANKI_ORIGINS: [&str; 2] = ["anki://localhost", "http://anki.localhost"];

/// The four methods a card may call (`mediasrv.py:1329-1334`); everything else is 403 for cards.
pub const CARD_METHODS: [&str; 4] = [
    "getSchedulingStatesWithContext",
    "setSchedulingStates",
    "i18nResources",
    "congratsInfo",
];

/// Largest accepted request body.
pub const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// Checks content type, caller and size. `Some(reply)` = refuse with that reply.
pub(crate) fn check(caller: Caller, req: &PostRequest) -> Option<PostReply> {
    if req.content_type.as_deref() != Some(CONTENT_TYPE) {
        return Some(PostReply::forbidden());
    }
    match caller {
        // Unknown names are 403 too: a card learns nothing about what exists.
        Caller::Card if !CARD_METHODS.contains(&req.method.as_str()) => {
            return Some(PostReply::forbidden());
        }
        Caller::Card => {}
        Caller::Page => {
            if let Some(origin) = req.origin.as_deref()
                && !ANKI_ORIGINS.contains(&origin)
            {
                return Some(PostReply::forbidden());
            }
        }
    }
    if req.body.len() > MAX_BODY_BYTES {
        return Some(PostReply::text(413, "A requisição é grande demais."));
    }
    None
}
