//! The Tauri shell: app state, the commands of spec 15, the `pdf` cover protocol, the `anki`
//! (Anki's own pages) and `card` (sandboxed cards and media) protocols, and the smoke check. The
//! reader is PdfCraft's own web UI (`/pdfcraft/`, an iframe of the UI); all the real work lives in
//! the `core-*` crates and in plain [`AppState`] methods, so the integration tests need no webview.

pub mod ai;
pub mod ai_features;
pub mod ai_queue;
pub mod anki;
pub mod anki_web;
pub mod book_panel;
pub mod code;
mod commands;
pub mod deep_link;
pub mod epub;
mod error;
mod files;
pub mod grants;
pub mod jobs;
pub mod library;
pub mod ocr;
pub mod open_paths;
mod protocol;
pub mod protocol_anki;
pub mod protocol_card;
mod reading;
pub mod secrets;
mod smoke;
mod state;
pub mod sync;
pub mod vocab;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{App, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

pub use anki::{AnkiChanged, AnkiHandles, ChangeReason, StudyOwnerChange, UiEvent, UiSink};
pub use book_panel::{
    BookCardKind, BookDeckInfo, BookDeckRole, BookPanelInfo, BookPanelPatch, WordDefinition,
};
pub use deep_link::{DeepLink, deep_links_from_args, parse_deep_link};
pub use epub::{EpubAnnotation, EpubAnnotationInput, EpubMarkWord, EpubSectionMarks};
pub use error::AppError;
pub use files::BookFiles;
pub use jobs::{JobKind, JobProgress, JobStage};
pub use library::{AddedBook, BookOpen, SavedVersion};
pub use open_paths::open_paths_from_args;
pub use protocol::{cover_response, cover_url, protocol_url, ui_origins_with};
pub use reading::SessionStarted;
pub use smoke::SmokeReport;
pub use state::AppState;
pub use sync::{AnkiSyncStatus, FullSyncResult, SyncErrorInfo, SyncNotice, SyncState};
pub use vocab::deck::{VocabDeckOptions, VocabDeckResult, VocabWordAdded};
pub use vocab::marks::{VocabMark, VocabPageMarks};
pub use vocab::scan::{ScanStarted, VocabReport};
pub use vocab::{VocabDataInfo, VocabFolder, VocabOutline, VocabSettings, VocabSettingsPatch};

/// Overrides the app data dir (tests, CI and side-by-side dev profiles).
const DATA_DIR_ENV: &str = "LEITOR_DATA_DIR";
/// Route the main window opens at, e.g. `/dev/smoke` or `/leitor` (development aid).
const START_ROUTE_ENV: &str = "LEITOR_START_ROUTE";
/// Event with the PDF paths of a second launch ("Abrir com" while the app is open).
pub const OPEN_PATHS_EVENT: &str = "leitor://open-paths";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    #[cfg(desktop)]
    let cli = match cli::Cli::parse(std::env::args().skip(1)) {
        Ok(cli) => cli,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    #[cfg(desktop)]
    let launch_paths = if cli.smoke {
        Vec::new()
    } else {
        cli.paths.clone()
    };
    #[cfg(not(desktop))]
    let launch_paths = Vec::new();

    let app = match build(launch_paths) {
        Ok(app) => app,
        Err(e) => {
            tracing::error!(%e, "could not start the app");
            std::process::exit(1);
        }
    };

    #[cfg(desktop)]
    if cli.smoke {
        std::process::exit(cli::run_smoke(&app, cli.smoke_png.as_deref()));
    }

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let state = handle.state::<Arc<AppState>>();
            // Before the shutdown closes the collection: the deck from before "Revisar aqui" comes back.
            state.mini_review_close_on_exit();
            state.reading_stop_on_exit();
            state.shutdown();
        }
    });
}

fn build(launch_paths: Vec<String>) -> Result<App, Box<dyn std::error::Error>> {
    let builder = tauri::Builder::default();
    // Must be the first plugin: a second launch hands its paths over and exits right away.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        open_paths::second_instance(app, argv, &cwd);
    }));
    // Desktop only: packages dropped on the window may be imported (after the UI confirms), so
    // they get a read grant.
    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
        if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event
            && let Some(state) = window.try_state::<Arc<AppState>>()
        {
            let paths: Vec<String> = paths.iter().map(|p| p.display().to_string()).collect();
            state.grant_packages(&paths);
        }
    });
    let app = builder
        // `leitor://` links (spec 10.2): registered with the OS, forwarded by the single-instance plugin.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol(protocol::PDF_SCHEME, protocol::handle)
        .register_asynchronous_uri_scheme_protocol(
            protocol_anki::ANKI_SCHEME,
            protocol_anki::handle,
        )
        .register_asynchronous_uri_scheme_protocol(
            protocol_card::CARD_SCHEME,
            protocol_card::handle,
        )
        .invoke_handler(invoke_handler())
        .setup(|app| {
            let state = Arc::clone(app.state::<Arc<AppState>>().inner());
            let handle = app.handle().clone();
            state.set_ui_sink(Arc::new(move |event| emit_ui_event(&handle, event)));
            state.warm_up();
            #[cfg(desktop)]
            deep_link::setup(app, &state);
            reading::spawn_ticker(&state);
            anki::spawn_backup_ticker(&state);
            sync::driver::ensure_started(&state);
            // Without a window there is nothing to show; exit cleanly instead of panicking.
            if let Err(e) = create_main_window(app) {
                tracing::error!(%e, "could not create the main window");
                app.handle().exit(1);
            }
            Ok(())
        })
        .build(tauri::generate_context!())?;

    let data_dir = match std::env::var_os(DATA_DIR_ENV) {
        Some(dir) => PathBuf::from(dir),
        None => app.path().app_data_dir()?,
    };
    tracing::info!(data_dir = %data_dir.display(), "starting");
    let state = AppState::new(data_dir);
    state.push_open_paths(launch_paths);
    if let Ok(dir) = app.path().resource_dir() {
        state.set_vocab_resource_dir(dir.clone());
        state.set_ocr_resource_dir(dir);
    }
    let web = anki_web::AnkiWeb::resolve(
        std::env::var_os(anki_web::ANKI_WEB_DIR_ENV).map(PathBuf::from),
        app.path().resource_dir().ok(),
    );
    let origins = protocol::ui_origins(app.handle());
    let media_dir = core_anki::CollectionPaths::in_dir(&state.anki_dir()).media_folder;
    app.manage(Arc::new(protocol_card::CardFrames::new(
        web.clone(),
        media_dir,
        &origins,
    )));
    app.manage(Arc::new(protocol_anki::AnkiPages::new(web, origins)));
    app.manage(Arc::new(state));
    Ok(app)
}

/// Delivers a core event to the main window (or the system browser for links).
fn emit_ui_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: UiEvent) {
    let sent = match event {
        UiEvent::AnkiPage(e) => app.emit_to("main", anki::ANKI_PAGE_EVENT, &e),
        UiEvent::AnkiChanged(reason) => {
            app.emit_to("main", anki::ANKI_CHANGED_EVENT, AnkiChanged { reason })
        }
        UiEvent::AnkiSync(status) => app.emit_to("main", sync::ANKI_SYNC_EVENT, &status),
        UiEvent::StudyOwner(change) => app.emit_to("main", anki::STUDY_OWNER_EVENT, change),
        UiEvent::DeepLink(link) => app.emit_to("main", deep_link::DEEP_LINK_EVENT, &link),
        UiEvent::AiQueue(info) => app.emit_to("main", ai_queue::AI_QUEUE_EVENT, &info),
        UiEvent::Job(progress) => app.emit_to(
            "main",
            &format!("{}{}", jobs::JOB_EVENT_PREFIX, progress.job_id),
            &progress,
        ),
        UiEvent::OpenUrl(url) => {
            open_url(app, &url);
            Ok(())
        }
    };
    if let Err(e) = sent {
        tracing::warn!(%e, "could not send an event to the UI");
    }
}

#[cfg(desktop)]
fn open_url<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &str) {
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        tracing::warn!(%e, "could not open a link from an Anki page");
    }
}

#[cfg(not(desktop))]
fn open_url<R: tauri::Runtime>(_app: &tauri::AppHandle<R>, _url: &str) {
    tracing::warn!("opening links is not available on this platform yet");
}

/// Commands callable from the UI. `dev_smoke` and `dev_log` are development aids, so they only
/// exist in debug builds (release keeps `--smoke` on the CLI).
macro_rules! app_commands {
    ($($extra:path),*) => {
        tauri::generate_handler![
            commands::anki_deck_tree,
            commands::anki_deck_names,
            commands::anki_deck_create,
            commands::anki_deck_rename,
            commands::anki_deck_move,
            commands::anki_deck_delete,
            commands::anki_deck_set_collapsed,
            commands::anki_set_current_deck,
            commands::anki_prepare_collection,
            commands::anki_study_next,
            commands::anki_show_answer,
            commands::anki_answer,
            commands::anki_undo,
            commands::anki_card_action,
            commands::anki_study_close,
            commands::anki_mini_review_open,
            commands::anki_mini_review_close,
            commands::book_panel_info,
            commands::book_panel_set,
            commands::anki_book_cards,
            commands::vocab_define,
            commands::anki_notetypes,
            commands::anki_add_defaults,
            commands::anki_note_get,
            commands::anki_note_check,
            commands::anki_note_add,
            commands::anki_note_update,
            commands::anki_media_add,
            commands::anki_tags_all,
            commands::anki_search,
            commands::anki_browse_rows,
            commands::anki_cards_set_deck,
            commands::anki_notes_tags,
            commands::anki_cards_suspend,
            commands::anki_cards_forget,
            commands::anki_notes_delete,
            commands::anki_change_notetype_prepare,
            commands::anki_pick_package,
            commands::anki_import,
            commands::anki_import_colpkg,
            commands::anki_export,
            commands::anki_backup_now,
            commands::anki_backups,
            commands::ai_settings_get,
            commands::ai_settings_set,
            commands::ai_key_set,
            commands::ai_key_delete,
            commands::ai_key_test,
            commands::ai_prices_get,
            commands::ai_prices_set,
            commands::ai_usage,
            commands::ai_estimate,
            commands::ai_judge_code,
            commands::ai_cards_from_text,
            commands::ai_define_word,
            commands::ai_enrich_start,
            commands::ai_queue_get,
            commands::ai_queue_set_paused,
            commands::ai_queue_remove,
            commands::ai_queue_retry,
            commands::ai_queue_add_note,
            commands::anki_sync_status,
            commands::anki_sync_login,
            commands::anki_sync_logout,
            commands::anki_sync_set_certificate,
            commands::anki_sync,
            commands::anki_sync_full,
            commands::anki_sync_notify,
            commands::library_list,
            commands::library_add,
            commands::library_remove,
            commands::library_update,
            commands::book_open,
            commands::book_bytes,
            commands::book_save_version,
            commands::export_pick_path,
            commands::book_export,
            commands::export_bytes,
            commands::book_open_external,
            commands::doc_words,
            commands::position_get,
            commands::position_set,
            commands::reading_session_start,
            commands::reading_session_heartbeat,
            commands::reading_session_stop,
            commands::pending_open_paths,
            commands::pending_deep_links,
            commands::code_mapping_list,
            commands::code_mapping_set,
            commands::code_note_extra_get,
            commands::code_note_extra_set,
            commands::code_accept_answer,
            commands::code_run_cpp,
            commands::code_format_cpp,
            commands::code_status,
            commands::code_settings_get,
            commands::code_settings_set,
            commands::code_runner_test,
            commands::code_import_markdown,
            commands::code_import_commit,
            commands::vocab_settings_get,
            commands::vocab_settings_set,
            commands::vocab_folder,
            commands::vocab_mapping_samples,
            commands::vocab_mapping_get,
            commands::vocab_mapping_set,
            commands::vocab_outline,
            commands::vocab_range_check,
            commands::vocab_scan_start,
            commands::vocab_rescan,
            commands::vocab_report,
            commands::vocab_override_set,
            commands::vocab_generate_deck,
            commands::vocab_marks,
            commands::vocab_add_word,
            commands::vocab_data_info,
            commands::job_status,
            commands::job_cancel,
            commands::ocr_info,
            commands::ocr_start,
            commands::ocr_cancel,
            commands::epub_annotation_list,
            commands::epub_annotation_upsert,
            commands::epub_annotation_delete,
            commands::vocab_epub_marks,
            $($extra),*
        ]
    };
}

fn invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    #[cfg(debug_assertions)]
    return app_commands![commands::dev_smoke, commands::dev_log];
    #[cfg(all(not(debug_assertions), feature = "bridge-probe"))]
    return app_commands![commands::dev_log];
    #[cfg(all(not(debug_assertions), not(feature = "bridge-probe")))]
    return app_commands![];
}

/// The main window comes from `tauri.conf.json` (`create: false`), so it is only built for an
/// interactive run, optionally at `LEITOR_START_ROUTE`.
fn create_main_window(app: &App) -> tauri::Result<()> {
    let Some(config) = app.config().app.windows.iter().find(|w| w.label == "main") else {
        return Err(tauri::Error::WindowNotFound);
    };
    let mut config = config.clone();
    if let Ok(route) = std::env::var(START_ROUTE_ENV) {
        config.url = WebviewUrl::App(route.trim_start_matches('/').into());
    }
    let builder = WebviewWindowBuilder::from_config(app, &config)?;
    #[cfg(any(debug_assertions, feature = "bridge-probe"))]
    let builder = if let Some(mode) = std::env::var_os(BRIDGE_PROBE_ENV) {
        // `LEITOR_BRIDGE_PROBE=perf` also times open → active and the frames while scrolling;
        // `load` clicks the Leitor tab and times its first and later openings.
        let perf = mode == "perf";
        let load = mode == "load";
        builder.initialization_script(format!(
            "window.__probePerf = {perf};\nwindow.__probeLoad = {load};\n{BRIDGE_PROBE_JS}"
        ))
    } else {
        builder
    };
    let window = builder.build()?;
    #[cfg(target_os = "linux")]
    webkit::configure(&window);
    #[cfg(not(target_os = "linux"))]
    let _ = window;
    Ok(())
}

/// Debug builds: logs every `pdfcraft:*` message the UI receives (through `dev_log`), whether the
/// iframe sees Tauri's IPC, and WebGL support. Used to check the real webview under Xvfb.
/// Perf mode (`window.__probePerf`): logs `open` as received inside the iframe and `active`, with
/// absolute times, and the frame times inside the iframe between the first and the last
/// `pdfcraft:page` of a scroll (logged once the pages stop for 3 s). Phase 1 acceptance 4 in the
/// real WebKitGTK webview (docs/progresso.md).
/// Load mode (`window.__probeLoad`, scripts/load-real-app.sh): from the Biblioteca, clicks the
/// Leitor tab and logs click → `pdfcraft:ready` with `window.__leitorTimings`, then 5 round trips
/// through Biblioteca/Anki (click → painted) and whether the iframe survived them unreloaded.
/// Also in release builds with the `bridge-probe` feature.
#[cfg(any(debug_assertions, feature = "bridge-probe"))]
const BRIDGE_PROBE_ENV: &str = "LEITOR_BRIDGE_PROBE";
#[cfg(any(debug_assertions, feature = "bridge-probe"))]
const BRIDGE_PROBE_JS: &str = r#"
(() => {
  const log = (message) => window.__TAURI_INTERNALS__?.invoke('dev_log', { level: 'info', message });
  const abs = () => (performance.timeOrigin + performance.now()).toFixed(1);
  // Perf mode: frame times inside the iframe (rAF), summarized over each scroll.
  let frames = [];
  let scroll = null;
  let quiet = null;
  const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0; };
  const pageSeen = (at) => {
    if (!scroll) scroll = { from: at, pages: 0 };
    scroll.to = at;
    scroll.pages += 1;
    clearTimeout(quiet);
    quiet = setTimeout(() => {
      const ts = frames.filter((x) => x >= scroll.from && x <= scroll.to);
      const d = ts.slice(1).map((x, i) => x - ts[i]);
      log(`probe: perf scroll ms=${(scroll.to - scroll.from).toFixed(0)} pageMsgs=${scroll.pages} frames=${ts.length} p50=${pct(d, 50).toFixed(1)} p95=${pct(d, 95).toFixed(1)} long=${d.filter((x) => x > 50).length}`);
      scroll = null;
      frames = [];
    }, 3000);
  };
  // The same synthetic wheel input for every run: 1200 notches of 100 px (about 190 pages of the 500-page test PDF), one per 16 ms, on
  // PdfCraft's canvas (no xdotool in the devcontainer).
  const autoScroll = () => {
    const f = document.querySelector('iframe');
    const w = f && f.contentWindow;
    const c = w && w.document.querySelector('canvas');
    if (!c) { log('probe: perf no canvas to scroll'); return; }
    const r = c.getBoundingClientRect();
    log(`probe: perf iframe ${f.clientWidth}x${f.clientHeight}`);
    const at = { clientX: r.left + r.width * 0.45, clientY: r.top + r.height * 0.55, bubbles: true, cancelable: true };
    // egui scrolls what is under the pointer: move it there first.
    c.dispatchEvent(new w.PointerEvent('pointermove', { ...at, pointerType: 'mouse', isPrimary: true }));
    c.dispatchEvent(new w.MouseEvent('mousemove', at));
    let n = 0;
    const tick = () => {
      c.dispatchEvent(new w.WheelEvent('wheel', { ...at, deltaY: 100, deltaMode: 0 }));
      if (++n < 1200) setTimeout(tick, 16);
    };
    tick();
  };
  const perfAttach = (w) => {
    if (!window.__probePerf || !w || w.__probeAttached) return;
    w.__probeAttached = true;
    w.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'pdfcraft:open') log(`probe: perf open-received id=${String(e.data.id).slice(0, 12)} abs=${abs()}`);
    });
  };
  // Started once a document is active, so it runs in PdfCraft's final document.
  const startFrames = () => {
    const w = document.querySelector('iframe')?.contentWindow;
    if (!w) return;
    const loop = () => { frames.push(w.performance.timeOrigin + w.performance.now()); if (frames.length > 20000) frames.splice(0, 10000); w.requestAnimationFrame(loop); };
    w.requestAnimationFrame(loop);
  };
  if (window.__probePerf) {
    // Every iframe document (load events), as early as possible so the first `open` is seen.
    setInterval(() => {
      const f = document.querySelector('iframe');
      if (!f || f.__probeLoad) return;
      f.__probeLoad = true;
      perfAttach(f.contentWindow);
      f.addEventListener('load', () => perfAttach(f.contentWindow));
    }, 20);
  }
  // Load mode: the Leitor tab's first and later openings, driven by clicks on the app tabs.
  if (window.__probeLoad && window.top === window) {
    const tabLink = (href) => document.querySelector(`nav[aria-label="Abas"] a[href="${href}"]`);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(5); } return null; };
    const r1 = (x) => (x == null ? 'null' : (Math.round(x * 10) / 10).toFixed(1));
    const timings = () => window.__leitorTimings || [];
    const agains = () => timings().filter((t) => t.kind === 'again').length;
    const frameEl = () => document.querySelector('iframe[title="PdfCraft"]');
    let clickAbs = 0;
    const readyAbs = [];
    window.addEventListener('click', (e) => { clickAbs = performance.timeOrigin + e.timeStamp; }, true);
    window.addEventListener('message', (e) => { if (e.data && e.data.type === 'pdfcraft:ready') readyAbs.push(performance.timeOrigin + performance.now()); });
    const run = async () => {
      if (!(await until(() => tabLink('/leitor'), 60000))) { log('probe: load no Leitor tab'); return; }
      // Let the Biblioteca settle first (covers, queries), as a user would.
      await sleep(3000);
      tabLink('/leitor').click();
      const first = await until(() => timings().find((t) => t.kind === 'first'), 120000);
      if (!first) { log('probe: load first timeout'); return; }
      const activate = performance.timeOrigin + performance.getEntriesByName('leitor:activate')[0].startTime;
      const w = frameEl().contentWindow;
      const wasm = w.performance.getEntriesByType('resource').find((e) => e.name.endsWith('.wasm'));
      log(`probe: load first clickToReady=${r1(readyAbs[0] - clickAbs)} clickToActivate=${r1(activate - clickAbs)} activateToReady=${r1(first.ms)} frameStart=${r1(first.frameStartMs)} wasmFetched=${r1(first.wasmFetchedMs)} wasmTransferKB=${r1(wasm ? wasm.transferSize / 1024 : null)} wasmUrl=${wasm ? wasm.name.slice(0, 60) : 'none'}`);
      const el = frameEl();
      const origin = w.performance.timeOrigin;
      w.__leitorMarker = 'still-here';
      for (let i = 0; i < 5; i++) {
        await sleep(1000);
        tabLink(i % 2 ? '/anki' : '/biblioteca').click();
        await sleep(1000);
        const n = agains();
        tabLink('/leitor').click();
        if (!(await until(() => agains() > n, 30000))) { log(`probe: load again timeout ${i}`); continue; }
        const painted = performance.getEntriesByName('leitor:again-painted').at(-1);
        const again = timings().filter((t) => t.kind === 'again').at(-1);
        log(`probe: load again via=${i % 2 ? 'anki' : 'biblioteca'} clickToPaint=${r1(performance.timeOrigin + painted.startTime - clickAbs)} activateToPaint=${r1(again.ms)}`);
      }
      const now = frameEl();
      log(`probe: load reload-check sameElement=${now === el} marker=${now.contentWindow.__leitorMarker === 'still-here'} sameDocument=${now.contentWindow.performance.timeOrigin === origin} readyCount=${readyAbs.length} firsts=${timings().filter((t) => t.kind === 'first').length}`);
      log('probe: load done');
    };
    window.addEventListener('load', () => void run());
  }
  window.addEventListener('message', (e) => {
    const t = e.data && e.data.type;
    if (typeof t !== 'string' || !t.startsWith('pdfcraft:')) return;
    const frame = document.querySelector('iframe');
    // `frameIpc`: Tauri's IPC in the iframe's own window. `parentIpc`: what code inside the iframe
    // reaches through `parent` (same origin, so it is the UI's invoke: isolation is by trust, spec 18).
    let frameIpc = 'n/a';
    let parentIpc = 'n/a';
    try {
      frameIpc = String(!!frame?.contentWindow?.__TAURI_INTERNALS__);
      parentIpc = String(typeof frame?.contentWindow?.parent?.__TAURI_INTERNALS__?.invoke === 'function');
    } catch (_) { frameIpc = 'blocked'; parentIpc = 'blocked'; }
    const fields = ['id', 'page', 'pageCount', 'dirty', 'theme', 'bridge', 'error', 'name', 'saveAs'];
    const extra = fields.filter((k) => e.data[k] !== undefined).map((k) => ` ${k}=${String(e.data[k]).slice(0, 12)}`).join('')
      + (e.data.bytes ? ` bytes=${e.data.bytes.byteLength}` : '');
    log(`probe: ${t} origin=${e.origin} frameIpc=${frameIpc} parentIpc=${parentIpc}${extra} abs=${abs()}`);
    if (window.__probePerf && t === 'pdfcraft:page') pageSeen(Number(abs()));
    if (window.__probePerf && t === 'pdfcraft:active' && e.data.id && !window.__probeScrolled) {
      window.__probeScrolled = true;
      startFrames();
      setTimeout(autoScroll, 4000);
    }
  });
  const watch = (w, where) => {
    w.addEventListener('securitypolicyviolation', (e) => log(`probe: csp ${where} ${e.violatedDirective} ${e.blockedURI}`));
    w.addEventListener('error', (e) => log(`probe: error ${where} ${e.message || e.type}`));
    w.addEventListener('unhandledrejection', (e) => log(`probe: rejection ${where} ${e.reason}`));
  };
  watch(window, 'main');
  window.addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('canvas');
    log(`probe: page ${location.href} webgl2=${!!c.getContext('webgl2')} webgl=${!!document.createElement('canvas').getContext('webgl')}`);
  });
  let n = 0;
  const seen = new WeakSet();
  const timer = setInterval(() => {
    const f = document.querySelector('iframe');
    if (f && f.contentWindow && !seen.has(f.contentWindow)) { seen.add(f.contentWindow); watch(f.contentWindow, 'frame'); }
    let state = 'no iframe';
    if (f) {
      try {
        const d = f.contentDocument;
        state = `src=${f.getAttribute("src")} url=${f.contentWindow?.location.href} title=${d?.title} ready=${d?.readyState} canvas=${!!d?.querySelector("canvas")} wasm=${!!f.contentWindow?.wasmBindings} html=${(d?.documentElement?.outerHTML || "").slice(0, 300)}`;
      } catch (_) { state = `src=${f.getAttribute('src')} cross-origin`; }
    }
    log(`probe: t=${++n * 5}s ${state}`);
    if (n >= 6) clearInterval(timer);
  }, 5000);
})();
"#;

/// WebKitGTK settings for the embedded PdfCraft, which draws with WebGL (spec 22).
#[cfg(target_os = "linux")]
mod webkit {
    use webkit2gtk::{SettingsExt, WebViewExt};

    /// Debug builds: `LEITOR_WEBKIT_CONSOLE=1` writes the webview console to stdout.
    const WEBKIT_CONSOLE_ENV: &str = "LEITOR_WEBKIT_CONSOLE";

    pub fn configure(window: &tauri::WebviewWindow) {
        let result = window.with_webview(|webview| {
            let webview = webview.inner();
            if let Some(settings) = WebViewExt::settings(&webview) {
                settings.set_enable_webgl(true);
                // Debug aid for scripts/anki-real-app.sh: every frame's console (CSP violations
                // of the anki/card iframes included) goes to stdout.
                if cfg!(debug_assertions) && std::env::var_os(WEBKIT_CONSOLE_ENV).is_some() {
                    settings.set_enable_write_console_messages_to_stdout(true);
                }
                tracing::debug!(
                    webgl = settings.enables_webgl(),
                    policy = ?settings.hardware_acceleration_policy(),
                    "webkit settings"
                );
            }
        });
        if let Err(e) = result {
            tracing::warn!(%e, "could not configure the webview");
        }
    }
}

/// Logs go to stderr (stdout carries the `--smoke` report). `RUST_LOG` overrides the filter.
fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("info,leitor_app=debug,core_anki=debug,core_pdf=debug,core_store=debug")
    });
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .try_init();
}

#[cfg(desktop)]
mod cli {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use tauri::{App, Manager};

    use crate::smoke;
    use crate::state::AppState;

    #[derive(Debug, Default, PartialEq)]
    pub struct Cli {
        /// Run the smoke check headless, print the report as JSON and exit.
        pub smoke: bool,
        /// Also write the sample's cover (page 1) as PNG here.
        pub smoke_png: Option<PathBuf>,
        /// PDF files and Anki packages to open ("Abrir com"), made absolute.
        pub paths: Vec<String>,
    }

    impl Cli {
        /// Unknown flags are left alone (the OS or a launcher may add its own); other arguments
        /// that are existing PDFs or Anki packages are kept for "Abrir com".
        pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Self, String> {
            let mut cli = Self::default();
            let mut args = args.into_iter();
            let mut rest = Vec::new();
            while let Some(arg) = args.next() {
                match arg.as_str() {
                    "--smoke" => cli.smoke = true,
                    "--smoke-png" => match args.next() {
                        Some(path) => cli.smoke_png = Some(path.into()),
                        None => return Err("--smoke-png precisa de um caminho".into()),
                    },
                    _ => {
                        if let Some(path) = arg.strip_prefix("--smoke-png=") {
                            cli.smoke_png = Some(path.into());
                        } else {
                            rest.push(arg);
                        }
                    }
                }
            }
            if cli.smoke_png.is_some() && !cli.smoke {
                return Err("--smoke-png só vale junto com --smoke".into());
            }
            let cwd = std::env::current_dir().unwrap_or_default();
            cli.paths = crate::open_paths::open_paths_from_args(rest, &cwd);
            Ok(cli)
        }
    }

    /// Returns the process exit code.
    pub fn run_smoke(app: &App, png: Option<&Path>) -> i32 {
        let state = Arc::clone(app.state::<Arc<AppState>>().inner());
        let code = match smoke_and_print(&state, png) {
            Ok(()) => 0,
            Err(e) => {
                eprintln!(
                    "{}",
                    serde_json::to_string(&e).unwrap_or_else(|_| e.to_string())
                );
                1
            }
        };
        state.shutdown();
        code
    }

    fn smoke_and_print(state: &AppState, png: Option<&Path>) -> Result<(), crate::AppError> {
        let (report, cover) = smoke::run(state)?;
        if let Some(path) = png {
            std::fs::write(path, cover).map_err(|e| {
                crate::AppError::new(
                    "file_write",
                    format!("Não foi possível gravar {}: {e}", path.display()),
                )
            })?;
        }
        let json = serde_json::to_string_pretty(&report).map_err(crate::AppError::internal)?;
        println!("{json}");
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn parse(args: &[&str]) -> Result<Cli, String> {
            Cli::parse(args.iter().map(|s| s.to_string()))
        }

        #[test]
        fn parses_smoke_flags() {
            assert_eq!(parse(&[]).unwrap(), Cli::default());
            let cli = parse(&["--smoke", "--smoke-png", "/tmp/p1.png"]).unwrap();
            assert!(cli.smoke);
            assert_eq!(cli.smoke_png, Some(PathBuf::from("/tmp/p1.png")));
            let cli = parse(&["--smoke-png=/tmp/a.png", "--smoke", "-psn_0_1"]).unwrap();
            assert_eq!(cli.smoke_png, Some(PathBuf::from("/tmp/a.png")));
            assert!(cli.paths.is_empty());
            assert!(parse(&["--smoke", "--smoke-png"]).is_err());
            assert!(parse(&["--smoke-png", "x.png"]).is_err());
        }

        #[test]
        fn keeps_pdf_paths_for_open_with() {
            let dir = tempfile::tempdir().unwrap();
            let pdf = dir.path().join("Livro.PDF");
            std::fs::write(&pdf, b"%PDF-1.4").unwrap();
            let pdf = pdf.display().to_string();
            let cli = parse(&["-psn_0_1", &pdf, "/nao/existe.pdf", "notas.txt"]).unwrap();
            assert_eq!(cli.paths, vec![pdf]);
            assert!(!cli.smoke);
        }
    }
}
