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
