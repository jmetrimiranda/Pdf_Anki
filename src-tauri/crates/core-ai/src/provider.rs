//! The one provider interface (plan 2.1). Adapters turn a [`CompletionRequest`] into their API's request and back.

use std::future::Future;
use std::pin::Pin;

use crate::error::Result;
use crate::prices::ModelPrice;
use crate::types::{ApiKey, Completion, CompletionRequest, ProviderKind};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T>> + Send + 'a>>;

pub trait Provider: Send + Sync {
    fn kind(&self) -> ProviderKind;

    /// One structured-output call. `price` carries the model's effort/thinking capabilities (plan 2.7).
    fn complete<'a>(
        &'a self,
        key: &'a ApiKey,
        req: &'a CompletionRequest,
        price: &'a ModelPrice,
    ) -> BoxFuture<'a, Completion>;

    /// "Testar chave": a call that consumes no tokens (plan 4). Only ever run on the user's click.
    fn test_key<'a>(&'a self, key: &'a ApiKey, model: &'a str) -> BoxFuture<'a, ()>;
}
