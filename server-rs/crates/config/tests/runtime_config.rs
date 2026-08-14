use converact_config::RuntimeConfig;

const VALID: &str = r#"{
  "bind_address": "127.0.0.1:0",
  "tenant_id": "tenant-a",
  "cell_id": "cell-cn-north-1",
  "source_commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "shutdown_timeout_ms": 5000,
  "service_token": "do-not-log-this-token"
}"#;

#[test]
fn configuration_rejects_unknown_fields() {
    let with_unknown = VALID.replace(
        r#""service_token": "do-not-log-this-token""#,
        r#""service_token": "do-not-log-this-token", "surprise": true"#,
    );

    assert!(RuntimeConfig::from_json(&with_unknown).is_err());
}

#[test]
fn configuration_debug_output_never_exposes_secret_values() {
    let config = RuntimeConfig::from_json(VALID).expect("valid runtime config");
    let debug = format!("{config:?}");

    assert!(!debug.contains("do-not-log-this-token"));
    assert!(debug.contains("[REDACTED]"));
    assert_eq!(config.tenant_id().as_str(), "tenant-a");
    assert_eq!(config.cell_id().as_str(), "cell-cn-north-1");
    assert_eq!(config.source_commit(), "a".repeat(40));
}

#[test]
fn configuration_requires_an_exact_lowercase_source_commit() {
    for source_commit in [
        "main".to_owned(),
        "A".repeat(40),
        "a".repeat(39),
        format!("{}g", "a".repeat(39)),
    ] {
        let invalid = VALID.replace(&"a".repeat(40), &source_commit);
        assert!(
            RuntimeConfig::from_json(&invalid).is_err(),
            "accepted {source_commit}"
        );
    }
}

#[test]
fn configuration_rejects_unbounded_shutdown_deadlines() {
    for timeout in [0, 60_001] {
        let invalid = VALID.replace("5000", &timeout.to_string());
        assert!(
            RuntimeConfig::from_json(&invalid).is_err(),
            "accepted {timeout}"
        );
    }
}
