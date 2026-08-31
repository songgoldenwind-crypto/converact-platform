mod support;

use converact_active_call_adapter::{NormalizedEvent, normalize_event};
use support::adapter_context;

#[test]
fn exact_upstream_media_and_hangup_fixtures_are_accepted() {
    assert!(matches!(
        normalize_event(
            &adapter_context(3),
            include_str!("fixtures/media-ready.json")
        )
        .unwrap(),
        NormalizedEvent::MediaReady { .. }
    ));
    assert!(matches!(
        normalize_event(&adapter_context(3), include_str!("fixtures/hangup.json")).unwrap(),
        NormalizedEvent::ConversationCompleted { .. }
    ));
}

#[test]
fn final_asr_is_durable_but_delta_is_ephemeral() {
    let event =
        normalize_event(&adapter_context(3), include_str!("fixtures/asr-final.json")).unwrap();
    assert!(matches!(
        event,
        NormalizedEvent::TranscriptFinal { index: 1, .. }
    ));
    assert!(event.is_durable());
    assert_eq!(event.execution_generation().get(), 3);

    let delta = normalize_event(
        &adapter_context(3),
        r#"{"event":"asrDelta","trackId":"track-001","timestamp":1110,"index":1,"text":"你"}"#,
    )
    .unwrap();
    assert!(matches!(delta, NormalizedEvent::TranscriptDelta { .. }));
    assert!(!delta.is_durable());
}

#[test]
fn function_call_becomes_a_proposal_not_an_executed_effect() {
    let event = normalize_event(
        &adapter_context(3),
        include_str!("fixtures/function-call.json"),
    )
    .unwrap();
    assert!(matches!(event, NormalizedEvent::ToolProposed { .. }));
}

#[test]
fn unknown_upstream_event_fails_closed() {
    let result = normalize_event(
        &adapter_context(3),
        r#"{"event":"newDangerousEvent","timestamp":1}"#,
    );
    assert_eq!(result.unwrap_err().code(), "active_call_event_unknown");
}

#[test]
fn tool_arguments_and_identifiers_are_bounded() {
    let malformed = r#"{"event":"functionCall","trackId":"bad track","callId":"tool-call-001","name":"lookup_customer","arguments":"{}","timestamp":1200}"#;
    assert_eq!(
        normalize_event(&adapter_context(3), malformed)
            .unwrap_err()
            .code(),
        "active_call_identifier_invalid",
    );
}
