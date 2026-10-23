//! Notetypes (docs/PROJETO.md 9, 10.2, 11.1, 12.6): the app's own types, created by
//! "Preparar coleção".
//!
//! Rules (spec 9): idempotent per type (looked up by exact name), an existing type is NEVER
//! modified (changing fields/templates of an existing type forces a full sync), so every type is
//! complete from its first creation.

use std::sync::Arc;

use anki::collection::Collection;
use anki::notetype::{CardTemplate, NoteField, all_stock_notetypes};
use anki::prelude::{I18n, Notetype, NotetypeId};
use anki_proto::notetypes::notetype::config::Kind as NotetypeKind;
use anki_proto::notetypes::stock_notetype::OriginalStockKind;

use crate::error::{Error, Result};
use crate::types::PrepareReport;

pub const BASIC_LEITOR: &str = "Básico (Leitor)";
pub const CLOZE_LEITOR: &str = "Cloze (Leitor)";
pub const CODE_COMMAND: &str = "Código · Comando";
pub const CODE_PROGRAM: &str = "Código · Programa";
pub const VOCAB_BOOK: &str = "Vocabulário · Livro";

/// Notetypes the app creates (idempotent per type, never modified once created).
pub const APP_NOTETYPES: [&str; 5] = [
    BASIC_LEITOR,
    CLOZE_LEITOR,
    CODE_COMMAND,
    CODE_PROGRAM,
    VOCAB_BOOK,
];

/// The field holding the `leitor://` link back to the book (spec 10.2).
pub const SOURCE_FIELD: &str = "Fonte";

/// Shared CSS for the source link at the bottom of the answer.
pub const SOURCE_CSS: &str = "\n.leitor-fonte{font-size:.8em;opacity:.75;margin-top:1em}\n";

/// Code types: long code lines scroll inside their block instead of being cut at narrow widths.
pub const CODE_CSS: &str = "\n.card pre{text-align:left;overflow-x:auto;max-width:100%}\n";

const SOURCE_BLOCK: &str = "{{#Fonte}}<div class=\"leitor-fonte\">{{Fonte}}</div>{{/Fonte}}";

/// Name of a single-template type's card, as Anki's stock pt-BR types name it ("Cartão 1"), so
/// the browser, card info and Anki's pages never show the English "Card 1".
pub fn card_1_name() -> String {
    I18n::new(&["pt-BR"]).notetypes_card_1_name().into()
}

pub fn is_app_notetype(name: &str) -> bool {
    APP_NOTETYPES.contains(&name)
}

/// "Preparar coleção": creates the app notetypes that are missing (by exact name) and leaves
/// existing ones — even a user's own type with the same name — untouched.
pub fn prepare_collection(col: &mut Collection) -> Result<PrepareReport> {
    let mut report = PrepareReport::default();
    for name in APP_NOTETYPES {
        if col.get_notetype_by_name(name)?.is_some() {
            report.existing.push(name.to_string());
            continue;
        }
        let mut nt = definition(name)?;
        // Storage asserts id == 0 for new notetypes (panic, not Err).
        nt.id = NotetypeId(0);
        nt.name = name.to_string();
        col.add_notetype(&mut nt, false)?;
        report.created.push(name.to_string());
    }
    Ok(report)
}

/// Full definition of an app notetype (fields, templates and CSS), before it is added.
pub fn definition(name: &str) -> Result<Notetype> {
    let mut nt = match name {
        BASIC_LEITOR => basic_leitor()?,
        CLOZE_LEITOR => cloze_leitor()?,
        CODE_COMMAND => custom(
            &[
                "Pergunta",
                "Resposta",
                "Aceitas",
                "Exige",
                "Observação",
                SOURCE_FIELD,
            ],
            &[(
                &card_1_name(),
                "{{Pergunta}}\n\n{{type:Resposta}}".to_string(),
                format!(
                    "{{{{FrontSide}}}}<hr id=answer>\
                     {{{{#Observação}}}}<blockquote>{{{{Observação}}}}</blockquote>{{{{/Observação}}}}\
                     {SOURCE_BLOCK}"
                ),
            )],
        ),
        CODE_PROGRAM => custom(
            &[
                "Pergunta",
                "Linguagem",
                "Modo",
                "Resposta",
                "Inicial",
                "Setup",
                "Testes",
                "Entrada",
                "SaidaEsperada",
                "Observação",
                SOURCE_FIELD,
            ],
            &[(
                &card_1_name(),
                "{{Pergunta}}".to_string(),
                format!(
                    "{{{{FrontSide}}}}<hr id=answer>\
                     <pre><code class=\"language-{{{{Linguagem}}}}\">{{{{Resposta}}}}</code></pre>\
                     {{{{#Observação}}}}<blockquote>{{{{Observação}}}}</blockquote>{{{{/Observação}}}}\
                     {SOURCE_BLOCK}"
                ),
            )],
        ),
        VOCAB_BOOK => custom(
            &[
                "Palavra",
                "Lema",
                "Classe",
                "Definição",
                "Tradução",
                "Exemplo",
                SOURCE_FIELD,
                "Frequência",
                // Non-empty value enables the optional pt → en card (off by default, spec 12.6).
                "Card 2",
            ],
            &[
                (
                    "Inglês → Português",
                    "<div class=\"palavra\">{{Palavra}}</div>{{tts en_US:Palavra}}\
                     <div class=\"exemplo\">{{Exemplo}}</div>"
                        .to_string(),
                    format!(
                        "{{{{FrontSide}}}}<hr id=answer><div>{{{{Definição}}}}</div>\
                         <div>{{{{Tradução}}}}</div>{SOURCE_BLOCK}"
                    ),
                ),
                (
                    "Português → Inglês",
                    "{{#Card 2}}{{Tradução}}{{/Card 2}}".to_string(),
                    format!("{{{{FrontSide}}}}<hr id=answer>{{{{Palavra}}}}{SOURCE_BLOCK}"),
                ),
            ],
        ),
        other => return Err(Error::NotFound(format!("tipo de nota do app \"{other}\""))),
    };
    nt.name = name.to_string();
    nt.config.sort_field_idx = 0;
    nt.config.css.push_str(SOURCE_CSS);
    if name == CODE_PROGRAM || name == CODE_COMMAND {
        nt.config.css.push_str(CODE_CSS);
    }
    Ok(nt)
}

/// Clone of the stock Basic (keeps its config, CSS and original stock kind).
fn basic_leitor() -> Result<Notetype> {
    let mut nt = stock(0)?;
    rename_fields(&mut nt, &["Frente", "Verso"]);
    nt.fields.push(NoteField::new(SOURCE_FIELD));
    let tmpl = nt
        .templates
        .first_mut()
        .ok_or_else(|| Error::NotFound("modelo do tipo Básico".into()))?;
    tmpl.name = card_1_name();
    tmpl.config.q_format = "{{Frente}}".into();
    tmpl.config.a_format =
        format!("{{{{FrontSide}}}}\n\n<hr id=answer>\n\n{{{{Verso}}}}{SOURCE_BLOCK}");
    Ok(nt)
}

/// Clone of the stock Cloze (kind Cloze, cloze field tags kept).
fn cloze_leitor() -> Result<Notetype> {
    let mut nt = stock(4)?;
    rename_fields(&mut nt, &["Texto", "Verso extra"]);
    nt.fields.push(NoteField::new(SOURCE_FIELD));
    let tmpl = nt
        .templates
        .first_mut()
        .ok_or_else(|| Error::NotFound("modelo do tipo Cloze".into()))?;
    tmpl.name = "Cloze".into();
    tmpl.config.q_format = "{{cloze:Texto}}".into();
    tmpl.config.a_format = format!("{{{{cloze:Texto}}}}<br>\n{{{{Verso extra}}}}{SOURCE_BLOCK}");
    Ok(nt)
}

/// Stock notetype by index of `all_stock_notetypes` (English base; names are replaced).
fn stock(index: usize) -> Result<Notetype> {
    all_stock_notetypes(&I18n::template_only())
        .into_iter()
        .nth(index)
        .ok_or_else(|| Error::NotFound("tipo de nota padrão do Anki".into()))
}

fn rename_fields(nt: &mut Notetype, names: &[&str]) {
    for (field, name) in nt.fields.iter_mut().zip(names) {
        field.name = (*name).to_string();
    }
}

fn custom(fields: &[&str], templates: &[(&str, String, String)]) -> Notetype {
    Notetype {
        fields: fields.iter().map(|f| NoteField::new(*f)).collect(),
        templates: templates
            .iter()
            .map(|(name, q, a)| CardTemplate::new(*name, q.as_str(), a.as_str()))
            .collect(),
        ..Default::default()
    }
}

/// The collection's stock "Basic" notetype, found by kind rather than by its (localized) name.
/// Picks the oldest one, which is the stock type created with the collection.
pub fn stock_basic(col: &mut Collection) -> Result<Arc<Notetype>> {
    col.get_all_notetypes()?
        .into_iter()
        .filter(|nt| {
            nt.config.original_stock_kind() == OriginalStockKind::Basic
                && nt.config.kind() == NotetypeKind::Normal
                && nt.fields.len() >= 2
                && !nt.templates.is_empty()
                && !is_app_notetype(&nt.name)
        })
        .min_by_key(|nt| nt.id.0)
        .ok_or_else(|| Error::NotFound("tipo de nota Básico".into()))
}
