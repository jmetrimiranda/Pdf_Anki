//! Errors. The `Display` texts are pt-BR: the app shows them as they are.

/// Errors of the vocabulary engine.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VocabError {
    /// The data pack (`vocab-en.sqlite`) is missing.
    #[error(
        "Os dados de vocabulário não estão instalados. Reinstale o app ou rode scripts/build-wordnet.sh."
    )]
    Unavailable,
    /// The data pack exists but cannot be read (corrupt file or another schema version).
    #[error("Os dados de vocabulário estão danificados ou numa versão incompatível ({0}).")]
    BadData(String),
    /// The scan was cancelled through the cancel flag.
    #[error("Escaneamento cancelado.")]
    Cancelled,
    /// The chosen range of the book is invalid.
    #[error(transparent)]
    Range(#[from] RangeError),
}

/// Errors of the "Trecho" step (spec 12.1 step 2): shown under the field, they block "Continuar".
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RangeError {
    #[error("Digite uma página, um intervalo ou uma lista, como 37, 21-45 ou 21-45, 60, 72-80.")]
    Empty,
    #[error("“{0}” não é uma página válida. Use números, como 37, 21-45 ou 21-45, 60, 72-80.")]
    NotANumber(String),
    #[error("As páginas começam em 1.")]
    Zero,
    #[error("O intervalo {from}-{to} está invertido. Use {to}-{from}.")]
    Reversed { from: u32, to: u32 },
    #[error("O intervalo “{0}” está incompleto. Informe o início e o fim, como 21-45.")]
    OpenEnded(String),
    #[error("A página {page} não existe (o livro tem {count} {}).", if *count == 1 { "página" } else { "páginas" })]
    BeyondEnd { page: u32, count: u32 },
    #[error("Use no máximo {0} páginas ou intervalos.")]
    TooMany(usize),
    #[error("O livro não tem páginas.")]
    EmptyBook,
    #[error("Marque pelo menos um item do sumário.")]
    NoItems,
    #[error("Um item marcado não existe mais no sumário. Volte e marque de novo.")]
    UnknownItem(String),
    #[error("“{0}” não aponta para uma página do livro.")]
    ItemWithoutPage(String),
}
