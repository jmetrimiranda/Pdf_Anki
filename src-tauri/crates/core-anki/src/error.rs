use std::path::PathBuf;

use anki::prelude::{AnkiError, I18n};
use serde::ser::SerializeStruct;

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Errors of the Anki service. `Display` is the pt-BR message shown to the user.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Não foi possível criar a pasta da coleção ({}): {source}", path.display())]
    CreateDir {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("Não foi possível abrir a coleção do Anki ({}): {message}", path.display())]
    Open {
        path: PathBuf,
        message: String,
        #[source]
        source: Box<AnkiError>,
    },
    #[error("Não foi possível iniciar o serviço do Anki: {0}")]
    Spawn(#[source] std::io::Error),
    /// An error from rslib; `message` is localized with the collection's translations.
    #[error("{message}")]
    Anki {
        message: String,
        #[source]
        source: Box<AnkiError>,
    },
    #[error("Não encontrado: {0}")]
    NotFound(String),
    #[error("Entrada inválida: {0}")]
    InvalidInput(String),
    #[error("O serviço do Anki foi encerrado.")]
    Closed,
    #[error("Erro interno no Anki: a operação foi interrompida.")]
    Panicked,
    #[error("Erro interno: chamada bloqueante ao serviço do Anki feita de dentro dele.")]
    Reentrant,
    #[error("Não há resposta para desfazer.")]
    UndoUnavailable,
    #[error("Este card não é mais o card atual do estudo.")]
    NotCurrentCard,
    #[error("Nenhuma sessão de estudo aberta.")]
    NoStudySession,
    #[error("Nota inválida: {0}")]
    NoteInvalid(String),
    #[error("Pacote inválido: {0}")]
    InvalidPackage(String),
    #[error("O arquivo é grande demais.")]
    TooLarge,
    #[error("Erro de arquivo ({}): {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl Error {
    /// Stable machine-readable code for the UI (`{ code, message }`).
    pub fn code(&self) -> &'static str {
        match self {
            Error::CreateDir { .. } => "anki.createDir",
            Error::Open { .. } => "anki.open",
            Error::Spawn(_) => "anki.spawn",
            Error::Anki { .. } => "anki.backend",
            Error::NotFound(_) => "anki.notFound",
            Error::InvalidInput(_) => "anki.invalidInput",
            Error::Closed => "anki.closed",
            Error::Panicked => "anki.panicked",
            Error::Reentrant => "anki.reentrant",
            Error::UndoUnavailable => "anki.undoUnavailable",
            Error::NotCurrentCard => "anki.notCurrentCard",
            Error::NoStudySession => "anki.noStudySession",
            Error::NoteInvalid(_) => "anki.noteInvalid",
            Error::InvalidPackage(_) => "anki.invalidPackage",
            Error::TooLarge => "anki.tooLarge",
            Error::Io { .. } => "anki.io",
        }
    }

    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Error::Io {
            path: path.into(),
            source,
        }
    }

    pub(crate) fn from_anki(source: AnkiError, tr: &I18n) -> Self {
        Error::Anki {
            message: source.message(tr),
            source: Box::new(source),
        }
    }

    /// Re-renders rslib messages with the collection's (pt-BR) translations.
    pub(crate) fn localized(self, tr: &I18n) -> Self {
        match self {
            Error::Anki { source, .. } => Error::from_anki(*source, tr),
            other => other,
        }
    }
}

impl From<AnkiError> for Error {
    /// Uses English templates; the actor re-localizes before the error leaves it.
    fn from(source: AnkiError) -> Self {
        Error::from_anki(source, &I18n::template_only())
    }
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("Error", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}
