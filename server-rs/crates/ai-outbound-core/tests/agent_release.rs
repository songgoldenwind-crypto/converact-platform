mod support;

use converact_ai_outbound_core::{
    AgentDraft, AgentReleaseError, ReleaseComponentDigests, publish_agent,
};
use converact_voice_agent_contracts::{AgentDefinitionId, AgentReleaseId};
use support::{agent_draft, release_digests};

#[test]
fn published_release_is_bound_to_every_component_digest() {
    let release = publish_agent(agent_draft(), release_digests()).unwrap();
    assert_eq!(release.state().as_str(), "published");
    assert_eq!(release.content_hash().len(), 64);
    assert_eq!(release.components().tool_schema_hash.len(), 64);

    let baseline = release.content_hash().to_owned();
    let mutations: [fn(&mut ReleaseComponentDigests); 8] = [
        |value| value.prompt_revision_hash = "9".repeat(64),
        |value| value.conversation_flow_revision_hash = "9".repeat(64),
        |value| value.knowledge_revision_hash = "9".repeat(64),
        |value| value.tool_schema_hash = "9".repeat(64),
        |value| value.speech_profile_hash = "9".repeat(64),
        |value| value.compliance_policy_hash = "9".repeat(64),
        |value| value.outcome_schema_hash = "9".repeat(64),
        |value| value.evaluation_rubric_hash = "9".repeat(64),
    ];
    for mutate in mutations {
        let mut changed = release_digests();
        mutate(&mut changed);
        assert_ne!(
            publish_agent(agent_draft(), changed)
                .unwrap()
                .content_hash(),
            baseline,
        );
    }
}

#[test]
fn publish_is_deterministic_for_the_same_frozen_inputs() {
    let first = publish_agent(agent_draft(), release_digests()).unwrap();
    let second = publish_agent(agent_draft(), release_digests()).unwrap();
    assert_eq!(first.content_hash(), second.content_hash());
}

#[test]
fn publish_rejects_mutable_or_incomplete_refs() {
    let mut digests = release_digests();
    digests.knowledge_revision_hash.clear();
    assert_eq!(
        publish_agent(agent_draft(), digests),
        Err(AgentReleaseError::InvalidComponentDigest),
    );

    let mut non_canonical = release_digests();
    non_canonical.prompt_revision_hash = "A".repeat(64);
    assert_eq!(
        publish_agent(agent_draft(), non_canonical),
        Err(AgentReleaseError::InvalidComponentDigest),
    );
}

#[test]
fn draft_rejects_unbounded_names_and_invalid_languages() {
    let definition_id = || AgentDefinitionId::parse("agent-sales-assistant").unwrap();
    let release_id = || AgentReleaseId::parse("agent-sales-assistant-r1").unwrap();
    assert_eq!(
        AgentDraft::try_new(definition_id(), release_id(), "", "zh-CN"),
        Err(AgentReleaseError::InvalidName),
    );
    assert_eq!(
        AgentDraft::try_new(definition_id(), release_id(), "Agent", "zh_CN"),
        Err(AgentReleaseError::InvalidLanguage),
    );
}
