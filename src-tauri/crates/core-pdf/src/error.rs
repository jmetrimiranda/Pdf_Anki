use serde::ser::{Serialize, SerializeStruct, Serializer};

/// Every failure of the PDF facade. `Display` is the pt-BR message shown to the user; the
/// English detail some variants carry is for logs (`Debug`).
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
    #[error("A página {} não existe (o documento tem {count}).", .page + 1)]
    PageOutOfRange { page: usize, count: usize },
    /// The message is already pt-BR.
    #[error("Pedido inválido: {0}")]
    InvalidRequest(String),
    #[error("Não foi possível desenhar a página.")]
    Render(String),
    #[error("Não foi possível ler o texto da página.")]
    Text(String),
    #[error("Não foi possível gerar a imagem da página.")]
    Encode(String),
    #[error("A página demorou demais para ser desenhada.")]
    Timeout,
    /// A newer search on the same document replaced this one.
    #[error("A busca foi interrompida por uma nova busca.")]
    Cancelled,
    #[error("Recurso ainda não disponível.")]
    NotYetImplemented(&'static str),
    #[error("Erro interno no leitor de PDF.")]
    Internal(String),
}

impl PdfError {
    /// Stable machine-readable code (the `code` of the command error contract).
    pub fn code(&self) -> &'static str {
        match self {
            Self::NeedsPassword => "needsPassword",
            Self::WrongPassword => "wrongPassword",
            Self::Invalid(_) => "invalidPdf",
            Self::Unsupported(_) => "unsupported",
            Self::UnknownDocument => "unknownDocument",
            Self::PageOutOfRange { .. } => "pageOutOfRange",
            Self::InvalidRequest(_) => "invalidRequest",
            Self::Render(_) => "renderFailed",
            Self::Text(_) => "textFailed",
            Self::Encode(_) => "encodeFailed",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::NotYetImplemented(_) => "notImplemented",
            Self::Internal(_) => "internal",
        }
    }

    /// HTTP status for the `pdf://` protocol.
    pub fn http_status(&self) -> u16 {
        match self {
            Self::UnknownDocument | Self::PageOutOfRange { .. } => 404,
            Self::InvalidRequest(_) => 400,
            Self::NeedsPassword | Self::WrongPassword => 403,
            Self::Invalid(_) | Self::Unsupported(_) => 422,
            Self::NotYetImplemented(_) => 501,
            Self::Timeout => 504,
            Self::Cancelled => 409,
            Self::Render(_) | Self::Text(_) | Self::Encode(_) | Self::Internal(_) => 500,
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
