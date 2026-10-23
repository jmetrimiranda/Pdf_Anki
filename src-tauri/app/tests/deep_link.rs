//! `leitor://` links (spec 10.2, 15) through `AppState`, without a webview: the launch queue, the deep-link plugin's
//! `on_open_url` path and a second launch's arguments. Each link must reach the UI exactly once.

use std::sync::{Arc, Mutex};

use leitor_app::deep_link::forwarded_by_plugin;
use leitor_app::{AppState, DeepLink, UiEvent, deep_links_from_args, open_paths_from_args};

const UID: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

struct Env {
    _dir: tempfile::TempDir,
    state: AppState,
    events: Arc<Mutex<Vec<UiEvent>>>,
}

impl Env {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().join("data"));
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        state.set_ui_sink(Arc::new(move |e| sink.lock().unwrap().push(e)));
        Self {
            _dir: dir,
            state,
            events,
        }
    }

    fn links(&self) -> Vec<DeepLink> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                UiEvent::DeepLink(l) => Some(l.clone()),
                _ => None,
            })
            .collect()
    }

    /// What the running app does with a second launch: the single-instance plugin first hands the arguments to the
    /// deep-link plugin (which forwards a lone URL to `on_open_url`), then calls our callback.
    fn second_launch(&self, argv: &[&str]) {
        let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
        if forwarded_by_plugin(&argv) {
            self.state.deliver_deep_links([argv[1].as_str()]);
        }
        self.state.second_instance_deep_links(&argv);
    }
}

fn expected(page: u32, query: Option<&str>) -> DeepLink {
    DeepLink {
        book_uid: UID.into(),
        page,
        query: query.map(String::from),
    }
}

#[test]
fn a_second_launch_with_a_link_emits_exactly_one_event() {
    let env = Env::new();
    let url = format!("leitor://livro/{UID}?pagina=37&q=the%20windmill");
    env.second_launch(&["/usr/bin/leitor-estudos", &url]);
    assert_eq!(env.links(), vec![expected(37, Some("the windmill"))]);

    // With other arguments the plugin skips it; our callback picks it up (still once).
    env.events.lock().unwrap().clear();
    env.second_launch(&["/usr/bin/leitor-estudos", "--new-window", &url, &url]);
    assert_eq!(env.links(), vec![expected(37, Some("the windmill"))]);

    // Invalid links and plain files emit nothing.
    env.events.lock().unwrap().clear();
    env.second_launch(&["/usr/bin/leitor-estudos", "leitor://livro/xyz?pagina=1"]);
    env.second_launch(&["/usr/bin/leitor-estudos", "/tmp/livro.pdf"]);
    assert!(env.links().is_empty());
}

#[test]
fn launch_links_are_queued_once() {
    let env = Env::new();
    let args = [
        "/usr/bin/leitor-estudos".to_string(),
        format!("leitor://livro/{UID}?pagina=2"),
    ];
    env.state
        .push_deep_links(deep_links_from_args(args.iter().skip(1).cloned()));
    // The plugin's `get_current` can report the same URL: no duplicate.
    env.state.push_deep_links(vec![expected(2, None)]);
    assert_eq!(env.state.take_deep_links(), vec![expected(2, None)]);
    assert!(env.state.take_deep_links().is_empty());
    assert!(env.links().is_empty(), "queued, not emitted");
}

#[test]
fn files_and_links_never_mix() {
    let dir = tempfile::tempdir().unwrap();
    let pdf = dir.path().join("a.pdf");
    std::fs::write(&pdf, b"%PDF-1.4").unwrap();
    let pdf = pdf.display().to_string();
    let url = format!("leitor://livro/{UID}?pagina=5&q=x.pdf");
    let args = vec![pdf.clone(), url.clone()];
    assert_eq!(open_paths_from_args(args.clone(), dir.path()), vec![pdf]);
    assert_eq!(deep_links_from_args(args), vec![expected(5, Some("x.pdf"))]);
}
