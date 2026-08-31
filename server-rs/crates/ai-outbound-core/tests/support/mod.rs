#![allow(dead_code)]

use converact_ai_outbound_core::{AgentDraft, ReleaseComponentDigests};
use converact_voice_agent_contracts::{AgentDefinitionId, AgentReleaseId};

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
