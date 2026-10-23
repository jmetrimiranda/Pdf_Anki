use serde::ser::{Serialize, SerializeStruct, Serializer};

/// Every failure of the PDF core. `Display` is the pt-BR message shown to the user; the English
/// detail some variants carry is for logs (`Debug`).
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum PdfError {
    #[error("Este PDF é protegido por senha.")]
    NeedsPassword,
    #[error("Senha incorreta.")]
    WrongPassword,
    #[error("Não foi possível ler o PDF: o arquivo está corrompido ou não é um PDF.")]
    Invalid(String),
    #[error("Este PDF usa um recurso que ainda não é suportado.")]
    Unsupported(String),
    #[error("O documento não está aberto.")]
    UnknownDocument,
    /// The message is already pt-BR.
    #[error("Pedido inválido: {0}")]
    InvalidRequest(String),
    #[error("A página demorou demais para ser processada.")]
    Timeout,
    #[error("Não foi possível ler o texto da página.")]
    Text(String),
    #[error("Não foi possível desenhar a página.")]
    Render(String),
    #[error("Erro interno no leitor de PDF.")]
    Internal(String),
}

impl PdfError {
    /// Stable machine-readable code (the `code` of the command error contract).
    pub fn code(&self) -> &'static str {
        match self {
            Self::NeedsPassword => "pdf_needs_password",
            Self::WrongPassword => "pdf_wrong_password",
            Self::Invalid(_) => "pdf_invalid",
            Self::Unsupported(_) => "pdf_unsupported",
            Self::UnknownDocument => "unknown_document",
            Self::InvalidRequest(_) => "invalid_request",
            Self::Timeout => "timeout",
            Self::Text(_) => "pdf_text",
            Self::Render(_) => "pdf_render",
            Self::Internal(_) => "internal",
        }
    }

    /// HTTP status for the `pdf://` protocol (covers).
    pub fn http_status(&self) -> u16 {
        match self {
            Self::UnknownDocument => 404,
            Self::InvalidRequest(_) => 400,
            Self::NeedsPassword | Self::WrongPassword => 403,
            Self::Invalid(_) | Self::Unsupported(_) => 422,
            Self::Timeout => 504,
            Self::Text(_) | Self::Render(_) | Self::Internal(_) => 500,
        }
    }

    pub(crate) fn from_open(e: pdfcraft_render::OpenError) -> Self {
        use pdfcraft_render::OpenError as E;
        match e {
            E::Invalid(d) => Self::Invalid(d),
            E::NeedsPassword => Self::NeedsPassword,
            E::WrongPassword => Self::WrongPassword,
            E::Unsupported(d) => Self::Unsupported(d),
        }
    }

    pub(crate) fn from_cos(e: pdfcraft_cos::CosError) -> Self {
        use pdfcraft_cos::CosError as E;
        match e {
            E::NeedsPassword => Self::NeedsPassword,
            E::WrongPassword => Self::WrongPassword,
            E::Security(d) => Self::Unsupported(d),
            other => Self::Invalid(other.to_string()),
        }
    }

    pub(crate) fn page_out_of_range(page: usize, count: usize) -> Self {
        Self::InvalidRequest(format!(
            "a página {} não existe (o documento tem {count}).",
            page.saturating_add(1)
        ))
    }
}

/// Serialises as `{ code, message }`, the error shape of the Tauri commands.
impl Serialize for PdfError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut st = s.serialize_struct("PdfError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

/// Runs `f`, turning a panic into `PdfError::Internal`. PdfCraft guards its own entry points;
/// this is the last line of defence for untrusted input.
pub(crate) fn guard<T>(f: impl FnOnce() -> Result<T, PdfError>) -> Result<T, PdfError> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or_else(|p| {
        let msg = p
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| p.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".into());
        tracing::error!(panic = %msg, "PdfCraft panicked");
        Err(PdfError::Internal(msg))
    })
}
