use converact_idempotency::{
    EffectReceipt, EffectReceiptAppendDecision, create_effect_audit_link,
    decide_effect_receipt_append, decide_effect_receipt_json_append,
    decide_effect_receipt_value_append, effect_needs_reconcile,
};
use serde_json::Value;

const FIXTURE: &str = include_str!("../../../tests/fixtures/platform-event-receipts-v1.json");

#[test]
fn rust_replays_the_frozen_typescript_effect_contract() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("receipt fixture");
    for vector in fixture["effect_cases"].as_array().expect("effect cases") {
        let history: Vec<_> = vector["history"]
            .as_array()
            .expect("history")
            .iter()
            .map(|stage| {
                EffectReceipt::try_from(&fixture["base_receipts"][stage.as_str().unwrap()])
                    .expect("history receipt")
            })
            .collect();
        let mut candidate = fixture["base_receipts"][vector["candidate"].as_str().unwrap()]
            .as_object()
            .unwrap()
            .clone();
        for (field, value) in vector["overrides"].as_object().unwrap() {
            candidate.insert(field.clone(), expanded(value));
        }
        let candidate = EffectReceipt::try_from(&Value::Object(candidate)).expect("candidate");
        assert_eq!(
            decide_effect_receipt_append(&history, &candidate).as_str(),
            vector["expected"].as_str().unwrap(),
            "{}",
            vector["name"]
        );
    }

    for vector in fixture["invalid_receipt_cases"]
        .as_array()
        .expect("invalid receipt cases")
    {
        let mut candidate = fixture["base_receipts"]["accepted"]
            .as_object()
            .unwrap()
            .clone();
        for (field, value) in vector["overrides"].as_object().unwrap() {
            candidate.insert(field.clone(), expanded(value));
        }
        for field in vector["remove"].as_array().unwrap() {
            candidate.remove(field.as_str().unwrap());
        }
        assert_eq!(
            decide_effect_receipt_value_append(&[], &Value::Object(candidate)).as_str(),
            vector["expected"].as_str().unwrap(),
            "{}",
            vector["name"]
        );
    }
}

#[test]
fn raw_json_boundary_maps_unpaired_surrogate_to_invalid_transition() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("receipt fixture");
    let document = serde_json::to_string(&fixture["base_receipts"]["accepted"])
        .expect("accepted receipt JSON");
    let malformed = document.replacen("effect-worker-a", "\\ud800", 1);
    assert_eq!(
        decide_effect_receipt_json_append(&[], &malformed),
        EffectReceiptAppendDecision::InvalidTransition
    );
}

#[test]
fn reconcile_and_audit_projection_are_explicit() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("receipt fixture");
    let accepted = EffectReceipt::try_from(&fixture["base_receipts"]["accepted"]).unwrap();
    let completed = EffectReceipt::try_from(&fixture["base_receipts"]["completed"]).unwrap();
    let observed = EffectReceipt::try_from(&fixture["base_receipts"]["state_observed"]).unwrap();
    assert!(!effect_needs_reconcile(&[]));
    assert!(effect_needs_reconcile(std::slice::from_ref(&accepted)));
    assert!(effect_needs_reconcile(&[
        accepted.clone(),
        completed.clone()
    ]));
    assert!(!effect_needs_reconcile(&[
        accepted.clone(),
        completed,
        observed
    ]));
    assert_eq!(
        serde_json::to_value(create_effect_audit_link(&accepted)).unwrap(),
        serde_json::json!({
            "tenant_id": "tenant-a",
            "effect_id": "effect-a",
            "event_id": "event-accepted",
            "receipt_id": "receipt-accepted",
            "correlation_id": "correlation-a"
        })
    );
    assert_eq!(
        EffectReceiptAppendDecision::StaleWriter.as_str(),
        "stale_writer"
    );
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
