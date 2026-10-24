/// App commands get `allow-<command>` permissions; only the capabilities in `capabilities/` grant them,
/// so a webview without a capability (Anki pages, card iframes) cannot invoke anything.
const COMMANDS: &[&str] = &[
    "anki_deck_tree",
    "anki_deck_names",
    "anki_deck_create",
    "anki_deck_rename",
    "anki_deck_move",
    "anki_deck_delete",
    "anki_deck_set_collapsed",
    "anki_set_current_deck",
    "anki_prepare_collection",
    "anki_study_next",
    "anki_show_answer",
    "anki_answer",
    "anki_undo",
    "anki_card_action",
    "anki_study_close",
    "anki_mini_review_open",
    "anki_mini_review_close",
    "book_panel_info",
    "book_panel_set",
    "anki_book_cards",
    "vocab_define",
    "anki_notetypes",
    "anki_add_defaults",
    "anki_note_get",
    "anki_note_check",
    "anki_note_add",
    "anki_note_update",
    "anki_media_add",
    "anki_tags_all",
    "anki_search",
    "anki_browse_rows",
    "anki_cards_set_deck",
    "anki_notes_tags",
    "anki_cards_suspend",
    "anki_cards_forget",
    "anki_notes_delete",
    "anki_change_notetype_prepare",
    "anki_pick_package",
    "anki_import",
    "anki_import_colpkg",
    "anki_export",
    "anki_backup_now",
    "anki_backups",
    "anki_sync_status",
    "anki_sync_login",
    "anki_sync_logout",
    "anki_sync_set_certificate",
    "anki_sync",
    "anki_sync_full",
    "anki_sync_notify",
    "library_list",
    "library_add",
    "library_remove",
    "library_update",
    "book_open",
    "book_bytes",
    "book_save_version",
    "export_pick_path",
    "book_export",
    "export_bytes",
    "book_open_external",
    "doc_words",
    "position_get",
    "position_set",
    "reading_session_start",
    "reading_session_heartbeat",
    "reading_session_stop",
    "pending_open_paths",
    "pending_deep_links",
    "code_mapping_list",
    "code_mapping_set",
    "code_note_extra_get",
    "code_note_extra_set",
    "code_accept_answer",
    "code_run_cpp",
    "code_format_cpp",
    "code_status",
    "code_settings_get",
    "code_settings_set",
    "code_runner_test",
    "code_import_markdown",
    "code_import_commit",
    "vocab_settings_get",
    "vocab_settings_set",
    "vocab_folder",
    "vocab_mapping_samples",
    "vocab_mapping_get",
    "vocab_mapping_set",
    "vocab_outline",
    "vocab_range_check",
    "vocab_scan_start",
    "vocab_rescan",
    "vocab_report",
    "vocab_override_set",
    "vocab_generate_deck",
    "vocab_marks",
    "vocab_add_word",
    "vocab_data_info",
    "job_status",
    "job_cancel",
    "ocr_info",
    "ocr_start",
    "ocr_cancel",
    "epub_annotation_list",
    "epub_annotation_upsert",
    "epub_annotation_delete",
    "vocab_epub_marks",
    "dev_smoke",
    "dev_log",
];

fn main() {
    ensure_anki_web_dir();
    ensure_vocab_data_dir();
    ensure_ocr_models_dir();
    let manifest = tauri_build::AppManifest::new().commands(COMMANDS);
    if let Err(e) = tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)) {
        panic!("tauri-build failed: {e:#}");
    }
}

/// `tauri.conf.json` bundles `../resources/anki-web/` (spec 19: Anki pages and MathJax offline),
/// and tauri-build refuses a missing resource folder. `scripts/fetch-anki-web.sh` fills it (the
/// `beforeBuildCommand` of `tauri build` runs it); a plain `cargo build`/`cargo test` without it
/// still compiles, and the app then shows "Os arquivos do Anki não foram encontrados".
fn ensure_anki_web_dir() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/anki-web");
    if !dir.join("sveltekit/index.html").is_file() {
        println!(
            "cargo:warning=Anki web assets missing in {}: run scripts/fetch-anki-web.sh",
            dir.display()
        );
        if let Err(e) = std::fs::create_dir_all(&dir) {
            panic!("could not create {}: {e}", dir.display());
        }
    }
}

/// `tauri.conf.json` bundles `../../data/generated/vocab/` (spec 12.2: WordNet, frequency list and
/// stopwords offline). `scripts/build-wordnet.sh` fills it (the `beforeBuildCommand` runs it); a plain
/// `cargo build`/`cargo test` without it still compiles, and scanning then answers
/// `vocab_data_missing`.
fn ensure_vocab_data_dir() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/generated/vocab");
    if !dir.join("vocab-data.json").is_file() {
        println!(
            "cargo:warning=Vocabulary data missing in {}: run scripts/build-wordnet.sh",
            dir.display()
        );
        if let Err(e) = std::fs::create_dir_all(&dir) {
            panic!("could not create {}: {e}", dir.display());
        }
    }
}

/// `tauri.conf.json` bundles `../resources/ocr-models/` (spec 7.2: the OCR models offline, CC-BY-SA-4.0).
/// `scripts/fetch-ocr-models.sh` fills it (the `beforeBuildCommand` runs it); a plain `cargo build`/`cargo test`
/// without it still compiles, and "Reconhecer texto" then answers that the models are missing.
fn ensure_ocr_models_dir() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../resources/ocr-models");
    if !dir.is_dir() {
        println!(
            "cargo:warning=OCR models missing in {}: run scripts/fetch-ocr-models.sh",
            dir.display()
        );
        if let Err(e) = std::fs::create_dir_all(&dir) {
            panic!("could not create {}: {e}", dir.display());
        }
    }
}
