mod support;

use converact_ai_outbound_core::{
    AttemptCommand, ComplianceDecision, ComplianceReason, DomainError, GateStatus,
    evaluate_compliance,
};
use support::{compliance_input, disclosure_pending_attempt};

#[test]
fn dnc_and_out_of_window_fail_closed() {
    let mut input = compliance_input();
    input.do_not_call = GateStatus::Blocked;
    assert_eq!(
        evaluate_compliance(&input),
        ComplianceDecision::Blocked(ComplianceReason::DoNotCall),
    );
    input.do_not_call = GateStatus::Allowed;
    input.dial_window = GateStatus::Blocked;
    assert_eq!(
        evaluate_compliance(&input),
        ComplianceDecision::Blocked(ComplianceReason::OutsideDialWindow),
    );
}

#[test]
fn all_required_facts_must_be_present() {
    let mut input = compliance_input();
    input.consent_basis = None;
    assert_eq!(
        evaluate_compliance(&input),
        ComplianceDecision::Blocked(ComplianceReason::ConsentUnknown),
    );

    input = compliance_input();
    input.do_not_call = GateStatus::Unknown;
    assert_eq!(
        evaluate_compliance(&input),
        ComplianceDecision::Blocked(ComplianceReason::DoNotCallStatusUnknown),
    );
}

#[test]
fn approved_requires_every_pre_dial_gate() {
    assert_eq!(
        evaluate_compliance(&compliance_input()),
        ComplianceDecision::Approved,
    );
}

#[test]
fn business_conversation_cannot_start_before_disclosure_completion() {
    let pending = disclosure_pending_attempt();
    assert_eq!(
        pending.apply(AttemptCommand::StartConversation),
        Err(DomainError::DisclosureRequired),
    );
    let disclosed = pending.apply(AttemptCommand::CompleteDisclosure).unwrap();
    assert!(disclosed.disclosure_completed());
    assert!(disclosed.apply(AttemptCommand::StartConversation).is_ok());
}
