/// App commands get `allow-<command>` permissions; only the capabilities in `capabilities/` grant them,
/// so a webview without a capability (Anki pages, card iframes) cannot invoke anything.
const COMMANDS: &[&str] = &[
    "anki_deck_tree",
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
    "dev_smoke",
    "dev_log",
];

fn main() {
    let manifest = tauri_build::AppManifest::new().commands(COMMANDS);
    if let Err(e) = tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)) {
        panic!("tauri-build failed: {e:#}");
    }
}
