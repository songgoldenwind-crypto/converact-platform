mod support;

use converact_ai_outbound_core::{AgentReleaseBinding, AgentReleaseBindingError};
use converact_voice_agent_contracts::{AgentReleaseId, CallAttemptState};
use support::Harness;

#[test]
fn release_binding_rejects_noncanonical_content_hashes() {
    let release_id = || AgentReleaseId::parse("agent-sales-assistant-r1").unwrap();

    assert_eq!(
        AgentReleaseBinding::try_new(release_id(), "A".repeat(64)),
        Err(AgentReleaseBindingError::InvalidContentHash),
    );
    assert_eq!(
        AgentReleaseBinding::try_new(release_id(), "9".repeat(63)),
        Err(AgentReleaseBindingError::InvalidContentHash),
    );
}

#[tokio::test]
async fn reserve_precedes_dial_and_disclosure_precedes_conversation() {
    let harness = Harness::new();
    let terminal = harness.run_one_attempt().await.unwrap();

    assert_eq!(terminal.state(), CallAttemptState::Completed);
    assert_eq!(harness.attempt_state(), CallAttemptState::Conversing);

    assert_eq!(
        harness.operations(),
        [
            "compliance.check",
            "agent.reserve",
            "rustpbx.originate",
            "rustpbx.answered",
            "agent.attach",
            "agent.media_ready",
            "agent.disclosure",
            "agent.disclosure_completed",
            "agent.start_conversation",
            "rustpbx.terminal",
        ],
    );
}

#[tokio::test]
async fn reservation_is_bound_to_the_exact_agent_release() {
    let harness = Harness::new();

    harness.run_one_attempt().await.unwrap();

    let release = harness.reserved_agent_release().unwrap();
    assert_eq!(release.id().as_str(), "agent-sales-assistant-r1");
    assert_eq!(release.content_hash(), "9".repeat(64));
}

#[tokio::test]
async fn unavailable_agent_prevents_customer_dial() {
    let harness = Harness::with_agent_reservation_failure();
    let result = harness.run_one_attempt().await;

    assert_eq!(result.unwrap_err().code(), "agent_capacity_unavailable");
    assert_eq!(harness.rustpbx_originate_count(), 0);
}

#[tokio::test]
async fn unknown_agent_reservation_freezes_attempt_before_customer_dial() {
    let harness = Harness::with_agent_reservation_timeout();

    assert_eq!(
        harness.run_one_attempt().await.unwrap_err().code(),
        "outcome_unknown"
    );
    assert_eq!(harness.attempt_state(), CallAttemptState::OutcomeUnknown);
    assert_eq!(harness.rustpbx_originate_count(), 0);
    assert_eq!(harness.retry_count(), 0);
}

#[tokio::test]
async fn crash_after_originate_reconciles_before_retry() {
    let harness = Harness::crash_after_originate();

    assert_eq!(
        harness.run_one_attempt().await.unwrap_err().code(),
        "outcome_unknown"
    );
    assert_eq!(harness.retry_count(), 0);

    harness.reconcile().await.unwrap();
    assert_eq!(harness.retry_count(), 0);
}

#[tokio::test]
async fn disclosure_timeout_is_unknown_and_never_auto_retried() {
    let harness = Harness::with_disclosure_timeout();

    assert_eq!(
        harness.run_one_attempt().await.unwrap_err().code(),
        "outcome_unknown"
    );
    assert_eq!(harness.attempt_state(), CallAttemptState::OutcomeUnknown);
    assert_eq!(harness.retry_count(), 0);
}
