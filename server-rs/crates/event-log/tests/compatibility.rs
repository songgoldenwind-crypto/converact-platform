use converact_event_log::{
    EventReadPolicy, InboxWriteDecision, PlatformInboxState, decide_inbox_write,
    decode_platform_event,
};
use serde_json::{Map, Value};

const FIXTURE: &str = include_str!("../../../tests/fixtures/platform-event-receipts-v1.json");

#[test]
fn rust_replays_the_frozen_typescript_envelope_and_inbox_contract() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("event fixture");
    let policy = EventReadPolicy::v2();
    for vector in fixture["event_cases"].as_array().expect("event cases") {
        let input = merged(
            &fixture["base_event"],
            &vector["overrides"],
            vector["remove"].as_array(),
        );
        let actual = decode_platform_event(&Value::Object(input), policy);
        if vector["expected"]["quarantine"] == true {
            let error = actual.expect_err("quarantined event");
            assert_eq!(
                error.reason(),
                vector["expected"]["reason"],
                "{}",
                vector["name"]
            );
        } else {
            let event = actual.expect("accepted event");
            assert_eq!(event.schema_version(), 2);
            assert_eq!(
                event.source_schema_version(),
                u8::try_from(
                    vector["expected"]["source_schema_version"]
                        .as_u64()
                        .unwrap(),
                )
                .unwrap(),
                "{}",
                vector["name"]
            );
            assert_eq!(
                event.extensions(),
                vector["expected"]["extensions"].as_object().unwrap(),
                "{}",
                vector["name"]
            );
            if let Some(expected) = vector["expected"]["correlation"].as_object() {
                assert_eq!(event.correlation(), expected, "{}", vector["name"]);
            }
        }
    }

    for vector in fixture["inbox_cases"].as_array().expect("inbox cases") {
        let input = merged(&fixture["base_event"], &vector["incoming_overrides"], None);
        let event = decode_platform_event(&Value::Object(input), policy).expect("incoming event");
        let existing = if vector["existing"].is_null() {
            None
        } else {
            Some(PlatformInboxState::try_from(&vector["existing"]).expect("inbox state"))
        };
        assert_eq!(
            decide_inbox_write(existing.as_ref(), &event).as_str(),
            vector["expected"].as_str().unwrap(),
            "{}",
            vector["name"]
        );
    }
}

#[test]
fn raw_json_boundary_rejects_unpaired_surrogates() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("event fixture");
    let document = serde_json::to_string(&fixture["base_event"]).expect("base event JSON");
    let malformed = document.replacen("event-a", "\\ud800", 1);
    assert!(
        converact_event_log::decode_platform_event_json(&malformed, EventReadPolicy::v2()).is_err()
    );
}

#[test]
fn payload_bounds_and_decisions_are_closed() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("event fixture");
    let policy = EventReadPolicy::v2();
    for (size, accepted) in [(0, true), (65_536, true), (65_537, false)] {
        let data = Value::String("x".repeat(size));
        let mut input = fixture["base_event"].as_object().unwrap().clone();
        input.insert("data".into(), data.clone());
        input.insert(
            "payload_digest".into(),
            Value::String(
                converact_contracts::canonical_sha256_with_max_bytes(&data, 65_536 * 6 + 2)
                    .unwrap(),
            ),
        );
        assert_eq!(
            decode_platform_event(&Value::Object(input), policy).is_ok(),
            accepted,
            "payload bytes {size}"
        );
    }
    assert_eq!(
        InboxWriteDecision::GapRequiresReconcile.as_str(),
        "gap_requires_reconcile"
    );
}

fn merged(base: &Value, overrides: &Value, remove: Option<&Vec<Value>>) -> Map<String, Value> {
    let mut value = base.as_object().expect("base object").clone();
    for (field, item) in overrides.as_object().expect("overrides") {
        value.insert(field.clone(), expanded(item));
    }
    for field in remove.into_iter().flatten() {
        value.remove(field.as_str().expect("removed field"));
    }
    value
}

fn expanded(value: &Value) -> Value {
    let Some(marker) = value.as_object() else {
        return value.clone();
    };
    if marker.len() != 2 {
        return value.clone();
    }
    let (Some(text), Some(count)) = (
        marker.get("$repeat").and_then(Value::as_str),
        marker.get("count").and_then(Value::as_u64),
    ) else {
        return value.clone();
    };
    Value::String(text.repeat(usize::try_from(count).expect("bounded fixture repeat")))
}
