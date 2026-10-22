use thiserror::Error;

pub type Result<T, E = StoreError> = std::result::Result<T, E>;

/// Store errors. `Display` is the pt-BR message shown to the user; [`StoreError::code`] is the
/// stable machine code for the `{ code, message }` error contract.
#[derive(Debug, Error)]
pub enum StoreError {
    #[error("Erro no banco de dados do app: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("Não foi possível acessar a pasta do banco de dados do app: {0}")]
    Io(#[source] std::io::Error),

    #[error(
        "O banco de dados do app foi criado por uma versão mais nova (esquema {found}; esta versão entende até {supported}). Atualize o app."
    )]
    SchemaTooNew { found: u32, supported: u32 },

    #[error("Identificador de livro inválido: {0:?}.")]
    InvalidBookUid(String),

    #[error("Livro não encontrado na biblioteca.")]
    BookNotFound(String),

    #[error("Configuração desconhecida: {0:?}.")]
    UnknownSetting(String),

    #[error("Valor inválido para a configuração {key:?}: {reason}")]
    InvalidSetting { key: String, reason: String },

    #[error("Dado inválido: {0}")]
    InvalidInput(String),

    #[error("Dado corrompido no banco de dados do app: {0}")]
    Corrupt(String),
}

impl StoreError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Sqlite(_) => "store_sqlite",
            Self::Io(_) => "store_io",
            Self::SchemaTooNew { .. } => "store_schema_too_new",
            Self::InvalidBookUid(_) => "invalid_book_uid",
            Self::BookNotFound(_) => "book_not_found",
            Self::UnknownSetting(_) => "unknown_setting",
            Self::InvalidSetting { .. } => "invalid_setting",
            Self::InvalidInput(_) => "invalid_input",
            Self::Corrupt(_) => "store_corrupt",
        }
    }
}
