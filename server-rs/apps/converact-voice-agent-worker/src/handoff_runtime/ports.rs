use std::{error::Error, fmt, future::Future};

use converact_agent_handoff_core::HandoffSession;
use converact_agent_handoff_store::{HandoffStoreCommand, HandoffTransitionWrite};

use crate::{AiResumeRequest, EffectObservation, GenerationCommit, HumanDialRequest};

use super::HumanLegObservation;

/// Initial aggregate persistence result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DurableCreateDecision {
    Created,
    Replayed,
}

/// Store permission for exactly one transition command.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DurablePrepareDecision {
    Execute,
    Query,
    ReplayApplied,
    ReplayNotApplied,
    Conflict,
    StaleFence,
}

/// Bounded Adapter failure without endpoint, credential or customer data.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct VoiceHandoffPortError {
    code: &'static str,
}

impl VoiceHandoffPortError {
    #[must_use]
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for VoiceHandoffPortError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for VoiceHandoffPortError {}

/// Durable Handoff effect oracle. Implementations own tenant transactions and deadlines.
pub trait HandoffDurabilityPort: Sync {
    fn create_requested(
        &self,
        requested: &HandoffSession,
        command: &HandoffStoreCommand,
    ) -> impl Future<Output = Result<DurableCreateDecision, VoiceHandoffPortError>> + Send;

    fn prepare_transition(
        &self,
        write: &HandoffTransitionWrite<'_>,
    ) -> impl Future<Output = Result<DurablePrepareDecision, VoiceHandoffPortError>> + Send;

    fn finalize_applied(
        &self,
        write: &HandoffTransitionWrite<'_>,
    ) -> impl Future<Output = Result<(), VoiceHandoffPortError>> + Send;

    fn finalize_not_applied(
        &self,
        current: &HandoffSession,
        command: &HandoffStoreCommand,
        failure_code: &'static str,
    ) -> impl Future<Output = Result<(), VoiceHandoffPortError>> + Send;
}

/// Typed `RustPBX` human Leg boundary.
pub trait TelephonyHandoffPort: Sync {
    fn dial_human(
        &self,
        request: HumanDialRequest,
    ) -> impl Future<Output = Result<EffectObservation, VoiceHandoffPortError>> + Send;

    fn query_human_leg(
        &self,
        request: HumanDialRequest,
    ) -> impl Future<Output = Result<HumanLegObservation, VoiceHandoffPortError>> + Send;
}

/// Typed bounded Active Call boundary; it owns no Handoff state.
pub trait ChannelAgentHandoffPort: Sync {
    fn prepare_ai_resume(
        &self,
        request: AiResumeRequest,
    ) -> impl Future<Output = Result<EffectObservation, VoiceHandoffPortError>> + Send;

    fn query_ai_resume(
        &self,
        request: AiResumeRequest,
    ) -> impl Future<Output = Result<EffectObservation, VoiceHandoffPortError>> + Send;

    fn generation_committed(
        &self,
        commit: GenerationCommit,
    ) -> impl Future<Output = Result<(), VoiceHandoffPortError>> + Send;
}
