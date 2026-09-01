use converact_postgres_store::PostgresActiveCallArtifactStore;
use converact_voice_agent_worker::ActiveCallArtifactSourcePort;

#[test]
fn postgres_store_is_the_concrete_active_call_artifact_source() {
    fn assert_source<T: ActiveCallArtifactSourcePort>() {}

    assert_source::<PostgresActiveCallArtifactStore>();
}
