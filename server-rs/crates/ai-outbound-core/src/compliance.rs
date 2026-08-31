/// A policy engine's already-resolved legal basis for this recipient and Campaign.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConsentBasis {
    Explicit,
    ExistingBusinessRelationship,
    Statutory,
}

/// Closed, side-effect-free facts required before a worker may dial.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ComplianceInput {
    pub consent_basis: Option<ConsentBasis>,
    pub timezone: EvidenceStatus,
    pub dial_window: GateStatus,
    pub do_not_call: GateStatus,
    pub frequency: GateStatus,
    pub release: GateStatus,
}

/// Whether a required fact was resolved by its authority.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EvidenceStatus {
    Confirmed,
    Unknown,
}

/// A required policy gate with an explicit unknown state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GateStatus {
    Allowed,
    Blocked,
    Unknown,
}

/// Stable fail-closed reasons used for audit and user-visible remediation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ComplianceReason {
    ReleaseUnavailable,
    ReleaseStatusUnknown,
    ConsentUnknown,
    TimezoneUnknown,
    DoNotCallStatusUnknown,
    DoNotCall,
    DialWindowUnknown,
    OutsideDialWindow,
    FrequencyUnknown,
    FrequencyExceeded,
}

/// Pure pre-dial decision. `Approved` means all required facts are present and passing.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ComplianceDecision {
    Approved,
    Blocked(ComplianceReason),
}

/// Evaluates a fully resolved compliance snapshot without I/O or permissive defaults.
#[must_use]
pub const fn evaluate_compliance(input: &ComplianceInput) -> ComplianceDecision {
    match input.release {
        GateStatus::Allowed => {}
        GateStatus::Blocked => {
            return ComplianceDecision::Blocked(ComplianceReason::ReleaseUnavailable);
        }
        GateStatus::Unknown => {
            return ComplianceDecision::Blocked(ComplianceReason::ReleaseStatusUnknown);
        }
    }
    if input.consent_basis.is_none() {
        return ComplianceDecision::Blocked(ComplianceReason::ConsentUnknown);
    }
    if matches!(input.timezone, EvidenceStatus::Unknown) {
        return ComplianceDecision::Blocked(ComplianceReason::TimezoneUnknown);
    }
    match input.do_not_call {
        GateStatus::Allowed => {}
        GateStatus::Blocked => {
            return ComplianceDecision::Blocked(ComplianceReason::DoNotCall);
        }
        GateStatus::Unknown => {
            return ComplianceDecision::Blocked(ComplianceReason::DoNotCallStatusUnknown);
        }
    }
    match input.dial_window {
        GateStatus::Allowed => {}
        GateStatus::Blocked => {
            return ComplianceDecision::Blocked(ComplianceReason::OutsideDialWindow);
        }
        GateStatus::Unknown => {
            return ComplianceDecision::Blocked(ComplianceReason::DialWindowUnknown);
        }
    }
    match input.frequency {
        GateStatus::Allowed => {}
        GateStatus::Blocked => {
            return ComplianceDecision::Blocked(ComplianceReason::FrequencyExceeded);
        }
        GateStatus::Unknown => {
            return ComplianceDecision::Blocked(ComplianceReason::FrequencyUnknown);
        }
    }
    ComplianceDecision::Approved
}
