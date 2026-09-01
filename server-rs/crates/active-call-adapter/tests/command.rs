use converact_active_call_adapter::{AdapterCommand, encode_command};

#[test]
fn disclosure_is_encoded_as_one_bounded_tts_command() {
    let json = encode_command(AdapterCommand::PlayDisclosure {
        text: "您好，我是 AI 助手，本次通话可能会被录音。".to_owned(),
        play_id: "disclosure-001".to_owned(),
    })
    .unwrap();
    assert_eq!(json["command"], "tts");
    assert_eq!(json["playId"], "disclosure-001");
    assert_eq!(json["autoHangup"], false);
}

#[test]
fn disclosure_rejects_empty_or_unbounded_content() {
    assert!(
        encode_command(AdapterCommand::PlayDisclosure {
            text: String::new(),
            play_id: "disclosure-001".to_owned(),
        })
        .is_err()
    );
    assert!(
        encode_command(AdapterCommand::PlayDisclosure {
            text: "x".repeat(4097),
            play_id: "disclosure-001".to_owned(),
        })
        .is_err()
    );
}

#[test]
fn handoff_output_controls_use_the_exact_safe_command_subset() {
    assert_eq!(
        encode_command(AdapterCommand::PauseOutput).unwrap(),
        serde_json::json!({"command": "pause"})
    );
    assert_eq!(
        encode_command(AdapterCommand::ResumeOutput).unwrap(),
        serde_json::json!({"command": "resume"})
    );
    assert_eq!(
        encode_command(AdapterCommand::InterruptOutput {
            fade_out_ms: Some(80),
        })
        .unwrap(),
        serde_json::json!({
            "command": "interrupt",
            "graceful": false,
            "fadeOutMs": 80,
        })
    );
    assert_eq!(
        encode_command(AdapterCommand::InterruptOutput { fade_out_ms: None }).unwrap(),
        serde_json::json!({
            "command": "interrupt",
            "graceful": false,
        })
    );
}

#[test]
fn output_control_rejects_an_unbounded_fade() {
    assert_eq!(
        encode_command(AdapterCommand::InterruptOutput {
            fade_out_ms: Some(2_001),
        })
        .unwrap_err()
        .code(),
        "active_call_playback_timing_invalid"
    );
}

#[test]
fn tool_result_is_encoded_for_the_exact_realtime_call() {
    assert_eq!(
        encode_command(AdapterCommand::ToolResult {
            call_id: "tool-call-001".to_owned(),
            output: serde_json::json!({
                "ok": true,
                "result": {"customer_id": "customer-001", "status": "active"},
            }),
        })
        .unwrap(),
        serde_json::json!({
            "command": "toolResult",
            "callId": "tool-call-001",
            "output": "{\"ok\":true,\"result\":{\"customer_id\":\"customer-001\",\"status\":\"active\"}}",
        })
    );
}

#[test]
fn tool_result_rejects_invalid_call_ids_and_unbounded_outputs() {
    assert!(
        encode_command(AdapterCommand::ToolResult {
            call_id: "bad call id".to_owned(),
            output: serde_json::json!({"ok": true}),
        })
        .is_err()
    );
    assert!(
        encode_command(AdapterCommand::ToolResult {
            call_id: "tool-call-001".to_owned(),
            output: serde_json::json!({"result": "x".repeat(65_537)}),
        })
        .is_err()
    );
}
