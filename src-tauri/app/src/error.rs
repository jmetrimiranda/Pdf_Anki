use serde::Serialize;

/// The error every command returns: `{ code, message }`, with a pt-BR `message`.
///
/// Codes are snake_case across the app boundary, whatever convention the core crate uses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn internal(detail: impl std::fmt::Display) -> Self {
        tracing::error!(%detail, "internal error");
        Self::new("internal", "Erro interno do app.")
    }

    pub fn read_file(path: &str, err: &std::io::Error) -> Self {
        tracing::warn!(path, %err, "could not read file");
        let message = match err.kind() {
            std::io::ErrorKind::NotFound => format!("Arquivo não encontrado: {path}"),
            std::io::ErrorKind::PermissionDenied => format!("Sem permissão para ler: {path}"),
            _ => format!("Não foi possível ler o arquivo: {path}"),
        };
        Self::new("file_read", message)
    }
}

impl From<core_pdf::PdfError> for AppError {
    fn from(e: core_pdf::PdfError) -> Self {
        use core_pdf::PdfError as E;
        let code = match &e {
            // Names the web client already relies on.
            E::UnknownDocument => "doc_not_open".to_owned(),
            E::Invalid(_) => "pdf_invalid".to_owned(),
            other => snake_case(other.code()),
        };
        log_detail("pdf", &e);
        Self::new(code, e.to_string())
    }
}

impl From<core_anki::Error> for AppError {
    fn from(e: core_anki::Error) -> Self {
        log_detail("anki", &e);
        Self::new(snake_case(e.code()), e.to_string())
    }
}

impl From<core_store::StoreError> for AppError {
    fn from(e: core_store::StoreError) -> Self {
        log_detail("store", &e);
        Self::new(snake_case(e.code()), e.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(e: tauri::Error) -> Self {
        Self::internal(e)
    }
}

fn log_detail(source: &str, e: &dyn std::fmt::Debug) {
    tracing::debug!(source, detail = ?e, "command error");
}

/// `anki.notFound` / `pageOutOfRange` → `anki_not_found` / `page_out_of_range`.
fn snake_case(code: &str) -> String {
    let mut out = String::with_capacity(code.len() + 4);
    for c in code.chars() {
        if c == '.' || c == '-' {
            out.push('_');
        } else if c.is_ascii_uppercase() {
            if !out.is_empty() && !out.ends_with('_') {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_snake_case() {
        assert_eq!(snake_case("anki.notFound"), "anki_not_found");
        assert_eq!(snake_case("pageOutOfRange"), "page_out_of_range");
        assert_eq!(snake_case("store_sqlite"), "store_sqlite");
        let e = AppError::from(core_pdf::PdfError::UnknownDocument);
        assert_eq!(e.code, "doc_not_open");
        let e = AppError::from(core_pdf::PdfError::PageOutOfRange { page: 3, count: 2 });
        assert_eq!(e.code, "page_out_of_range");
        assert!(e.message.contains('4'));
        let json = serde_json::to_value(&e).unwrap();
        assert_eq!(json["code"], "page_out_of_range");
    }
}
