//! `leitor://livro/<book_uid>?pagina=N&q=…` links opened by the OS (spec 10.2, 15): "Abrir no livro" from a card
//! seen outside the app. The scheme is registered with the system by `tauri-plugin-deep-link` (the bundler writes
//! `MimeType=x-scheme-handler/leitor` / the Windows registry keys; [`registration_plan`] decides when the app also
//! registers it at run time, off the startup path: AppImage and unbundled Windows runs, debug builds only on request).
//!
//! Delivery:
//! - first launch: the URL in the arguments (and the plugin's `get_current`) is queued until the UI asks
//!   (`pending_deep_links`);
//! - the app is running: a second launch hands its arguments to the single-instance plugin, which forwards a lone
//!   URL argument to the deep-link plugin (`on_open_url` → [`AppState::deliver_deep_links`]); any other argument list
//!   is checked here ([`AppState::second_instance_deep_links`]), so every link produces exactly one event.
//!
//! Every link becomes [`DEEP_LINK_EVENT`] with a [`DeepLink`] payload; invalid links are logged and dropped. Parsing
//! is shared with the Fonte links ([`core_anki::study::source::parse_link`]) and never panics.

use serde::{Deserialize, Serialize};

use crate::anki::UiEvent;
use crate::state::{AppState, lock};

/// Event with a [`DeepLink`] for the main window.
pub const DEEP_LINK_EVENT: &str = "leitor://deep-link";
/// The scheme registered with the OS (also in `tauri.conf.json` → `plugins.deep-link.desktop.schemes`).
pub const SCHEME: &str = "leitor";
/// Longer URLs are refused before parsing.
pub const MAX_URL_BYTES: usize = 4096;
/// At most this many links are queued for the UI (a launch has one).
const MAX_PENDING: usize = 16;
const PREFIX: &str = "leitor://livro/";

/// A parsed book link (payload of [`DEEP_LINK_EVENT`] and `pending_deep_links`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepLink {
    /// 64 lowercase hex chars.
    pub book_uid: String,
    /// 1-based.
    pub page: u32,
    /// The text to find on the page (at most 500 chars), when the link has one.
    pub query: Option<String>,
}

/// `leitor://livro/<64 lowercase hex>?pagina=N[&q=…]` → [`DeepLink`]. The scheme and host are case-insensitive
/// (some launchers change them); the uid is not. `None` for anything else: other schemes or hosts, a missing or
/// non-positive `pagina`, an uppercase or short uid, URLs over [`MAX_URL_BYTES`].
pub fn parse_deep_link(url: &str) -> Option<DeepLink> {
    if url.len() > MAX_URL_BYTES {
        return None;
    }
    let url = url.trim();
    let head = url.get(..PREFIX.len())?;
    if !head.eq_ignore_ascii_case(PREFIX) {
        return None;
    }
    let normalized = format!("{PREFIX}{}", &url[PREFIX.len()..]);
    let link = core_anki::study::source::parse_link(&normalized, "")?;
    Some(DeepLink {
        book_uid: link.book_uid,
        page: link.page,
        query: link.query,
    })
}

/// Whether an argument looks like a `leitor:` URL (case-insensitive scheme).
pub fn is_deep_link_arg(arg: &str) -> bool {
    arg.trim()
        .get(..SCHEME.len() + 1)
        .is_some_and(|s| s.eq_ignore_ascii_case("leitor:"))
}

/// The valid `leitor://` links among command-line arguments (duplicates once, in order). File paths and flags are
/// ignored here, as `leitor://` arguments are in [`crate::open_paths_from_args`].
pub fn deep_links_from_args(args: impl IntoIterator<Item = String>) -> Vec<DeepLink> {
    let mut out: Vec<DeepLink> = Vec::new();
    for arg in args {
        if !is_deep_link_arg(&arg) {
            continue;
        }
        match parse_deep_link(&arg) {
            Some(link) if !out.contains(&link) => out.push(link),
            Some(_) => {}
            None => tracing::warn!("ignored an invalid leitor:// link"),
        }
    }
    out
}

/// Whether the deep-link plugin forwards this second-launch `argv` itself (its Linux/Windows rule in
/// `DeepLink::handle_cli_arguments`: exactly one argument after the program, a URL of a configured scheme).
pub fn forwarded_by_plugin(argv: &[String]) -> bool {
    argv.len() == 2
        && argv[1]
            .split_once(':')
            .is_some_and(|(scheme, _)| scheme.eq_ignore_ascii_case(SCHEME))
}

impl AppState {
    /// Emits [`DEEP_LINK_EVENT`] for each valid link among `urls` (the deep-link plugin's `on_open_url`). Returns how
    /// many were sent.
    pub fn deliver_deep_links<S: AsRef<str>>(&self, urls: impl IntoIterator<Item = S>) -> usize {
        let mut sent: Vec<DeepLink> = Vec::new();
        for url in urls {
            match parse_deep_link(url.as_ref()) {
                Some(link) if !sent.contains(&link) => {
                    tracing::info!(page = link.page, "deep link");
                    self.emit(UiEvent::DeepLink(link.clone()));
                    sent.push(link);
                }
                Some(_) => {}
                None => tracing::warn!("ignored an invalid leitor:// link"),
            }
        }
        sent.len()
    }

    /// A second launch's links that the deep-link plugin does not forward (see [`forwarded_by_plugin`]); emits them.
    pub fn second_instance_deep_links(&self, argv: &[String]) -> usize {
        if forwarded_by_plugin(argv) {
            return 0;
        }
        let links = deep_links_from_args(argv.iter().skip(1).cloned());
        let n = links.len();
        for link in links {
            self.emit(UiEvent::DeepLink(link));
        }
        n
    }

    /// Queues the links of the first launch until the UI asks for them.
    pub fn push_deep_links(&self, links: Vec<DeepLink>) {
        let mut queue = lock(&self.deep_links);
        for link in links {
            if !queue.contains(&link) && queue.len() < MAX_PENDING {
                queue.push(link);
            }
        }
    }

    /// The queued launch links; each one is returned once.
    pub fn take_deep_links(&self) -> Vec<DeepLink> {
        std::mem::take(&mut *lock(&self.deep_links))
    }
}

/// Desktop wiring of the deep-link plugin, called from `setup`: runtime registration of the scheme when needed
/// ([`registration_plan`]; in a background thread, failures are logged, startup never waits or fails), the launch
/// URL(s), and `on_open_url` while running.
#[cfg(desktop)]
pub fn setup<R: tauri::Runtime>(app: &tauri::App<R>, state: &std::sync::Arc<AppState>) {
    use tauri_plugin_deep_link::DeepLinkExt;

    register_with_os(app);
    let mut urls: Vec<String> = match app.deep_link().get_current() {
        Ok(current) => current
            .unwrap_or_default()
            .into_iter()
            .map(|u| u.to_string())
            .collect(),
        Err(e) => {
            tracing::warn!(%e, "could not read the launch deep link");
            Vec::new()
        }
    };
    urls.extend(std::env::args().skip(1).filter(|a| is_deep_link_arg(a)));
    let links = deep_links_from_args(urls);
    if !links.is_empty() {
        tracing::info!(count = links.len(), "launched with deep links");
        state.push_deep_links(links);
    }
    let state = std::sync::Arc::clone(state);
    app.deep_link().on_open_url(move |event| {
        let urls: Vec<String> = event.urls().into_iter().map(|u| u.to_string()).collect();
        state.deliver_deep_links(urls);
    });
}

/// Run-time registration switch: `0` never registers, `1` registers even where it is skipped by default (debug
/// builds, a Linux binary that is not an AppImage). Unset: see [`registration_plan`].
#[cfg(desktop)]
const REGISTER_ENV: &str = "LEITOR_DEEP_LINK_REGISTER";

/// Whether this run should make sure `leitor://` points at it ([`registration_plan`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Registration {
    /// Leave the system alone.
    Skip(&'static str),
    /// Register in the background unless this binary is already the handler (or, on Linux, the user chose another
    /// handler).
    IfNeeded,
}

/// The run-time registration policy, kept off the startup path and away from the user's choices:
/// - `LEITOR_DEEP_LINK_REGISTER=0` → skip, `=1` → register if needed;
/// - debug builds skip by default (a `target/debug` binary must not become the system handler);
/// - on Linux only an AppImage registers at run time: `.deb`/`.rpm` installs already carry
///   `MimeType=x-scheme-handler/leitor` from the bundler, and a second handler file would outlive an uninstall;
/// - otherwise (Windows; a release AppImage) register if needed.
pub fn registration_plan(
    env: Option<&str>,
    debug: bool,
    linux: bool,
    appimage: bool,
) -> Registration {
    match env.map(str::trim) {
        Some("0") => return Registration::Skip("disabled by LEITOR_DEEP_LINK_REGISTER=0"),
        Some("1") => return Registration::IfNeeded,
        _ => {}
    }
    if debug {
        return Registration::Skip("debug build (set LEITOR_DEEP_LINK_REGISTER=1 to register)");
    }
    if linux && !appimage {
        return Registration::Skip("installed package: the bundler registered the scheme");
    }
    Registration::IfNeeded
}

/// Linux: what to do given the first line of `xdg-mime query default x-scheme-handler/leitor` (`None` when there is
/// no default). Registers when nothing handles the scheme, or when our handler file is the default but points at an
/// old path (a moved AppImage); never takes the scheme back from another handler the user (or a package) chose.
pub fn linux_needs_register(
    current_default: Option<&str>,
    our_file: &str,
    exec_matches: bool,
) -> bool {
    match current_default.map(str::trim).filter(|d| !d.is_empty()) {
        None => true,
        Some(d) if d == our_file => !exec_matches,
        Some(_) => false,
    }
}

#[cfg(desktop)]
fn register_with_os<R: tauri::Runtime>(app: &tauri::App<R>) {
    #[cfg(any(target_os = "linux", windows))]
    {
        use tauri::Manager;

        let env = std::env::var(REGISTER_ENV).ok();
        let appimage = app.env().appimage.is_some();
        match registration_plan(
            env.as_deref(),
            cfg!(debug_assertions),
            cfg!(target_os = "linux"),
            appimage,
        ) {
            Registration::Skip(why) => tracing::info!("leitor:// registration skipped: {why}"),
            Registration::IfNeeded => {
                // `xdg-mime`/`update-desktop-database` are subprocesses (often hundreds of ms): never on the startup
                // path.
                let handle = app.handle().clone();
                let spawned = std::thread::Builder::new()
                    .name("deep-link-register".into())
                    .spawn(move || register_if_needed(&handle));
                if let Err(e) = spawned {
                    tracing::warn!(%e, "could not start the leitor:// registration");
                }
            }
        }
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    let _ = app;
}

#[cfg(all(desktop, any(target_os = "linux", windows)))]
fn register_if_needed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri_plugin_deep_link::DeepLinkExt;

    #[cfg(target_os = "linux")]
    let needed = linux_registration_needed(app);
    #[cfg(windows)]
    let needed = !matches!(app.deep_link().is_registered(SCHEME), Ok(true));
    if !needed {
        tracing::info!("leitor:// already handled; registration not needed");
        return;
    }
    match app.deep_link().register(SCHEME) {
        Ok(()) => tracing::info!("leitor:// registered with the system"),
        Err(e) => tracing::warn!(%e, "could not register leitor:// with the system"),
    }
}

/// See [`linux_needs_register`]. The handler file and its `Exec` line follow `tauri-plugin-deep-link`'s `register`.
#[cfg(all(desktop, target_os = "linux"))]
fn linux_registration_needed<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> bool {
    use tauri::Manager;

    let Ok(bin) = tauri::utils::platform::current_exe() else {
        return false;
    };
    let Some(name) = bin.file_name() else {
        return false;
    };
    let our_file = format!("{}-handler.desktop", name.to_string_lossy());
    let output = match std::process::Command::new("xdg-mime")
        .args(["query", "default", &format!("x-scheme-handler/{SCHEME}")])
        .output()
    {
        Ok(output) => output,
        Err(e) => {
            tracing::warn!(%e, "xdg-mime unavailable; leitor:// not registered");
            return false;
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    // xdg-utils exits with 4 when there is no default handler.
    let current = if output.status.success() {
        stdout.lines().next()
    } else {
        None
    };
    let exec = app
        .env()
        .appimage
        .unwrap_or_else(|| bin.into_os_string())
        .to_string_lossy()
        .into_owned();
    let exec_line = format!("Exec=\"{exec}\" %u");
    let exec_matches = app
        .path()
        .data_dir()
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("applications").join(&our_file)).ok())
        .is_some_and(|f| f.lines().any(|l| l.trim() == exec_line));
    linux_needs_register(current, &our_file, exec_matches)
}

#[cfg(test)]
mod tests {
    use super::*;

    const UID: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn link(page: u32, query: Option<&str>) -> DeepLink {
        DeepLink {
            book_uid: UID.into(),
            page,
            query: query.map(String::from),
        }
    }

    #[test]
    fn valid_links() {
        assert_eq!(
            parse_deep_link(&format!("leitor://livro/{UID}?pagina=37")),
            Some(link(37, None))
        );
        assert_eq!(
            parse_deep_link(&format!(
                "leitor://livro/{UID}?pagina=2&q=the%20windmill%20%C3%A9"
            )),
            Some(link(2, Some("the windmill é")))
        );
        // `+` is a space, as in a form-encoded query; surrounding whitespace is trimmed.
        assert_eq!(
            parse_deep_link(&format!("  leitor://livro/{UID}?q=a+b&pagina=5  ")),
            Some(link(5, Some("a b")))
        );
        // Scheme and host are case-insensitive; an empty q is no query.
        assert_eq!(
            parse_deep_link(&format!("LEITOR://Livro/{UID}?pagina=1&q=")),
            Some(link(1, None))
        );
        // Unknown parameters and a fragment are ignored.
        assert_eq!(
            parse_deep_link(&format!("leitor://livro/{UID}?x=1&pagina=3#frag")),
            Some(link(3, None))
        );
    }

    #[test]
    fn query_is_capped() {
        let q = "a".repeat(800);
        let l = parse_deep_link(&format!("leitor://livro/{UID}?pagina=1&q={q}")).unwrap();
        assert_eq!(l.query.unwrap().chars().count(), 500);
    }

    #[test]
    fn invalid_links() {
        let upper = UID.to_uppercase();
        for bad in [
            format!("leitor://livro/{upper}?pagina=1"),
            format!("leitor://livro/{}?pagina=1", &UID[1..]),
            format!("leitor://livro/{UID}"),
            format!("leitor://livro/{UID}?pagina=0"),
            format!("leitor://livro/{UID}?pagina=-1"),
            format!("leitor://livro/{UID}?pagina=abc"),
            format!("leitor://livro/{UID}?q=x"),
            format!("leitor://outro/{UID}?pagina=1"),
            format!("leitora://livro/{UID}?pagina=1"),
            format!("https://livro/{UID}?pagina=1"),
            format!("file:///livro/{UID}?pagina=1"),
            "leitor://".to_string(),
            "leitor:".to_string(),
            String::new(),
        ] {
            assert_eq!(parse_deep_link(&bad), None, "{bad}");
        }
        let long = format!(
            "leitor://livro/{UID}?pagina=1&q={}",
            "a".repeat(MAX_URL_BYTES)
        );
        assert_eq!(parse_deep_link(&long), None);
        let just_fits = format!("leitor://livro/{UID}?pagina=1&q=");
        let fill = "b".repeat(MAX_URL_BYTES - just_fits.len());
        assert!(parse_deep_link(&format!("{just_fits}{fill}")).is_some());
    }

    #[test]
    fn garbage_never_panics() {
        let base = format!("leitor://livro/{UID}?pagina=12&q=caf%C3%A9%20%E2%9C%93+x");
        // Every truncation (at char boundaries) of a valid link, and of a multi-byte one.
        for s in [base.as_str(), "leitor://livro/é?pagina=1&q=%FF%FE%"] {
            for (i, _) in s.char_indices() {
                let _ = parse_deep_link(&s[..i]);
                let _ = parse_deep_link(&s[i..]);
            }
        }
        // Pseudo-random bytes (xorshift), lossily decoded, with the prefix and without.
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        for n in 0..2000 {
            let len = (n % 300) + 1;
            let bytes: Vec<u8> = (0..len)
                .map(|_| {
                    x ^= x << 13;
                    x ^= x >> 7;
                    x ^= x << 17;
                    (x & 0xff) as u8
                })
                .collect();
            let junk = String::from_utf8_lossy(&bytes);
            let _ = parse_deep_link(&junk);
            let _ = parse_deep_link(&format!("leitor://livro/{UID}?{junk}"));
            let _ = parse_deep_link(&format!("leitor://livro/{junk}"));
            let _ = deep_links_from_args([junk.to_string()]);
        }
    }

    #[test]
    fn args_pick_only_links() {
        let url = format!("leitor://livro/{UID}?pagina=4&q=x");
        let got = deep_links_from_args([
            "/usr/bin/leitor-estudos".to_string(),
            "--flag".into(),
            "/tmp/a.pdf".into(),
            url.clone(),
            url.clone(),
            "leitor://livro/nope?pagina=1".into(),
            format!("Leitor://livro/{UID}?pagina=9"),
        ]);
        assert_eq!(got, vec![link(4, Some("x")), link(9, None)]);
    }

    #[test]
    fn plugin_forwarding_rule() {
        let url = format!("leitor://livro/{UID}?pagina=4");
        let argv = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(forwarded_by_plugin(&argv(&["bin", &url])));
        assert!(!forwarded_by_plugin(&argv(&["bin", "--x", &url])));
        assert!(!forwarded_by_plugin(&argv(&["bin", "/tmp/a.pdf"])));
        assert!(!forwarded_by_plugin(&argv(&["bin"])));
    }

    #[test]
    fn registration_policy() {
        use Registration::*;
        // The env var wins: 0 never, 1 always (if needed), even in debug and for a non-AppImage Linux binary.
        assert!(matches!(
            registration_plan(Some("0"), false, false, true),
            Skip(_)
        ));
        assert_eq!(registration_plan(Some("1"), true, true, false), IfNeeded);
        // Debug builds stay out of the system by default.
        assert!(matches!(
            registration_plan(None, true, false, false),
            Skip(_)
        ));
        assert!(matches!(
            registration_plan(Some(""), true, true, true),
            Skip(_)
        ));
        // Linux: packages are registered by the bundler; only an AppImage registers itself.
        assert!(matches!(
            registration_plan(None, false, true, false),
            Skip(_)
        ));
        assert_eq!(registration_plan(None, false, true, true), IfNeeded);
        // Windows release.
        assert_eq!(registration_plan(None, false, false, false), IfNeeded);
    }

    #[test]
    fn linux_registration_respects_other_handlers() {
        let ours = "leitor-estudos-handler.desktop";
        assert!(linux_needs_register(None, ours, false));
        assert!(linux_needs_register(Some("  "), ours, false));
        // Already ours and current: nothing to do; ours but a moved AppImage: refresh.
        assert!(!linux_needs_register(Some(ours), ours, true));
        assert!(linux_needs_register(Some(ours), ours, false));
        // Another handler (the user's choice, or the installed package's .desktop) is left alone.
        assert!(!linux_needs_register(
            Some("leitor-de-estudos.desktop"),
            ours,
            false
        ));
    }

    #[test]
    fn payload_is_camel_case() {
        let json = serde_json::to_value(link(3, Some("q"))).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "bookUid": UID, "page": 3, "query": "q" })
        );
    }
}
