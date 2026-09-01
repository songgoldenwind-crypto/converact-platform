use std::{net::SocketAddr, path::Path, time::Duration};

use converact_voice_agent_worker::{
    ActiveCallSessionSupervisorConfig, VoiceAgentRuntimeConfig, VoiceAgentRuntimeConfigError,
};

#[test]
fn strict_document_builds_only_bounded_non_secret_runtime_values() {
    let config = VoiceAgentRuntimeConfig::from_json(&valid_document()).unwrap();

    assert_eq!(config.tenant_id().as_str(), "tenant-a");
    assert_eq!(config.instance_id(), "voice-worker-a-001");
    assert_eq!(
        config.bind_address(),
        "127.0.0.1:18081".parse::<SocketAddr>().unwrap()
    );
    assert_eq!(config.worker_config().worker_count(), 8);
    assert_eq!(config.worker_config().claim_size(), 16);
    assert_eq!(
        config.claim_loop_config().poll_interval(),
        Duration::from_millis(250)
    );
    assert_eq!(config.shutdown_timeout(), Duration::from_secs(10));
    assert_eq!(
        config.active_call().session_supervisor_config(),
        ActiveCallSessionSupervisorConfig::new(
            Duration::from_secs(10),
            Duration::from_millis(250),
        )
        .unwrap()
    );
    assert_eq!(
        config.database_url_environment(),
        "CONVERACT_TEST_DATABASE_URL"
    );
    assert_eq!(
        config.platform_auth().jwks_path(),
        Path::new("/run/converact/platform.jwks.json")
    );
    assert_eq!(
        config.platform_auth().expected_issuer(),
        "converact-platform"
    );
    assert_eq!(
        config.platform_auth().expected_audience(),
        "voice-agent-worker"
    );
}

#[test]
fn document_rejects_unknown_fields_inline_secrets_and_public_plaintext_bind() {
    let with_unknown = valid_document().replace(
        "\"schema_version\":1,",
        "\"schema_version\":1,\"token\":\"must-not-be-inline\",",
    );
    assert_eq!(
        VoiceAgentRuntimeConfig::from_json(&with_unknown).unwrap_err(),
        VoiceAgentRuntimeConfigError::InvalidDocument
    );

    let public_bind = valid_document().replace("127.0.0.1:18081", "0.0.0.0:18081");
    assert_eq!(
        VoiceAgentRuntimeConfig::from_json(&public_bind).unwrap_err(),
        VoiceAgentRuntimeConfigError::InvalidBindAddress
    );

    let inline_database = valid_document().replace(
        "\"url_environment\":\"CONVERACT_TEST_DATABASE_URL\"",
        "\"url_environment\":\"postgres://user:password@db/runtime\"",
    );
    assert_eq!(
        VoiceAgentRuntimeConfig::from_json(&inline_database).unwrap_err(),
        VoiceAgentRuntimeConfigError::InvalidDatabase
    );

    let unsupported_secret_source = valid_document().replace(
        "file:///run/converact/rustpbx-rwi-token",
        "env://CONVERACT_RUSTPBX_RWI_TOKEN",
    );
    assert_eq!(
        VoiceAgentRuntimeConfig::from_json(&unsupported_secret_source).unwrap_err(),
        VoiceAgentRuntimeConfigError::InvalidRustPbx
    );
}

fn valid_document() -> String {
    serde_json::json!({
        "schema_version": 1,
        "tenant_id": "tenant-a",
        "instance_id": "voice-worker-a-001",
        "bind_address": "127.0.0.1:18081",
        "shutdown_timeout_ms": 10_000,
        "worker": {
            "worker_count": 8,
            "claim_size": 16,
            "claim_poll_interval_ms": 250,
            "attempt_lease_duration_ms": 30_000
        },
        "database": {
            "url_environment": "CONVERACT_TEST_DATABASE_URL",
            "transport": "local_no_tls",
            "max_connections": 16,
            "max_waiters": 32,
            "pool_wait_timeout_ms": 1_000,
            "connect_timeout_ms": 1_000,
            "recycle_timeout_ms": 1_000,
            "statement_timeout_ms": 2_000,
            "lock_timeout_ms": 1_000,
            "transaction_timeout_ms": 4_000,
            "rollback_timeout_ms": 1_000
        },
        "post_call": {
            "lease_duration_ms": 30_000,
            "max_claim_batch": 16
        },
        "platform_auth": {
            "jwks_path": "/run/converact/platform.jwks.json",
            "expected_issuer": "converact-platform",
            "expected_audience": "voice-agent-worker",
            "policy_version": 1,
            "revocation_epoch": 0
        },
        "active_call": {
            "endpoint": "http://127.0.0.1:8090/",
            "timeout_ms": 2_000,
            "max_response_bytes": 262_144,
            "compiler_revision": "active-call-compiler-r1",
            "disclosure": "您好，本次由AI助理为您服务。",
            "max_sessions": 10_000,
            "lease_renew_interval_ms": 10_000,
            "event_reconnect_delay_ms": 250
        },
        "rustpbx": {
            "endpoint": "ws://127.0.0.1:8080/rwi/v1",
            "token_ref": "file:///run/converact/rustpbx-rwi-token",
            "internal_service": false,
            "command_timeout_ms": 10_000,
            "agent_target": "sip:active-call@127.0.0.1:5060",
            "poll_interval_ms": 20,
            "max_answer_wait_ms": 60_000
        }
    })
    .to_string()
}
