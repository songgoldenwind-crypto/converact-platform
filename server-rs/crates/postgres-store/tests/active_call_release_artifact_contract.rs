use converact_ai_outbound_core::{AgentReleaseBinding, ReleaseComponentDigests};
use converact_postgres_store::{
    PostgresActiveCallArtifactRecord, PostgresActiveCallArtifactStoreConfig,
};
use converact_voice_agent_contracts::AgentReleaseId;

const MIGRATION: &str =
    include_str!("../../../../src/migrations/137_converact_agent_release_runtime_artifacts.sql");
const DEVELOPMENT_SCHEMA: &str = include_str!("../../../../src/schema.sql");
const STORE_SOURCE: &str = include_str!("../src/release_artifact.rs");

#[test]
fn migration_is_additive_tenant_scoped_and_append_only() {
    for required in [
        "converact_agent_release_runtime_artifacts",
        "PRIMARY KEY (tenant_id, agent_release_id, compiler_revision)",
        "REFERENCES converact_agent_releases(tenant_id, id) ON DELETE CASCADE",
        "artifact_hash ~ '^[0-9a-f]{64}$'",
        "octet_length(playbook_content) BETWEEN 1 AND 65536",
        "BEFORE UPDATE OR DELETE",
        "ENABLE ROW LEVEL SECURITY",
        "FORCE ROW LEVEL SECURITY",
        "GRANT SELECT ON converact_agent_release_runtime_artifacts TO opc_runtime",
    ] {
        assert!(
            MIGRATION.contains(required),
            "missing migration invariant {required}"
        );
    }
    assert!(DEVELOPMENT_SCHEMA.contains("converact_agent_release_runtime_artifacts"));
}

#[test]
fn configuration_and_record_reject_drift_or_unbounded_content() {
    let config = PostgresActiveCallArtifactStoreConfig::new("active-call-compiler-r1").unwrap();
    assert_eq!(config.compiler_revision(), "active-call-compiler-r1");
    assert!(PostgresActiveCallArtifactStoreConfig::new("").is_err());
    assert!(PostgresActiveCallArtifactStoreConfig::new("compiler/revision").is_err());

    let release = release();
    let record = PostgresActiveCallArtifactRecord::try_new(
        release.clone(),
        "active-call-compiler-r1",
        "---\nname: sales-r1\n---\n# Main\nHello",
        "d166fc603bcf881b32a0ebfde04994f38f5aa655160834ee69b0dbce5b9052af",
    )
    .unwrap();
    assert_eq!(record.release(), &release);
    assert_eq!(record.compiler_revision(), "active-call-compiler-r1");
    assert!(!format!("{record:?}").contains("Hello"));
    assert!(
        PostgresActiveCallArtifactRecord::try_new(
            release,
            "active-call-compiler-r1",
            "x".repeat(65_537),
            "9".repeat(64),
        )
        .is_err()
    );
}

#[test]
fn source_uses_one_exact_tenant_release_compiler_lookup() {
    for required in [
        "PostgresActiveCallArtifactStore",
        "with_tenant_transaction",
        "agent_release_id = $2",
        "compiler_revision = $3",
        "release.content_hash",
        "release.components",
        "LIMIT 1",
    ] {
        assert!(
            STORE_SOURCE.contains(required),
            "missing Store invariant {required}"
        );
    }
}

fn release() -> AgentReleaseBinding {
    AgentReleaseBinding::try_new(
        AgentReleaseId::parse("release-001").unwrap(),
        "9".repeat(64),
        ReleaseComponentDigests {
            prompt_revision_hash: "1".repeat(64),
            conversation_flow_revision_hash: "2".repeat(64),
            knowledge_revision_hash: "3".repeat(64),
            tool_schema_hash: "4".repeat(64),
            speech_profile_hash: "5".repeat(64),
            compliance_policy_hash: "6".repeat(64),
            outcome_schema_hash: "7".repeat(64),
            evaluation_rubric_hash: "8".repeat(64),
        },
    )
    .unwrap()
}
