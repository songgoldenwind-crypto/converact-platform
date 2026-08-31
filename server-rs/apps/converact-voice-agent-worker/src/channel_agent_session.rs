use converact_ai_outbound_core::AgentReleaseBinding;
use converact_contracts::canonical_sha256;
use converact_voice_agent_contracts::{CallAttemptId, ChannelAgentSessionId};
use serde_json::json;

use crate::{AuthenticatedTenant, WorkerError};

const INITIAL_SESSION_ID_DOMAIN: &str = "active_call_initial_session_v1";

/// Derives the replay-stable, tenant-scoped identity for an Attempt's initial AI session.
pub(crate) fn derive_initial_session_id(
    tenant: &AuthenticatedTenant,
    attempt_id: &CallAttemptId,
    release: &AgentReleaseBinding,
) -> Result<ChannelAgentSessionId, WorkerError> {
    let digest = canonical_sha256(&json!({
        "agent_release_content_hash": release.content_hash(),
        "agent_release_id": release.id().as_str(),
        "call_attempt_id": attempt_id.as_str(),
        "domain": INITIAL_SESSION_ID_DOMAIN,
        "tenant_id": tenant.as_str(),
    }))
    .map_err(|_| WorkerError::new("voice_agent_session_identity_invalid"))?;
    ChannelAgentSessionId::parse(format!("ac.{digest}"))
        .map_err(|_| WorkerError::new("voice_agent_session_identity_invalid"))
}

#[cfg(test)]
mod tests {
    use converact_ai_outbound_core::{AgentReleaseBinding, ReleaseComponentDigests};
    use converact_voice_agent_contracts::{AgentReleaseId, CallAttemptId};

    use crate::AuthenticatedTenant;

    use super::derive_initial_session_id;

    #[test]
    fn initial_session_identity_is_stable_and_tenant_scoped() {
        let release = release("release-001", '9');
        let attempt = CallAttemptId::parse("attempt-001").unwrap();
        let tenant_a = AuthenticatedTenant::try_from_verified_tenant_id("tenant-a").unwrap();
        let tenant_b = AuthenticatedTenant::try_from_verified_tenant_id("tenant-b").unwrap();

        let first = derive_initial_session_id(&tenant_a, &attempt, &release).unwrap();
        let replay = derive_initial_session_id(&tenant_a, &attempt, &release).unwrap();
        let other_tenant = derive_initial_session_id(&tenant_b, &attempt, &release).unwrap();

        assert_eq!(first, replay);
        assert_ne!(first, other_tenant);
        assert_eq!(
            first.as_str(),
            "ac.5069b46759b073148da8e9412a9ca35fd65aad08e917b54eab4ce4d539bb6030"
        );
    }

    #[test]
    fn attempt_and_release_are_part_of_the_session_identity() {
        let tenant = AuthenticatedTenant::try_from_verified_tenant_id("tenant-a").unwrap();
        let attempt_one = CallAttemptId::parse("attempt-001").unwrap();
        let attempt_two = CallAttemptId::parse("attempt-002").unwrap();
        let release_one = release("release-001", '9');
        let release_two = release("release-002", '8');

        let baseline = derive_initial_session_id(&tenant, &attempt_one, &release_one).unwrap();

        assert_ne!(
            baseline,
            derive_initial_session_id(&tenant, &attempt_two, &release_one).unwrap()
        );
        assert_ne!(
            baseline,
            derive_initial_session_id(&tenant, &attempt_one, &release_two).unwrap()
        );
    }

    fn release(id: &str, digest_character: char) -> AgentReleaseBinding {
        AgentReleaseBinding::try_new(
            AgentReleaseId::parse(id).unwrap(),
            digest_character.to_string().repeat(64),
            components(),
        )
        .unwrap()
    }

    fn components() -> ReleaseComponentDigests {
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
}
