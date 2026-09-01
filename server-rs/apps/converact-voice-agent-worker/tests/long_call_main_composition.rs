const MAIN: &str = include_str!("../src/main.rs");

#[test]
fn executable_composes_durable_long_call_runtime_before_claiming_active_attempts() {
    for required in [
        "PostgresActiveCallEventStore::new",
        "PostgresConversationResultStore::new",
        "ActiveCallTranscriptIngestProcessor::new",
        "PostgresReleaseToolStore::new",
        "ReleaseToolAuthority::new",
        "PostgresAgentToolSchema::new",
        "PostgresToolActionStore::new",
        "PostgresAgentToolProvider::new",
        "ToolBroker::new",
        "ToolRuntime::new",
        "ActiveCallToolEventProcessor::new",
        "ActiveCallToolResultPort::new",
        "ActiveCallEventProjectionRouter::new",
        "ActiveCallSessionRuntime::new",
        "VoiceAgentLongCallClaimExecutor::new",
        "session_supervisor_config",
    ] {
        assert!(
            MAIN.contains(required),
            "missing main composition {required}"
        );
    }
    assert!(!MAIN.contains("VoiceAgentClaimExecutor::new"));
    assert!(!MAIN.contains("RejectUnconfiguredActiveCallTools"));
}
