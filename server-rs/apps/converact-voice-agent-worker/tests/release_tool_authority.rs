use std::sync::{Arc, Mutex};

use converact_contracts::canonical_sha256_with_max_bytes;
use converact_kernel_ids::TenantId;
use converact_postgres_store::PostgresReleaseToolManifest;
use converact_tool_broker_core::{
    PolicyDecision, PolicyPort, ToolCatalogPort, ToolProposal, ToolProposalInput,
};
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CampaignContactId, CampaignId, EnvelopeContext,
    EnvelopeContextInput, ExecutionGeneration, InteractionId, ToolCallId, ToolRevisionId,
    VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    ReleaseToolAuthority, ReleaseToolManifestPort, ToolBindingPort,
};
use serde_json::{Value, json};

#[tokio::test]
async fn one_release_manifest_resolves_binding_catalog_and_policy() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let authority = ReleaseToolAuthority::new(Arc::new(Source {
        manifest: manifest(),
        calls: Arc::clone(&calls),
    }));
    let context = context("release-001");

    let binding = ToolBindingPort::resolve(&authority, &context, "customer.lookup")
        .await
        .unwrap()
        .unwrap();
    let proposal = proposal(
        context,
        binding.revision_id().clone(),
        binding.schema_hash(),
    );
    let definition = ToolCatalogPort::resolve(&authority, &proposal)
        .await
        .unwrap()
        .unwrap();
    let policy = PolicyPort::evaluate(&authority, &definition, &proposal)
        .await
        .unwrap();

    assert_eq!(binding.deadline_after_ms(), 5_000);
    assert_eq!(definition.action_capability(), "customer.lookup");
    assert_eq!(policy, PolicyDecision::Allowed);
    assert_eq!(
        calls.lock().unwrap().as_slice(),
        [
            "tenant-a/release-001",
            "tenant-a/release-001",
            "tenant-a/release-001"
        ]
    );
}

#[tokio::test]
async fn unknown_name_and_release_drift_fail_closed() {
    let authority = ReleaseToolAuthority::new(Arc::new(Source {
        manifest: manifest(),
        calls: Arc::new(Mutex::new(Vec::new())),
    }));

    assert!(
        ToolBindingPort::resolve(&authority, &context("release-001"), "customer.export")
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        ToolBindingPort::resolve(&authority, &context("release-002"), "customer.lookup")
            .await
            .unwrap()
            .is_none()
    );
}

struct Source {
    manifest: PostgresReleaseToolManifest,
    calls: Arc<Mutex<Vec<String>>>,
}

impl ReleaseToolManifestPort for Source {
    async fn load_manifest(
        &self,
        tenant: &TenantId,
        release_id: &AgentReleaseId,
    ) -> Result<Option<PostgresReleaseToolManifest>, converact_tool_broker_core::ToolPortError>
    {
        self.calls
            .lock()
            .unwrap()
            .push(format!("{}/{}", tenant.as_str(), release_id.as_str()));
        if tenant.as_str() == "tenant-a" && release_id.as_str() == "release-001" {
            Ok(Some(self.manifest.clone()))
        } else {
            Ok(None)
        }
    }
}

fn manifest() -> PostgresReleaseToolManifest {
    let schema = schema();
    let schema_hash = canonical_sha256_with_max_bytes(&schema, 65_536).unwrap();
    let manifest = json!([{
        "name": "customer.lookup",
        "revision_id": "customer.lookup-r1",
        "schema_hash": schema_hash,
        "arguments_schema": schema,
        "effect_class": "query",
        "risk": "low",
        "action_capability": "customer.lookup",
        "policy_decision": "allowed",
        "deadline_after_ms": 5_000,
    }]);
    let hash = canonical_sha256_with_max_bytes(&manifest, 65_536).unwrap();
    PostgresReleaseToolManifest::try_new(
        AgentReleaseId::parse("release-001").unwrap(),
        hash,
        manifest,
    )
    .unwrap()
}

fn proposal(
    context: EnvelopeContext,
    revision_id: ToolRevisionId,
    schema_hash: &str,
) -> ToolProposal {
    let arguments = json!({"customer_id": "customer-001"});
    ToolProposal::try_new(ToolProposalInput {
        context,
        tool_revision_id: revision_id,
        tool_call_id: ToolCallId::parse("tool-call-001").unwrap(),
        tool_schema_hash: schema_hash.to_owned(),
        arguments_hash: canonical_sha256_with_max_bytes(&arguments, 65_536).unwrap(),
        arguments,
        requested_at_ms: 1_000,
        deadline_ms: 6_000,
    })
    .unwrap()
}

fn schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["customer_id"],
        "properties": {"customer_id": {"type": "string"}},
    })
}

fn context(release_id: &str) -> EnvelopeContext {
    EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version: VOICE_AGENT_SCHEMA_VERSION,
        tenant_id: "tenant-a".to_owned(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        campaign_id: CampaignId::parse("campaign-001").unwrap(),
        campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
        call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        call_id: None,
        agent_release_id: AgentReleaseId::parse(release_id).unwrap(),
        channel_agent_session_id: None,
        execution_generation: ExecutionGeneration::new(1).unwrap(),
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}
