//! Typed AI errors with stable codes and pt-BR messages (plan 6.2). Provider error bodies never reach these
//! messages: they become codes, so a key echoed back by a provider can't leak into the UI or a log.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum AiError {
    #[error("IA desligada: escolha um provedor em Configurações → IA.")]
    Disabled,
    #[error("Falta a chave do provedor {0}. Adicione-a em Configurações → IA.")]
    NoKey(&'static str),
    #[error("Sem conexão com o provedor de IA. As funções de IA voltam quando a rede voltar.")]
    Offline,
    #[error("O provedor de IA demorou demais para responder (mais de 60 s).")]
    Timeout,
    #[error("A chave do provedor {0} foi recusada. Confira-a em Configurações → IA.")]
    Auth(&'static str),
    #[error("O provedor de IA pediu para esperar{}.", .retry_after_secs.map(|s| format!(" {s} s")).unwrap_or_default())]
    RateLimited { retry_after_secs: Option<u64> },
    #[error("O limite de gasto configurado no painel do provedor {0} foi atingido.")]
    ProviderSpendLimit(&'static str),
    #[error("O provedor de IA está com problemas (erro {0}). Tente de novo mais tarde.")]
    Server(u16),
    #[error("O provedor recusou o pedido (erro {0}).")]
    BadRequest(u16),
    #[error("O modelo recusou responder a este pedido.")]
    Refused,
    #[error("A resposta da IA veio fora do formato esperado.")]
    InvalidOutput,
    #[error("A resposta passou do limite de tokens; aumente o limite ou baixe o esforço.")]
    Truncated,
    #[error("{0}")]
    LimitReached(String),
    #[error("Esta chamada pode custar até US$ {0:.4}. Confirme para enviar.")]
    NeedsConfirmation(f64),
    #[error("O modelo \"{0}\" não foi encontrado no provedor.")]
    ModelNotFound(String),
    #[error(
        "O modelo \"{0}\" não tem preço na tabela. Informe o preço em Configurações → IA antes de usá-lo."
    )]
    ModelUnpriced(String),
    #[error("Falha inesperada na IA: {0}")]
    Internal(String),
}

impl AiError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Disabled => "ai_disabled",
            Self::NoKey(_) => "ai_no_key",
            Self::Offline => "ai_offline",
            Self::Timeout => "ai_timeout",
            Self::Auth(_) => "ai_auth",
            Self::RateLimited { .. } => "ai_rate_limited",
            Self::ProviderSpendLimit(_) => "ai_provider_spend_limit",
            Self::Server(_) => "ai_server",
            Self::BadRequest(_) => "ai_bad_request",
            Self::Refused => "ai_refused",
            Self::InvalidOutput => "ai_invalid_output",
            Self::Truncated => "ai_truncated",
            Self::LimitReached(_) => "ai_limit_reached",
            Self::NeedsConfirmation(_) => "ai_needs_confirmation",
            Self::ModelNotFound(_) => "ai_model_not_found",
            Self::ModelUnpriced(_) => "ai_model_unpriced",
            Self::Internal(_) => "ai_internal",
        }
    }
}

impl Serialize for AiError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AiError", 2)?;
        st.serialize_field("code", self.code())?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}

pub type Result<T, E = AiError> = std::result::Result<T, E>;
