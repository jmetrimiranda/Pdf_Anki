//! Code cards (spec 11): the "Comando" role of user notetypes (Configurações → Código), the local
//! extras of notes without `Aceitas`/`Exige` (`code_note_extra`), "Contestar", C++ (local compiler on
//! desktop or the remote runner), the code settings with the runner token in the keychain, and the
//! Markdown batch import.
//!
//! Plain [`AppState`] methods (the Tauri commands in `commands.rs` are thin wrappers), so the
//! integration tests need no webview. Nothing here ever changes a notetype (spec 11.1: no schema
//! change, no full sync).

use std::collections::{BTreeMap, HashMap};

use core_anki::notes::{self, NewNote, NotetypeInfo, NotetypeKindName};
use core_anki::notetypes::{self, CODE_COMMAND, CODE_PROGRAM};
use core_code::markdown::{self, ImportItem, ImportPreview, ItemKind};
use core_code::{code_to_html, html_to_code, prose_to_html};
use core_cpp::{CppRequest, CppRunResult, RemoteRunner, RunError};
use core_store::setting_keys as keys;
use core_store::{CodeMappingFields, CodeRole};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::anki::{ChangeReason, UiEvent};
use crate::error::AppError;
use crate::state::AppState;

/// Keychain account of the runner token for the runner at `url` (the stored, normalized URL).
pub fn runner_account(url: &str) -> String {
    format!("runner-token:{url}")
}

/// A user notetype with the "Comando" role (`code_mapping_list`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeMapping {
    pub notetype_id: i64,
    pub notetype_name: String,
    /// Always `code_command` for now (the UI only assigns that role).
    pub role: CodeRole,
    pub fields: CodeMappingFields,
    pub note_count: u32,
    /// Mapped field names the notetype no longer has (its cards are then studied normally).
    pub missing_fields: Vec<String>,
    pub updated_at: i64,
}

/// Extra accepted answers and required prefixes of a note (`code_note_extra_get/set`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeNoteExtra {
    pub note_id: i64,
    pub accepted: Vec<String>,
    pub requires: Vec<String>,
}

/// Where "Contestar" put the user's answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AcceptTarget {
    /// The note's `Aceitas` field (undoable, syncs through Anki).
    Field,
    /// `code_note_extra` (the type has no `Aceitas` field).
    Extra,
    /// It already was the Resposta or an accepted answer: nothing changed.
    Already,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeAcceptResult {
    pub target: AcceptTarget,
    /// Every accepted answer of the note afterwards (plain text).
    pub accepted: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeFormatted {
    pub formatted: String,
    /// `"clang-format"`, or `None` when the code came back unchanged.
    pub formatter: Option<&'static str>,
}

/// Where C++ runs (setting `code_cpp_backend`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CppBackendChoice {
    Auto,
    Local,
    Remote,
}

impl CppBackendChoice {
    fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Local => "local",
            Self::Remote => "remote",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "local" => Self::Local,
            "remote" => Self::Remote,
            _ => Self::Auto,
        }
    }
}

/// Where C++ would run now.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CppBackendEffective {
    Local,
    Remote,
    None,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeStatus {
    pub cpp: CppStatus,
    pub cpp_backend: CppBackendEffective,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CppStatus {
    /// `None` on builds without local compilation (mobile).
    pub local: Option<LocalCppStatus>,
    pub remote: RemoteCppStatus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCppStatus {
    /// First line of `--version` of the compiler found (or its name), `None` without one.
    pub compiler: Option<String>,
    pub clang_format: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCppStatus {
    pub url: Option<String>,
    pub token_set: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSettings {
    pub suggest_easy: bool,
    pub suggest_easy_secs: u32,
    pub output_exact: bool,
    pub cpp_backend: CppBackendChoice,
    pub runner_url: Option<String>,
    /// The token itself never leaves the keychain.
    pub runner_token_set: bool,
}

/// Partial update of [`CodeSettings`]: a missing field is left alone; `null` clears `runnerUrl` /
/// `runnerToken`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CodeSettingsPatch {
    pub suggest_easy: Option<bool>,
    pub suggest_easy_secs: Option<u32>,
    pub output_exact: Option<bool>,
    pub cpp_backend: Option<CppBackendChoice>,
    #[serde(deserialize_with = "double_option")]
    pub runner_url: Option<Option<String>>,
    #[serde(deserialize_with = "double_option")]
    pub runner_token: Option<Option<String>>,
}

fn double_option<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerTestResult {
    pub ok: bool,
    /// pt-BR.
    pub message: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeImportResult {
    pub added: u32,
    pub note_ids: Vec<i64>,
    /// Included items that were not added (they have errors, or no such index).
    pub skipped: u32,
}

fn invalid(message: impl Into<String>) -> AppError {
    AppError::new("invalid_input", message)
}

/// No backend for C++. When the local compiler is there but refused (the app runs as root), says so: the review then
/// falls back to `estrutura` like without a compiler.
fn cpp_unavailable() -> AppError {
    if let Some(refusal) = local_refusal() {
        return AppError::new(
            "code_cpp_unavailable",
            format!("{} Ou configure o runner.", refusal.message_pt()),
        );
    }
    AppError::new(
        "code_cpp_unavailable",
        "Nenhum compilador de C++ encontrado (g++ ou clang++) e nenhum runner configurado.",
    )
}

/// `core_cpp::RunError` → `{ code, message }`.
pub fn run_error(e: RunError) -> AppError {
    tracing::debug!(error = %e, "C++ run error");
    let code = match &e {
        RunError::Unavailable => return cpp_unavailable(),
        // Same code as "no compiler" so the review falls back the same way; the message says why.
        RunError::RunningAsRoot => "code_cpp_unavailable",
        RunError::InvalidRequest(_) => "code_invalid_input",
        RunError::TooLarge => "code_too_large",
        RunError::Io(_) => "code_cpp_io",
        RunError::RemoteUnreachable(_) => "code_runner_unreachable",
        RunError::RemoteAuth => "code_runner_auth",
        RunError::RemoteBusy => "code_runner_busy",
        RunError::RemoteProtocol(_) => "code_runner_protocol",
    };
    AppError::new(code, e.message_pt())
}

/// `http(s)://host[:port][/path]`, normalized with a trailing `/`. Plain http only for local hosts
/// (no dot in the name, `localhost`, loopback addresses): the dev compose network.
pub fn normalize_runner_url(raw: &str) -> Result<String, AppError> {
    let raw = raw.trim();
    let bad = || {
        invalid(
            "Endereço do runner inválido: use https://servidor/ (ou http:// só para um runner local).",
        )
    };
    let (scheme, rest) = raw.split_once("://").ok_or_else(bad)?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(bad());
    }
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if authority.is_empty()
        || authority.contains('@')
        || path.contains(['?', '#'])
        || rest.contains(char::is_whitespace)
    {
        return Err(bad());
    }
    let host = host_of(authority).ok_or_else(bad)?.to_ascii_lowercase();
    if host.is_empty() {
        return Err(bad());
    }
    if scheme == "http" && !is_local_host(&host) {
        return Err(AppError::new(
            "code_runner_insecure_url",
            "Use https:// para o runner: http:// só é aceito para um runner local (localhost ou um nome sem ponto).",
        ));
    }
    let path = if path.ends_with('/') {
        path.to_owned()
    } else {
        format!("{path}/")
    };
    Ok(format!(
        "{scheme}://{}{path}",
        authority.to_ascii_lowercase()
    ))
}

/// The host of `host[:port]` / `[v6]:port`; `None` when the port is not a number.
fn host_of(authority: &str) -> Option<&str> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        return match after {
            "" => Some(host),
            p => p
                .strip_prefix(':')
                .filter(|p| p.parse::<u16>().is_ok())
                .map(|_| host),
        };
    }
    match authority.split_once(':') {
        Some((host, port)) => port.parse::<u16>().is_ok().then_some(host),
        None => Some(authority),
    }
}

fn is_local_host(host: &str) -> bool {
    host == "localhost"
        || host == "::1"
        || host.starts_with("127.")
        || (!host.contains('.') && !host.contains(':'))
}

/// Collapses whitespace runs (the "same answer" test of "Contestar").
fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The non-empty lines of a code field.
fn field_lines(html: &str) -> Vec<String> {
    html_to_code(html)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_owned)
        .collect()
}

/// The app notetype a Markdown item becomes.
fn import_notetype(kind: ItemKind) -> &'static str {
    match kind {
        ItemKind::Command => CODE_COMMAND,
        ItemKind::Program => CODE_PROGRAM,
    }
}

/// Plain-text item fields → field HTML: prose for the Pergunta and the Observação, code otherwise.
fn import_field_html(name: &str, text: &str) -> String {
    if name == markdown::FIELD_QUESTION || name == markdown::FIELD_NOTES {
        prose_to_html(text)
    } else {
        code_to_html(text)
    }
}

/// Adds the errors that come from the collection: a missing app notetype or a missing field.
fn check_import_items(preview: &mut ImportPreview, notetypes: &[NotetypeInfo]) {
    for item in &mut preview.items {
        let Some(kind) = item.kind else { continue };
        let name = import_notetype(kind);
        let Some(nt) = notetypes.iter().find(|nt| nt.name == name) else {
            item.errors
                .push("Prepare a coleção primeiro (Anki → Preparar coleção).".to_owned());
            continue;
        };
        for field in item.fields.keys() {
            if !nt.fields.iter().any(|f| &f.name == field) {
                item.errors.push(format!(
                    "O tipo de nota \"{name}\" não tem o campo \"{field}\"."
                ));
            }
        }
    }
}

impl AppState {
    // --- Comando role of user notetypes ---------------------------------------------------------

    /// The live code mappings of the store as the roles the study engine uses (command only).
    pub(crate) fn code_roles_from_store(&self) -> Result<Vec<core_anki::CodeRole>, AppError> {
        let rows = self.with_store(|s| s.code_mappings())?;
        Ok(rows
            .into_iter()
            .filter(|r| r.role == CodeRole::Command)
            .map(|r| core_anki::CodeRole {
                notetype_id: r.notetype_id,
                question_field: r.fields.question,
                answer_field: r.fields.answer,
                notes_field: r.fields.notes,
            })
            .collect())
    }

    async fn push_code_roles(&self) -> Result<(), AppError> {
        let roles = self.code_roles_from_store()?;
        self.anki_handles()?.svc.set_code_roles(roles).await?;
        Ok(())
    }

    pub async fn code_mapping_list(&self) -> Result<Vec<CodeMapping>, AppError> {
        let rows = self.with_store(|s| s.code_mappings())?;
        let notetypes = self.on_col(notes::notetypes).await?;
        let by_id: HashMap<i64, &NotetypeInfo> = notetypes.iter().map(|nt| (nt.id, nt)).collect();
        Ok(rows
            .into_iter()
            .filter(|r| r.role == CodeRole::Command)
            .filter_map(|r| {
                // A deleted notetype has no cards to study: its mapping is not shown.
                let nt = by_id.get(&r.notetype_id)?;
                let missing_fields = [
                    Some(&r.fields.question),
                    Some(&r.fields.answer),
                    r.fields.notes.as_ref(),
                ]
                .into_iter()
                .flatten()
                .filter(|name| !nt.fields.iter().any(|f| &f.name == *name))
                .cloned()
                .collect();
                Some(CodeMapping {
                    notetype_id: r.notetype_id,
                    notetype_name: nt.name.clone(),
                    role: r.role,
                    fields: r.fields,
                    note_count: nt.note_count,
                    missing_fields,
                    updated_at: r.updated_at,
                })
            })
            .collect())
    }

    /// Assigns (`Some`) or removes (`None`) the "Comando" role of a user notetype. The notetype
    /// itself is never changed.
    pub async fn code_mapping_set(
        &self,
        notetype_id: i64,
        fields: Option<CodeMappingFields>,
    ) -> Result<Vec<CodeMapping>, AppError> {
        let mapping = match fields {
            None => None,
            Some(fields) => Some(self.validate_mapping(notetype_id, fields).await?),
        };
        self.with_store(|s| {
            s.set_code_mapping(notetype_id, mapping.map(|f| (CodeRole::Command, f)))
        })?;
        self.push_code_roles().await?;
        self.code_mapping_list().await
    }

    async fn validate_mapping(
        &self,
        notetype_id: i64,
        fields: CodeMappingFields,
    ) -> Result<CodeMappingFields, AppError> {
        let notetypes = self.on_col(notes::notetypes).await?;
        let nt = notetypes
            .iter()
            .find(|nt| nt.id == notetype_id)
            .ok_or_else(|| AppError::new("not_found", "Tipo de nota não encontrado."))?;
        if notetypes::is_app_notetype(&nt.name) {
            return Err(AppError::new(
                "code_mapping_app_type",
                format!(
                    "\"{}\" é um tipo de nota do app; escolha um tipo de nota seu.",
                    nt.name
                ),
            ));
        }
        if nt.kind == NotetypeKindName::Cloze {
            return Err(AppError::new(
                "code_mapping_cloze",
                "Um tipo de nota de omissão de palavras (cloze) não pode ter o papel Comando.",
            ));
        }
        let question = fields.question.trim().to_owned();
        let answer = fields.answer.trim().to_owned();
        let notes = fields
            .notes
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty());
        for (label, name) in [
            ("Pergunta", Some(&question)),
            ("Resposta", Some(&answer)),
            ("Observação", notes.as_ref()),
        ] {
            let Some(name) = name else { continue };
            if name.is_empty() {
                return Err(invalid(format!("Escolha o campo da {label}.")));
            }
            if !nt.fields.iter().any(|f| &f.name == name) {
                return Err(invalid(format!(
                    "O tipo de nota \"{}\" não tem o campo \"{name}\".",
                    nt.name
                )));
            }
        }
        if question == answer
            || notes
                .as_ref()
                .is_some_and(|n| *n == question || *n == answer)
        {
            return Err(invalid(
                "A Pergunta, a Resposta e a Observação precisam ser campos diferentes.",
            ));
        }
        Ok(CodeMappingFields {
            question,
            answer,
            notes,
        })
    }

    // --- Extras and "Contestar" ------------------------------------------------------------------

    pub fn code_note_extra_get(&self, note_id: i64) -> Result<CodeNoteExtra, AppError> {
        let row = self.with_store(|s| s.code_note_extra(note_id))?;
        Ok(match row {
            Some(r) => CodeNoteExtra {
                note_id,
                accepted: r.accepted,
                requires: r.requires,
            },
            None => CodeNoteExtra {
                note_id,
                ..CodeNoteExtra::default()
            },
        })
    }

    pub fn code_note_extra_set(
        &self,
        note_id: i64,
        accepted: Vec<String>,
        requires: Vec<String>,
    ) -> Result<CodeNoteExtra, AppError> {
        let row = self.with_store(|s| s.set_code_note_extra(note_id, &accepted, &requires))?;
        Ok(CodeNoteExtra {
            note_id,
            accepted: row.accepted,
            requires: row.requires,
        })
    }

    /// "Contestar" (spec 11.2): adds the user's answer to the accepted ones — the `Aceitas` field
    /// when the type has it (an undoable note update), else `code_note_extra`.
    pub async fn code_accept_answer(
        &self,
        note_id: i64,
        answer: String,
    ) -> Result<CodeAcceptResult, AppError> {
        let answer = answer.trim().to_owned();
        if answer.is_empty() {
            return Err(invalid("A resposta está vazia."));
        }
        if answer.chars().count() > core_store::CODE_EXTRA_MAX_CHARS {
            return Err(invalid(format!(
                "A resposta passa de {} caracteres.",
                core_store::CODE_EXTRA_MAX_CHARS
            )));
        }
        let svc = self.anki_handles()?.svc;
        let note = svc.code_note(note_id).await?;
        if note.role.is_none() {
            return Err(AppError::new(
                "code_not_code_note",
                "Esta nota não é de um card de código.",
            ));
        }
        let answer_field = if notetypes::is_app_notetype(&note.notetype_name) {
            core_anki::code::fields::ANSWER.to_owned()
        } else {
            self.with_store(|s| s.code_mappings())?
                .into_iter()
                .find(|m| m.notetype_id == note.notetype_id)
                .map(|m| m.fields.answer)
                .unwrap_or_else(|| core_anki::code::fields::ANSWER.to_owned())
        };
        let reference = note
            .fields
            .get(&answer_field)
            .map(|html| html_to_code(html))
            .unwrap_or_default();
        let extra = self.code_note_extra_get(note_id)?;
        let field_html = note
            .accepted_field
            .as_ref()
            .and_then(|f| note.fields.get(f))
            .cloned();
        let field_accepted = field_html.as_deref().map(field_lines).unwrap_or_default();

        let wanted = squash(&answer);
        let already = squash(&reference) == wanted
            || field_accepted
                .iter()
                .chain(extra.accepted.iter())
                .any(|a| squash(a) == wanted);
        let current = |field: Vec<String>, extra: Vec<String>| {
            let mut all = field;
            for a in extra {
                if !all.contains(&a) {
                    all.push(a);
                }
            }
            all
        };
        if already {
            return Ok(CodeAcceptResult {
                target: AcceptTarget::Already,
                accepted: current(field_accepted, extra.accepted),
            });
        }
        match (note.accepted_field, field_html) {
            (Some(field), Some(html)) => {
                let text = html_to_code(&html);
                let text = text.trim_end_matches(['\n', ' ', '\t']);
                let new_text = if text.trim().is_empty() {
                    answer
                } else {
                    format!("{text}\n{answer}")
                };
                svc.note_field_set(note_id, &field, code_to_html(&new_text))
                    .await?;
                Ok(CodeAcceptResult {
                    target: AcceptTarget::Field,
                    accepted: current(field_lines(&new_text), extra.accepted),
                })
            }
            _ => {
                let mut accepted = extra.accepted;
                accepted.push(answer);
                let row = self.code_note_extra_set(note_id, accepted, extra.requires)?;
                Ok(CodeAcceptResult {
                    target: AcceptTarget::Extra,
                    accepted: row.accepted,
                })
            }
        }
    }

    // --- Settings --------------------------------------------------------------------------------

    fn runner_url_setting(&self) -> Result<Option<String>, AppError> {
        let v = self.with_store(|s| s.setting(keys::RUNNER_URL))?;
        Ok(v.as_str().map(str::to_owned).filter(|s| !s.is_empty()))
    }

    /// The runner token of `url` from the keychain (a keychain error reads as "no token").
    fn runner_token(&self, url: &str) -> Option<String> {
        match self.secret_store().get(&runner_account(url)) {
            Ok(token) => token.filter(|t| !t.is_empty()),
            Err(e) => {
                tracing::warn!(code = %e.code, "could not read the runner token");
                None
            }
        }
    }

    /// Blocks (store, keychain): call it off the async runtime.
    pub fn code_settings_get(&self) -> Result<CodeSettings, AppError> {
        let (suggest_easy, secs, output_exact, backend) = self.with_store(|s| {
            Ok((
                s.setting_as::<bool>(keys::CODE_SUGGEST_EASY)?,
                s.setting_as::<u32>(keys::CODE_SUGGEST_EASY_SECS)?,
                s.setting_as::<bool>(keys::CODE_OUTPUT_EXACT)?,
                s.setting_as::<String>(keys::CODE_CPP_BACKEND)?,
            ))
        })?;
        let runner_url = self.runner_url_setting()?;
        let runner_token_set = runner_url
            .as_deref()
            .is_some_and(|u| self.runner_token(u).is_some());
        Ok(CodeSettings {
            suggest_easy,
            suggest_easy_secs: secs,
            output_exact,
            cpp_backend: CppBackendChoice::parse(&backend),
            runner_url,
            runner_token_set,
        })
    }

    /// Applies a settings patch. The token goes to the keychain only (never to a file); changing
    /// the URL forgets the token of the previous one. Blocks.
    pub fn code_settings_set(&self, patch: CodeSettingsPatch) -> Result<CodeSettings, AppError> {
        let old_url = self.runner_url_setting()?;
        let new_url = match &patch.runner_url {
            None => old_url.clone(),
            Some(None) => None,
            Some(Some(raw)) if raw.trim().is_empty() => None,
            Some(Some(raw)) => Some(normalize_runner_url(raw)?),
        };
        if let Some(secs) = patch.suggest_easy_secs
            && !(1..=600).contains(&secs)
        {
            return Err(invalid(
                "O tempo para sugerir \"Fácil\" vai de 1 a 600 segundos.",
            ));
        }
        let token = match &patch.runner_token {
            Some(Some(t)) if !t.trim().is_empty() => {
                if new_url.is_none() {
                    return Err(invalid("Informe o endereço do runner antes do token."));
                }
                Some(Some(t.trim().to_owned()))
            }
            Some(_) => Some(None),
            None => None,
        };
        self.with_store(|s| {
            if let Some(v) = patch.suggest_easy {
                s.set_setting(keys::CODE_SUGGEST_EASY, v.into())?;
            }
            if let Some(v) = patch.suggest_easy_secs {
                s.set_setting(keys::CODE_SUGGEST_EASY_SECS, v.into())?;
            }
            if let Some(v) = patch.output_exact {
                s.set_setting(keys::CODE_OUTPUT_EXACT, v.into())?;
            }
            if let Some(v) = patch.cpp_backend {
                s.set_setting(keys::CODE_CPP_BACKEND, v.as_str().into())?;
            }
            if patch.runner_url.is_some() {
                match &new_url {
                    Some(u) => s.set_setting(keys::RUNNER_URL, Value::from(u.as_str()))?,
                    None => s.reset_setting(keys::RUNNER_URL)?,
                }
            }
            Ok(())
        })?;
        let store = self.secret_store();
        if old_url != new_url
            && let Some(old) = &old_url
        {
            store.delete(&runner_account(old))?;
        }
        match (token, &new_url) {
            (Some(Some(t)), Some(url)) => store.set(&runner_account(url), &t)?,
            (Some(None), Some(url)) => store.delete(&runner_account(url))?,
            _ => {}
        }
        self.code_settings_get()
    }

    // --- C++ ---------------------------------------------------------------------------------------

    /// The configured remote runner, if both its URL and token are set. Blocks (keychain).
    fn remote_runner(&self) -> Result<Option<RemoteRunner>, AppError> {
        let Some(url) = self.runner_url_setting()? else {
            return Ok(None);
        };
        let Some(token) = self.runner_token(&url) else {
            return Ok(None);
        };
        RemoteRunner::new(&url, &token).map(Some).map_err(run_error)
    }

    /// Where C++ runs now and the remote runner when that is the choice. Blocks (detects the
    /// local compiler once, reads the keychain).
    fn cpp_backend(&self) -> Result<(CppBackendEffective, Option<RemoteRunner>), AppError> {
        let choice = self
            .with_store(|s| s.setting_as::<String>(keys::CODE_CPP_BACKEND))
            .map(|s| CppBackendChoice::parse(&s))?;
        let local = local_compiler().is_some();
        Ok(match choice {
            CppBackendChoice::Local if local => (CppBackendEffective::Local, None),
            CppBackendChoice::Local => (CppBackendEffective::None, None),
            CppBackendChoice::Auto if local => (CppBackendEffective::Local, None),
            CppBackendChoice::Auto | CppBackendChoice::Remote => match self.remote_runner()? {
                Some(r) => (CppBackendEffective::Remote, Some(r)),
                None => (CppBackendEffective::None, None),
            },
        })
    }

    /// Blocks: call it off the async runtime.
    pub fn code_status(&self) -> Result<CodeStatus, AppError> {
        let url = self.runner_url_setting()?;
        let token_set = url
            .as_deref()
            .is_some_and(|u| self.runner_token(u).is_some());
        let (cpp_backend, _) = self.cpp_backend()?;
        Ok(CodeStatus {
            cpp: CppStatus {
                local: local_status(),
                remote: RemoteCppStatus { url, token_set },
            },
            cpp_backend,
        })
    }

    /// Where the next C++ run goes. Blocks (store, keychain, the first compiler probe): call it
    /// off the async runtime, then [`run_cpp_on`].
    pub fn code_cpp_target(&self) -> Result<CppTarget, AppError> {
        Ok(match self.cpp_backend()? {
            (CppBackendEffective::Remote, Some(runner)) => CppTarget::Remote(runner),
            (CppBackendEffective::Local, _) => CppTarget::Local,
            _ => CppTarget::None,
        })
    }

    /// Compiles and runs C++ (spec 11.5) on the effective backend ([`Self::code_cpp_target`] and
    /// [`run_cpp_on`] in one go; the command splits them to keep the keychain off the runtime).
    pub async fn code_run_cpp(
        &self,
        files: BTreeMap<String, String>,
        stdin: String,
    ) -> Result<CppRunResult, AppError> {
        let target = self.code_cpp_target()?;
        run_cpp_on(target, files, stdin).await
    }

    /// The configured runner, if any (blocks: keychain). For [`code_runner_test`].
    pub fn code_runner(&self) -> Result<Option<RemoteRunner>, AppError> {
        self.remote_runner()
    }

    /// `GET /health` and a tiny authenticated run on the configured runner.
    pub async fn code_runner_test(&self) -> Result<RunnerTestResult, AppError> {
        let runner = self.code_runner()?;
        code_runner_test(runner).await
    }

    // --- Markdown import -----------------------------------------------------------------------

    /// The preview of a Markdown batch (spec 11.7), with the errors of each item.
    pub async fn code_import_markdown(&self, text: String) -> Result<ImportPreview, AppError> {
        let mut preview = markdown::parse(&text);
        let notetypes = self.on_col(notes::notetypes).await?;
        check_import_items(&mut preview, &notetypes);
        Ok(preview)
    }

    /// Adds the `include`d items without errors to `deck_id` as "Código · Comando"/"Código ·
    /// Programa" notes.
    pub async fn code_import_commit(
        &self,
        text: String,
        deck_id: i64,
        include: Vec<u32>,
    ) -> Result<CodeImportResult, AppError> {
        let mut preview = markdown::parse(&text);
        if let Some(first) = preview.errors.first() {
            return Err(invalid(first.clone()));
        }
        let notetypes = self.on_col(notes::notetypes).await?;
        let mut included: Vec<usize> = Vec::new();
        let mut skipped = 0u32;
        for index in dedup(include) {
            match usize::try_from(index) {
                Ok(i) if i < preview.items.len() => included.push(i),
                _ => skipped += 1,
            }
        }
        let missing = included
            .iter()
            .filter_map(|&i| preview.items[i].kind)
            .any(|k| !notetypes.iter().any(|nt| nt.name == import_notetype(k)));
        if missing {
            return Err(AppError::new(
                "code_notetypes_missing",
                "Os tipos de nota de código não existem nesta coleção: use Anki → Preparar coleção primeiro.",
            ));
        }
        check_import_items(&mut preview, &notetypes);
        let mut new_notes = Vec::new();
        for i in included {
            let item: &ImportItem = &preview.items[i];
            let (Some(kind), true) = (item.kind, item.errors.is_empty()) else {
                skipped += 1;
                continue;
            };
            let name = import_notetype(kind);
            let Some(nt) = notetypes.iter().find(|nt| nt.name == name) else {
                skipped += 1;
                continue;
            };
            let fields = nt
                .fields
                .iter()
                .map(|f| {
                    item.fields
                        .get(&f.name)
                        .map(|text| import_field_html(&f.name, text))
                        .unwrap_or_default()
                })
                .collect();
            new_notes.push(NewNote {
                notetype_id: nt.id,
                deck_id,
                fields,
                tags: item.tags.clone(),
            });
        }
        let note_ids = self
            .on_col(move |col| {
                new_notes
                    .into_iter()
                    .map(|n| notes::add(col, n).map(|a| a.note_id))
                    .collect::<core_anki::Result<Vec<i64>>>()
            })
            .await?;
        if !note_ids.is_empty() {
            self.emit(UiEvent::AnkiChanged(ChangeReason::Import));
        }
        Ok(CodeImportResult {
            added: u32::try_from(note_ids.len()).unwrap_or(u32::MAX),
            note_ids,
            skipped,
        })
    }
}

/// Where a C++ run goes.
#[derive(Debug)]
pub enum CppTarget {
    Local,
    Remote(RemoteRunner),
    None,
}

/// Runs on `target` (local on the blocking pool, remote over HTTP).
pub async fn run_cpp_on(
    target: CppTarget,
    files: BTreeMap<String, String>,
    stdin: String,
) -> Result<CppRunResult, AppError> {
    let req = CppRequest {
        files,
        stdin,
        timeout_ms: None,
    };
    match target {
        CppTarget::Remote(runner) => runner.run(&req).await.map_err(run_error),
        CppTarget::Local => run_local(req).await,
        CppTarget::None => Err(cpp_unavailable()),
    }
}

/// `GET /health` and a tiny authenticated run on `runner`.
pub async fn code_runner_test(runner: Option<RemoteRunner>) -> Result<RunnerTestResult, AppError> {
    let fail = |message: String| Ok(RunnerTestResult { ok: false, message });
    let Some(runner) = runner else {
        return fail("Informe o endereço e o token do runner.".to_owned());
    };
    if let Err(e) = runner.health().await {
        return fail(run_error(e).message);
    }
    let req = CppRequest {
        files: BTreeMap::from([(
            "main.cpp".to_owned(),
            "#include <iostream>\nint main() { std::cout << \"ok\"; }\n".to_owned(),
        )]),
        stdin: String::new(),
        timeout_ms: Some(5_000),
    };
    match runner.run(&req).await {
        Ok(r) if r.compile.ok && r.run.as_ref().is_some_and(|x| x.stdout == "ok") => {
            Ok(RunnerTestResult {
                ok: true,
                message: "O runner respondeu e executou um programa de teste.".to_owned(),
            })
        }
        Ok(_) => fail("O runner respondeu, mas o programa de teste falhou.".to_owned()),
        Err(e) => fail(run_error(e).message),
    }
}

fn dedup(mut v: Vec<u32>) -> Vec<u32> {
    let mut seen = std::collections::HashSet::new();
    v.retain(|i| seen.insert(*i));
    v
}

// --- Local C++ (desktop only) ---------------------------------------------------------------------

/// The local compiler C++ may use: none when the app runs as root ([`local_refusal`]), so `auto`
/// goes to the runner and `local` to "none".
#[cfg(desktop)]
fn local_compiler() -> Option<&'static core_cpp::CompilerInfo> {
    if local_refusal().is_some() {
        return None;
    }
    core_cpp::detect_local().compiler.as_ref()
}

/// Why local C++ runs are refused (the app runs as root), if they are.
#[cfg(desktop)]
fn local_refusal() -> Option<RunError> {
    core_cpp::local_run_refusal()
}

#[cfg(not(desktop))]
fn local_refusal() -> Option<RunError> {
    None
}

#[cfg(not(desktop))]
fn local_compiler() -> Option<&'static core_cpp::CompilerInfo> {
    None
}

#[cfg(desktop)]
fn local_status() -> Option<LocalCppStatus> {
    let tc = core_cpp::detect_local();
    Some(LocalCppStatus {
        compiler: tc.compiler.as_ref().map(|c| {
            if c.version.is_empty() {
                c.name.clone()
            } else {
                c.version.clone()
            }
        }),
        clang_format: tc.clang_format.is_some(),
    })
}

#[cfg(not(desktop))]
fn local_status() -> Option<LocalCppStatus> {
    None
}

#[cfg(desktop)]
async fn run_local(req: CppRequest) -> Result<CppRunResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || core_cpp::run_local(&req))
        .await?
        .map_err(run_error)
}

#[cfg(not(desktop))]
async fn run_local(_req: CppRequest) -> Result<CppRunResult, AppError> {
    Err(cpp_unavailable())
}

/// `clang-format` on desktop; elsewhere the code comes back unchanged.
#[cfg(desktop)]
pub async fn format_cpp(code: String) -> Result<CodeFormatted, AppError> {
    let (formatted, formatter) =
        tauri::async_runtime::spawn_blocking(move || core_cpp::format_cpp(&code)).await?;
    Ok(CodeFormatted {
        formatted,
        formatter,
    })
}

#[cfg(not(desktop))]
pub async fn format_cpp(code: String) -> Result<CodeFormatted, AppError> {
    Ok(CodeFormatted {
        formatted: code,
        formatter: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runner_urls() {
        assert_eq!(
            normalize_runner_url(" https://Runner.Example.com ").unwrap(),
            "https://runner.example.com/"
        );
        assert_eq!(
            normalize_runner_url("https://x.dev/runner").unwrap(),
            "https://x.dev/runner/"
        );
        assert_eq!(
            normalize_runner_url("http://runner-proxy:8080").unwrap(),
            "http://runner-proxy:8080/"
        );
        assert_eq!(
            normalize_runner_url("http://localhost:9000/").unwrap(),
            "http://localhost:9000/"
        );
        assert_eq!(
            normalize_runner_url("http://127.0.0.1:9000").unwrap(),
            "http://127.0.0.1:9000/"
        );
        assert_eq!(
            normalize_runner_url("http://[::1]:9000").unwrap(),
            "http://[::1]:9000/"
        );
        for insecure in ["http://runner.example.com/", "http://10.0.0.5:8080/"] {
            assert_eq!(
                normalize_runner_url(insecure).unwrap_err().code,
                "code_runner_insecure_url",
                "{insecure}"
            );
        }
        for bad in [
            "",
            "runner.example.com",
            "ftp://x.com/",
            "https://",
            "https://u:p@x.com/",
            "https://x.com/?a=1",
            "https://x.com:port/",
            "https:// x.com/",
        ] {
            assert_eq!(
                normalize_runner_url(bad).unwrap_err().code,
                "invalid_input",
                "{bad}"
            );
        }
    }

    #[test]
    fn run_errors_map_to_codes() {
        assert_eq!(
            run_error(RunError::Unavailable).code,
            "code_cpp_unavailable"
        );
        let root = run_error(RunError::RunningAsRoot);
        assert_eq!(root.code, "code_cpp_unavailable");
        assert!(root.message.contains("root"), "{}", root.message);
        assert_eq!(run_error(RunError::TooLarge).code, "code_too_large");
        assert_eq!(
            run_error(RunError::InvalidRequest("x".into())).code,
            "code_invalid_input"
        );
        assert_eq!(run_error(RunError::RemoteAuth).code, "code_runner_auth");
        assert_eq!(run_error(RunError::RemoteBusy).code, "code_runner_busy");
        assert_eq!(
            run_error(RunError::RemoteUnreachable("x".into())).code,
            "code_runner_unreachable"
        );
        assert_eq!(
            run_error(RunError::RemoteProtocol("x".into())).code,
            "code_runner_protocol"
        );
    }

    #[test]
    fn settings_patch_tells_missing_from_null() {
        let p: CodeSettingsPatch = serde_json::from_str(r#"{"runnerUrl":null}"#).unwrap();
        assert_eq!(p.runner_url, Some(None));
        assert_eq!(p.runner_token, None);
        let p: CodeSettingsPatch =
            serde_json::from_str(r#"{"runnerToken":"t","cppBackend":"remote"}"#).unwrap();
        assert_eq!(p.runner_token, Some(Some("t".into())));
        assert_eq!(p.cpp_backend, Some(CppBackendChoice::Remote));
    }

    #[test]
    fn squash_and_lines() {
        assert_eq!(squash("  ros2   run\ta  b "), "ros2 run a b");
        assert_eq!(field_lines("a<br><br> b <div>c</div>"), ["a", "b", "c"]);
    }
}
