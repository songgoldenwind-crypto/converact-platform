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

#[test]
fn exact_realtime_control_fixtures_preserve_active_call_capabilities() {
    let context = adapter_context(7);

    let speaking = normalize_event(&context, include_str!("fixtures/speaking.json")).unwrap();
    assert!(matches!(
        speaking,
        NormalizedEvent::SpeechStarted {
            start_time_ms: 1_640_995_199_500,
            is_filler: false,
            confidence: Some(confidence),
            ..
        } if (confidence - 0.95).abs() < 0.000_1
    ));
    assert!(!speaking.is_durable());
    assert_eq!(speaking.execution_generation().get(), 7);

    let eou = normalize_event(&context, include_str!("fixtures/eou.json")).unwrap();
    assert!(matches!(
        eou,
        NormalizedEvent::UtteranceEnded {
            completed: true,
            ..
        }
    ));
    assert!(!eou.is_durable());
    let debug = format!("{eou:?}");
    assert!(!debug.contains("private subtitle position"));
    assert!(!debug.contains("private utterance"));

    let interruption =
        normalize_event(&context, include_str!("fixtures/interruption.json")).unwrap();
    assert!(matches!(
        interruption,
        NormalizedEvent::PlaybackInterrupted {
            total_duration_ms: 30_000,
            elapsed_ms: 15_000,
            ..
        }
    ));
    assert!(interruption.is_durable());
    let debug = format!("{interruption:?}");
    assert!(!debug.contains("private prompt text"));
    assert!(!debug.contains("media.example.invalid"));
    assert!(!debug.contains("secret"));

    let dtmf = normalize_event(&context, include_str!("fixtures/dtmf.json")).unwrap();
    let NormalizedEvent::DtmfInput { digit, .. } = &dtmf else {
        panic!("expected DTMF input");
    };
    assert_eq!(digit.as_char(), '1');
    assert_eq!(format!("{digit:?}"), "DtmfDigit([REDACTED])");
    assert!(!dtmf.is_durable());

    let hold = normalize_event(&context, include_str!("fixtures/hold.json")).unwrap();
    assert!(matches!(
        hold,
        NormalizedEvent::HoldChanged { on_hold: true, .. }
    ));
    assert!(hold.is_durable());

    let inactivity = normalize_event(&context, include_str!("fixtures/inactivity.json")).unwrap();
    assert!(matches!(
        inactivity,
        NormalizedEvent::InactivityDetected { .. }
    ));
    assert!(inactivity.is_durable());
}

#[test]
fn realtime_control_values_fail_closed() {
    for invalid_digit in ["", "12", "a", "X"] {
        let wire = format!(
            r#"{{"event":"dtmf","trackId":"track-001","timestamp":1,"digit":"{invalid_digit}"}}"#
        );
        assert_eq!(
            normalize_event(&adapter_context(3), &wire)
                .unwrap_err()
                .code(),
            "active_call_dtmf_invalid"
        );
    }

    let impossible_timing = r#"{"event":"interruption","trackId":"track-001","timestamp":1,"totalDuration":100,"current":101}"#;
    assert_eq!(
        normalize_event(&adapter_context(3), impossible_timing)
            .unwrap_err()
            .code(),
        "active_call_playback_timing_invalid"
    );

    let zero_duration = r#"{"event":"interruption","trackId":"track-001","timestamp":1,"totalDuration":0,"current":0}"#;
    assert_eq!(
        normalize_event(&adapter_context(3), zero_duration)
            .unwrap_err()
            .code(),
        "active_call_playback_timing_invalid"
    );

    let invalid_confidence = r#"{"event":"speaking","trackId":"track-001","timestamp":2,"startTime":1,"confidence":1.1}"#;
    assert_eq!(
        normalize_event(&adapter_context(3), invalid_confidence)
            .unwrap_err()
            .code(),
        "active_call_confidence_invalid"
    );

    let reversed_timing =
        r#"{"event":"speaking","trackId":"track-001","timestamp":1,"startTime":2}"#;
    assert_eq!(
        normalize_event(&adapter_context(3), reversed_timing)
            .unwrap_err()
            .code(),
        "active_call_timestamp_invalid"
    );
}
