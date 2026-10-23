//! The two `FrontendService` messages the card page uses (`proto/anki/frontend.proto:71-79`). `anki_proto` does not
//! generate the `frontend` package (it is implemented by the Qt host), so they are declared here with the same tags,
//! wire-compatible with `reviewer.js`.
use anki_proto::scheduler::{SchedulingContext, SchedulingStates};

/// `anki.frontend.SchedulingStatesWithContext`.
#[derive(Clone, PartialEq, prost::Message)]
pub struct SchedulingStatesWithContext {
    #[prost(message, optional, tag = "1")]
    pub states: Option<SchedulingStates>,
    #[prost(message, optional, tag = "2")]
    pub context: Option<SchedulingContext>,
}

/// `anki.frontend.SetSchedulingStatesRequest`.
#[derive(Clone, PartialEq, prost::Message)]
pub struct SetSchedulingStatesRequest {
    #[prost(string, tag = "1")]
    pub key: String,
    #[prost(message, optional, tag = "2")]
    pub states: Option<SchedulingStates>,
}
