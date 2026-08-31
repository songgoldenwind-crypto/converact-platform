mod support;

use converact_ai_outbound_core::{Campaign, CampaignCommand, DomainError};
use converact_voice_agent_contracts::{CampaignId, CampaignState};

#[test]
fn durable_campaign_restores_before_applying_the_single_core_state_machine() {
    let restored = Campaign::restore(
        CampaignId::parse("campaign-001").unwrap(),
        CampaignState::Paused,
        0,
        5,
    )
    .unwrap();
    let running = restored.apply(CampaignCommand::Resume).unwrap();
    assert_eq!(running.state(), CampaignState::Running);
    assert_eq!(running.revision(), 6);

    assert_eq!(
        Campaign::restore(
            CampaignId::parse("campaign-001").unwrap(),
            CampaignState::Draft,
            0,
            0,
        ),
        Err(DomainError::InvalidRevision)
    );
}
use support::{completed_campaign, running_campaign};

#[test]
fn pause_stops_new_claims_but_does_not_cancel_active_attempts() {
    let running = running_campaign();
    let paused = running.apply(CampaignCommand::Pause).unwrap();
    assert!(!paused.accepts_new_attempts());
    assert_eq!(paused.active_attempts(), running.active_attempts());
}

#[test]
fn draining_campaign_waits_for_active_attempts() {
    let draining = running_campaign().apply(CampaignCommand::Drain).unwrap();
    assert_eq!(
        draining.clone().apply(CampaignCommand::Complete),
        Err(DomainError::ActiveAttemptsRemain),
    );
    let completed = draining.observe_attempt_finished().unwrap();
    assert!(completed.apply(CampaignCommand::Complete).is_ok());
}

#[test]
fn completed_campaign_cannot_restart() {
    let completed = completed_campaign();
    assert_eq!(
        completed.apply(CampaignCommand::Start),
        Err(DomainError::InvalidTransition),
    );
}
