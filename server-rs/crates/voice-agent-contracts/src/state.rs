use serde::{Deserialize, Serialize};

macro_rules! wire_state {
    ($name:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
        #[serde(rename_all = "snake_case")]
        pub enum $name {
            $($variant),+
        }

        impl $name {
            /// Returns the frozen lower-snake-case wire value.
            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire),+
                }
            }
        }
    };
}

wire_state!(AgentReleaseState {
    Draft => "draft",
    Validating => "validating",
    Published => "published",
    Rejected => "rejected",
    Retired => "retired",
});

wire_state!(CampaignState {
    Draft => "draft",
    Scheduled => "scheduled",
    Running => "running",
    Paused => "paused",
    Draining => "draining",
    Completed => "completed",
    Cancelled => "cancelled",
    Archived => "archived",
});

wire_state!(CallAttemptState {
    Planned => "planned",
    Claimed => "claimed",
    ComplianceApproved => "compliance_approved",
    ComplianceBlocked => "compliance_blocked",
    AgentCapacityReserved => "agent_capacity_reserved",
    Dialing => "dialing",
    Ringing => "ringing",
    Answered => "answered",
    AgentConnecting => "agent_connecting",
    DisclosurePending => "disclosure_pending",
    Conversing => "conversing",
    HandoffPending => "handoff_pending",
    HumanActive => "human_active",
    AiResuming => "ai_resuming",
    Finalizing => "finalizing",
    Completed => "completed",
    Cancelled => "cancelled",
    Busy => "busy",
    NoAnswer => "no_answer",
    Rejected => "rejected",
    FailedBeforeAnswer => "failed_before_answer",
    FailedAfterAnswer => "failed_after_answer",
    OutcomeUnknown => "outcome_unknown",
    ReconcileRequired => "reconcile_required",
});
