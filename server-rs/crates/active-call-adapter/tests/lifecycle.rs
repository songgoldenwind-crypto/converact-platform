use converact_active_call_adapter::{ActiveCallLifecycleEvent, decode_lifecycle_event};

#[test]
fn lifecycle_projection_accepts_media_disclosure_completion_and_terminal() {
    assert_eq!(
        decode_lifecycle_event(br#"{"event":"mediaReady","trackId":"track-001","timestamp":1}"#,)
            .unwrap(),
        Some(ActiveCallLifecycleEvent::MediaReady),
    );
    assert_eq!(
        decode_lifecycle_event(
            br#"{"event":"trackEnd","trackId":"track-001","timestamp":2,"duration":640,"ssrc":7,"playId":"agent-session-001"}"#,
        )
        .unwrap(),
        Some(ActiveCallLifecycleEvent::PlaybackCompleted {
            play_id: "agent-session-001".into(),
        }),
    );
    assert_eq!(
        decode_lifecycle_event(
            br#"{"event":"hangup","trackId":"track-001","timestamp":3,"startTime":"2026-09-01T00:00:00Z","hangupTime":"2026-09-01T00:01:00Z"}"#,
        )
        .unwrap(),
        Some(ActiveCallLifecycleEvent::Terminal),
    );
}

#[test]
fn lifecycle_projection_ignores_unrelated_events_but_rejects_invalid_control_events() {
    assert_eq!(
        decode_lifecycle_event(
            br#"{"event":"asrFinal","trackId":"track-001","timestamp":2,"index":1,"text":"hello"}"#,
        )
        .unwrap(),
        None,
    );
    assert!(
        decode_lifecycle_event(
            br#"{"event":"trackEnd","trackId":"track-001","timestamp":2,"duration":640,"ssrc":7,"playId":"bad/play"}"#,
        )
        .is_err(),
    );
    assert!(
        decode_lifecycle_event(
            br#"{"event":"trackEnd","trackId":"track-001","timestamp":2,"duration":0,"ssrc":7,"playId":"agent-session-001"}"#,
        )
        .is_err(),
    );
    assert!(decode_lifecycle_event(&vec![b'x'; 131_073]).is_err());
}
