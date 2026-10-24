//! Tests with the real data pack (Open English WordNet + wordfreq + Snowball). They skip when the pack is missing,
//! unless `LEITOR_REQUIRE_VOCAB_DATA=1` or `CI` is set (then they fail).

mod common;

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;

use core_vocab::{
    CompareInput, DATA_SCHEMA_VERSION, DerivedPolicy, KnownIndex, KnownNote, MarkStatus,
    NoteStatus, PageInput, Pos, RangeSpec, RowGroup, ScanConfig, ScanResult, Status, StatusOracle,
    StatusSource, build_book_table, compare, lemmatize, resolve_range, sample_tokens, to_csv,
};

#[test]
fn data_info_and_definitions() {
    let Some(lex) = common::lexicon() else { return };
    let info = lex.info();
    assert_eq!(info.schema_version, DATA_SCHEMA_VERSION);
    assert_eq!(info.wordnet.license, "CC-BY-4.0");
    assert_eq!(info.frequency.license, "CC-BY-SA-4.0");
    assert_eq!(info.stopwords.license, "BSD-3-Clause");
    assert_eq!(info.wordnet.sha256.len(), 64);
    assert!(lex.lemma_count() > 100_000);
    let (pos, def) = lex.definition("windmill", None).expect("windmill");
    assert_eq!(pos, Pos::Noun);
    assert!(def.contains("mill"), "{def}");
    assert!(lex.definition("run", Some(Pos::Verb)).is_some());
    assert!(lex.definition("zzzzqx", None).is_none());
    assert!(lex.zipf("the").is_some_and(|z| z > 7.0));
    assert!(
        lex.is_function_word("the")
            && lex.is_function_word("of")
            && !lex.is_function_word("windmill")
    );
    assert!(lex.is_phrasal("look", "up") && lex.is_phrasal("give", "in"));
}

#[test]
fn lemmatizes_with_wordnet() {
    let Some(lex) = common::lexicon() else { return };
    let cases = [
        // irregular
        ("went", "go"),
        ("children", "child"),
        ("mice", "mouse"),
        ("better", "good"),
        ("ran", "run"),
        ("geese", "goose"),
        ("feet", "foot"),
        ("thought", "think"),
        ("was", "be"),
        ("women", "woman"),
        // regular
        ("studies", "study"),
        ("running", "run"),
        ("bigger", "big"),
        ("watched", "watch"),
        ("stopped", "stop"),
        ("happier", "happy"),
        ("horses", "horse"),
        ("boxes", "box"),
        ("tried", "try"),
        ("making", "make"),
        ("hoped", "hope"),
        // the form itself, clearly more frequent than the reduction
        ("physics", "physics"),
        ("news", "news"),
        ("windmill", "windmill"),
        ("Windmills", "windmill"),
        ("Napoleon's", "napoleon"),
    ];
    let failures: Vec<String> = cases
        .iter()
        .filter_map(|(w, want)| {
            let got = lemmatize(w, &lex, None).lemma;
            (got != *want).then(|| format!("{w}: got {got}, want {want}"))
        })
        .collect();
    assert!(failures.is_empty(), "{failures:#?}");
    // The user's index decides between candidates.
    let idx = KnownIndex::build(
        &[KnownNote {
            note_id: 1,
            field_html: "axe".into(),
            status: NoteStatus::Mature,
        }],
        &lex,
        &ScanConfig::default(),
    );
    assert_eq!(lemmatize("axes", &lex, None).lemma, "axis");
    assert_eq!(lemmatize("axes", &lex, Some(&idx)).lemma, "axe");
}

fn pages(texts: &[&str]) -> Vec<String> {
    texts.iter().map(|s| s.to_string()).collect()
}

fn scan(texts: &[String], known: &[&str], config: ScanConfig) -> ScanResult {
    let lex = common::lexicon().expect("lexicon");
    let inputs: Vec<PageInput> = texts
        .iter()
        .enumerate()
        .map(|(i, t)| PageInput {
            unit: i as u32,
            text: t,
        })
        .collect();
    let table =
        build_book_table(&inputs, &lex, &AtomicBool::new(false), &mut |_, _| {}).expect("table");
    let notes: Vec<KnownNote> = known
        .iter()
        .enumerate()
        .map(|(i, w)| KnownNote {
            note_id: i as i64,
            field_html: (*w).into(),
            status: NoteStatus::Mature,
        })
        .collect();
    let idx = KnownIndex::build(&notes, &lex, &config);
    let range = resolve_range(&RangeSpec::All, &[], table.page_count).expect("range");
    compare(CompareInput {
        lemmas: &table.lemmas,
        pages: &table.pages,
        range: &range,
        chapters: &[],
        known: &idx,
        overrides: &HashMap::new(),
        previous_notes: &HashMap::new(),
        config: &config,
        lex: &lex,
    })
}

const ANIMAL_FARM: &str = "Mr. Jones, of the Manor Farm, had locked the hen-houses for the night. Old Major, the prize \
    boar, had a strange dream. Napoleon and Snowball were the cleverest of the pigs. Boxer was an enormous beast, \
    nearly eighteen hands high. Napoleon did not speak much, but Snowball was quicker in speech. The animals said \
    that Boxer worked harder than anyone. Snowball drew plans for the windmill, and Napoleon urinated over them. \
    In the end Napoleon drove Snowball off the farm, and Boxer said: Napoleon is always right. Later Squealer told them \
    that Snowball was a traitor and that Napoleon had invented the windmill. Boxer was sent to the knacker by \
    Napoleon. The children threw a snowball at the window.";

#[test]
fn proper_nouns_in_a_story() {
    if common::lexicon().is_none() {
        return;
    }
    let more = "Later, Snowball spoke to the sheep while Napoleon listened. Everyone remembered how Snowball fought at \
        the Battle of the Cowshed, and how bravely Snowball led the charge. The hens said Snowball had been a hero, and the ducks agreed with Snowball.";
    let r = scan(&pages(&[ANIMAL_FARM, more]), &[], ScanConfig::default());
    for name in ["Napoleon", "Snowball", "Boxer", "Squealer"] {
        let row = r
            .rows
            .iter()
            .find(|x| x.lemma == name)
            .unwrap_or_else(|| panic!("no {name}"));
        assert_eq!(
            (row.group, row.status),
            (RowGroup::Proper, Status::Proper),
            "{name}"
        );
    }
    let lower = r
        .rows
        .iter()
        .find(|x| x.lemma == "snowball")
        .expect("lowercase snowball");
    assert_eq!(lower.group, RowGroup::Main);
    assert_eq!(lower.occurrences, 1);
    // Proper nouns are out of the metrics.
    assert!(r.metrics.proper_lemmas >= 4);
    let total: u32 = r
        .rows
        .iter()
        .filter(|x| x.group == RowGroup::Main && x.status != Status::Ignored)
        .map(|x| x.occurrences)
        .sum();
    assert_eq!(
        total
            + r.rows
                .iter()
                .filter(|x| x.group == RowGroup::Forms)
                .map(|x| x.occurrences)
                .sum::<u32>(),
        r.metrics.total_tokens
    );
}

const FAMILIES: &str = "Learning English is fun because every learner learns new things. She learned the meaning \
    of each word with a strong feeling of joy. The old building was interesting to everyone in the town. We must \
    unlearn bad habits, find happiness and move quickly through the long book today.";
const BASES: &[&str] = &[
    "learn", "happy", "quick", "mean", "feel", "build", "interest",
];

#[test]
fn forms_of_known_words() {
    if common::lexicon().is_none() {
        return;
    }
    let r = scan(&pages(&[FAMILIES]), BASES, ScanConfig::default());
    for (form, base) in [
        ("learning", "learn"),
        ("meaning", "mean"),
        ("feeling", "feel"),
        ("building", "build"),
        ("interesting", "interest"),
    ] {
        let row = r
            .rows
            .iter()
            .find(|x| x.lemma == form)
            .unwrap_or_else(|| panic!("no {form}"));
        assert_eq!(row.group, RowGroup::Forms, "{form}");
        assert_eq!(row.status, Status::Known, "{form} counts as known");
        assert_eq!(row.status_source, Some(StatusSource::Form));
        assert!(!row.default_selected, "{form}");
        assert_eq!(
            row.base.as_ref().map(|b| (b.lemma.as_str(), b.status)),
            Some((base, Status::Known)),
            "{form}"
        );
    }
    // Plain inflections are known through the lemma.
    for form in ["learns", "learned"] {
        let row = r
            .rows
            .iter()
            .find(|x| x.form.eq_ignore_ascii_case(form))
            .unwrap_or_else(|| panic!("no row for {form}"));
        assert_eq!(row.status, Status::Known, "{form}");
    }
}

#[test]
fn function_words_whose_lemma_is_another_word() {
    if common::lexicon().is_none() {
        return;
    }
    // morphy reads "his" as the plural of the noun "hi"; it is still a function word (Snowball list).
    let r = scan(
        &pages(&["The Time Traveller explains his theory and shows his machine."]),
        &[],
        ScanConfig::default(),
    );
    let his = r
        .rows
        .iter()
        .find(|x| x.form.eq_ignore_ascii_case("his"))
        .expect("a row for his");
    assert_eq!(his.status, Status::Known, "{his:?}");
    assert_eq!(his.status_source, Some(StatusSource::Function));
}

#[test]
fn derivatives_of_known_words() {
    if common::lexicon().is_none() {
        return;
    }
    let r = scan(&pages(&[FAMILIES]), BASES, ScanConfig::default());
    for (word, base) in [
        ("learner", "learn"),
        ("unlearn", "learn"),
        ("happiness", "happy"),
        ("quickly", "quick"),
    ] {
        let row = r
            .rows
            .iter()
            .find(|x| x.lemma == word)
            .unwrap_or_else(|| panic!("no {word}"));
        assert_eq!(row.status, Status::Unknown, "{word} becomes a card");
        assert_eq!(row.group, RowGroup::Main);
        assert!(row.default_selected, "{word}");
        assert_eq!(
            row.family.as_ref().map(|f| f.lemma.as_str()),
            Some(base),
            "{word}"
        );
    }
    let known_cfg = ScanConfig {
        derived_policy: DerivedPolicy::Known,
        ..ScanConfig::default()
    };
    let k = scan(&pages(&[FAMILIES]), BASES, known_cfg);
    for word in ["learner", "unlearn", "happiness", "quickly"] {
        let row = k.rows.iter().find(|x| x.lemma == word).expect("row");
        assert_eq!(
            (row.status, row.status_source),
            (Status::Known, Some(StatusSource::Family)),
            "{word}"
        );
        assert!(!row.default_selected);
    }
    assert!(k.metrics.known_tokens > r.metrics.known_tokens);
}

#[test]
fn no_false_families() {
    let Some(lex) = common::lexicon() else { return };
    // Affix look-alikes (number → numb, summer → sum, corner → corn, station → state, record → cord) and the OEWN
    // link from a rare sense (letter "one who lets" → let).
    for word in ["letter", "number", "summer", "corner", "station", "record"] {
        assert!(
            lex.family_bases(word).is_empty(),
            "{word}: {:?}",
            lex.family_bases(word)
        );
    }
    for (word, base) in [
        ("learner", "learn"),
        ("unlearn", "learn"),
        ("happiness", "happy"),
        ("quickly", "quick"),
        ("runner", "run"),
        ("creation", "create"),
    ] {
        assert!(
            lex.family_bases(word).iter().any(|b| b == base),
            "{word}: {:?}",
            lex.family_bases(word)
        );
    }
}

#[test]
fn marks_oracle_matches_the_scan() {
    let Some(lex) = common::lexicon() else { return };
    let notes: Vec<KnownNote> = BASES
        .iter()
        .chain(["dream"].iter())
        .enumerate()
        .map(|(i, w)| KnownNote {
            note_id: i as i64,
            field_html: (*w).into(),
            status: if *w == "dream" {
                NoteStatus::Learning
            } else {
                NoteStatus::Mature
            },
        })
        .collect();
    let idx = KnownIndex::build(&notes, &lex, &ScanConfig::default());
    let oracle = StatusOracle::new(idx, HashMap::new(), ScanConfig::default(), lex.clone());
    let words = [
        ("The", true),
        ("learner", false),
        ("dreams", false),
        ("of", false),
        ("Napoleon", false),
        ("learning", false),
        ("windmills", false),
        ("1984", false),
        ("quickly", false),
    ];
    let marks = oracle.classify_words(&words);
    let got: Vec<Option<(&str, MarkStatus)>> = marks
        .iter()
        .map(|m| m.as_ref().map(|k| (k.lemma.as_str(), k.status)))
        .collect();
    assert_eq!(
        got,
        vec![
            None,
            Some(("learner", MarkStatus::Unknown)),
            Some(("dream", MarkStatus::Learning)),
            None,
            None,
            None,
            Some(("windmill", MarkStatus::Unknown)),
            None,
            Some(("quickly", MarkStatus::Unknown)),
        ]
    );
}

#[test]
fn sampler_writes_a_review_csv() {
    let Some(lex) = common::lexicon() else { return };
    let inputs = [
        PageInput {
            unit: 0,
            text: ANIMAL_FARM,
        },
        PageInput {
            unit: 1,
            text: FAMILIES,
        },
    ];
    let a = sample_tokens(&inputs, &lex, None, 100, 7);
    let b = sample_tokens(&inputs, &lex, None, 100, 7);
    assert_eq!(a, b, "deterministic for a seed");
    assert_eq!(a.len(), 100);
    assert!(a.windows(2).all(|w| w[0].page <= w[1].page));
    let csv = to_csv(&a);
    assert!(csv.starts_with("token,lemma,pos,status,page,sentence,lemma_ok,status_ok\n"));
    assert_eq!(csv.lines().count(), 101);
    assert!(
        a.iter()
            .any(|r| r.token == "Napoleon" && r.status == Status::Proper)
    );
}
