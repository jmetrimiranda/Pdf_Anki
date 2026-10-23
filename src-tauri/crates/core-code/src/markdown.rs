//! Markdown batch import of code cards (spec 11.7): a preview with the errors of each item.
//!
//! ````markdown
//! ### Pergunta
//! ```bash            ← the first fenced block is the Resposta (bash/sh/ros2 → Comando,
//! ros2 topic list       python/cpp → Programa)
//! ```
//! ```tests           ← after it: tests | input + output | setup | start (Programa only)
//! ...
//! ```
//! > Observação       ← blockquote
//! aceitas: …         ← optional, one or more (Comando)
//! exige: …           ← optional (Comando)
//! tags: a b          ← optional, space separated
//! ````
//!
//! Fields are plain text keyed by the app notetypes' field names; the app turns them into field
//! HTML (`html::code_to_html` for code, `html::prose_to_html` for the Pergunta and Observação).
//! Never panics, whatever the input.

use std::collections::BTreeMap;

use serde::Serialize;

/// Larger texts are refused as a whole.
pub const MAX_TEXT_BYTES: usize = 1024 * 1024;
/// More items are refused as a whole.
pub const MAX_ITEMS: usize = 500;

pub const FIELD_QUESTION: &str = "Pergunta";
pub const FIELD_ANSWER: &str = "Resposta";
pub const FIELD_ACCEPTED: &str = "Aceitas";
pub const FIELD_REQUIRES: &str = "Exige";
pub const FIELD_NOTES: &str = "Observação";
pub const FIELD_LANGUAGE: &str = "Linguagem";
pub const FIELD_MODE: &str = "Modo";
pub const FIELD_START: &str = "Inicial";
pub const FIELD_SETUP: &str = "Setup";
pub const FIELD_TESTS: &str = "Testes";
pub const FIELD_INPUT: &str = "Entrada";
pub const FIELD_OUTPUT: &str = "SaidaEsperada";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub items: Vec<ImportItem>,
    /// Problems of the text as a whole that do not stop the import (pt-BR).
    pub warnings: Vec<String>,
    /// Problems that refuse the whole text (too large, too many items; pt-BR). No items then.
    pub errors: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    /// 0-based position in the text (what `code_import_commit`'s `include` refers to).
    pub index: u32,
    /// 1-based line of the `###` heading.
    pub line: u32,
    pub title: String,
    /// `None` when the Resposta block is missing or its language is unknown (then `errors` says so).
    pub kind: Option<ItemKind>,
    /// `bash`, `sh`, `ros2`, `python` or `cpp`.
    pub language: Option<String>,
    /// Programa items only.
    pub mode: Option<ProgramMode>,
    /// Plain text by field name (Pergunta, Resposta, Aceitas, Exige, Observação, Linguagem, Modo,
    /// Inicial, Setup, Testes, Entrada, SaidaEsperada); absent fields are left empty.
    pub fields: BTreeMap<String, String>,
    pub tags: Vec<String>,
    /// The item cannot be added (pt-BR).
    pub errors: Vec<String>,
    /// The item can be added, but something was ignored (pt-BR).
    pub warnings: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    /// "Código · Comando".
    Command,
    /// "Código · Programa".
    Program,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProgramMode {
    Testes,
    Saida,
    Estrutura,
}

impl ProgramMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Testes => "testes",
            Self::Saida => "saida",
            Self::Estrutura => "estrutura",
        }
    }
}

/// Parses the import text into a preview. Never panics.
pub fn parse(text: &str) -> ImportPreview {
    let mut preview = ImportPreview::default();
    if text.len() > MAX_TEXT_BYTES {
        preview.errors.push(format!(
            "O texto é grande demais para importar de uma vez (máximo de {} MiB).",
            MAX_TEXT_BYTES / (1024 * 1024)
        ));
        return preview;
    }
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    let normalized;
    let text = if text.contains('\r') {
        normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        normalized.as_str()
    } else {
        text
    };
    let lines: Vec<&str> = text.split('\n').collect();
    let blocks = scan(&lines);

    let mut current: Option<ItemBuilder> = None;
    let mut ignored_before_first = false;
    let mut items = Vec::new();
    for block in blocks {
        match block {
            Block::Heading {
                level: 3,
                text,
                line,
            } => {
                if let Some(b) = current.take() {
                    items.push(b);
                }
                current = Some(ItemBuilder::new(items.len(), line, text));
            }
            // A higher-level heading (a section of the file) ends the current item.
            Block::Heading { level, .. } if level < 3 => {
                if let Some(b) = current.take() {
                    items.push(b);
                }
            }
            Block::Blank => {}
            other => match current.as_mut() {
                Some(b) => b.push(other),
                // Text under a section heading (`#`/`##`) between items is a description.
                None if items.is_empty() => ignored_before_first = true,
                None => {}
            },
        }
        if items.len() > MAX_ITEMS {
            break;
        }
    }
    if let Some(b) = current.take() {
        items.push(b);
    }
    if items.len() > MAX_ITEMS {
        preview.errors.push(format!(
            "O texto tem mais de {MAX_ITEMS} perguntas; divida a importação em partes menores."
        ));
        return preview;
    }
    if ignored_before_first {
        preview
            .warnings
            .push("O texto antes do primeiro ### foi ignorado.".to_owned());
    }
    if items.is_empty() && !text.trim().is_empty() {
        preview.warnings.push(
            "Nenhuma pergunta encontrada: cada pergunta começa com uma linha ### .".to_owned(),
        );
    }
    preview.items = items.into_iter().map(ItemBuilder::finish).collect();
    preview
}

// --- Scanner ----------------------------------------------------------------------------------

#[derive(Debug)]
enum Block<'a> {
    Heading {
        level: usize,
        text: String,
        line: u32,
    },
    Fence {
        info: String,
        content: String,
        line: u32,
        unclosed: bool,
    },
    Quote {
        text: String,
    },
    Text {
        text: &'a str,
        line: u32,
    },
    Blank,
}

/// Up to three spaces of indentation, as in CommonMark (an indented copy of the spec's example
/// still imports).
fn strip_indent(line: &str) -> (usize, &str) {
    let n = line.bytes().take(3).take_while(|b| *b == b' ').count();
    (n, &line[n..])
}

/// An ATX heading: `#`×level, then a space or the end of the line.
fn heading(line: &str) -> Option<(usize, String)> {
    let (_, rest) = strip_indent(line);
    let level = rest.bytes().take_while(|b| *b == b'#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let after = &rest[level..];
    if !(after.is_empty() || after.starts_with([' ', '\t'])) {
        return None;
    }
    let mut text = after.trim();
    // The optional closing sequence: `### Título ###`.
    let without = text.trim_end_matches('#');
    if without.len() != text.len() && (without.is_empty() || without.ends_with([' ', '\t'])) {
        text = without.trim_end();
    }
    Some((level, text.to_owned()))
}

struct FenceOpen {
    indent: usize,
    ch: char,
    len: usize,
    info: String,
}

fn fence_open(line: &str) -> Option<FenceOpen> {
    let (indent, rest) = strip_indent(line);
    let ch = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let len = rest.chars().take_while(|c| *c == ch).count();
    if len < 3 {
        return None;
    }
    let info = rest[len..].trim();
    // A backtick fence's info string never holds a backtick.
    if ch == '`' && info.contains('`') {
        return None;
    }
    Some(FenceOpen {
        indent,
        ch,
        len,
        info: info.to_owned(),
    })
}

fn is_fence_close(line: &str, open: &FenceOpen) -> bool {
    let (_, rest) = strip_indent(line);
    let rest = rest.trim_end();
    let len = rest.chars().take_while(|c| *c == open.ch).count();
    len >= open.len && rest.chars().all(|c| c == open.ch)
}

/// Removes up to `indent` leading spaces (the opening fence's indentation) from a content line.
fn dedent(line: &str, indent: usize) -> &str {
    let n = line.bytes().take(indent).take_while(|b| *b == b' ').count();
    &line[n..]
}

fn line_no(i: usize) -> u32 {
    u32::try_from(i + 1).unwrap_or(u32::MAX)
}

/// A `###` heading whose next non-blank line opens a fence with a language.
fn starts_item(lines: &[&str], j: usize) -> bool {
    if !matches!(heading(lines[j]), Some((3, _))) {
        return false;
    }
    lines[j + 1..]
        .iter()
        .find(|l| !l.trim().is_empty())
        .and_then(|l| fence_open(l))
        .is_some_and(|f| !f.info.is_empty())
}

fn scan<'a>(lines: &[&'a str]) -> Vec<Block<'a>> {
    let mut blocks = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if let Some(open) = fence_open(line) {
            let close = (i + 1..lines.len()).find(|&j| is_fence_close(lines[j], &open));
            // An unclosed fence would swallow the next items (or close on the next item's closing
            // fence). It ends instead where the next item visibly starts: a `###` line followed by
            // a fence with a language (a `###` comment inside code is not followed by one), or at
            // the next `###` when nothing closes it at all.
            let limit = close.unwrap_or(lines.len());
            let item_start = (i + 1..limit).find(|&j| starts_item(lines, j));
            let (end, next, unclosed) = match (item_start, close) {
                (Some(h), _) => (h, h, true),
                (None, Some(j)) => (j, j + 1, false),
                (None, None) => {
                    let h = (i + 1..lines.len())
                        .find(|&j| matches!(heading(lines[j]), Some((3, _))))
                        .unwrap_or(lines.len());
                    (h, h, true)
                }
            };
            let content: Vec<&str> = lines[i + 1..end]
                .iter()
                .map(|l| dedent(l, open.indent))
                .collect();
            let mut content = content.join("\n");
            if unclosed {
                let trimmed = content.trim_end_matches('\n').len();
                content.truncate(trimmed);
            }
            blocks.push(Block::Fence {
                info: open.info,
                content,
                line: line_no(i),
                unclosed,
            });
            i = next;
            continue;
        }
        if let Some((level, text)) = heading(line) {
            blocks.push(Block::Heading {
                level,
                text,
                line: line_no(i),
            });
            i += 1;
            continue;
        }
        let (_, rest) = strip_indent(line);
        if rest.starts_with('>') {
            let mut quote = Vec::new();
            while i < lines.len() {
                let (_, rest) = strip_indent(lines[i]);
                let Some(q) = rest.strip_prefix('>') else {
                    break;
                };
                quote.push(q.strip_prefix(' ').unwrap_or(q).trim_end());
                i += 1;
            }
            blocks.push(Block::Quote {
                text: quote.join("\n"),
            });
            continue;
        }
        if line.trim().is_empty() {
            blocks.push(Block::Blank);
        } else {
            blocks.push(Block::Text {
                text: line,
                line: line_no(i),
            });
        }
        i += 1;
    }
    blocks
}

// --- Items ------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Extra {
    Tests,
    Output,
    Input,
    Setup,
    Start,
}

impl Extra {
    fn from_info(lang: &str) -> Option<Self> {
        Some(match lang {
            "tests" => Self::Tests,
            "output" => Self::Output,
            "input" => Self::Input,
            "setup" => Self::Setup,
            "start" => Self::Start,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Self::Tests => "tests",
            Self::Output => "output",
            Self::Input => "input",
            Self::Setup => "setup",
            Self::Start => "start",
        }
    }

    fn field(self) -> &'static str {
        match self {
            Self::Tests => FIELD_TESTS,
            Self::Output => FIELD_OUTPUT,
            Self::Input => FIELD_INPUT,
            Self::Setup => FIELD_SETUP,
            Self::Start => FIELD_START,
        }
    }
}

struct ItemBuilder {
    index: usize,
    line: u32,
    title: String,
    answer: Option<(String, String)>,
    kind: Option<ItemKind>,
    language: Option<String>,
    extras: Vec<(Extra, String)>,
    notes: Vec<String>,
    accepted: Vec<String>,
    requires: Vec<String>,
    tags: Vec<String>,
    errors: Vec<String>,
    warnings: Vec<String>,
}

fn push_unique(list: &mut Vec<String>, s: String) {
    if !list.contains(&s) {
        list.push(s);
    }
}

/// `aceitas:`/`exige:`/`tags:` (case-insensitive key) → `(key, trimmed value)`.
fn key_line(line: &str) -> Option<(&'static str, &str)> {
    let trimmed = line.trim();
    let (key, value) = trimmed.split_once(':')?;
    let key = match key.trim().to_lowercase().as_str() {
        "aceitas" => "aceitas",
        "exige" => "exige",
        "tags" => "tags",
        _ => return None,
    };
    Some((key, value.trim()))
}

fn snippet(s: &str) -> String {
    let t = s.trim();
    let mut out: String = t.chars().take(40).collect();
    if t.chars().count() > 40 {
        out.push('…');
    }
    out
}

impl ItemBuilder {
    fn new(index: usize, line: u32, title: String) -> Self {
        Self {
            index,
            line,
            title,
            answer: None,
            kind: None,
            language: None,
            extras: Vec::new(),
            notes: Vec::new(),
            accepted: Vec::new(),
            requires: Vec::new(),
            tags: Vec::new(),
            errors: Vec::new(),
            warnings: Vec::new(),
        }
    }

    fn error(&mut self, message: String) {
        push_unique(&mut self.errors, message);
    }

    fn warning(&mut self, message: String) {
        push_unique(&mut self.warnings, message);
    }

    fn push(&mut self, block: Block<'_>) {
        match block {
            Block::Fence {
                info,
                content,
                line,
                unclosed,
            } => {
                if unclosed {
                    self.error(format!(
                        "Bloco de código sem fechamento (linha {line}): feche-o com ```."
                    ));
                }
                let lang = info.split_whitespace().next().unwrap_or("").to_lowercase();
                if self.answer.is_none() {
                    self.answer_block(&lang, content);
                } else {
                    self.extra_block(&lang, content);
                }
            }
            Block::Quote { text } => self.notes.push(text),
            Block::Text { text, line } => match key_line(text) {
                Some(("aceitas", v)) => {
                    if !v.is_empty() {
                        self.accepted.push(v.to_owned());
                    }
                }
                Some(("exige", v)) => {
                    if !v.is_empty() {
                        self.requires.push(v.to_owned());
                    }
                }
                Some((_, v)) => {
                    for tag in v.split_whitespace() {
                        push_unique(&mut self.tags, tag.to_owned());
                    }
                }
                None => self.warning(format!("Linha {line} ignorada: {}", snippet(text))),
            },
            Block::Heading { line, .. } => {
                self.warning(format!(
                    "Título da linha {line} ignorado (use ### para perguntas)."
                ));
            }
            Block::Blank => {}
        }
    }

    fn answer_block(&mut self, lang: &str, content: String) {
        let (kind, language) = match lang {
            "bash" | "sh" | "ros2" => (Some(ItemKind::Command), lang),
            "python" | "py" => (Some(ItemKind::Program), "python"),
            "cpp" | "c++" => (Some(ItemKind::Program), "cpp"),
            "" => {
                self.error(
                    "Linguagem do bloco desconhecida: (sem linguagem). Use bash, sh, ros2, python ou cpp."
                        .to_owned(),
                );
                (None, "")
            }
            other => {
                if Extra::from_info(other).is_some() {
                    self.error(format!(
                        "O primeiro bloco é a resposta, mas é um bloco ```{other}."
                    ));
                } else {
                    self.error(format!(
                        "Linguagem do bloco desconhecida: {other}. Use bash, sh, ros2, python ou cpp."
                    ));
                }
                (None, "")
            }
        };
        self.kind = kind;
        if !language.is_empty() {
            self.language = Some(language.to_owned());
        }
        self.answer = Some((language.to_owned(), content));
    }

    fn extra_block(&mut self, lang: &str, content: String) {
        let Some(extra) = Extra::from_info(lang) else {
            let shown = if lang.is_empty() { "(sem nome)" } else { lang };
            self.error(format!(
                "Bloco desconhecido depois da resposta: {shown}. Use tests, input, output, setup ou start."
            ));
            return;
        };
        if self.extras.iter().any(|(e, _)| *e == extra) {
            self.error(format!(
                "O bloco ```{} aparece mais de uma vez.",
                extra.name()
            ));
            return;
        }
        self.extras.push((extra, content));
    }

    fn has(&self, extra: Extra) -> bool {
        self.extras.iter().any(|(e, _)| *e == extra)
    }

    fn finish(mut self) -> ImportItem {
        let mut fields = BTreeMap::new();
        if self.title.trim().is_empty() {
            self.error("A pergunta (o texto depois do ###) está vazia.".to_owned());
        }
        fields.insert(FIELD_QUESTION.to_owned(), self.title.trim().to_owned());

        let mut mode = None;
        match self.answer.take() {
            None => self
                .error("Falta o bloco de código com a resposta (```bash, ```python…).".to_owned()),
            Some((_, answer)) => {
                if answer.trim().is_empty() {
                    self.error("A resposta está vazia.".to_owned());
                }
                fields.insert(FIELD_ANSWER.to_owned(), answer);
            }
        }

        match self.kind {
            Some(ItemKind::Command) => {
                if !self.extras.is_empty() {
                    let names: Vec<&str> = self.extras.iter().map(|(e, _)| e.name()).collect();
                    self.error(format!(
                        "Blocos {} só valem para Python e C++, não para comandos.",
                        names.join(", ")
                    ));
                }
                if !self.accepted.is_empty() {
                    fields.insert(FIELD_ACCEPTED.to_owned(), self.accepted.join("\n"));
                }
                if !self.requires.is_empty() {
                    fields.insert(FIELD_REQUIRES.to_owned(), self.requires.join("\n"));
                }
            }
            Some(ItemKind::Program) => {
                if self.has(Extra::Tests) && self.has(Extra::Output) {
                    self.error("Use ```tests ou ```output, não os dois no mesmo item.".to_owned());
                }
                if self.has(Extra::Input) && !self.has(Extra::Output) {
                    self.error("O bloco ```input precisa de um bloco ```output.".to_owned());
                }
                if !self.accepted.is_empty() || !self.requires.is_empty() {
                    self.warning(
                        "aceitas: e exige: valem só para comandos e foram ignoradas.".to_owned(),
                    );
                }
                let m = if self.has(Extra::Tests) {
                    ProgramMode::Testes
                } else if self.has(Extra::Output) {
                    ProgramMode::Saida
                } else {
                    ProgramMode::Estrutura
                };
                mode = Some(m);
                if let Some(lang) = &self.language {
                    fields.insert(FIELD_LANGUAGE.to_owned(), lang.clone());
                }
                fields.insert(FIELD_MODE.to_owned(), m.as_str().to_owned());
                for (extra, content) in &self.extras {
                    fields.insert(extra.field().to_owned(), content.clone());
                }
            }
            None => {}
        }
        if !self.notes.is_empty() {
            let notes = self.notes.join("\n");
            let notes = notes.trim_matches('\n');
            if !notes.trim().is_empty() {
                fields.insert(FIELD_NOTES.to_owned(), notes.to_owned());
            }
        }
        ImportItem {
            index: u32::try_from(self.index).unwrap_or(u32::MAX),
            line: self.line,
            title: self.title.trim().to_owned(),
            kind: self.kind,
            language: self.language,
            mode,
            fields,
            tags: self.tags,
            errors: self.errors,
            warnings: self.warnings,
        }
    }
}
