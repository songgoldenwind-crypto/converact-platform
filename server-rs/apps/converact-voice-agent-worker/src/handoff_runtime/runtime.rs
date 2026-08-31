use converact_agent_handoff_core::HandoffSession;
use converact_agent_handoff_store::{
    HandoffStoreCommand, HandoffStoreCommandInput, HandoffTransitionWrite,
    canonical_request_payload_hash, canonical_transition_payload_hash,
};
use converact_voice_agent_contracts::{ChannelAgentSessionId, HandoffCommandId, HumanLegId};

use super::{
    AiResumeCommandIds, AiResumeRequest, ChannelAgentHandoffPort, DurablePrepareDecision,
    EffectObservation, GenerationCommit, HandoffDurabilityPort, HandoffProgress,
    HumanActivationCommandIds, HumanDialRequest, HumanLegObservation, TelephonyHandoffPort,
    VoiceHandoffRuntimeError,
};

/// Durable coordinator for telephone AI/human ownership changes.
pub struct HandoffRuntime<'a, D, T, A> {
    durability: &'a D,
    telephony: &'a T,
    channel_agent: &'a A,
}

impl<'a, D, T, A> HandoffRuntime<'a, D, T, A> {
    #[must_use]
    pub const fn new(durability: &'a D, telephony: &'a T, channel_agent: &'a A) -> Self {
        Self {
            durability,
            telephony,
            channel_agent,
        }
    }
}

impl<D, T, A> HandoffRuntime<'_, D, T, A>
where
    D: HandoffDurabilityPort,
    T: TelephonyHandoffPort,
    A: ChannelAgentHandoffPort,
{
    /// Runs or resumes the idempotent path from requested AI control to an active human.
    ///
    /// # Errors
    ///
    /// Returns only bounded domain, Store or Provider failure categories.
    #[allow(clippy::too_many_lines)] // Keep the ordered ownership path auditable in one function.
    pub async fn activate_human(
        &self,
        requested: &HandoffSession,
        human_leg_id: HumanLegId,
        ids: &HumanActivationCommandIds,
    ) -> Result<HandoffProgress, VoiceHandoffRuntimeError> {
        let request_command = request_command(ids.request.clone(), requested)?;
        self.durability
            .create_requested(requested, &request_command)
            .await
            .map_err(port_error)?;

        let prepared = requested
            .prepare(requested.revision(), requested.execution_generation())
            .map_err(domain_error)?;
        let prepared = self
            .persist_pure(requested, &prepared, ids.prepare.clone(), "prepare")
            .await?;

        let dialing = prepared
            .observe_human_leg_dialing(
                prepared.revision(),
                prepared.execution_generation(),
                human_leg_id.clone(),
            )
            .map_err(domain_error)?;
        let dial_command = transition_command(ids.dial.clone(), "dial_human", &prepared, &dialing)?;
        let dial_write = HandoffTransitionWrite::try_new(dial_command, &prepared, &dialing)
            .map_err(store_model_error)?;
        let dial_request =
            HumanDialRequest::from_handoff(&prepared, human_leg_id, ids.dial.clone());
        let prepare_decision = self
            .durability
            .prepare_transition(&dial_write)
            .await
            .map_err(port_error)?;
        let observed_during_reconcile = match prepare_decision {
            DurablePrepareDecision::Execute => {
                match self
                    .telephony
                    .dial_human(dial_request.clone())
                    .await
                    .map_err(port_error)?
                {
                    EffectObservation::Applied => None,
                    EffectObservation::NotApplied(code) => {
                        self.durability
                            .finalize_not_applied(&prepared, dial_write.command(), code)
                            .await
                            .map_err(port_error)?;
                        return self
                            .abort(
                                &prepared,
                                ids.abort_before_dial.clone(),
                                "abort_before_dial",
                            )
                            .await;
                    }
                    EffectObservation::OutcomeUnknown => {
                        return Ok(HandoffProgress::Pending(prepared));
                    }
                }
            }
            DurablePrepareDecision::Query => Some(
                self.telephony
                    .query_human_leg(dial_request.clone())
                    .await
                    .map_err(port_error)?,
            ),
            DurablePrepareDecision::ReplayApplied => None,
            DurablePrepareDecision::ReplayNotApplied => {
                return self
                    .abort(
                        &prepared,
                        ids.abort_before_dial.clone(),
                        "abort_before_dial",
                    )
                    .await;
            }
            DurablePrepareDecision::Conflict | DurablePrepareDecision::StaleFence => {
                return Ok(HandoffProgress::ReconcileRequired(prepared));
            }
        };
        if !matches!(prepare_decision, DurablePrepareDecision::ReplayApplied) {
            match observed_during_reconcile {
                Some(HumanLegObservation::Ended(code)) => {
                    self.durability
                        .finalize_not_applied(&prepared, dial_write.command(), code)
                        .await
                        .map_err(port_error)?;
                    return self
                        .abort(
                            &prepared,
                            ids.abort_before_dial.clone(),
                            "abort_before_dial",
                        )
                        .await;
                }
                Some(HumanLegObservation::NotFound) => {
                    self.durability
                        .finalize_not_applied(
                            &prepared,
                            dial_write.command(),
                            "human_leg_not_found",
                        )
                        .await
                        .map_err(port_error)?;
                    return self
                        .abort(
                            &prepared,
                            ids.abort_before_dial.clone(),
                            "abort_before_dial",
                        )
                        .await;
                }
                Some(HumanLegObservation::OutcomeUnknown) => {
                    return Ok(HandoffProgress::Pending(prepared));
                }
                Some(HumanLegObservation::Dialing | HumanLegObservation::Answered) | None => {
                    self.durability
                        .finalize_applied(&dial_write)
                        .await
                        .map_err(port_error)?;
                }
            }
        }

        let leg_observation = match observed_during_reconcile {
            Some(observation) => observation,
            None => self
                .telephony
                .query_human_leg(dial_request)
                .await
                .map_err(port_error)?,
        };
        match leg_observation {
            HumanLegObservation::Dialing | HumanLegObservation::OutcomeUnknown => {
                return Ok(HandoffProgress::Pending(dialing));
            }
            HumanLegObservation::Ended(_) | HumanLegObservation::NotFound => {
                return self
                    .abort(&dialing, ids.abort_after_dial.clone(), "abort_after_dial")
                    .await;
            }
            HumanLegObservation::Answered => {}
        }

        let answered = dialing
            .observe_human_leg_answered(dialing.revision(), dialing.execution_generation())
            .map_err(domain_error)?;
        let answered = self
            .persist_pure(
                &dialing,
                &answered,
                ids.observe_answered.clone(),
                "observe_human_answered",
            )
            .await?;
        let committed = answered
            .commit_human(answered.revision(), answered.execution_generation())
            .map_err(domain_error)?;
        let committed = self
            .persist_pure(&answered, &committed, ids.commit.clone(), "commit_human")
            .await?;
        if self
            .channel_agent
            .generation_committed(GenerationCommit::from_handoff(
                &committed,
                ids.commit.clone(),
            ))
            .await
            .is_err()
        {
            return Ok(HandoffProgress::ReconcileRequired(committed));
        }
        let active = committed
            .mark_human_active(committed.revision(), committed.execution_generation())
            .map_err(domain_error)?;
        let active = self
            .persist_pure(
                &committed,
                &active,
                ids.mark_active.clone(),
                "mark_human_active",
            )
            .await?;
        Ok(HandoffProgress::HumanActive(active))
    }

    /// Runs or resumes the idempotent path from active human control to a ready AI generation.
    ///
    /// # Errors
    ///
    /// Returns only bounded domain, Store or Provider failure categories.
    pub async fn resume_ai(
        &self,
        human_active: &HandoffSession,
        ai_session_id: ChannelAgentSessionId,
        ids: &AiResumeCommandIds,
    ) -> Result<HandoffProgress, VoiceHandoffRuntimeError> {
        let preparing = human_active
            .prepare_ai_resume(
                human_active.revision(),
                human_active.execution_generation(),
                ai_session_id.clone(),
            )
            .map_err(domain_error)?;
        let command = transition_command(
            ids.prepare.clone(),
            "prepare_ai_resume",
            human_active,
            &preparing,
        )?;
        let write = HandoffTransitionWrite::try_new(command, human_active, &preparing)
            .map_err(store_model_error)?;
        let request =
            AiResumeRequest::from_handoff(human_active, ai_session_id, ids.prepare.clone());
        let prepare_decision = self
            .durability
            .prepare_transition(&write)
            .await
            .map_err(port_error)?;
        let observation = match prepare_decision {
            DurablePrepareDecision::Execute => self
                .channel_agent
                .prepare_ai_resume(request)
                .await
                .map_err(port_error)?,
            DurablePrepareDecision::Query => self
                .channel_agent
                .query_ai_resume(request)
                .await
                .map_err(port_error)?,
            DurablePrepareDecision::ReplayApplied => EffectObservation::Applied,
            DurablePrepareDecision::ReplayNotApplied => {
                return Ok(HandoffProgress::NotApplied {
                    session: human_active.clone(),
                    failure_code: "ai_resume_not_applied",
                });
            }
            DurablePrepareDecision::Conflict | DurablePrepareDecision::StaleFence => {
                return Ok(HandoffProgress::ReconcileRequired(human_active.clone()));
            }
        };
        match observation {
            EffectObservation::Applied => {
                if !matches!(prepare_decision, DurablePrepareDecision::ReplayApplied) {
                    self.durability
                        .finalize_applied(&write)
                        .await
                        .map_err(port_error)?;
                }
            }
            EffectObservation::NotApplied(code) => {
                self.durability
                    .finalize_not_applied(human_active, write.command(), code)
                    .await
                    .map_err(port_error)?;
                return Ok(HandoffProgress::NotApplied {
                    session: human_active.clone(),
                    failure_code: code,
                });
            }
            EffectObservation::OutcomeUnknown => {
                return Ok(HandoffProgress::Pending(human_active.clone()));
            }
        }

        let resumed = preparing
            .commit_ai_resume(preparing.revision(), preparing.execution_generation())
            .map_err(domain_error)?;
        let resumed = self
            .persist_pure(&preparing, &resumed, ids.commit.clone(), "commit_ai_resume")
            .await?;
        if self
            .channel_agent
            .generation_committed(GenerationCommit::from_handoff(&resumed, ids.commit.clone()))
            .await
            .is_err()
        {
            return Ok(HandoffProgress::ReconcileRequired(resumed));
        }
        Ok(HandoffProgress::AiResumed(resumed))
    }

    async fn persist_pure(
        &self,
        current: &HandoffSession,
        next: &HandoffSession,
        id: HandoffCommandId,
        kind: &str,
    ) -> Result<HandoffSession, VoiceHandoffRuntimeError> {
        let command = transition_command(id, kind, current, next)?;
        let write =
            HandoffTransitionWrite::try_new(command, current, next).map_err(store_model_error)?;
        match self
            .durability
            .prepare_transition(&write)
            .await
            .map_err(port_error)?
        {
            DurablePrepareDecision::Execute | DurablePrepareDecision::Query => self
                .durability
                .finalize_applied(&write)
                .await
                .map_err(port_error)?,
            DurablePrepareDecision::ReplayApplied => {}
            DurablePrepareDecision::ReplayNotApplied
            | DurablePrepareDecision::Conflict
            | DurablePrepareDecision::StaleFence => {
                return Err(VoiceHandoffRuntimeError::new(
                    "voice_handoff_transition_not_committed",
                ));
            }
        }
        Ok(next.clone())
    }

    async fn abort(
        &self,
        current: &HandoffSession,
        id: HandoffCommandId,
        kind: &str,
    ) -> Result<HandoffProgress, VoiceHandoffRuntimeError> {
        let aborted = current
            .abort(current.revision(), current.execution_generation())
            .map_err(domain_error)?;
        self.persist_pure(current, &aborted, id, kind)
            .await
            .map(HandoffProgress::Aborted)
    }
}

fn request_command(
    id: HandoffCommandId,
    requested: &HandoffSession,
) -> Result<HandoffStoreCommand, VoiceHandoffRuntimeError> {
    HandoffStoreCommand::try_new(HandoffStoreCommandInput {
        id,
        kind: "request".to_owned(),
        payload_hash: canonical_request_payload_hash(requested).map_err(store_model_error)?,
        expected_revision: requested.revision(),
        expected_generation: requested.execution_generation(),
    })
    .map_err(store_model_error)
}

fn transition_command(
    id: HandoffCommandId,
    kind: &str,
    current: &HandoffSession,
    next: &HandoffSession,
) -> Result<HandoffStoreCommand, VoiceHandoffRuntimeError> {
    HandoffStoreCommand::try_new(HandoffStoreCommandInput {
        id,
        kind: kind.to_owned(),
        payload_hash: canonical_transition_payload_hash(kind, current, next)
            .map_err(store_model_error)?,
        expected_revision: current.revision(),
        expected_generation: current.execution_generation(),
    })
    .map_err(store_model_error)
}

fn domain_error(error: converact_agent_handoff_core::HandoffError) -> VoiceHandoffRuntimeError {
    VoiceHandoffRuntimeError::new(error.code())
}

fn store_model_error(
    error: converact_agent_handoff_store::HandoffStoreError,
) -> VoiceHandoffRuntimeError {
    VoiceHandoffRuntimeError::new(error.code())
}

fn port_error(error: super::VoiceHandoffPortError) -> VoiceHandoffRuntimeError {
    VoiceHandoffRuntimeError::new(error.code())
}
