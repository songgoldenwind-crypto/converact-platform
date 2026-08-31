mod support;

use converact_active_call_adapter::{
    ActiveCallClient, ActiveCallEventKind, ActiveCallSessionState, ClientConfig, ClientFailureKind,
    InlinePlaybook,
};
use converact_voice_agent_contracts::ChannelAgentSessionId;
use std::time::Duration;
use support::{CommandFixture, FakeActiveCall};

#[tokio::test]
async fn client_rejects_non_loopback_plaintext_endpoint() {
    let error =
        ActiveCallClient::connect(ClientConfig::new("http://10.0.0.8:8080", 2_000, 1_024).unwrap())
            .unwrap_err();

    assert_eq!(error.code(), "active_call_plaintext_not_loopback");
}

#[tokio::test]
async fn command_timeout_returns_unknown_not_failed() {
    let fake = FakeActiveCall::timeout_commands().await;
    let client = ActiveCallClient::connect(fake.config()).unwrap();

    assert_eq!(
        client
            .send_command(CommandFixture::disclosure())
            .await
            .unwrap_err()
            .kind(),
        ClientFailureKind::OutcomeUnknown,
    );
    assert_eq!(fake.command_count(), 1);
}

#[tokio::test]
async fn stalled_command_response_body_is_also_outcome_unknown() {
    let fake = FakeActiveCall::stall_command_body().await;
    let client = ActiveCallClient::connect(fake.config()).unwrap();

    let result = tokio::time::timeout(
        Duration::from_millis(200),
        client.send_command(CommandFixture::disclosure()),
    )
    .await
    .expect("client deadline must include the response body");

    assert_eq!(
        result.unwrap_err().kind(),
        ClientFailureKind::OutcomeUnknown
    );
}

#[tokio::test]
async fn status_retries_and_event_frames_remain_typed_and_bounded() {
    let fake = FakeActiveCall::status_retry_with_event().await;
    let client = ActiveCallClient::connect(fake.config()).unwrap();
    let session_id = ChannelAgentSessionId::parse("agent-session-001").unwrap();

    assert_eq!(
        client.query_session(&session_id).await.unwrap(),
        ActiveCallSessionState::Active
    );
    assert_eq!(fake.status_count(), 2);

    let mut events = client.events(&session_id).await.unwrap();
    let event = events.next_event().await.unwrap().unwrap();
    assert_eq!(event.kind, ActiveCallEventKind::Event);
    assert_eq!(event.data.as_ref(), r#"{"event":"mediaReady"}"#);
}

#[tokio::test]
async fn playbook_reservation_uses_only_inline_content_and_returns_typed_session() {
    let fake = FakeActiveCall::accept_playbook_reservations().await;
    let client = ActiveCallClient::connect(fake.config()).unwrap();
    let playbook = InlinePlaybook::try_new("---\nname: sales-r1\n---\n# Main\nHello").unwrap();

    let reservation = client.reserve_playbook(playbook).await.unwrap();

    assert_eq!(
        reservation.session_id.as_str(),
        "s.00000000-0000-4000-8000-000000000001"
    );
    assert_eq!(fake.playbook_reservation_count(), 1);
    let request = fake.last_playbook_reservation().unwrap();
    assert_eq!(
        request["content"],
        "---\nname: sales-r1\n---\n# Main\nHello"
    );
    assert!(request.get("to").is_none());
    assert!(request.get("type").is_none());
}

#[test]
fn inline_playbook_rejects_non_playbook_or_unbounded_content() {
    assert!(InlinePlaybook::try_new("plain prompt").is_err());
    assert!(InlinePlaybook::try_new(format!("---\n{}", "x".repeat(65_537))).is_err());
    assert!(InlinePlaybook::try_new("---\nname: bad\0value").is_err());
}

#[tokio::test]
async fn playbook_reservation_timeout_is_outcome_unknown() {
    let fake = FakeActiveCall::timeout_playbook_reservations().await;
    let client = ActiveCallClient::connect(fake.config()).unwrap();
    let playbook = InlinePlaybook::try_new("---\nname: sales-r1\n---\n# Main\nHello").unwrap();

    assert_eq!(
        client.reserve_playbook(playbook).await.unwrap_err().kind(),
        ClientFailureKind::OutcomeUnknown,
    );
    assert_eq!(fake.playbook_reservation_count(), 1);
}
