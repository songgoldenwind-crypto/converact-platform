use std::future::{Future, ready};

use converact_ai_outbound_core::{AgentReleaseBinding, ReleaseComponentDigests};
use converact_voice_agent_contracts::AgentReleaseId;
use converact_voice_agent_worker::{
    ActiveCallArtifactSource, ActiveCallArtifactSourcePort, ActiveCallPlaybookResolver,
    ActiveCallPlaybookResolverError, AuthenticatedTenant,
};

const PLAYBOOK: &str = "---\nname: sales-r1\n---\n# Main\nHello";
const ARTIFACT_HASH: &str = "d166fc603bcf881b32a0ebfde04994f38f5aa655160834ee69b0dbce5b9052af";
const COMPILER_REVISION: &str = "converact-active-call-playbook-v1";

#[tokio::test]
async fn resolver_binds_tenant_release_compiler_and_artifact() {
    let release = release("release-001", '9');
    let source = FakeSource(Some(ActiveCallArtifactSource::new(
        release.clone(),
        COMPILER_REVISION,
        PLAYBOOK,
        ARTIFACT_HASH,
    )));
    let resolver = ActiveCallPlaybookResolver::new(source, COMPILER_REVISION).unwrap();
    let tenant = AuthenticatedTenant::try_from_verified_tenant_id("tenant-a").unwrap();

    let artifact = resolver.resolve(&tenant, &release).await.unwrap();

    assert_eq!(artifact.release(), &release);
    assert_eq!(artifact.artifact_hash(), ARTIFACT_HASH);
}

#[tokio::test]
async fn missing_or_drifting_provenance_fails_closed() {
    let requested = release("release-001", '9');
    let tenant = AuthenticatedTenant::try_from_verified_tenant_id("tenant-a").unwrap();

    let missing = ActiveCallPlaybookResolver::new(FakeSource(None), COMPILER_REVISION).unwrap();
    assert_eq!(
        missing.resolve(&tenant, &requested).await.unwrap_err(),
        ActiveCallPlaybookResolverError::NotFound,
    );

    let wrong_release = source(
        release("release-002", '8'),
        COMPILER_REVISION,
        ARTIFACT_HASH,
    );
    assert_eq!(
        resolver(wrong_release)
            .resolve(&tenant, &requested)
            .await
            .unwrap_err(),
        ActiveCallPlaybookResolverError::SourceDrift,
    );

    let wrong_compiler = source(requested.clone(), "other-compiler-v1", ARTIFACT_HASH);
    assert_eq!(
        resolver(wrong_compiler)
            .resolve(&tenant, &requested)
            .await
            .unwrap_err(),
        ActiveCallPlaybookResolverError::CompilerDrift,
    );

    let wrong_content = source(requested.clone(), COMPILER_REVISION, &"8".repeat(64));
    assert_eq!(
        resolver(wrong_content)
            .resolve(&tenant, &requested)
            .await
            .unwrap_err(),
        ActiveCallPlaybookResolverError::ArtifactInvalid,
    );
}

#[derive(Clone)]
struct FakeSource(Option<ActiveCallArtifactSource>);

impl ActiveCallArtifactSourcePort for FakeSource {
    fn load(
        &self,
        _tenant: &AuthenticatedTenant,
        _release: &AgentReleaseBinding,
    ) -> impl Future<
        Output = Result<Option<ActiveCallArtifactSource>, ActiveCallPlaybookResolverError>,
    > + Send {
        ready(Ok(self.0.clone()))
    }
}

fn resolver(source: FakeSource) -> ActiveCallPlaybookResolver<FakeSource> {
    ActiveCallPlaybookResolver::new(source, COMPILER_REVISION).unwrap()
}

fn source(
    release: AgentReleaseBinding,
    compiler_revision: &str,
    artifact_hash: &str,
) -> FakeSource {
    FakeSource(Some(ActiveCallArtifactSource::new(
        release,
        compiler_revision,
        PLAYBOOK,
        artifact_hash,
    )))
}

fn release(id: &str, digest_character: char) -> AgentReleaseBinding {
    AgentReleaseBinding::try_new(
        AgentReleaseId::parse(id).unwrap(),
        digest_character.to_string().repeat(64),
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
