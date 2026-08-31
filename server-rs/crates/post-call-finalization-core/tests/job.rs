use converact_post_call_finalization_core::{
    FinalizationJobError, FinalizationJobInput, FinalizationJobState, FinalizationResolution,
    PostCallFinalizationJob,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    ConversationFinalizationJobId, EnvelopeContext, EnvelopeContextInput, ExecutionGeneration,
    InteractionId, VOICE_AGENT_SCHEMA_VERSION,
};

#[test]
fn job_identity_payload_and_context_are_stable_and_content_free() {
    let job = job("finalize-001");

    assert_eq!(job.id().as_str(), "finalize-001");
    assert_eq!(job.context().interaction_id().as_str(), "interaction-001");
    assert_eq!(job.context().call_attempt_id().as_str(), "attempt-001");
    assert_eq!(job.state(), FinalizationJobState::Pending);
    assert_eq!(job.revision(), 1);
    assert_eq!(job.payload_hash().len(), 64);
    assert!(!format!("{job:?}").contains("transcript"));
}

#[test]
fn claimed_job_reconciles_and_completes_only_with_fresh_revision() {
    let pending = job("finalize-002");
    assert_eq!(
        pending
            .complete(1, FinalizationResolution::Projected)
            .unwrap_err(),
        FinalizationJobError::InvalidTransition
    );

    let claimed = pending.claim(1).unwrap();
    assert_eq!(claimed.state(), FinalizationJobState::Claimed);
    assert_eq!(
        claimed.require_reconcile(1).unwrap_err(),
        FinalizationJobError::StaleRevision
    );
    let reconcile = claimed.require_reconcile(2).unwrap();
    let reclaimed = reconcile.claim(3).unwrap();
    let completed = reclaimed
        .complete(4, FinalizationResolution::Incomplete)
        .unwrap();

    assert_eq!(completed.state(), FinalizationJobState::Completed);
    assert_eq!(
        completed.resolution(),
        Some(FinalizationResolution::Incomplete)
    );
    assert_eq!(
        completed.claim(5).unwrap_err(),
        FinalizationJobError::InvalidTransition
    );
}

#[test]
fn finalization_requires_a_call_and_bounded_retention_policy() {
    let mut no_call = input("finalize-no-call");
    no_call.context = context(None);
    assert_eq!(
        PostCallFinalizationJob::try_new(no_call).unwrap_err(),
        FinalizationJobError::CallRequired
    );

    let mut bad_retention = input("finalize-bad-retention");
    bad_retention.retention_policy_ref = "bad retention".to_owned();
    assert_eq!(
        PostCallFinalizationJob::try_new(bad_retention).unwrap_err(),
        FinalizationJobError::InvalidRetentionPolicy
    );
}

fn job(id: &str) -> PostCallFinalizationJob {
    PostCallFinalizationJob::try_new(input(id)).unwrap()
}

fn input(id: &str) -> FinalizationJobInput {
    FinalizationJobInput {
        id: ConversationFinalizationJobId::parse(id).unwrap(),
        context: context(Some("call-001")),
        retention_policy_ref: "retention:standard-r1".to_owned(),
        enqueued_at_ms: 1_000,
    }
}

fn context(call_id: Option<&str>) -> EnvelopeContext {
    EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version: VOICE_AGENT_SCHEMA_VERSION,
        tenant_id: "tenant-a".to_owned(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        campaign_id: CampaignId::parse("campaign-001").unwrap(),
        campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
        call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        call_id: call_id.map(|value| CallId::parse(value).unwrap()),
        agent_release_id: AgentReleaseId::parse("agent-r1").unwrap(),
        channel_agent_session_id: Some(ChannelAgentSessionId::parse("agent-session-001").unwrap()),
        execution_generation: ExecutionGeneration::new(1).unwrap(),
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}
