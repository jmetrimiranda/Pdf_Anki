//! Name → generated service trait method dispatch (docs/decisoes.md: by NAME, no numeric
//! indices). Every entry decodes the request with prost, calls the trait method implemented on
//! `Collection` (UFCS, so a wrong service or signature is a compile error) and encodes the output.

use anki::collection::Collection;
use anki::error::AnkiError;
use prost::Message;

use super::Decision;

/// `exposed_backend_list` of `qt/aqt/mediasrv.py:1167-1238` (aqt 26.9.3) in camelCase, verbatim
/// and in the same order.
pub const EXPOSED_METHODS: [&str; 55] = [
    // CollectionService
    "latestProgress",
    "getCustomColours",
    // DecksService (the Python comment says DeckService)
    "getDeckNames",
    "getDeck",
    // I18nService
    "i18nResources",
    // ImportExportService
    "getCsvMetadata",
    "getImportAnkiPackagePresets",
    "importCsv",
    "importAnkiPackage",
    "importJsonFile",
    "importJsonString",
    // NotesService (getFieldNames and updateNotetype are really NotetypesService)
    "getFieldNames",
    "getNote",
    "newNote",
    "noteFieldsCheck",
    "defaultsForAdding",
    "defaultDeckForNotetype",
    "addNote",
    "updateNotes",
    "updateNotetype",
    // NotetypesService
    "getNotetype",
    "getNotetypeNames",
    "getChangeNotetypeInfo",
    "getClozeFieldOrds",
    // StatsService
    "cardStats",
    "getReviewLogs",
    "graphs",
    "getGraphPreferences",
    "setGraphPreferences",
    // TagsService
    "completeTag",
    // ImageOcclusionService
    "getImageForOcclusion",
    "addImageOcclusionNote",
    "getImageOcclusionNote",
    "updateImageOcclusionNote",
    "getImageOcclusionFields",
    // SchedulerService (setWantsAbort is really CollectionService)
    "computeFsrsParams",
    "computeOptimalRetention",
    "setWantsAbort",
    "evaluateParamsLegacy",
    "getOptimalRetentionParameters",
    "simulateFsrsReview",
    "simulateFsrsWorkload",
    // DeckConfigService
    "getIgnoredBeforeCount",
    "getRetentionWorkload",
    // CardRenderingService
    "encodeIriPaths",
    "decodeIriPaths",
    "htmlToTextLine",
    // ConfigService
    "setConfigJson",
    "getConfigBool",
    // MediaService (addMediaFromUrl is BackendMediaService)
    "addMediaFile",
    "addMediaFromPath",
    "addMediaFromUrl",
    "getAbsoluteMediaPath",
    "extractMediaFiles",
    // CardsService
    "getCard",
];

/// Exposed methods answered outside the actor (docs/decisoes.md: the actor owns `Collection`).
pub(crate) const OUTSIDE_ACTOR: [&str; 2] = ["latestProgress", "setWantsAbort"];

/// Exposed methods that rslib's `Collection` cannot run (Backend-only services).
pub(crate) const BACKEND_ONLY: [&str; 1] = ["addMediaFromUrl"];

/// Decision for an exposed backend method.
pub fn exposed_decision(name: &str) -> Option<Decision> {
    if !EXPOSED_METHODS.contains(&name) {
        None
    } else if OUTSIDE_ACTOR.contains(&name) {
        Some(Decision::App)
    } else if BACKEND_ONLY.contains(&name) {
        Some(Decision::NotFound)
    } else {
        Some(Decision::Forward)
    }
}

/// Builds [`forward`] (and, for tests, `FORWARDED`) from `"camelName" => Service::method(InputType)` rows.
/// Methods whose input is `generic.Empty` are written `Service::method()`.
macro_rules! forward_table {
    ($( $name:literal => $svc:ident :: $method:ident ( $($input:ty)? ); )*) => {
        /// Every method name [`forward`] knows, in table order.
        #[cfg(test)]
        pub(crate) const FORWARDED: &[&str] = &[$($name),*];

        /// Runs a forwarded method on the collection. `None` = not a forwarded name.
        #[allow(clippy::redundant_closure_call, clippy::let_unit_value, clippy::unit_arg)]
        pub(crate) fn forward(
            col: &mut Collection,
            name: &str,
            body: &[u8],
        ) -> Option<Result<Vec<u8>, AnkiError>> {
            Some(match name {
                $( $name => (|| -> Result<Vec<u8>, AnkiError> {
                    let output = forward_table!(@call col, body, $svc, $method $(, $input)?);
                    Ok(output.encode_to_vec())
                })(), )*
                _ => return None,
            })
        }
    };
    (@call $col:ident, $body:ident, $svc:ident, $method:ident) => {{
        let _ = $body;
        <Collection as anki::services::$svc>::$method($col)?
    }};
    (@call $col:ident, $body:ident, $svc:ident, $method:ident, $input:ty) => {
        <Collection as anki::services::$svc>::$method($col, <$input>::decode($body)?)?
    };
}

// Exposed methods (the proto service of each was checked against proto/anki/*.proto of 26.09.3),
// then the post handlers that are forwarded as-is.
forward_table! {
    "getCustomColours" => CollectionService::get_custom_colours();
    "getDeckNames" => DecksService::get_deck_names(anki_proto::decks::GetDeckNamesRequest);
    "getDeck" => DecksService::get_deck(anki_proto::decks::DeckId);
    "i18nResources" => I18nService::i18n_resources(anki_proto::i18n::I18nResourcesRequest);
    "getCsvMetadata" => ImportExportService::get_csv_metadata(anki_proto::import_export::CsvMetadataRequest);
    "getImportAnkiPackagePresets" => ImportExportService::get_import_anki_package_presets();
    "importCsv" => ImportExportService::import_csv(anki_proto::import_export::ImportCsvRequest);
    "importAnkiPackage" => ImportExportService::import_anki_package(anki_proto::import_export::ImportAnkiPackageRequest);
    "importJsonFile" => ImportExportService::import_json_file(anki_proto::generic::String);
    "importJsonString" => ImportExportService::import_json_string(anki_proto::generic::String);
    "getFieldNames" => NotetypesService::get_field_names(anki_proto::notetypes::NotetypeId);
    "getNote" => NotesService::get_note(anki_proto::notes::NoteId);
    "newNote" => NotesService::new_note(anki_proto::notetypes::NotetypeId);
    "noteFieldsCheck" => NotesService::note_fields_check(anki_proto::notes::Note);
    "defaultsForAdding" => NotesService::defaults_for_adding(anki_proto::notes::DefaultsForAddingRequest);
    "defaultDeckForNotetype" => NotesService::default_deck_for_notetype(anki_proto::notetypes::NotetypeId);
    "addNote" => NotesService::add_note(anki_proto::notes::AddNoteRequest);
    "updateNotes" => NotesService::update_notes(anki_proto::notes::UpdateNotesRequest);
    "updateNotetype" => NotetypesService::update_notetype(anki_proto::notetypes::Notetype);
    "getNotetype" => NotetypesService::get_notetype(anki_proto::notetypes::NotetypeId);
    "getNotetypeNames" => NotetypesService::get_notetype_names();
    "getChangeNotetypeInfo" => NotetypesService::get_change_notetype_info(anki_proto::notetypes::GetChangeNotetypeInfoRequest);
    "getClozeFieldOrds" => NotetypesService::get_cloze_field_ords(anki_proto::notetypes::NotetypeId);
    "cardStats" => StatsService::card_stats(anki_proto::cards::CardId);
    "getReviewLogs" => StatsService::get_review_logs(anki_proto::cards::CardId);
    "graphs" => StatsService::graphs(anki_proto::stats::GraphsRequest);
    "getGraphPreferences" => StatsService::get_graph_preferences();
    "setGraphPreferences" => StatsService::set_graph_preferences(anki_proto::stats::GraphPreferences);
    "completeTag" => TagsService::complete_tag(anki_proto::tags::CompleteTagRequest);
    "getImageForOcclusion" => ImageOcclusionService::get_image_for_occlusion(anki_proto::image_occlusion::GetImageForOcclusionRequest);
    "addImageOcclusionNote" => ImageOcclusionService::add_image_occlusion_note(anki_proto::image_occlusion::AddImageOcclusionNoteRequest);
    "getImageOcclusionNote" => ImageOcclusionService::get_image_occlusion_note(anki_proto::image_occlusion::GetImageOcclusionNoteRequest);
    "updateImageOcclusionNote" => ImageOcclusionService::update_image_occlusion_note(anki_proto::image_occlusion::UpdateImageOcclusionNoteRequest);
    "getImageOcclusionFields" => ImageOcclusionService::get_image_occlusion_fields(anki_proto::image_occlusion::GetImageOcclusionFieldsRequest);
    "computeFsrsParams" => SchedulerService::compute_fsrs_params(anki_proto::scheduler::ComputeFsrsParamsRequest);
    "computeOptimalRetention" => SchedulerService::compute_optimal_retention(anki_proto::scheduler::SimulateFsrsReviewRequest);
    "evaluateParamsLegacy" => SchedulerService::evaluate_params_legacy(anki_proto::scheduler::EvaluateParamsLegacyRequest);
    "getOptimalRetentionParameters" => SchedulerService::get_optimal_retention_parameters(anki_proto::scheduler::GetOptimalRetentionParametersRequest);
    "simulateFsrsReview" => SchedulerService::simulate_fsrs_review(anki_proto::scheduler::SimulateFsrsReviewRequest);
    "simulateFsrsWorkload" => SchedulerService::simulate_fsrs_workload(anki_proto::scheduler::SimulateFsrsReviewRequest);
    "getIgnoredBeforeCount" => DeckConfigService::get_ignored_before_count(anki_proto::deck_config::GetIgnoredBeforeCountRequest);
    "getRetentionWorkload" => DeckConfigService::get_retention_workload(anki_proto::deck_config::GetRetentionWorkloadRequest);
    "encodeIriPaths" => CardRenderingService::encode_iri_paths(anki_proto::generic::String);
    "decodeIriPaths" => CardRenderingService::decode_iri_paths(anki_proto::generic::String);
    "htmlToTextLine" => CardRenderingService::html_to_text_line(anki_proto::card_rendering::HtmlToTextLineRequest);
    "setConfigJson" => ConfigService::set_config_json(anki_proto::config::SetConfigJsonRequest);
    "getConfigBool" => ConfigService::get_config_bool(anki_proto::config::GetConfigBoolRequest);
    "addMediaFile" => MediaService::add_media_file(anki_proto::media::AddMediaFileRequest);
    "addMediaFromPath" => MediaService::add_media_from_path(anki_proto::media::AddMediaFromPathRequest);
    "getAbsoluteMediaPath" => MediaService::get_absolute_media_path(anki_proto::generic::String);
    "extractMediaFiles" => MediaService::extract_media_files(anki_proto::generic::String);
    "getCard" => CardsService::get_card(anki_proto::cards::CardId);
    // post_handler_list entries forwarded unchanged
    "congratsInfo" => SchedulerService::congrats_info();
    "getDeckConfigsForUpdate" => DeckConfigService::get_deck_configs_for_update(anki_proto::decks::DeckId);
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;
    use crate::bridge::handlers::POST_HANDLERS;

    #[test]
    fn forwarded_names_are_exactly_the_forward_decisions() {
        let forwarded: BTreeSet<&str> = FORWARDED.iter().copied().collect();
        assert_eq!(forwarded.len(), FORWARDED.len(), "duplicate row");
        let expected: BTreeSet<&str> = EXPOSED_METHODS
            .iter()
            .copied()
            .filter(|n| exposed_decision(n) == Some(Decision::Forward))
            .chain(
                POST_HANDLERS
                    .iter()
                    .filter(|(_, d)| *d == Decision::Forward)
                    .map(|(n, _)| *n),
            )
            .collect();
        assert_eq!(forwarded, expected);
    }

    /// Spec 8.1 / docs/decisoes.md: dispatch by method NAME to the generated service traits, never
    /// `run_service_method` with numeric (service, method) indices.
    #[test]
    fn dispatch_is_by_name_never_by_numeric_index() {
        let sources = [
            include_str!("mod.rs"),
            include_str!("dispatch.rs"),
            include_str!("handlers.rs"),
            include_str!("policy.rs"),
            include_str!("events.rs"),
        ];
        let needle = ["run_service", "_method("].concat();
        for src in sources {
            assert!(!src.contains(&needle), "the bridge must not call {needle}");
        }
        // Every one of the 55 exposed names has a decision, and every Forward one a dispatch row.
        assert_eq!(EXPOSED_METHODS.len(), 55);
        for name in EXPOSED_METHODS {
            match exposed_decision(name) {
                Some(Decision::Forward) => assert!(FORWARDED.contains(&name), "{name}"),
                Some(_) => {}
                None => panic!("{name} has no decision"),
            }
        }
    }

    /// Phase 2 never syncs (spec 21): no sync method is reachable through `/_anki/`.
    #[test]
    fn no_sync_method_is_exposed() {
        let names = EXPOSED_METHODS
            .iter()
            .copied()
            .chain(POST_HANDLERS.iter().map(|(n, _)| *n))
            .chain(FORWARDED.iter().copied());
        for name in names {
            let lower = name.to_ascii_lowercase();
            for bad in ["sync", "fullupload", "fulldownload", "login"] {
                assert!(!lower.contains(bad), "{name} looks like a sync method");
            }
        }
    }

    #[test]
    fn exposed_list_has_no_duplicates() {
        let set: BTreeSet<&str> = EXPOSED_METHODS.iter().copied().collect();
        assert_eq!(set.len(), EXPOSED_METHODS.len());
    }
}
