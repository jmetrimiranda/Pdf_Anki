/// Every failure of the EPUB core. `Display` is the pt-BR message shown to the user; the English
/// detail some variants carry is for logs (`Debug`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EpubError {
    #[error("Este arquivo não é um EPUB válido ou está danificado.")]
    NotEpub,
    /// The detail is English, for logs only.
    #[error("Este arquivo não é um EPUB válido ou está danificado.")]
    Damaged(String),
    #[error("Este EPUB está protegido por DRM e não pode ser aberto.")]
    Drm,
    #[error("O EPUB é grande demais para abrir.")]
    TooLarge,
    #[error("Este EPUB não tem capítulos para ler.")]
    NoContent,
    #[error("A leitura do texto do livro foi cancelada.")]
    Cancelled,
    #[error("Erro interno no leitor de EPUB.")]
    Internal(String),
}

impl EpubError {
    /// Stable machine-readable code (the `code` of the command error contract).
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotEpub | Self::Damaged(_) => "epub_invalid",
            Self::Drm => "epub_drm",
            Self::TooLarge => "epub_too_big",
            Self::NoContent => "epub_empty",
            Self::Cancelled => "cancelled",
            Self::Internal(_) => "epub_internal",
        }
    }

    pub(crate) fn damaged(detail: impl Into<String>) -> Self {
        Self::Damaged(detail.into())
    }
}

/// Runs `f`, turning a panic (in a dependency or here) into `EpubError::Internal`: the last line of
/// defence for untrusted input (spec 18).
pub(crate) fn guard<T>(f: impl FnOnce() -> Result<T, EpubError>) -> Result<T, EpubError> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or_else(|p| {
        let msg = p
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| p.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".into());
        tracing::error!(panic = %msg, "EPUB core panicked");
        Err(EpubError::Internal(msg))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_and_messages() {
        assert_eq!(EpubError::NotEpub.code(), "epub_invalid");
        assert_eq!(EpubError::Damaged("x".into()).code(), "epub_invalid");
        assert_eq!(EpubError::Drm.code(), "epub_drm");
        assert_eq!(EpubError::TooLarge.code(), "epub_too_big");
        assert_eq!(EpubError::NoContent.code(), "epub_empty");
        assert_eq!(EpubError::Cancelled.code(), "cancelled");
        assert_eq!(EpubError::Internal("x".into()).code(), "epub_internal");
        assert_eq!(
            EpubError::Damaged("opf missing".into()).to_string(),
            "Este arquivo não é um EPUB válido ou está danificado."
        );
        assert_eq!(
            EpubError::Drm.to_string(),
            "Este EPUB está protegido por DRM e não pode ser aberto."
        );
    }

    #[test]
    fn guard_turns_panics_into_internal() {
        let r: Result<(), EpubError> = guard(|| panic!("boom"));
        assert_eq!(r, Err(EpubError::Internal("boom".into())));
    }
}
