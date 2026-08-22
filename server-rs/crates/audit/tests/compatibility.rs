use converact_audit::{
    AuditAppendDecision, AuditAppendInput, AuditContractError, AuditEvent, audit_event_hash,
    decide_audit_append,
};
use serde_json::{Map, Value, json};

const FIXTURE: &str = include_str!("../../../tests/fixtures/audit-record-v1.json");

#[test]
fn rust_replays_the_frozen_typescript_audit_hash_contract() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("audit fixture");
    let base = fixture["base_append"].as_object().expect("base append");
    for vector in fixture["hash_cases"].as_array().expect("hash cases") {
        let input = AuditAppendInput::try_from(&Value::Object(merged(
            base,
            vector["overrides"].as_object().expect("overrides"),
        )))
        .expect("valid append input");
        assert_eq!(
            audit_event_hash(&input, vector["previous_hash"].as_str().unwrap()).unwrap(),
            vector["expected_hash"].as_str().unwrap(),
            "{}",
            vector["name"]
        );
    }
}

#[test]
fn append_input_is_bounded_and_rejects_sensitive_metadata() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("audit fixture");
    let base = fixture["base_append"].as_object().expect("base append");

    for (name, input) in [
        ("missing actor", removed(base, "actor_id")),
        (
            "unknown role",
            changed(base, "actor_role", json!("superuser")),
        ),
        (
            "oversized tenant",
            changed(base, "tenant_id", json!("x".repeat(256))),
        ),
        (
            "noncanonical timestamp",
            changed(base, "occurred_at", json!("2026-07-15T08:00:00Z")),
        ),
        (
            "invalid source HMAC",
            changed(base, "source_ip_hmac", json!("b".repeat(63))),
        ),
        (
            "secret metadata key",
            changed(base, "metadata", json!({"access_token": "redacted"})),
        ),
        (
            "email metadata value",
            changed(base, "metadata", json!({"subject": "user@example.com"})),
        ),
        (
            "phone metadata value",
            changed(base, "metadata", json!({"subject": "+8613800001234"})),
        ),
        (
            "phone metadata value with ECMAScript whitespace",
            changed(
                base,
                "metadata",
                json!({"subject": "+12\u{00a0}345\u{00a0}6789"}),
            ),
        ),
        (
            "oversized metadata value",
            changed(base, "metadata", json!({"subject": "x".repeat(2_049)})),
        ),
        (
            "nested metadata array",
            changed(base, "metadata", json!({"values": [[1]]})),
        ),
    ] {
        assert_eq!(
            AuditAppendInput::try_from(&Value::Object(input)),
            Err(AuditContractError::InvalidRecord),
            "{name}"
        );
    }

    let mut too_many = Vec::new();
    too_many.resize(101, Value::Null);
    assert_eq!(
        AuditAppendInput::try_from(&Value::Object(changed(
            base,
            "metadata",
            json!({"values": too_many}),
        ))),
        Err(AuditContractError::InvalidRecord)
    );
}

#[test]
fn normalized_text_uses_the_ecmascript_trim_boundary() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("audit fixture");
    let base = fixture["base_append"].as_object().expect("base append");

    // ECMAScript String.prototype.trim does not trim U+0085 (NEXT LINE), so
    // the active TypeScript service accepts this already-normalized value.
    let actor_id = "\u{0085}actor\u{0085}";
    let input =
        AuditAppendInput::try_from(&Value::Object(changed(base, "actor_id", json!(actor_id))))
            .expect("Rust must preserve the TypeScript trim contract");

    assert_eq!(input.actor_id(), actor_id);
}

#[test]
fn replay_uses_the_original_occurred_at_and_rejects_changed_payloads() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("audit fixture");
    let base = fixture["base_append"].as_object().expect("base append");
    let input = AuditAppendInput::try_from(&Value::Object(base.clone())).unwrap();
    assert_eq!(
        decide_audit_append(None, &input),
        AuditAppendDecision::Append
    );

    let hash = audit_event_hash(&input, &"0".repeat(64)).unwrap();
    let event = AuditEvent::try_from(&json!({
        "id": "audit-a",
        "tenant_id": input.tenant_id(),
        "actor_id": input.actor_id(),
        "actor_role": input.actor_role().as_str(),
        "action": input.action(),
        "resource_type": input.resource_type(),
        "resource_id": input.resource_id(),
        "business_ref_type": input.business_ref_type(),
        "business_ref_id": input.business_ref_id(),
        "request_id": input.request_id(),
        "idempotency_key": input.idempotency_key(),
        "result": input.result().as_str(),
        "policy_decision": input.policy_decision().as_str(),
        "source_ip_hmac": input.source_ip_hmac(),
        "metadata": input.metadata(),
        "occurred_at": input.occurred_at(),
        "retention_until": input.retention_until(),
        "legal_hold": input.legal_hold(),
        "previous_hash": "0".repeat(64),
        "event_hash": hash,
        "created_at": "2026-07-15T08:00:00.000Z"
    }))
    .unwrap();

    let changed_clock = AuditAppendInput::try_from(&Value::Object(changed(
        base,
        "occurred_at",
        json!("2026-07-15T09:00:00.000Z"),
    )))
    .unwrap();
    assert_eq!(
        decide_audit_append(Some(&event), &changed_clock),
        AuditAppendDecision::Replay
    );

    let changed_action = AuditAppendInput::try_from(&Value::Object(changed(
        base,
        "action",
        json!("notification.endpoint.delete"),
    )))
    .unwrap();
    assert_eq!(
        decide_audit_append(Some(&event), &changed_action),
        AuditAppendDecision::Conflict
    );
}

#[test]
fn hash_and_record_debug_surfaces_do_not_expose_raw_source_ip() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("audit fixture");
    let input = AuditAppendInput::try_from(&fixture["base_append"]).unwrap();
    let debug = format!("{input:?}");
    assert!(!debug.contains("203.0.113.10"));
    assert!(
        !serde_json::to_string(&input)
            .unwrap()
            .contains("source_ip\"")
    );
    assert_eq!(
        audit_event_hash(&input, "invalid"),
        Err(AuditContractError::InvalidPreviousHash)
    );
}

fn merged(base: &Map<String, Value>, overrides: &Map<String, Value>) -> Map<String, Value> {
    let mut value = base.clone();
    value.extend(overrides.clone());
    value
}

fn changed(base: &Map<String, Value>, field: &str, value: Value) -> Map<String, Value> {
    let mut input = base.clone();
    input.insert(field.to_owned(), value);
    input
}

fn removed(base: &Map<String, Value>, field: &str) -> Map<String, Value> {
    let mut input = base.clone();
    input.remove(field);
    input
}
