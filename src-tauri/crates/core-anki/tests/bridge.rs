//! The `/_anki/` bridge (spec 8.3, 8.4, 20 "Ponte /_anki/").
//!
//! Every whitelisted method goes through `Bridge::post` against a collection. When the integrator
//! has recorded the real pages (`tests/fixtures/bridge/fixture.colpkg` + `<method>.bin`, optional
//! `<method>.json` = `{ "opChanges": 1|2|3, "note": "…" }`, from `scripts/record-anki-posts.sh`),
//! that collection and body are used; otherwise the collection is built with `core_anki::fixture`
//! and the request is constructed with prost. Tests never write into `tests/fixtures`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anki_proto::search::search_node::Filter;
use core_anki::anki::services::{
    CardsService, DeckConfigService, DecksService, ImageOcclusionService, ImportExportService,
    NotesService, NotetypesService, SearchService,
};
use core_anki::bridge::{
    Bridge, BridgeEvent, CARD_METHODS, Caller, Decision, EXPOSED_METHODS, POST_HANDLERS, PostReply,
    PostRequest, decision,
};
use core_anki::study::{Study, StudyNext};
use core_anki::{AnkiService, Collection, fixture};
use prost::Message;

// ---------------------------------------------------------------------------------------------
// Environment

struct Env {
    _dir: tempfile::TempDir,
    tmp: PathBuf,
    svc: AnkiService,
    study: Study,
    bridge: Bridge,
    events: Arc<Mutex<Vec<BridgeEvent>>>,
    ctx: Ctx,
    recorded: bool,
}

/// Ids from the collection, looked up through rslib so they work for the fixture and for a
/// recorded `.colpkg`.
#[derive(Clone, Debug)]
struct Ctx {
    deck_id: i64,
    deck_name: String,
    card_id: i64,
    note_id: i64,
    basic_ntid: i64,
    other_normal_ntid: i64,
    cloze_ntid: i64,
}

fn recordings_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bridge")
}

fn recorded_colpkg() -> Option<PathBuf> {
    let path = recordings_dir().join("fixture.colpkg");
    path.is_file().then_some(path)
}

/// Runs `f` on the actor from a test (the actor is its own thread, so blocking here is fine).
fn on_col<R: Send + 'static>(
    svc: &AnkiService,
    f: impl FnOnce(&mut Collection) -> core_anki::Result<R> + Send + 'static,
) -> R {
    svc.call_blocking(f).expect("actor call")
}

async fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let tmp = dir.path().join("tmp");
    std::fs::create_dir_all(&tmp).unwrap();
    let svc = AnkiService::open(&dir.path().join("anki")).unwrap();
    let recorded = match recorded_colpkg() {
        Some(colpkg) => {
            svc.import_colpkg(&colpkg)
                .await
                .expect("import recorded colpkg");
            true
        }
        None => {
            svc.call(|col| fixture::populate(col, fixture::FixtureOptions::default()))
                .await
                .expect("fixture");
            false
        }
    };
    let study = Study::new(svc.clone());
    let events: Arc<Mutex<Vec<BridgeEvent>>> = Arc::default();
    let sink_events = events.clone();
    let bridge = Bridge::new(
        svc.clone(),
        study.clone(),
        Arc::new(move |e| sink_events.lock().unwrap().push(e)),
    );
    let ctx = svc.call(lookup_ctx).await.expect("ctx");
    Env {
        _dir: dir,
        tmp,
        svc,
        study,
        bridge,
        events,
        ctx,
        recorded,
    }
}

fn lookup_ctx(col: &mut Collection) -> core_anki::Result<Ctx> {
    let names = DecksService::get_deck_names(
        col,
        anki_proto::decks::GetDeckNamesRequest {
            skip_empty_default: true,
            include_filtered: false,
        },
    )?;
    // Prefer the fixture's main deck; otherwise the first deck that has cards.
    let mut decks: Vec<(i64, String)> = names.entries.into_iter().map(|e| (e.id, e.name)).collect();
    decks.sort_by_key(|(_, name)| name != "5000 palavras");
    let mut found = None;
    for (id, name) in decks {
        let cards = search_cards(col, &format!("did:{id}"))?;
        if let Some(&card) = cards.first() {
            found = Some((id, name, card));
            break;
        }
    }
    let (deck_id, deck_name, card_id) = found.expect("a deck with cards");
    let card = CardsService::get_card(col, anki_proto::cards::CardId { cid: card_id })?;
    let note_id = card.note_id;
    let note_ntid =
        NotesService::get_note(col, anki_proto::notes::NoteId { nid: note_id })?.notetype_id;
    let mut normal = vec![];
    let mut cloze = None;
    for entry in NotetypesService::get_notetype_names(col)?.entries {
        let nt = NotetypesService::get_notetype(
            col,
            anki_proto::notetypes::NotetypeId { ntid: entry.id },
        )?;
        let kind = nt.config.as_ref().map(|c| c.kind()).unwrap_or_default();
        if kind == anki_proto::notetypes::notetype::config::Kind::Cloze {
            cloze.get_or_insert(entry.id);
        } else if nt.fields.len() >= 2 && !entry.name.contains("Occlusion") {
            normal.push(entry.id);
        }
    }
    let basic_ntid = if normal.contains(&note_ntid) {
        note_ntid
    } else {
        normal[0]
    };
    let other_normal_ntid = normal
        .iter()
        .copied()
        .find(|id| *id != basic_ntid)
        .unwrap_or(basic_ntid);
    Ok(Ctx {
        deck_id,
        deck_name,
        card_id,
        note_id,
        basic_ntid,
        other_normal_ntid,
        cloze_ntid: cloze.expect("a cloze notetype"),
    })
}

fn search_cards(col: &mut Collection, search: &str) -> core_anki::Result<Vec<i64>> {
    Ok(SearchService::search_cards(
        col,
        anki_proto::search::SearchRequest {
            search: search.into(),
            order: None,
        },
    )?
    .ids)
}

fn search_notes(col: &mut Collection, search: &str) -> core_anki::Result<Vec<i64>> {
    Ok(SearchService::search_notes(
        col,
        anki_proto::search::SearchRequest {
            search: search.into(),
            order: None,
        },
    )?
    .ids)
}

impl Env {
    fn request(&self, method: &str, body: Vec<u8>) -> PostRequest {
        PostRequest {
            origin: Some("anki://localhost".into()),
            ..PostRequest::new(method, body)
        }
    }

    async fn post(&self, method: &str, body: Vec<u8>) -> PostReply {
        self.bridge
            .post(Caller::Page, self.request(method, body))
            .await
    }

    async fn post_card(&self, method: &str, body: Vec<u8>) -> PostReply {
        let req = PostRequest {
            origin: Some("null".into()),
            ..PostRequest::new(method, body)
        };
        self.bridge.post(Caller::Card, req).await
    }

    fn take_events(&self) -> Vec<BridgeEvent> {
        std::mem::take(&mut *self.events.lock().unwrap())
    }

    /// Waits (polling) until the sink received all `wanted` events.
    async fn wait_events(&self, wanted: &[BridgeEvent]) -> Vec<BridgeEvent> {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let seen = self.events.lock().unwrap().clone();
            if wanted.iter().all(|w| seen.contains(w)) {
                return seen;
            }
            assert!(
                Instant::now() < deadline,
                "events {wanted:?} not received; got {seen:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Opens a study session on a deck that has a card to show.
    async fn start_study(&self) {
        if let Ok(StudyNext::Card { .. }) = self.study.next(self.ctx.deck_id).await
            && self.study.states_with_context().is_some()
        {
            return;
        }
        let decks = on_col(&self.svc, |col| {
            Ok(DecksService::get_deck_names(
                col,
                anki_proto::decks::GetDeckNamesRequest::default(),
            )?
            .entries)
        });
        for deck in decks {
            if let Ok(StudyNext::Card { .. }) = self.study.next(deck.id).await
                && self.study.states_with_context().is_some()
            {
                return;
            }
        }
        panic!("no deck with a card to study");
    }

    fn csv_file(&self) -> String {
        let path = self.tmp.join("bridge.csv");
        std::fs::write(&path, "frente da ponte;verso da ponte\nsegunda;linha\n").unwrap();
        path.to_string_lossy().into_owned()
    }

    fn png_file(&self) -> String {
        let path = self.tmp.join("bridge-occlusion.png");
        if !path.exists() {
            let file = std::fs::File::create(&path).unwrap();
            let mut enc = png::Encoder::new(std::io::BufWriter::new(file), 4, 4);
            enc.set_color(png::ColorType::Rgb);
            enc.set_depth(png::BitDepth::Eight);
            let mut writer = enc.write_header().unwrap();
            writer.write_image_data(&[200u8; 4 * 4 * 3]).unwrap();
        }
        path.to_string_lossy().into_owned()
    }

    fn json_import(&self) -> String {
        serde_json::json!({
            "default_deck": self.ctx.deck_id,
            "default_notetype": self.ctx.basic_ntid,
            "notes": [{ "fields": ["json frente", "json verso"], "tags": ["ponte"] }],
        })
        .to_string()
    }

    /// Adds an image occlusion note and returns `(note id, notetype id)`.
    fn io_note(&self) -> (i64, i64) {
        let image_path = self.png_file();
        on_col(&self.svc, move |col| {
            let _ = ImageOcclusionService::add_image_occlusion_note(
                col,
                anki_proto::image_occlusion::AddImageOcclusionNoteRequest {
                    image_path,
                    occlusions: OCCLUSION.into(),
                    header: "Cabeçalho".into(),
                    back_extra: String::new(),
                    tags: vec![],
                    notetype_id: 0,
                },
            )?;
            let nid = *search_notes(col, "added:1")?.iter().max().unwrap();
            let ntid = NotesService::get_note(col, anki_proto::notes::NoteId { nid })?.notetype_id;
            Ok((nid, ntid))
        })
    }

    fn new_basic_note(&self) -> anki_proto::notes::Note {
        let ntid = self.ctx.basic_ntid;
        let mut note = on_col(&self.svc, move |col| {
            Ok(NotesService::new_note(
                col,
                anki_proto::notetypes::NotetypeId { ntid },
            )?)
        });
        note.fields[0] = "frente da ponte".into();
        note.fields[1] = "verso da ponte".into();
        note
    }

    fn simulate_request(&self) -> anki_proto::scheduler::SimulateFsrsReviewRequest {
        anki_proto::scheduler::SimulateFsrsReviewRequest {
            params: vec![],
            desired_retention: 0.9,
            deck_size: 20,
            days_to_simulate: 10,
            new_limit: 5,
            review_limit: 50,
            max_interval: 36500,
            search: format!("did:{}", self.ctx.deck_id),
            easy_days_percentages: vec![1.0; 7],
            learning_step_count: 2,
            relearning_step_count: 1,
            ..Default::default()
        }
    }

    fn deck_configs_update(&self) -> anki_proto::deck_config::UpdateDeckConfigsRequest {
        let did = self.ctx.deck_id;
        let configs = on_col(&self.svc, move |col| {
            Ok(DeckConfigService::get_deck_configs_for_update(
                col,
                anki_proto::decks::DeckId { did },
            )?)
        });
        let current = configs.current_deck.clone().unwrap_or_default();
        let config = configs
            .all_config
            .iter()
            .filter_map(|c| c.config.clone())
            .find(|c| c.id == current.config_id)
            .expect("current preset");
        anki_proto::deck_config::UpdateDeckConfigsRequest {
            target_deck_id: did,
            configs: vec![config],
            removed_config_ids: vec![],
            mode: anki_proto::deck_config::UpdateDeckConfigsMode::Normal as i32,
            card_state_customizer: configs.card_state_customizer,
            limits: current.limits,
            new_cards_ignore_review_limit: configs.new_cards_ignore_review_limit,
            fsrs: configs.fsrs,
            apply_all_parent_limits: configs.apply_all_parent_limits,
            fsrs_reschedule: false,
            fsrs_health_check: configs.fsrs_health_check,
        }
    }

    fn change_notetype_request(&self, old: i64, new: i64) -> Vec<u8> {
        let info = on_col(&self.svc, move |col| {
            Ok(NotetypesService::get_change_notetype_info(
                col,
                anki_proto::notetypes::GetChangeNotetypeInfoRequest {
                    old_notetype_id: old,
                    new_notetype_id: new,
                },
            )?)
        });
        info.input.expect("change notetype input").encode_to_vec()
    }
}

const OCCLUSION: &str = "{{c1::image-occlusion:rect:left=.1:top=.1:width=.3:height=.2:oi=1}}";

fn enc<M: Message>(m: M) -> Vec<u8> {
    m.encode_to_vec()
}

fn s(val: impl Into<String>) -> Vec<u8> {
    enc(anki_proto::generic::String { val: val.into() })
}

fn decodes<M: Message + Default>(bytes: &[u8]) -> Result<(), prost::DecodeError> {
    M::decode(bytes).map(|_| ())
}

// ---------------------------------------------------------------------------------------------
// The table: one constructor per method

#[derive(Clone, Copy, Debug)]
enum Expect {
    /// 200 or 204, and the body decodes as the output type.
    Ok,
    /// Exactly this status.
    Status(u16),
    /// Like `Ok`, or a 500 carrying this (pt-BR) rslib message: the request reached rslib but the
    /// small fixture has too little review history for it (a recording may succeed).
    OkOrRslib(&'static str),
}

struct Row {
    name: &'static str,
    build: fn(&Env) -> Vec<u8>,
    check: fn(&[u8]) -> Result<(), prost::DecodeError>,
    expect: Expect,
}

macro_rules! table {
    ($( $name:literal : $out:ty = $expect:expr, $build:expr; )*) => {
        const TABLE_NAMES: &[&str] = &[$($name),*];
        fn table() -> Vec<Row> {
            vec![$(Row { name: $name, build: $build, check: decodes::<$out>, expect: $expect }),*]
        }
    };
}

use Expect::{Ok as Fine, Status};
use anki_proto::{
    card_rendering as cr, cards, collection as coll, config, deck_config as dc, decks, generic,
    i18n, image_occlusion as io, import_export as ie, media, notes, notetypes as nt, scheduler,
    search, stats, tags,
};

table! {
    // --- exposed_backend_list (55), same order as mediasrv.py
    "latestProgress": coll::Progress = Status(204), |_| vec![];
    "getCustomColours": coll::GetCustomColoursResponse = Fine, |_| vec![];
    "getDeckNames": decks::DeckNames = Fine, |_| enc(decks::GetDeckNamesRequest { skip_empty_default: true, include_filtered: true });
    "getDeck": decks::Deck = Fine, |e| enc(decks::DeckId { did: e.ctx.deck_id });
    "i18nResources": generic::Json = Status(200), |_| enc(i18n::I18nResourcesRequest { modules: vec!["scheduling".into(), "deck-config".into(), "actions".into()] });
    "getCsvMetadata": ie::CsvMetadata = Fine, |e| enc(ie::CsvMetadataRequest { path: e.csv_file(), delimiter: None, notetype_id: Some(e.ctx.basic_ntid), deck_id: Some(e.ctx.deck_id), is_html: None });
    "getImportAnkiPackagePresets": ie::ImportAnkiPackageOptions = Fine, |_| vec![];
    "importCsv": ie::ImportResponse = Status(200), |e| {
        let (path, ntid, did) = (e.csv_file(), e.ctx.basic_ntid, e.ctx.deck_id);
        let p = path.clone();
        let metadata = on_col(&e.svc, move |col| Ok(ImportExportService::get_csv_metadata(col, ie::CsvMetadataRequest { path: p, delimiter: None, notetype_id: Some(ntid), deck_id: Some(did), is_html: None })?));
        enc(ie::ImportCsvRequest { path, metadata: Some(metadata) })
    };
    "importAnkiPackage": ie::ImportResponse = Status(200), |e| {
        let out = e.tmp.join("ponte.apkg").to_string_lossy().into_owned();
        let (out2, did) = (out.clone(), e.ctx.deck_id);
        let presets = on_col(&e.svc, move |col| {
            let _ = ImportExportService::export_anki_package(col, ie::ExportAnkiPackageRequest {
                out_path: out2,
                options: Some(ie::ExportAnkiPackageOptions { with_scheduling: true, with_deck_configs: true, with_media: true, legacy: false }),
                limit: Some(ie::ExportLimit { limit: Some(ie::export_limit::Limit::DeckId(did)) }),
            })?;
            Ok(ImportExportService::get_import_anki_package_presets(col)?)
        });
        enc(ie::ImportAnkiPackageRequest { package_path: out, options: Some(presets) })
    };
    "importJsonFile": ie::ImportResponse = Status(200), |e| {
        let path = e.tmp.join("ponte.json");
        std::fs::write(&path, e.json_import()).unwrap();
        s(path.to_string_lossy())
    };
    "importJsonString": ie::ImportResponse = Status(200), |e| s(e.json_import());
    "getFieldNames": generic::StringList = Status(200), |e| enc(nt::NotetypeId { ntid: e.ctx.basic_ntid });
    "getNote": notes::Note = Status(200), |e| enc(notes::NoteId { nid: e.ctx.note_id });
    "newNote": notes::Note = Status(200), |e| enc(nt::NotetypeId { ntid: e.ctx.basic_ntid });
    "noteFieldsCheck": notes::NoteFieldsCheckResponse = Fine, |e| enc(e.new_basic_note());
    "defaultsForAdding": notes::DeckAndNotetype = Status(200), |_| enc(notes::DefaultsForAddingRequest { home_deck_of_current_review_card: 0 });
    "defaultDeckForNotetype": decks::DeckId = Fine, |e| enc(nt::NotetypeId { ntid: e.ctx.basic_ntid });
    "addNote": notes::AddNoteResponse = Status(200), |e| enc(notes::AddNoteRequest { note: Some(e.new_basic_note()), deck_id: e.ctx.deck_id });
    "updateNotes": coll::OpChanges = Status(200), |e| {
        let nid = e.ctx.note_id;
        let mut note = on_col(&e.svc, move |col| Ok(NotesService::get_note(col, notes::NoteId { nid })?));
        note.fields[0].push_str(" (editado)");
        enc(notes::UpdateNotesRequest { notes: vec![note], skip_undo_entry: false })
    };
    "updateNotetype": coll::OpChanges = Fine, |e| {
        let ntid = e.ctx.basic_ntid;
        enc(on_col(&e.svc, move |col| Ok(NotetypesService::get_notetype(col, nt::NotetypeId { ntid })?)))
    };
    "getNotetype": nt::Notetype = Status(200), |e| enc(nt::NotetypeId { ntid: e.ctx.basic_ntid });
    "getNotetypeNames": nt::NotetypeNames = Status(200), |_| vec![];
    "getChangeNotetypeInfo": nt::ChangeNotetypeInfo = Status(200), |e| enc(nt::GetChangeNotetypeInfoRequest { old_notetype_id: e.ctx.basic_ntid, new_notetype_id: e.ctx.other_normal_ntid });
    "getClozeFieldOrds": nt::GetClozeFieldOrdsResponse = Fine, |e| enc(nt::NotetypeId { ntid: e.ctx.cloze_ntid });
    "cardStats": stats::CardStatsResponse = Status(200), |e| enc(cards::CardId { cid: e.ctx.card_id });
    "getReviewLogs": stats::ReviewLogs = Fine, |e| enc(cards::CardId { cid: e.ctx.card_id });
    "graphs": stats::GraphsResponse = Status(200), |_| enc(stats::GraphsRequest { search: "deck:current".into(), days: 365 });
    "getGraphPreferences": stats::GraphPreferences = Fine, |_| vec![];
    "setGraphPreferences": generic::Empty = Status(204), |_| enc(stats::GraphPreferences { calendar_first_day_of_week: 1, card_counts_separate_inactive: true, browser_links_supported: true, future_due_show_backlog: true });
    "completeTag": tags::CompleteTagResponse = Fine, |_| enc(tags::CompleteTagRequest { input: "f".into(), match_limit: 10 });
    "getImageForOcclusion": io::GetImageForOcclusionResponse = Status(200), |e| enc(io::GetImageForOcclusionRequest { path: e.png_file() });
    "addImageOcclusionNote": coll::OpChanges = Status(200), |e| enc(io::AddImageOcclusionNoteRequest { image_path: e.png_file(), occlusions: OCCLUSION.into(), header: "Ponte".into(), back_extra: String::new(), tags: vec!["ponte".into()], notetype_id: 0 });
    "getImageOcclusionNote": io::GetImageOcclusionNoteResponse = Status(200), |e| enc(io::GetImageOcclusionNoteRequest { note_id: e.io_note().0 });
    "updateImageOcclusionNote": coll::OpChanges = Status(200), |e| enc(io::UpdateImageOcclusionNoteRequest { note_id: e.io_note().0, occlusions: OCCLUSION.replace("left=.1", "left=.2"), header: "Editado".into(), back_extra: String::new(), tags: vec![] });
    "getImageOcclusionFields": io::GetImageOcclusionFieldsResponse = Status(200), |e| enc(io::GetImageOcclusionFieldsRequest { notetype_id: e.io_note().1 });
    "computeFsrsParams": scheduler::ComputeFsrsParamsResponse = Fine, |e| enc(scheduler::ComputeFsrsParamsRequest { search: format!("did:{}", e.ctx.deck_id), current_params: vec![], ignore_revlogs_before_ms: 0, num_of_relearning_steps: 1, health_check: false });
    "computeOptimalRetention": scheduler::ComputeOptimalRetentionResponse = Status(200), |e| enc(e.simulate_request());
    "setWantsAbort": generic::Empty = Status(204), |_| vec![];
    "evaluateParamsLegacy": scheduler::EvaluateParamsResponse = Expect::OkOrRslib("revisões históricas é insuficiente"), |e| enc(scheduler::EvaluateParamsLegacyRequest { params: vec![], search: format!("did:{}", e.ctx.deck_id), ignore_revlogs_before_ms: 0 });
    "getOptimalRetentionParameters": scheduler::GetOptimalRetentionParametersResponse = Fine, |e| enc(scheduler::GetOptimalRetentionParametersRequest { search: format!("did:{}", e.ctx.deck_id) });
    "simulateFsrsReview": scheduler::SimulateFsrsReviewResponse = Status(200), |e| enc(e.simulate_request());
    "simulateFsrsWorkload": scheduler::SimulateFsrsWorkloadResponse = Status(200), |e| enc(e.simulate_request());
    "getIgnoredBeforeCount": dc::GetIgnoredBeforeCountResponse = Fine, |e| enc(dc::GetIgnoredBeforeCountRequest { ignore_revlogs_before_date: "1970-01-01".into(), search: format!("did:{}", e.ctx.deck_id) });
    "getRetentionWorkload": dc::GetRetentionWorkloadResponse = Fine, |e| enc(dc::GetRetentionWorkloadRequest { w: vec![], search: format!("did:{}", e.ctx.deck_id) });
    "encodeIriPaths": generic::String = Status(200), |_| s(r#"<img src="foto da ponte.png">"#);
    "decodeIriPaths": generic::String = Status(200), |_| s(r#"<img src="foto%20da%20ponte.png">"#);
    "htmlToTextLine": generic::String = Status(200), |_| enc(cr::HtmlToTextLineRequest { text: "<b>olá</b> [sound:ponte.wav]".into(), preserve_media_filenames: true });
    "setConfigJson": coll::OpChanges = Status(200), |_| enc(config::SetConfigJsonRequest { key: "leitorBridgeTest".into(), value_json: b"{\"ok\":true}".to_vec(), undoable: true });
    "getConfigBool": generic::Bool = Fine, |_| enc(config::GetConfigBoolRequest { key: config::config_key::Bool::BrowserTableShowNotesMode as i32 });
    "addMediaFile": generic::String = Status(200), |_| enc(media::AddMediaFileRequest { desired_name: "ponte.txt".into(), data: b"ponte".to_vec() });
    "addMediaFromPath": generic::String = Status(200), |e| enc(media::AddMediaFromPathRequest { path: e.png_file() });
    "addMediaFromUrl": generic::Empty = Status(404), |_| vec![];
    "getAbsoluteMediaPath": generic::String = Status(200), |_| s("ponte.png");
    "extractMediaFiles": generic::StringList = Status(200), |_| s(r#"<img src="a.png"> [sound:b.wav]"#);
    "getCard": cards::Card = Status(200), |e| enc(cards::CardId { cid: e.ctx.card_id });
    // --- post_handler_list: forwarded and app-implemented (404 rows are checked separately)
    "congratsInfo": scheduler::CongratsInfoResponse = Status(200), |_| vec![];
    "getDeckConfigsForUpdate": dc::DeckConfigsForUpdate = Status(200), |e| enc(decks::DeckId { did: e.ctx.deck_id });
    "updateDeckConfigs": generic::Empty = Status(204), |e| enc(e.deck_configs_update());
    "getSchedulingStatesWithContext": core_anki::study::frontend::SchedulingStatesWithContext = Status(200), |_| vec![];
    "setSchedulingStates": generic::Empty = Status(204), |e| enc(core_anki::study::frontend::SetSchedulingStatesRequest { key: "chave-errada".into(), states: e.study.states_with_context().and_then(|s| s.states) });
    "changeNotetype": generic::Empty = Status(204), |e| {
        let note = e.new_basic_note();
        let did = e.ctx.deck_id;
        let nid = on_col(&e.svc, move |col| Ok(NotesService::add_note(col, notes::AddNoteRequest { note: Some(note), deck_id: did })?.note_id));
        e.bridge.set_change_notetype_notes(vec![nid]);
        e.change_notetype_request(e.ctx.basic_ntid, e.ctx.other_normal_ntid)
    };
    "importDone": generic::Empty = Status(204), |_| vec![];
    "importDialogRequireClose": generic::Empty = Status(204), |_| vec![];
    "searchInBrowser": generic::Empty = Status(204), |e| enc(search::SearchNode { filter: Some(Filter::Deck(e.ctx.deck_name.clone())) });
    "deckOptionsRequireClose": generic::Empty = Status(204), |_| vec![];
    "deckOptionsReady": generic::Empty = Status(204), |_| vec![];
    "getConfigJson": generic::Json = Status(200), |_| s("curDeck");
    "openLink": generic::Empty = Status(204), |_| s("https://docs.ankiweb.net/");
    "saveCustomColours": generic::Empty = Status(204), |_| vec![];
}

// Compile-time check: the table covers exactly EXPOSED_METHODS ∪ the non-404 POST_HANDLERS.
const fn str_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}

const fn count(list: &[&str], name: &str) -> usize {
    let (mut i, mut n) = (0, 0);
    while i < list.len() {
        if str_eq(list[i], name) {
            n += 1;
        }
        i += 1;
    }
    n
}

const fn table_covers_whitelist() -> bool {
    let mut expected = 0;
    let mut i = 0;
    while i < EXPOSED_METHODS.len() {
        if count(TABLE_NAMES, EXPOSED_METHODS[i]) != 1 {
            return false;
        }
        expected += 1;
        i += 1;
    }
    i = 0;
    while i < POST_HANDLERS.len() {
        let (name, d) = POST_HANDLERS[i];
        let wanted = if matches!(d, Decision::NotFound) {
            0
        } else {
            1
        };
        if count(TABLE_NAMES, name) != wanted {
            return false;
        }
        expected += wanted;
        i += 1;
    }
    expected == TABLE_NAMES.len()
}

const _: () = assert!(
    table_covers_whitelist(),
    "the request table must cover exactly EXPOSED_METHODS + forwarded/app POST_HANDLERS"
);

// ---------------------------------------------------------------------------------------------
// (a) every whitelisted method

struct Recording {
    body: Vec<u8>,
    op_changes: Option<String>,
}

fn recording(name: &str) -> Option<Recording> {
    let dir = recordings_dir();
    let body = std::fs::read(dir.join(format!("{name}.bin"))).ok()?;
    let op_changes = std::fs::read(dir.join(format!("{name}.json")))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| match v.get("opChanges")? {
            // The recorder writes the header value as a string; hand-written files may use a number.
            serde_json::Value::String(s) => Some(s.clone()),
            serde_json::Value::Number(n) => Some(n.to_string()),
            _ => None,
        });
    Some(Recording { body, op_changes })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_whitelisted_method_answers_with_a_recorded_or_constructed_request() {
    let env = env().await;
    env.start_study().await;
    let mut used_recordings = vec![];
    let mut failures = vec![];
    for row in table() {
        let rec = if env.recorded {
            recording(row.name)
        } else {
            None
        };
        let (body, op_changes, source) = match rec {
            Some(r) => (r.body, r.op_changes, "gravada"),
            None => ((row.build)(&env), None, "montada"),
        };
        if source == "gravada" {
            used_recordings.push(row.name);
        }
        if row.name == "changeNotetype" && source == "gravada" {
            // The page never sends note ids: register a note of the recorded old notetype.
            let old = anki_proto::notetypes::ChangeNotetypeRequest::decode(&*body)
                .map(|r| r.old_notetype_id)
                .unwrap_or_default();
            let ids = on_col(&env.svc, move |col| {
                search_notes(col, &format!("mid:{old}"))
            });
            env.bridge
                .set_change_notetype_notes(ids.into_iter().take(1).collect());
        }
        let req = PostRequest {
            op_changes,
            ..env.request(row.name, body)
        };
        let started = Instant::now();
        let reply = env.bridge.post(Caller::Page, req).await;
        let ok_status = match row.expect {
            Expect::Ok => matches!(reply.status, 200 | 204),
            Expect::Status(s) => reply.status == s,
            Expect::OkOrRslib(msg) => {
                matches!(reply.status, 200 | 204)
                    || (reply.status == 500 && reply.text_body().contains(msg))
            }
        };
        let decoded = (row.check)(&reply.body);
        println!(
            "{:<32} {:<8} {} ({} bytes, {} ms)",
            row.name,
            source,
            reply.status,
            reply.body.len(),
            started.elapsed().as_millis()
        );
        if !ok_status {
            failures.push(format!(
                "{}: expected {:?}, got {} {:?}",
                row.name,
                row.expect,
                reply.status,
                reply.text_body()
            ));
        } else if matches!(reply.status, 200 | 204) {
            if let Err(err) = decoded {
                failures.push(format!("{}: output does not decode: {err}", row.name));
            }
            if reply.status == 200 {
                assert_eq!(reply.content_type, "application/binary", "{}", row.name);
            }
        }
    }
    println!(
        "requisições gravadas usadas: {}",
        if used_recordings.is_empty() {
            "nenhuma (tests/fixtures/bridge/ sem gravações)".to_owned()
        } else {
            used_recordings.join(", ")
        }
    );
    assert!(failures.is_empty(), "{failures:#?}");
}

#[tokio::test]
async fn editor_only_post_handlers_are_404() {
    let env = env().await;
    for (name, d) in POST_HANDLERS {
        if d == Decision::NotFound {
            let reply = env.post(name, s("x")).await;
            assert_eq!(reply.status, 404, "{name}");
        }
    }
    assert_eq!(env.post("noSuchMethod", vec![]).await.status, 404);
    assert_eq!(env.post("addMediaFromUrl", vec![]).await.status, 404);
}

// ---------------------------------------------------------------------------------------------
// (b) card policy

#[tokio::test]
async fn cards_reach_only_the_four_methods() {
    let env = env().await;
    env.start_study().await;
    let add = enc(notes::AddNoteRequest {
        note: Some(env.new_basic_note()),
        deck_id: env.ctx.deck_id,
    });
    assert_eq!(env.post_card("addNote", add).await.status, 403);
    assert_eq!(env.post_card("noSuchMethod", vec![]).await.status, 403);
    assert_eq!(env.post_card("importAnkiPackage", vec![]).await.status, 403);
    for name in EXPOSED_METHODS
        .iter()
        .chain(POST_HANDLERS.iter().map(|(n, _)| n))
    {
        if !CARD_METHODS.contains(name) {
            assert_eq!(env.post_card(name, vec![]).await.status, 403, "{name}");
        }
    }
    let modules = enc(i18n::I18nResourcesRequest {
        modules: vec!["scheduling".into()],
    });
    let i18n = env.post_card("i18nResources", modules).await;
    assert_eq!(i18n.status, 200);
    assert!(!generic::Json::decode(&*i18n.body).unwrap().json.is_empty());
    for name in CARD_METHODS {
        let body = match name {
            "setSchedulingStates" => enc(core_anki::study::frontend::SetSchedulingStatesRequest {
                key: "x".into(),
                states: None,
            }),
            _ => vec![],
        };
        let reply = env.post_card(name, body).await;
        assert_ne!(reply.status, 403, "{name}");
        assert!(matches!(reply.status, 200 | 204), "{name}: {reply:?}");
    }
}

// ---------------------------------------------------------------------------------------------
// (c) content type and origin

#[tokio::test]
async fn wrong_content_type_or_origin_is_forbidden() {
    let env = env().await;
    for content_type in [
        Some("application/octet-stream"),
        None,
        Some("application/binary; charset=x"),
        Some("Application/Binary"),
    ] {
        for caller in [Caller::Page, Caller::Card] {
            let req = PostRequest {
                content_type: content_type.map(Into::into),
                ..env.request("i18nResources", vec![])
            };
            assert_eq!(
                env.bridge.post(caller, req).await.status,
                403,
                "{caller:?} {content_type:?}"
            );
        }
    }
    for origin in [
        "card://localhost",
        "tauri://localhost",
        "http://evil",
        "null",
        "http://card.localhost",
    ] {
        let req = PostRequest {
            origin: Some(origin.into()),
            ..env.request("getDeckNames", vec![])
        };
        assert_eq!(
            env.bridge.post(Caller::Page, req).await.status,
            403,
            "{origin}"
        );
    }
    for origin in [
        Some("anki://localhost"),
        Some("http://anki.localhost"),
        None,
    ] {
        let req = PostRequest {
            origin: origin.map(Into::into),
            ..env.request("getDeckNames", vec![])
        };
        assert_eq!(env.bridge.post(Caller::Page, req).await.status, 200);
    }
    // Size limit.
    let big = vec![0u8; core_anki::bridge::MAX_BODY_BYTES + 1];
    assert_eq!(env.post("getDeckNames", big).await.status, 413);
}

// ---------------------------------------------------------------------------------------------
// (d) getConfigJson

#[tokio::test]
async fn get_config_json_of_a_missing_key_is_null() {
    let env = env().await;
    let reply = env
        .post("getConfigJson", s("leitor.chaveQueNaoExiste"))
        .await;
    assert_eq!(reply.status, 200);
    assert_eq!(generic::Json::decode(&*reply.body).unwrap().json, b"null");
    let reply = env.post("getConfigJson", s("curDeck")).await;
    assert_eq!(reply.status, 200);
    let json = generic::Json::decode(&*reply.body).unwrap().json;
    assert!(
        serde_json::from_slice::<serde_json::Value>(&json)
            .unwrap()
            .is_number()
    );
}

// ---------------------------------------------------------------------------------------------
// (e) progress outside the actor

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abort_and_progress_do_not_wait_for_the_actor() {
    let env = env().await;
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let svc = env.svc.clone();
    let busy = tokio::spawn(async move {
        svc.call(move |_| {
            started_tx.send(()).unwrap();
            let _ = release_rx.recv_timeout(Duration::from_secs(30));
            Ok(())
        })
        .await
    });
    started_rx.recv_timeout(Duration::from_secs(10)).unwrap();

    let abort = tokio::time::timeout(Duration::from_secs(2), env.post("setWantsAbort", vec![]))
        .await
        .expect("setWantsAbort must not wait for the actor");
    assert_eq!(abort.status, 204);
    let progress = tokio::time::timeout(Duration::from_secs(2), env.post("latestProgress", vec![]))
        .await
        .expect("latestProgress must not wait for the actor");
    assert_eq!(progress.status, 204);
    assert!(progress.body.is_empty());

    release_tx.send(()).unwrap();
    busy.await.unwrap().unwrap();
}

// ---------------------------------------------------------------------------------------------
// (f) updateDeckConfigs

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn update_deck_configs_replies_at_once_and_closes_later() {
    let env = env().await;
    let body = enc(env.deck_configs_update());
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let svc = env.svc.clone();
    let busy = tokio::spawn(async move {
        svc.call(move |_| {
            started_tx.send(()).unwrap();
            let _ = release_rx.recv_timeout(Duration::from_secs(30));
            Ok(())
        })
        .await
    });
    started_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    env.take_events();

    let reply = tokio::time::timeout(
        Duration::from_secs(2),
        env.post("updateDeckConfigs", body.clone()),
    )
    .await
    .expect("updateDeckConfigs must reply before the work runs");
    assert_eq!(reply.status, 204);
    assert!(env.take_events().is_empty(), "no event before the work ran");

    release_tx.send(()).unwrap();
    busy.await.unwrap().unwrap();
    let events = env
        .wait_events(&[BridgeEvent::Changed, BridgeEvent::Close])
        .await;
    assert_eq!(events, vec![BridgeEvent::Changed, BridgeEvent::Close]);

    // COMPUTE_ALL_PARAMS keeps the page open.
    env.take_events();
    let mut req = env.deck_configs_update();
    req.mode = anki_proto::deck_config::UpdateDeckConfigsMode::ComputeAllParams as i32;
    req.fsrs = true; // computing params needs FSRS
    assert_eq!(env.post("updateDeckConfigs", enc(req)).await.status, 204);
    env.wait_events(&[BridgeEvent::Changed]).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!env.events.lock().unwrap().contains(&BridgeEvent::Close));

    // A failure is reported as an Error event.
    env.take_events();
    // (computing every preset's params needs FSRS: rslib refuses with FSRS off)
    let mut bad = env.deck_configs_update();
    bad.mode = anki_proto::deck_config::UpdateDeckConfigsMode::ComputeAllParams as i32;
    bad.fsrs = false;
    assert_eq!(env.post("updateDeckConfigs", enc(bad)).await.status, 204);
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let seen = env.events.lock().unwrap().clone();
        if seen
            .iter()
            .any(|e| matches!(e, BridgeEvent::Error { message } if !message.is_empty()))
        {
            break;
        }
        assert!(Instant::now() < deadline, "no error event: {seen:?}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// ---------------------------------------------------------------------------------------------
// (g) setSchedulingStates

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn set_scheduling_states_needs_the_session_key() {
    let env = env().await;
    // No session yet.
    let none = env.post("getSchedulingStatesWithContext", vec![]).await;
    assert_eq!(none.status, 500);
    assert_eq!(none.text_body(), "Nenhum card em estudo.");

    // Custom scheduling JS makes the study session hand out its state mutation key.
    let set = enc(config::SetConfigJsonRequest {
        key: "cardStateCustomizer".into(),
        value_json: serde_json::to_vec("states.good.normal = states.easy.normal;").unwrap(),
        undoable: false,
    });
    assert_eq!(env.post("setConfigJson", set).await.status, 200);
    let StudyNext::Card { card } = env.study.next(env.ctx.deck_id).await.unwrap() else {
        panic!("expected a card");
    };
    let key = card
        .state_mutation
        .as_ref()
        .expect("state mutation with custom JS")
        .key
        .clone();

    let reply = env.post("getSchedulingStatesWithContext", vec![]).await;
    assert_eq!(reply.status, 200);
    let with_context =
        core_anki::study::frontend::SchedulingStatesWithContext::decode(&*reply.body).unwrap();
    let original = with_context.states.clone().expect("states");
    let mut changed = original.clone();
    changed.good = changed.easy.clone();
    assert_ne!(changed, original);

    // Wrong key: ignored (204), states unchanged.
    let wrong = enc(core_anki::study::frontend::SetSchedulingStatesRequest {
        key: format!("{key}x"),
        states: Some(changed.clone()),
    });
    assert_eq!(
        env.post_card("setSchedulingStates", wrong).await.status,
        204
    );
    assert_eq!(
        env.study.states_with_context().unwrap().states,
        Some(original)
    );

    // Right key: the session's states change.
    let right = enc(core_anki::study::frontend::SetSchedulingStatesRequest {
        key,
        states: Some(changed.clone()),
    });
    assert_eq!(
        env.post_card("setSchedulingStates", right).await.status,
        204
    );
    assert_eq!(
        env.study.states_with_context().unwrap().states,
        Some(changed)
    );
}

// ---------------------------------------------------------------------------------------------
// (h) op changes

#[tokio::test]
async fn op_changes_header_emits_changed() {
    let env = env().await;
    let set = |n: u32| {
        enc(config::SetConfigJsonRequest {
            key: "leitorBridgeOp".into(),
            value_json: n.to_string().into_bytes(),
            undoable: true,
        })
    };
    // Without the header: no event.
    env.take_events();
    assert_eq!(env.post("setConfigJson", set(1)).await.status, 200);
    assert!(env.take_events().is_empty());
    // OpChanges (1).
    let req = PostRequest {
        op_changes: Some("1".into()),
        ..env.request("setConfigJson", set(2))
    };
    assert_eq!(env.bridge.post(Caller::Page, req).await.status, 200);
    assert_eq!(env.take_events(), vec![BridgeEvent::Changed]);
    // OpChangesOnly (2): ImportResponse, whose field 1 is OpChanges.
    let req = PostRequest {
        op_changes: Some("2".into()),
        ..env.request("importJsonString", s(env.json_import()))
    };
    assert_eq!(env.bridge.post(Caller::Page, req).await.status, 200);
    assert_eq!(env.take_events(), vec![BridgeEvent::Changed]);
    // NestedOpChanges (3): AddNoteResponse → OpChangesWithCount → OpChanges.
    let add = enc(notes::AddNoteRequest {
        note: Some(env.new_basic_note()),
        deck_id: env.ctx.deck_id,
    });
    let req = PostRequest {
        op_changes: Some("3".into()),
        ..env.request("addNote", add)
    };
    assert_eq!(env.bridge.post(Caller::Page, req).await.status, 200);
    assert_eq!(env.take_events(), vec![BridgeEvent::Changed]);
    // A failed call emits nothing.
    let req = PostRequest {
        op_changes: Some("1".into()),
        ..env.request("setConfigJson", vec![0xff; 8])
    };
    assert_eq!(env.bridge.post(Caller::Page, req).await.status, 500);
    assert!(env.take_events().is_empty());
}

// ---------------------------------------------------------------------------------------------
// App handlers with side effects

#[tokio::test]
async fn app_handlers_emit_their_events() {
    let env = env().await;
    env.take_events();
    assert_eq!(env.post("importDone", vec![]).await.status, 204);
    assert_eq!(
        env.take_events(),
        vec![BridgeEvent::ImportDone, BridgeEvent::Changed]
    );
    assert_eq!(env.post("deckOptionsReady", vec![]).await.status, 204);
    assert_eq!(env.take_events(), vec![BridgeEvent::Ready]);
    for name in ["deckOptionsRequireClose", "importDialogRequireClose"] {
        assert_eq!(env.post(name, vec![]).await.status, 204);
        assert_eq!(env.take_events(), vec![BridgeEvent::Close], "{name}");
    }
    let node = enc(search::SearchNode {
        filter: Some(Filter::Deck("Oxford::Oxford 3000".into())),
    });
    assert_eq!(env.post("searchInBrowser", node).await.status, 204);
    assert_eq!(
        env.take_events(),
        vec![BridgeEvent::SearchInBrowser {
            search: "\"deck:Oxford::Oxford 3000\"".into()
        }]
    );
    assert_eq!(
        env.post("openLink", s("https://docs.ankiweb.net/"))
            .await
            .status,
        204
    );
    assert_eq!(
        env.take_events(),
        vec![BridgeEvent::OpenLink {
            url: "https://docs.ankiweb.net/".into()
        }]
    );
    for url in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "leitor://livro/x",
    ] {
        assert_eq!(env.post("openLink", s(url)).await.status, 204);
        assert!(env.take_events().is_empty(), "{url}");
    }
    assert_eq!(env.post("saveCustomColours", vec![]).await.status, 204);
    assert!(env.take_events().is_empty());
}

#[tokio::test]
async fn change_notetype_uses_the_registered_notes() {
    let env = env().await;
    let body = env.change_notetype_request(env.ctx.basic_ntid, env.ctx.other_normal_ntid);
    // Nothing registered → refused.
    let reply = env.post("changeNotetype", body.clone()).await;
    assert_eq!(reply.status, 500);
    assert!(!reply.text_body().is_empty());

    let note = env.new_basic_note();
    let did = env.ctx.deck_id;
    let nid = on_col(&env.svc, move |col| {
        Ok(NotesService::add_note(
            col,
            notes::AddNoteRequest {
                note: Some(note),
                deck_id: did,
            },
        )?
        .note_id)
    });
    // reset() forgets the registration.
    env.bridge.set_change_notetype_notes(vec![nid]);
    env.bridge.reset();
    assert_eq!(env.post("changeNotetype", body.clone()).await.status, 500);

    env.bridge.set_change_notetype_notes(vec![nid]);
    env.take_events();
    assert_eq!(env.post("changeNotetype", body.clone()).await.status, 204);
    assert_eq!(
        env.take_events(),
        vec![BridgeEvent::Changed, BridgeEvent::Close]
    );
    let ntid = on_col(&env.svc, move |col| {
        Ok(NotesService::get_note(col, notes::NoteId { nid })?.notetype_id)
    });
    assert_eq!(ntid, env.ctx.other_normal_ntid);
    // The registration is used once.
    assert_eq!(env.post("changeNotetype", body).await.status, 500);
}

// ---------------------------------------------------------------------------------------------
// (i) docs parity

fn doc_rows() -> Vec<(String, Vec<String>)> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/anki-handlers.md");
    let text = std::fs::read_to_string(&path).expect("docs/anki-handlers.md");
    text.lines()
        .filter(|l| l.starts_with('|'))
        .filter_map(|line| {
            let cells: Vec<String> = line
                .trim_matches('|')
                .split('|')
                .map(|c| c.trim().to_owned())
                .collect();
            // The method cell is the first one that is a single backticked identifier.
            let name = cells.iter().find_map(|c| {
                let inner = c.strip_prefix('`')?.strip_suffix('`')?;
                inner
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric())
                    .then(|| inner.to_owned())
            })?;
            Some((name, cells))
        })
        .collect()
}

#[test]
fn docs_parity() {
    let rows = doc_rows();
    let mut seen = BTreeSet::new();
    for (name, cells) in &rows {
        assert!(
            seen.insert(name.clone()),
            "{name} appears twice in the docs"
        );
        let d = decision(name).unwrap_or_else(|| panic!("{name} is not a known method"));
        assert!(
            cells.iter().any(|c| c == d.doc_label()),
            "{name}: decision column should be {:?}: {cells:?}",
            d.doc_label()
        );
        let card = if CARD_METHODS.contains(&name.as_str()) {
            "sim"
        } else {
            "não"
        };
        assert!(
            cells.iter().any(|c| c == card),
            "{name}: card column should be {card:?}: {cells:?}"
        );
    }
    let expected: BTreeSet<String> = EXPOSED_METHODS
        .iter()
        .chain(POST_HANDLERS.iter().map(|(n, _)| n))
        .map(|n| n.to_string())
        .collect();
    assert_eq!(seen, expected);
    assert_eq!(seen.len(), 87);
}

// ---------------------------------------------------------------------------------------------
// (j) name clashes and garbage bodies

#[test]
fn no_name_is_both_a_backend_method_and_a_post_handler() {
    for (name, _) in POST_HANDLERS {
        assert!(!EXPOSED_METHODS.contains(&name), "{name}");
    }
    let all: BTreeSet<&str> = EXPOSED_METHODS
        .iter()
        .copied()
        .chain(POST_HANDLERS.iter().map(|(n, _)| *n))
        .collect();
    assert_eq!(all.len(), 55 + 32);
}

/// Methods whose request is `generic.Empty` (the body is ignored).
const NO_INPUT: [&str; 13] = [
    "latestProgress",
    "setWantsAbort",
    "getCustomColours",
    "getImportAnkiPackagePresets",
    "getNotetypeNames",
    "getGraphPreferences",
    "congratsInfo",
    "getSchedulingStatesWithContext",
    "importDone",
    "importDialogRequireClose",
    "deckOptionsRequireClose",
    "deckOptionsReady",
    "saveCustomColours",
];

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn garbage_bodies_are_errors_not_panics() {
    let env = env().await;
    env.start_study().await;
    let garbage: [&[u8]; 4] = [
        &[0xff; 16],               // invalid wire type
        &[0x0a, 0x64, 0x41],       // length-delimited field 1 claiming 100 bytes
        &[0x08],                   // truncated varint
        &[0x12, 0x05, 0x0a, 0x10], // nested message truncated
    ];
    let mut names: Vec<&str> = EXPOSED_METHODS.to_vec();
    names.extend(POST_HANDLERS.iter().map(|(n, _)| *n));
    for name in names {
        for body in garbage {
            for caller in [Caller::Page, Caller::Card] {
                let req = PostRequest {
                    origin: (caller == Caller::Page).then(|| "anki://localhost".into()),
                    ..PostRequest::new(name, body.to_vec())
                };
                let reply = env.bridge.post(caller, req).await;
                if caller == Caller::Card && !CARD_METHODS.contains(&name) {
                    assert_eq!(reply.status, 403, "{name}");
                    continue;
                }
                match decision(name).unwrap() {
                    Decision::NotFound => assert_eq!(reply.status, 404, "{name}"),
                    _ if NO_INPUT.contains(&name) => {
                        assert!(matches!(reply.status, 200 | 204), "{name}: {reply:?}")
                    }
                    _ => {
                        assert_eq!(reply.status, 500, "{name} {body:?}: {reply:?}");
                        assert!(!reply.body.is_empty(), "{name}: empty error message");
                    }
                }
            }
        }
    }
    // The bridge still works afterwards.
    assert_eq!(env.post("getDeckNames", vec![]).await.status, 200);
}
