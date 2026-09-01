use converact_contracts::canonical_sha256_with_max_bytes;
use converact_postgres_store::PostgresReleaseToolManifest;
use converact_tool_broker_core::{PolicyDecision, ToolEffectClass, ToolRisk};
use converact_voice_agent_contracts::AgentReleaseId;
use serde_json::json;

const MIGRATION: &str =
    include_str!("../../../../src/migrations/141_converact_agent_release_tool_manifests.sql");
const DEVELOPMENT_SCHEMA: &str = include_str!("../../../../src/schema.sql");
const STORE_SOURCE: &str = include_str!("../src/release_tool_manifest.rs");

#[test]
fn migration_binds_one_immutable_tool_manifest_to_each_release() {
    for required in [
        "converact_agent_release_tool_manifests",
        "PRIMARY KEY (tenant_id, agent_release_id)",
        "REFERENCES converact_agent_releases(tenant_id, id) ON DELETE CASCADE",
        "components->>'tool_schema_hash'",
        "tool_set_hash ~ '^[0-9a-f]{64}$'",
        "jsonb_typeof(tool_manifest) = 'array'",
        "octet_length(tool_manifest::TEXT) <= 65536",
        "BEFORE UPDATE OR DELETE",
        "ENABLE ROW LEVEL SECURITY",
        "FORCE ROW LEVEL SECURITY",
        "GRANT SELECT ON converact_agent_release_tool_manifests TO opc_runtime",
    ] {
        assert!(MIGRATION.contains(required), "missing invariant {required}");
    }
    assert!(DEVELOPMENT_SCHEMA.contains("converact_agent_release_tool_manifests"));
}

#[test]
fn manifest_resolves_exact_names_and_revisions_and_rejects_digest_drift() {
    let schema = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["customer_id"],
        "properties": {"customer_id": {"type": "string"}},
    });
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
    let tool_set_hash = canonical_sha256_with_max_bytes(&manifest, 65_536).unwrap();
    let release_id = AgentReleaseId::parse("release-001").unwrap();
    let parsed =
        PostgresReleaseToolManifest::try_new(release_id.clone(), &tool_set_hash, manifest.clone())
            .unwrap();

    let by_name = parsed.tool_by_name("customer.lookup").unwrap();
    let by_revision = parsed.tool_by_revision("customer.lookup-r1").unwrap();
    assert_eq!(by_name, by_revision);
    assert_eq!(by_name.definition().agent_release_id(), &release_id);
    assert_eq!(by_name.definition().effect_class(), ToolEffectClass::Query);
    assert_eq!(by_name.definition().risk(), ToolRisk::Low);
    assert_eq!(by_name.policy_decision(), PolicyDecision::Allowed);
    assert_eq!(by_name.deadline_after_ms(), 5_000);
    assert_eq!(by_name.arguments_schema()["additionalProperties"], false);

    assert!(PostgresReleaseToolManifest::try_new(release_id, "9".repeat(64), manifest).is_err());
}

#[test]
fn store_uses_one_tenant_release_lookup_and_validates_release_binding() {
    for required in [
        "PostgresReleaseToolStore",
        "with_tenant_transaction",
        "artifact.tenant_id = $1",
        "artifact.agent_release_id = $2",
        "release.components->>'tool_schema_hash'",
        "LIMIT 1",
    ] {
        assert!(
            STORE_SOURCE.contains(required),
            "missing Store invariant {required}"
        );
    }
}
