#![allow(dead_code)]

use converact_ai_outbound_core::{
    AgentDraft, AttemptCommand, CallAttempt, Campaign, CampaignCommand, ReleaseComponentDigests,
};
use converact_voice_agent_contracts::{
    AgentDefinitionId, AgentReleaseId, CallAttemptId, CampaignId,
};

pub fn agent_draft() -> AgentDraft {
    AgentDraft::try_new(
        AgentDefinitionId::parse("agent-sales-assistant").unwrap(),
        AgentReleaseId::parse("agent-sales-assistant-r1").unwrap(),
        "Industry-neutral sales assistant",
        "zh-CN",
    )
    .unwrap()
}

pub fn release_digests() -> ReleaseComponentDigests {
    ReleaseComponentDigests {
        prompt_revision_hash: "1".repeat(64),
        conversation_flow_revision_hash: "2".repeat(64),
        knowledge_revision_hash: "3".repeat(64),
        tool_schema_hash: "4".repeat(64),
        speech_profile_hash: "5".repeat(64),
        compliance_policy_hash: "6".repeat(64),
        outcome_schema_hash: "7".repeat(64),
        evaluation_rubric_hash: "8".repeat(64),
    }
}

pub fn running_campaign() -> Campaign {
    Campaign::new(CampaignId::parse("campaign-001").unwrap())
        .apply(CampaignCommand::Schedule)
        .unwrap()
        .apply(CampaignCommand::Start)
        .unwrap()
        .observe_attempt_started()
        .unwrap()
}

pub fn completed_campaign() -> Campaign {
    running_campaign()
        .apply(CampaignCommand::Drain)
        .unwrap()
        .observe_attempt_finished()
        .unwrap()
        .apply(CampaignCommand::Complete)
        .unwrap()
}

pub fn planned_attempt() -> CallAttempt {
    CallAttempt::new(CallAttemptId::parse("attempt-001").unwrap())
}

pub fn no_answer_attempt() -> CallAttempt {
    dialling_attempt()
        .apply(AttemptCommand::MarkNoAnswer)
        .unwrap()
}

pub fn outcome_unknown_attempt() -> CallAttempt {
    dialling_attempt()
        .apply(AttemptCommand::MarkOutcomeUnknown)
        .unwrap()
}

fn dialling_attempt() -> CallAttempt {
    planned_attempt()
        .apply(AttemptCommand::Claim)
        .unwrap()
        .apply(AttemptCommand::ApproveCompliance)
        .unwrap()
        .apply(AttemptCommand::ReserveAgentCapacity)
        .unwrap()
        .apply(AttemptCommand::Dial)
        .unwrap()
}
