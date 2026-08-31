use std::{
    error::Error,
    fmt,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use converact_ai_outbound_core::{
    AgentLegBinding, CallObservation, OriginateCall, PortError, TelephonyPort, TerminateCall,
};
use converact_voice_agent_contracts::CallId;
use serde_json::Value;

use crate::{
    AddAgentLegRequest, ClientError, CommandOutcome, HangupRequest, InspectCallRequest,
    OriginateRequest, RustPbxRwiClient, RwiCommand, encode_command,
};

const MIN_POLL_INTERVAL: Duration = Duration::from_millis(1);
const MAX_POLL_INTERVAL: Duration = Duration::from_secs(5);
const MIN_ANSWER_WAIT: Duration = Duration::from_millis(10);
const MAX_ANSWER_WAIT: Duration = Duration::from_secs(300);

/// Invalid bounded runtime policy for the concrete `RustPBX` telephony port.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RustPbxTelephonyConfigError {
    InvalidAgentTarget,
    InvalidPollInterval,
    InvalidAnswerWait,
}

impl fmt::Display for RustPbxTelephonyConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidAgentTarget => "rustpbx_agent_target_invalid",
            Self::InvalidPollInterval => "rustpbx_poll_interval_invalid",
            Self::InvalidAnswerWait => "rustpbx_answer_wait_invalid",
        })
    }
}

impl Error for RustPbxTelephonyConfigError {}

/// Private Active Call SIP endpoint and bounded observation policy.
#[derive(Clone)]
pub struct RustPbxTelephonyConfig {
    agent_target: Box<str>,
    poll_interval: Duration,
    max_answer_wait: Duration,
}

impl RustPbxTelephonyConfig {
    /// Validates the fixed Agent target and all local resource bounds.
    ///
    /// # Errors
    ///
    /// Rejects non-SIP targets and unsafe wait values.
    pub fn new(
        agent_target: impl AsRef<str>,
        poll_interval: Duration,
        max_answer_wait: Duration,
    ) -> Result<Self, RustPbxTelephonyConfigError> {
        encode_command(RwiCommand::AddAgentLeg(AddAgentLegRequest {
            action_id: "config.agent-leg".to_owned(),
            call_id: "config-call".to_owned(),
            target: agent_target.as_ref().to_owned(),
            leg_id: "config-agent-leg".to_owned(),
            agent_session_id: "config-agent-session".to_owned(),
        }))
        .map_err(|_| RustPbxTelephonyConfigError::InvalidAgentTarget)?;
        if !(MIN_POLL_INTERVAL..=MAX_POLL_INTERVAL).contains(&poll_interval) {
            return Err(RustPbxTelephonyConfigError::InvalidPollInterval);
        }
        if !(MIN_ANSWER_WAIT..=MAX_ANSWER_WAIT).contains(&max_answer_wait) {
            return Err(RustPbxTelephonyConfigError::InvalidAnswerWait);
        }
        Ok(Self {
            agent_target: agent_target.as_ref().into(),
            poll_interval,
            max_answer_wait,
        })
    }
}

impl fmt::Debug for RustPbxTelephonyConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RustPbxTelephonyConfig")
            .field("agent_target", &"[REDACTED]")
            .field("poll_interval", &self.poll_interval)
            .field("max_answer_wait", &self.max_answer_wait)
            .finish()
    }
}

/// Concrete `RustPBX` call/leg authority adapter for one AI outbound worker.
pub struct RustPbxTelephony {
    client: Arc<RustPbxRwiClient>,
    config: RustPbxTelephonyConfig,
    query_sequence: AtomicU64,
}

impl RustPbxTelephony {
    #[must_use]
    pub fn new(client: Arc<RustPbxRwiClient>, config: RustPbxTelephonyConfig) -> Self {
        Self {
            client,
            config,
            query_sequence: AtomicU64::new(1),
        }
    }

    async fn originate_inner(&self, request: OriginateCall) -> Result<CallObservation, PortError> {
        let call_id = request.call_id.as_str();
        let action_id = format!("originate.{}", request.agent_session_id.as_str());
        let outcome = self
            .client
            .originate(OriginateRequest {
                action_id,
                call_id: call_id.to_owned(),
                destination: request.dial.destination().to_owned(),
                caller_id: request.dial.caller_id().map(str::to_owned),
                timeout_secs: request.dial.timeout_secs(),
                trunk: request.dial.trunk().map(str::to_owned),
            })
            .await
            .map_err(map_client_error)?;
        expect_originated(outcome, call_id)?;

        let requested_wait = Duration::from_secs(u64::from(request.dial.timeout_secs()));
        let deadline = Instant::now() + requested_wait.min(self.config.max_answer_wait);
        loop {
            match self.inspect_call(call_id).await? {
                Some(WireCallState::Talking) => {
                    return Ok(CallObservation::Answered(request.call_id));
                }
                Some(WireCallState::Ringing) | None if Instant::now() < deadline => {
                    tokio::time::sleep(self.config.poll_interval).await;
                }
                Some(WireCallState::Ringing) | None => {
                    return Err(PortError::outcome_unknown(
                        "rustpbx_answer_observation_timeout",
                    ));
                }
            }
        }
    }

    async fn add_agent_leg_inner(&self, request: AgentLegBinding) -> Result<(), PortError> {
        let session_id = request.session_id.as_str();
        let outcome = self
            .client
            .execute(RwiCommand::AddAgentLeg(AddAgentLegRequest {
                action_id: format!("agent-leg.{session_id}"),
                call_id: request.call_id.as_str().to_owned(),
                target: self.config.agent_target.to_string(),
                leg_id: format!("agent.{session_id}"),
                agent_session_id: session_id.to_owned(),
            }))
            .await
            .map_err(map_client_error)?;
        expect_success(outcome)
    }

    async fn query_inner(&self, call_id: &CallId) -> Result<CallObservation, PortError> {
        match self.inspect_call(call_id.as_str()).await? {
            Some(WireCallState::Ringing | WireCallState::Talking) => {
                Ok(CallObservation::Active(call_id.clone()))
            }
            None => Ok(CallObservation::NotFound(call_id.clone())),
        }
    }

    async fn terminate_inner(&self, request: TerminateCall) -> Result<(), PortError> {
        let outcome = self
            .client
            .execute(RwiCommand::Hangup(HangupRequest {
                action_id: format!("hangup.{}", request.attempt_id.as_str()),
                call_id: request.call_id.as_str().to_owned(),
                reason: "normal".to_owned(),
            }))
            .await
            .map_err(map_client_error)?;
        expect_success(outcome)
    }

    async fn inspect_call(&self, call_id: &str) -> Result<Option<WireCallState>, PortError> {
        let sequence = self
            .query_sequence
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| PortError::unavailable("rustpbx_query_sequence_exhausted"))?;
        let outcome = self
            .client
            .execute(RwiCommand::InspectCall(InspectCallRequest {
                action_id: format!("query.{sequence}"),
                call_id: call_id.to_owned(),
            }))
            .await
            .map_err(map_client_error)?;
        let data = expect_data(outcome)?;
        decode_call_state(&data, call_id)
    }
}

impl TelephonyPort for RustPbxTelephony {
    async fn originate(&self, request: OriginateCall) -> Result<CallObservation, PortError> {
        self.originate_inner(request).await
    }

    async fn add_agent_leg(&self, request: AgentLegBinding) -> Result<(), PortError> {
        self.add_agent_leg_inner(request).await
    }

    async fn query(&self, call_id: &CallId) -> Result<CallObservation, PortError> {
        self.query_inner(call_id).await
    }

    async fn terminate(&self, request: TerminateCall) -> Result<(), PortError> {
        self.terminate_inner(request).await
    }
}

impl fmt::Debug for RustPbxTelephony {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RustPbxTelephony([REDACTED])")
    }
}

#[derive(Clone, Copy)]
enum WireCallState {
    Ringing,
    Talking,
}

fn decode_call_state(data: &Value, call_id: &str) -> Result<Option<WireCallState>, PortError> {
    if data.is_null() {
        return Ok(None);
    }
    let session_id = data
        .get("session_id")
        .and_then(Value::as_str)
        .ok_or_else(|| PortError::unavailable("rustpbx_protocol_mismatch"))?;
    if session_id != call_id {
        return Err(PortError::outcome_unknown(
            "rustpbx_inspect_identity_mismatch",
        ));
    }
    match data.get("status").and_then(Value::as_str) {
        Some("ringing") => Ok(Some(WireCallState::Ringing)),
        Some("talking")
            if data
                .get("answered_at")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty()) =>
        {
            Ok(Some(WireCallState::Talking))
        }
        _ => Err(PortError::unavailable("rustpbx_protocol_mismatch")),
    }
}

fn expect_originated(outcome: CommandOutcome, expected_call_id: &str) -> Result<(), PortError> {
    let data = expect_data(outcome)?;
    if data.get("call_id").and_then(Value::as_str) == Some(expected_call_id) {
        Ok(())
    } else {
        Err(PortError::outcome_unknown(
            "rustpbx_originate_identity_mismatch",
        ))
    }
}

fn expect_success(outcome: CommandOutcome) -> Result<(), PortError> {
    expect_data(outcome).map(|_| ())
}

fn expect_data(outcome: CommandOutcome) -> Result<Value, PortError> {
    match outcome {
        CommandOutcome::Succeeded { data, .. } => Ok(data),
        CommandOutcome::Failed { .. } => Err(PortError::rejected("rustpbx_command_rejected")),
        CommandOutcome::Uncertain { error_code, .. } => Err(PortError::outcome_unknown(error_code)),
    }
}

const fn map_client_error(error: ClientError) -> PortError {
    match error {
        ClientError::CapacityUnavailable => {
            PortError::unavailable("rustpbx_client_capacity_unavailable")
        }
        ClientError::ConnectFailed
        | ClientError::ConnectTimeout
        | ClientError::SecretUnavailable => PortError::unavailable("rustpbx_client_unavailable"),
        ClientError::ConfigInvalid
        | ClientError::PlaintextRejected
        | ClientError::CommandInvalid(_) => PortError::rejected("rustpbx_command_invalid"),
    }
}
