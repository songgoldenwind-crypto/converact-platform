use converact_ai_outbound_core::{CallAttempt, TerminalAttemptCommit};
use converact_voice_agent_contracts::{
    AgentReleaseId, AttemptCommand, CallAttemptId, CallId, CampaignId, ChannelAgentSessionId,
};

#[test]
fn terminal_commit_accepts_only_a_completed_disclosed_attempt() {
    let completed = completed_attempt();
    let commit = TerminalAttemptCommit::try_new(
        completed.clone(),
        CampaignId::parse("campaign-001").unwrap(),
        AgentReleaseId::parse("release-001").unwrap(),
        CallId::parse("call-001").unwrap(),
        ChannelAgentSessionId::parse("session-001").unwrap(),
    )
    .unwrap();

    assert_eq!(commit.attempt(), &completed);
    assert_eq!(commit.campaign_id().as_str(), "campaign-001");
    assert_eq!(commit.agent_release_id().as_str(), "release-001");
    assert_eq!(commit.call_id().as_str(), "call-001");
    assert_eq!(commit.channel_agent_session_id().as_str(), "session-001");
}

#[test]
fn terminal_commit_rejects_a_preterminal_attempt() {
    let claimed = CallAttempt::new(CallAttemptId::parse("attempt-001").unwrap())
        .apply(AttemptCommand::Claim)
        .unwrap();
    let error = TerminalAttemptCommit::try_new(
        claimed,
        CampaignId::parse("campaign-001").unwrap(),
        AgentReleaseId::parse("release-001").unwrap(),
        CallId::parse("call-001").unwrap(),
        ChannelAgentSessionId::parse("session-001").unwrap(),
    )
    .unwrap_err();

    assert_eq!(error.code(), "ai_outbound_terminal_attempt_invalid");
}

fn completed_attempt() -> CallAttempt {
    let mut attempt = CallAttempt::new(CallAttemptId::parse("attempt-001").unwrap());
    for command in [
        AttemptCommand::Claim,
        AttemptCommand::ApproveCompliance,
        AttemptCommand::ReserveAgentCapacity,
        AttemptCommand::Dial,
        AttemptCommand::ObserveAnswered,
        AttemptCommand::AttachAgent,
        AttemptCommand::AwaitDisclosure,
        AttemptCommand::CompleteDisclosure,
        AttemptCommand::StartConversation,
        AttemptCommand::Finalize,
        AttemptCommand::Complete,
    ] {
        attempt = attempt.apply(command).unwrap();
    }
    attempt
}
