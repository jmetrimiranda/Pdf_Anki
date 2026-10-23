//! The 32 Python post handlers of `mediasrv.py:1131-1164` (aqt 26.9.3) and the app-side ones.
//! Every row is explained in `docs/anki-handlers.md`.

use crate::study::frontend::SetSchedulingStatesRequest;
use anki::error::AnkiError;
use anki::services::{ConfigService, DeckConfigService, NotetypesService, SearchService};
use anki_proto::deck_config::{UpdateDeckConfigsMode, UpdateDeckConfigsRequest};
use anki_proto::notetypes::ChangeNotetypeRequest;
use anki_proto::search::SearchNode;
use prost::Message;

use super::{Bridge, BridgeEvent, Decision, PostReply, PostRequest, decode};
use crate::Collection;

/// `post_handler_list`, in the same order, with our decision.
pub const POST_HANDLERS: [(&str, Decision); 32] = [
    ("congratsInfo", Decision::Forward),
    ("getDeckConfigsForUpdate", Decision::Forward),
    ("updateDeckConfigs", Decision::App),
    ("getSchedulingStatesWithContext", Decision::App),
    ("setSchedulingStates", Decision::App),
    ("changeNotetype", Decision::App),
    ("importDone", Decision::App),
    ("importDialogRequireClose", Decision::App),
    ("searchInBrowser", Decision::App),
    ("deckOptionsRequireClose", Decision::App),
    ("deckOptionsReady", Decision::App),
    ("getProfileConfigJson", Decision::NotFound),
    ("setProfileConfigJson", Decision::NotFound),
    ("getMetaJson", Decision::NotFound),
    ("setMetaJson", Decision::NotFound),
    ("getConfigJson", Decision::App),
    ("convertPastedImage", Decision::NotFound),
    ("openFilePicker", Decision::NotFound),
    ("openMedia", Decision::NotFound),
    ("showInMediaFolder", Decision::NotFound),
    ("recordAudio", Decision::NotFound),
    ("playFile", Decision::NotFound),
    ("readClipboard", Decision::NotFound),
    ("writeClipboard", Decision::NotFound),
    ("closeAddCards", Decision::NotFound),
    ("closeEditCurrent", Decision::NotFound),
    ("openLink", Decision::App),
    ("askUser", Decision::NotFound),
    ("showMessageBox", Decision::NotFound),
    ("openFieldsDialog", Decision::NotFound),
    ("openCardsDialog", Decision::NotFound),
    ("saveCustomColours", Decision::App),
];

/// Reply text when `getSchedulingStatesWithContext` arrives with no card being studied.
pub(crate) const NO_CARD: &str = "Nenhum card em estudo.";
/// Reply text when `changeNotetype` arrives without notes registered by the app.
pub(crate) const NO_CHANGE_NOTETYPE_NOTES: &str =
    "Nenhuma nota selecionada para trocar o tipo de nota.";

impl Bridge {
    /// Methods with [`Decision::App`] (post handlers and the two exposed methods answered
    /// outside the actor).
    pub(super) async fn app_handler(&self, req: PostRequest) -> PostReply {
        let result = match req.method.as_str() {
            // Exposed methods answered outside the actor (docs/decisoes.md).
            "latestProgress" => Ok(PostReply::binary(
                anki_proto::collection::Progress::default().encode_to_vec(),
            )),
            "setWantsAbort" => {
                self.inner.svc.request_abort();
                Ok(PostReply::no_content())
            }
            "updateDeckConfigs" => self.update_deck_configs(&req.body),
            "getSchedulingStatesWithContext" => match self.inner.study.states_with_context() {
                Some(states) => Ok(PostReply::binary(states.encode_to_vec())),
                None => Ok(PostReply::error(NO_CARD)),
            },
            "setSchedulingStates" => decode::<SetSchedulingStatesRequest>(&req.body).map(|r| {
                // A wrong key or a stale card is ignored, like Python's reviewer.
                let _ = self.inner.study.set_states(r);
                PostReply::no_content()
            }),
            "changeNotetype" => self.change_notetype(&req.body).await,
            "importDone" => {
                self.emit(BridgeEvent::ImportDone);
                self.emit(BridgeEvent::Changed);
                Ok(PostReply::no_content())
            }
            "importDialogRequireClose" | "deckOptionsRequireClose" => {
                self.emit(BridgeEvent::Close);
                Ok(PostReply::no_content())
            }
            "deckOptionsReady" => {
                self.emit(BridgeEvent::Ready);
                Ok(PostReply::no_content())
            }
            "searchInBrowser" => self.search_in_browser(&req.body).await,
            "getConfigJson" => self.get_config_json(&req.body).await,
            "openLink" => decode::<anki_proto::generic::String>(&req.body).map(|s| {
                if is_web_link(&s.val) {
                    self.emit(BridgeEvent::OpenLink { url: s.val });
                }
                PostReply::no_content()
            }),
            // image-occlusion calls it on every colour change; a 404 would alert().
            "saveCustomColours" => Ok(PostReply::no_content()),
            _ => Ok(PostReply::not_found()),
        };
        result.unwrap_or_else(|reply| reply)
    }

    /// Replies 204 at once and runs the update in the background, like `mediasrv.py:669`.
    fn update_deck_configs(&self, body: &[u8]) -> Result<PostReply, PostReply> {
        let input = decode::<UpdateDeckConfigsRequest>(body)?;
        let close = input.mode() != UpdateDeckConfigsMode::ComputeAllParams;
        let bridge = self.clone();
        let spawned = std::thread::Builder::new()
            .name("anki-update-deck-configs".into())
            .spawn(move || {
                let res = bridge.inner.svc.call_blocking(move |col| {
                    DeckConfigService::update_deck_configs(col, input).map_err(Into::into)
                });
                match res {
                    Ok(_) => {
                        bridge.emit(BridgeEvent::Changed);
                        if close {
                            bridge.emit(BridgeEvent::Close);
                        }
                    }
                    Err(err) => bridge.emit(BridgeEvent::Error {
                        message: err.to_string(),
                    }),
                }
            });
        match spawned {
            Ok(_) => Ok(PostReply::no_content()),
            Err(err) => Err(PostReply::error(&err.to_string())),
        }
    }

    /// Fills in the note ids registered by the app (the page never sends them) and changes the
    /// notetype; then the page is closed.
    async fn change_notetype(&self, body: &[u8]) -> Result<PostReply, PostReply> {
        let mut input = decode::<ChangeNotetypeRequest>(body)?;
        let note_ids = self
            .inner
            .change_notetype_notes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .filter(|ids| !ids.is_empty())
            .ok_or_else(|| PostReply::error(NO_CHANGE_NOTETYPE_NOTES))?;
        input.note_ids = note_ids;
        let _changes = self
            .on_actor(move |col| NotetypesService::change_notetype(col, input))
            .await?;
        self.reset();
        self.emit(BridgeEvent::Changed);
        self.emit(BridgeEvent::Close);
        Ok(PostReply::no_content())
    }

    async fn search_in_browser(&self, body: &[u8]) -> Result<PostReply, PostReply> {
        let node = decode::<SearchNode>(body)?;
        let search = self
            .on_actor(move |col| SearchService::build_search_string(col, node))
            .await?
            .val;
        self.emit(BridgeEvent::SearchInBrowser { search });
        Ok(PostReply::no_content())
    }

    /// Like Python: a missing key is JSON `null`, not an error.
    async fn get_config_json(&self, body: &[u8]) -> Result<PostReply, PostReply> {
        let key = decode::<anki_proto::generic::String>(body)?;
        let json = self
            .on_actor(move |col| config_json_or_null(col, key))
            .await?;
        Ok(PostReply::binary(json.encode_to_vec()))
    }
}

fn config_json_or_null(
    col: &mut Collection,
    key: anki_proto::generic::String,
) -> Result<anki_proto::generic::Json, AnkiError> {
    match ConfigService::get_config_json(col, key) {
        Err(AnkiError::NotFound { .. }) => Ok(anki_proto::generic::Json {
            json: b"null".to_vec(),
        }),
        other => other,
    }
}

/// Only http(s) links leave the app.
fn is_web_link(url: &str) -> bool {
    let lower = url.trim_start().to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://")) && !url.contains(['\n', '\r'])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_links_are_opened() {
        assert!(is_web_link("https://docs.ankiweb.net/"));
        assert!(is_web_link("HTTP://example.com"));
        assert!(!is_web_link("file:///etc/passwd"));
        assert!(!is_web_link("javascript:alert(1)"));
        assert!(!is_web_link("leitor://livro/x"));
        assert!(!is_web_link("https://x\nfoo"));
    }
}
