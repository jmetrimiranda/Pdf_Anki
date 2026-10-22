/// App commands get `allow-<command>` permissions; only the capabilities in `capabilities/` grant them,
/// so a webview without a capability (Anki pages, card iframes) cannot invoke anything.
const COMMANDS: &[&str] = &[
    "anki_deck_tree",
    "doc_open_path",
    "doc_info",
    "doc_outline",
    "doc_words",
    "doc_search",
    "doc_close",
    "dev_smoke",
];

fn main() {
    let manifest = tauri_build::AppManifest::new().commands(COMMANDS);
    if let Err(e) = tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)) {
        panic!("tauri-build failed: {e:#}");
    }
}
