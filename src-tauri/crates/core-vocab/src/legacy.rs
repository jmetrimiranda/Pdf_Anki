//! The provisional rule-based lemmatizer of Phase 4 ("Definir palavra", spec 12.7). It is the fallback when the
//! vocabulary data pack is missing ([`crate::lemma_with`] with `None`). Pure Rust, no data files, never panics.

use unicode_segmentation::UnicodeSegmentation;

/// Longest text [`single_word`] accepts as a word, in chars.
pub const MAX_WORD_CHARS: usize = 64;

/// Irregular forms and words the suffix rules would get wrong (form → lemma; identity entries protect a word).
const IRREGULAR: &[(&str, &str)] = &[
    // be / have / do / go
    ("am", "be"),
    ("is", "be"),
    ("are", "be"),
    ("was", "be"),
    ("were", "be"),
    ("been", "be"),
    ("being", "be"),
    ("has", "have"),
    ("had", "have"),
    ("having", "have"),
    ("does", "do"),
    ("did", "do"),
    ("done", "do"),
    ("doing", "do"),
    ("goes", "go"),
    ("went", "go"),
    ("gone", "go"),
    ("going", "go"),
    // irregular verbs
    ("said", "say"),
    ("says", "say"),
    ("made", "make"),
    ("took", "take"),
    ("taken", "take"),
    ("came", "come"),
    ("saw", "see"),
    ("seen", "see"),
    ("knew", "know"),
    ("known", "know"),
    ("got", "get"),
    ("gotten", "get"),
    ("gave", "give"),
    ("given", "give"),
    ("found", "find"),
    ("thought", "think"),
    ("told", "tell"),
    ("became", "become"),
    ("left", "leave"),
    ("felt", "feel"),
    ("brought", "bring"),
    ("began", "begin"),
    ("begun", "begin"),
    ("kept", "keep"),
    ("held", "hold"),
    ("wrote", "write"),
    ("written", "write"),
    ("stood", "stand"),
    ("heard", "hear"),
    ("meant", "mean"),
    ("met", "meet"),
    ("ran", "run"),
    ("paid", "pay"),
    ("sat", "sit"),
    ("spoke", "speak"),
    ("spoken", "speak"),
    ("lay", "lie"),
    ("lain", "lie"),
    ("lying", "lie"),
    ("led", "lead"),
    ("grew", "grow"),
    ("grown", "grow"),
    ("lost", "lose"),
    ("fell", "fall"),
    ("fallen", "fall"),
    ("sent", "send"),
    ("built", "build"),
    ("understood", "understand"),
    ("drew", "draw"),
    ("drawn", "draw"),
    ("broke", "break"),
    ("broken", "break"),
    ("spent", "spend"),
    ("rose", "rise"),
    ("risen", "rise"),
    ("drove", "drive"),
    ("driven", "drive"),
    ("bought", "buy"),
    ("wore", "wear"),
    ("worn", "wear"),
    ("chose", "choose"),
    ("chosen", "choose"),
    ("sought", "seek"),
    ("threw", "throw"),
    ("thrown", "throw"),
    ("caught", "catch"),
    ("dealt", "deal"),
    ("won", "win"),
    ("forgot", "forget"),
    ("forgotten", "forget"),
    ("sold", "sell"),
    ("fought", "fight"),
    ("taught", "teach"),
    ("ate", "eat"),
    ("eaten", "eat"),
    ("sang", "sing"),
    ("sung", "sing"),
    ("flew", "fly"),
    ("flown", "fly"),
    ("drank", "drink"),
    ("drunk", "drink"),
    ("swam", "swim"),
    ("swum", "swim"),
    ("rode", "ride"),
    ("ridden", "ride"),
    ("hid", "hide"),
    ("hidden", "hide"),
    ("shook", "shake"),
    ("shaken", "shake"),
    ("stole", "steal"),
    ("stolen", "steal"),
    ("woke", "wake"),
    ("woken", "wake"),
    ("slept", "sleep"),
    ("fed", "feed"),
    ("fled", "flee"),
    ("hung", "hang"),
    ("dug", "dig"),
    ("shot", "shoot"),
    ("stuck", "stick"),
    ("struck", "strike"),
    ("swore", "swear"),
    ("sworn", "swear"),
    ("tore", "tear"),
    ("torn", "tear"),
    ("froze", "freeze"),
    ("frozen", "freeze"),
    ("forgave", "forgive"),
    ("forgiven", "forgive"),
    ("bore", "bear"),
    ("borne", "bear"),
    ("beaten", "beat"),
    ("bent", "bend"),
    ("bled", "bleed"),
    ("blew", "blow"),
    ("blown", "blow"),
    ("bred", "breed"),
    ("lent", "lend"),
    ("lit", "light"),
    ("slid", "slide"),
    ("spun", "spin"),
    ("sprang", "spring"),
    ("sprung", "spring"),
    ("stung", "sting"),
    ("swung", "swing"),
    ("wept", "weep"),
    ("died", "die"),
    ("dying", "die"),
    ("tying", "tie"),
    ("agreed", "agree"),
    ("freed", "free"),
    ("guaranteed", "guarantee"),
    ("added", "add"),
    ("adding", "add"),
    ("focused", "focus"),
    ("focusing", "focus"),
    ("biased", "bias"),
    ("guided", "guide"),
    ("aches", "ache"),
    ("created", "create"),
    ("creating", "create"),
    ("movies", "movie"),
    ("cookies", "cookie"),
    ("calories", "calorie"),
    ("zombies", "zombie"),
    ("headaches", "headache"),
    // irregular nouns
    ("children", "child"),
    ("men", "man"),
    ("women", "woman"),
    ("mice", "mouse"),
    ("geese", "goose"),
    ("feet", "foot"),
    ("teeth", "tooth"),
    ("oxen", "ox"),
    ("lice", "louse"),
    ("wolves", "wolf"),
    ("knives", "knife"),
    ("wives", "wife"),
    ("halves", "half"),
    ("shelves", "shelf"),
    ("thieves", "thief"),
    ("loaves", "loaf"),
    ("calves", "calf"),
    ("selves", "self"),
    ("elves", "elf"),
    ("criteria", "criterion"),
    ("phenomena", "phenomenon"),
    ("analyses", "analysis"),
    ("crises", "crisis"),
    ("theses", "thesis"),
    ("cacti", "cactus"),
    ("fungi", "fungus"),
    ("buses", "bus"),
    ("gases", "gas"),
    ("lenses", "lens"),
    ("heroes", "hero"),
    ("potatoes", "potato"),
    ("tomatoes", "tomato"),
    ("echoes", "echo"),
    ("quizzes", "quiz"),
    // irregular comparison
    ("better", "good"),
    ("best", "good"),
    ("worse", "bad"),
    ("worst", "bad"),
    ("farther", "far"),
    ("farthest", "far"),
    ("further", "far"),
    ("furthest", "far"),
    ("elder", "old"),
    ("eldest", "old"),
    ("less", "little"),
    ("least", "little"),
    // words the rules would cut
    ("always", "always"),
    ("perhaps", "perhaps"),
    ("news", "news"),
    ("series", "series"),
    ("species", "species"),
    ("means", "means"),
    ("politics", "politics"),
    ("physics", "physics"),
    ("mathematics", "mathematics"),
    ("economics", "economics"),
    ("its", "its"),
    ("yes", "yes"),
    ("gas", "gas"),
    ("atlas", "atlas"),
    ("alias", "alias"),
    ("canvas", "canvas"),
    ("whereas", "whereas"),
    ("bias", "bias"),
    ("chaos", "chaos"),
    ("besides", "besides"),
    ("towards", "towards"),
    ("afterwards", "afterwards"),
    ("sometimes", "sometimes"),
    ("nothing", "nothing"),
    ("something", "something"),
    ("anything", "anything"),
    ("everything", "everything"),
    ("morning", "morning"),
    ("evening", "evening"),
    ("during", "during"),
    ("ceiling", "ceiling"),
    ("pudding", "pudding"),
    ("sibling", "sibling"),
    ("darling", "darling"),
    ("hundred", "hundred"),
    ("naked", "naked"),
    ("wicked", "wicked"),
    ("sacred", "sacred"),
    ("beloved", "beloved"),
    ("kindred", "kindred"),
];

/// The English lemma of a word: lowercased, possessive removed, irregular forms looked up, then regular
/// inflections undone (plural -s/-es/-ies, past -ed/-ied, -ing with doubled consonants and the silent e).
/// Provisional (Phase 6 replaces it); when unsure the word comes back lowercased.
pub fn lemma(word: &str) -> String {
    let mut w = word
        .trim()
        .to_lowercase()
        .replace(['\u{2019}', '\u{2018}'], "'");
    if let Some(stem) = w.strip_suffix("'s") {
        w = stem.to_string();
    } else if w.ends_with("s'") {
        w.pop();
    }
    if let Some((_, lemma)) = IRREGULAR.iter().find(|(form, _)| *form == w) {
        return (*lemma).to_string();
    }
    // Only plain ASCII letters go through the suffix rules (hyphenated words, contractions, numbers and other
    // scripts stay as they are).
    if w.len() < 4 || !w.bytes().all(|b| b.is_ascii_lowercase()) {
        return w;
    }
    regular(&w).unwrap_or(w)
}

fn is_vowel(b: u8) -> bool {
    matches!(b, b'a' | b'e' | b'i' | b'o' | b'u')
}

fn has_vowel(s: &str) -> bool {
    s.bytes().any(|b| is_vowel(b) || b == b'y')
}

fn regular(w: &str) -> Option<String> {
    let len = w.len();
    if let Some(stem) = w.strip_suffix("ies") {
        // studies → study; ties → tie (4 letters: only the s).
        return Some(if len > 4 {
            format!("{stem}y")
        } else {
            w[..len - 1].to_string()
        });
    }
    if let Some(stem) = w.strip_suffix("ied") {
        return Some(if len > 4 {
            format!("{stem}y")
        } else {
            w[..len - 1].to_string()
        });
    }
    if w.ends_with("sses") || w.ends_with("zzes") {
        return Some(w[..len - 2].to_string());
    }
    if w.ends_with("ches") || w.ends_with("shes") || w.ends_with("xes") {
        return Some(w[..len - 2].to_string());
    }
    if w.ends_with('s') {
        if w.ends_with("ss") || w.ends_with("us") || w.ends_with("is") {
            return None;
        }
        // horses → horse, sizes → size, moves → move, days → day.
        return Some(w[..len - 1].to_string());
    }
    if let Some(stem) = w.strip_suffix("ed") {
        if w.ends_with("eed") {
            return None;
        }
        return verb_stem(stem);
    }
    if let Some(stem) = w.strip_suffix("ing") {
        return verb_stem(stem);
    }
    None
}

/// The verb behind `stem` + -ed/-ing: undoubles the final consonant (stopped → stop) or restores the silent e
/// (hoped → hope, making → make). `None` when the stem cannot be a verb (thing, bed).
fn verb_stem(stem: &str) -> Option<String> {
    let b = stem.as_bytes();
    let n = b.len();
    if n < 2 || !has_vowel(stem) {
        return None;
    }
    let last = b[n - 1];
    let prev = b[n - 2];
    // stopped → stop, running → run (not -ll, -ss, -zz, -ff: called, missed, buzzed, stuffed).
    if last == prev && !is_vowel(last) && !matches!(last, b'l' | b's' | b'z' | b'f') {
        return Some(stem[..n - 1].to_string());
    }
    if needs_silent_e(b) {
        return Some(format!("{stem}e"));
    }
    Some(stem.to_string())
}

fn needs_silent_e(b: &[u8]) -> bool {
    let n = b.len();
    let last = b[n - 1];
    let prev = b[n - 2];
    let consonant = |c: u8| c.is_ascii_lowercase() && !is_vowel(c) && c != b'y';
    // No English word ends in v or a lone c/u/z: loved, danced, continued, sized (not buzzed).
    if last == b'v'
        || last == b'c'
        || (last == b'u' && prev != b'u')
        || (last == b'z' && prev != b'z')
    {
        return true;
    }
    if last == b'g' && matches!(prev, b'd' | b'r') {
        return true; // judged, charged
    }
    if n >= 5
        && last == b'g'
        && prev == b'n'
        && matches!(b[n - 3], b'a' | b'e')
        && consonant(b[n - 4])
    {
        return true; // changed, arranged, challenged
    }
    // troubled, settled, handled.
    if last == b'l' && matches!(prev, b'b' | b'p' | b'g' | b'k' | b't' | b'd' | b'f' | b'z') {
        return true;
    }
    // sensed, nursed, collapsed, pulsed; raised, promised, closed, used.
    if last == b's' && matches!(prev, b'n' | b'r' | b'p' | b'l' | b'a' | b'i' | b'o' | b'u') {
        return true;
    }
    if n >= 3 {
        let before = b[n - 3];
        let hit = match (prev, last) {
            (b'a', b't') => consonant(before), // related, separated, stated
            (b'i', b'd') => consonant(before) && n >= 4, // decided, provided
            (b'i', b'r') => consonant(before) || before == b'u', // desired, required
            (b'u', b'r') => consonant(before), // secured, measured
            (b'u', b't') => consonant(before) && n >= 5, // computed, executed
            _ => false,
        };
        if hit {
            return true;
        }
    }
    // One-syllable consonant-vowel-consonant (hop, name, smile, vote): measure 1 and not w/x/y.
    n >= 3
        && consonant(last)
        && !matches!(last, b'w' | b'x' | b'y')
        && is_vowel(prev)
        && consonant(b[n - 3])
        && measure(b) == 1
}

/// Porter's measure m of `[C](VC){m}[V]`.
fn measure(b: &[u8]) -> usize {
    let mut m = 0;
    let mut seen_vowel = false;
    for (i, &c) in b.iter().enumerate() {
        let vowel = is_vowel(c) || (c == b'y' && i > 0 && !is_vowel(b[i - 1]));
        if vowel {
            seen_vowel = true;
        } else if seen_vowel {
            m += 1;
            seen_vowel = false;
        }
    }
    m
}

/// The selection as a single word (spec 10.2 "Vocabulário" only for one word, 12.7): surrounding punctuation is
/// trimmed and the rest must be exactly one UAX #29 word (internal apostrophes, as in "don't") or words joined by
/// hyphens ("well-known"), with at least one letter. Anything else is `None`.
pub fn single_word(text: &str) -> Option<String> {
    let t = text.trim_matches(|c: char| !c.is_alphanumeric());
    if t.is_empty() || t.chars().count() > MAX_WORD_CHARS || !t.chars().any(char::is_alphabetic) {
        return None;
    }
    let one_word = |part: &str| {
        let mut words = part.unicode_words();
        matches!((words.next(), words.next()), (Some(w), None) if w == part)
    };
    t.split(['-', '\u{2010}', '\u{2011}'])
        .all(one_word)
        .then(|| t.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lemmas() {
        let cases = [
            // irregular
            ("was", "be"),
            ("Were", "be"),
            ("been", "be"),
            ("is", "be"),
            ("went", "go"),
            ("gone", "go"),
            ("goes", "go"),
            ("children", "child"),
            ("mice", "mouse"),
            ("better", "good"),
            ("worst", "bad"),
            ("thought", "think"),
            ("wolves", "wolf"),
            ("knives", "knife"),
            ("feet", "foot"),
            ("had", "have"),
            ("did", "do"),
            ("taught", "teach"),
            // possessive
            ("Napoleon's", "napoleon"),
            ("farmer’s", "farmer"),
            ("animals'", "animal"),
            // plurals
            ("studies", "study"),
            ("flies", "fly"),
            ("ties", "tie"),
            ("classes", "class"),
            ("boxes", "box"),
            ("watches", "watch"),
            ("wishes", "wish"),
            ("buzzes", "buzz"),
            ("horses", "horse"),
            ("houses", "house"),
            ("sizes", "size"),
            ("windmills", "windmill"),
            ("days", "day"),
            ("pigs", "pig"),
            ("shoes", "shoe"),
            ("moves", "move"),
            ("photos", "photo"),
            ("ideas", "idea"),
            ("glass", "glass"),
            ("famous", "famous"),
            ("analysis", "analysis"),
            ("this", "this"),
            ("always", "always"),
            ("news", "news"),
            ("buses", "bus"),
            // past
            ("stopped", "stop"),
            ("planned", "plan"),
            ("called", "call"),
            ("missed", "miss"),
            ("hoped", "hope"),
            ("named", "name"),
            ("smiled", "smile"),
            ("voted", "vote"),
            ("loved", "love"),
            ("danced", "dance"),
            ("judged", "judge"),
            ("changed", "change"),
            ("created", "create"),
            ("decided", "decide"),
            ("required", "require"),
            ("secured", "secure"),
            ("troubled", "trouble"),
            ("raised", "raise"),
            ("used", "use"),
            ("continued", "continue"),
            ("studied", "study"),
            ("tried", "try"),
            ("died", "die"),
            ("played", "play"),
            ("jumped", "jump"),
            ("opened", "open"),
            ("visited", "visit"),
            ("wanted", "want"),
            ("looked", "look"),
            ("rained", "rain"),
            ("fixed", "fix"),
            ("showed", "show"),
            ("treated", "treat"),
            ("need", "need"),
            ("agreed", "agree"),
            ("added", "add"),
            ("bed", "bed"),
            ("hundred", "hundred"),
            // -ing
            ("running", "run"),
            ("making", "make"),
            ("hoping", "hope"),
            ("telling", "tell"),
            ("putting", "put"),
            ("studying", "study"),
            ("seeing", "see"),
            ("dying", "die"),
            ("lying", "lie"),
            ("using", "use"),
            ("arguing", "argue"),
            ("thing", "thing"),
            ("king", "king"),
            ("bring", "bring"),
            ("nothing", "nothing"),
            ("morning", "morning"),
            ("building", "build"),
            // left alone
            ("Windmill", "windmill"),
            ("don't", "don't"),
            ("well-known", "well-known"),
            ("1984", "1984"),
            ("ação", "ação"),
            ("", ""),
            ("cat", "cat"),
        ];
        assert!(cases.len() >= 60);
        let failures: Vec<String> = cases
            .iter()
            .filter(|(w, l)| lemma(w) != *l)
            .map(|(w, l)| format!("{w}: got {}, want {l}", lemma(w)))
            .collect();
        assert!(failures.is_empty(), "{failures:#?}");
    }

    #[test]
    fn irregular_table_is_lowercase_and_unique() {
        assert!(IRREGULAR.len() >= 150, "{}", IRREGULAR.len());
        let mut seen = std::collections::HashSet::new();
        for (form, lemma) in IRREGULAR {
            assert_eq!(form.to_lowercase(), *form);
            assert!(!lemma.is_empty());
            assert!(seen.insert(*form), "duplicate {form}");
        }
    }

    #[test]
    fn never_panics_on_odd_input() {
        for w in [
            "s",
            "'s",
            "’s",
            "ed",
            "ing",
            "ies",
            "ied",
            "es",
            "sses",
            "-",
            "🐷s",
            "ÉTATS",
            "x'",
            "a\u{301}s",
        ] {
            let _ = lemma(w);
            let _ = single_word(w);
        }
    }

    #[test]
    fn single_words() {
        let cases: [(&str, Option<&str>); 18] = [
            ("windmill", Some("windmill")),
            ("wind mill", None),
            ("don't", Some("don't")),
            ("don’t", Some("don’t")),
            ("well-known", Some("well-known")),
            ("  Farm,", Some("Farm")),
            ("\"Snowball!\"", Some("Snowball")),
            ("(Boxer)", Some("Boxer")),
            ("Napoleon's", Some("Napoleon's")),
            ("ação", Some("ação")),
            ("", None),
            ("   ", None),
            ("...", None),
            ("1984", None),
            ("two words", None),
            ("line\nbreak", None),
            ("well--known", None),
            ("a.b, c", None),
        ];
        for (text, want) in cases {
            assert_eq!(single_word(text).as_deref(), want, "{text:?}");
        }
        assert_eq!(single_word(&"a".repeat(MAX_WORD_CHARS + 1)), None);
    }
}
