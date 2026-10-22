//! The Tauri shell: app state, the Phase 0 commands, the `pdf` protocol and the smoke check.
//! All the real work lives in the `core-*` crates.

mod commands;
mod error;
mod protocol;
mod smoke;
mod state;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{App, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

pub use error::AppError;
pub use protocol::{protocol_url, render_url};
pub use smoke::SmokeReport;
pub use state::AppState;

/// Overrides the app data dir (tests, CI and side-by-side dev profiles).
const DATA_DIR_ENV: &str = "LEITOR_DATA_DIR";
/// Route the main window opens at, e.g. `/dev/smoke` (development aid).
const START_ROUTE_ENV: &str = "LEITOR_START_ROUTE";

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

    let app = match build() {
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
            handle.state::<Arc<AppState>>().shutdown();
        }
    });
}

fn build() -> Result<App, Box<dyn std::error::Error>> {
    let app = tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol(protocol::PDF_SCHEME, protocol::handle)
        .invoke_handler(invoke_handler())
        .setup(|app| {
            app.state::<Arc<AppState>>().warm_up();
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
    app.manage(Arc::new(AppState::new(data_dir)));
    Ok(app)
}

/// Commands callable from the UI. `dev_smoke` is a development aid, so it only exists in debug
/// builds (release keeps `--smoke` on the CLI). Both use a separate smoke collection.
macro_rules! app_commands {
    ($($extra:path),*) => {
        tauri::generate_handler![
            commands::anki_deck_tree,
            commands::doc_open_path,
            commands::doc_info,
            commands::doc_outline,
            commands::doc_words,
            commands::doc_search,
            commands::doc_close,
            $($extra),*
        ]
    };
}

fn invoke_handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    #[cfg(debug_assertions)]
    return app_commands![commands::dev_smoke];
    #[cfg(not(debug_assertions))]
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
    WebviewWindowBuilder::from_config(app, &config)?.build()?;
    Ok(())
}

/// Logs go to stderr (stdout carries the `--smoke` report). `RUST_LOG` overrides the filter.
fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,leitor_app=debug,core_anki=debug,core_pdf=debug"));
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
        /// Also write page 1 as PNG here.
        pub smoke_png: Option<PathBuf>,
    }

    impl Cli {
        /// Unknown arguments are left alone (the OS or a launcher may add its own).
        pub fn parse(args: impl IntoIterator<Item = String>) -> Result<Self, String> {
            let mut cli = Self::default();
            let mut args = args.into_iter();
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
                        }
                    }
                }
            }
            if cli.smoke_png.is_some() && !cli.smoke {
                return Err("--smoke-png só vale junto com --smoke".into());
            }
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
        let (report, doc) = smoke::run(state)?;
        if let Some(path) = png {
            let bytes = smoke::page1_png(state, doc)?;
            std::fs::write(path, bytes).map_err(|e| {
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
            assert!(parse(&["--smoke", "--smoke-png"]).is_err());
            assert!(parse(&["--smoke-png", "x.png"]).is_err());
        }
    }
}
