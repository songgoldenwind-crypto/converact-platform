mod support;

use converact_active_call_adapter::{
    ActiveCallClient, ActiveCallEventCursor, ActiveCallEventKind, ActiveCallSessionState,
    ClientConfig, ClientFailureKind, InlinePlaybook, PlaybookReservationState,
};
use converact_voice_agent_contracts::ChannelAgentSessionId;
use std::time::Duration;
use support::{CommandFixture, FakeActiveCall};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
    task::JoinHandle,
};

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
    assert_eq!(event.cursor(), None);
    assert_eq!(event.data.as_ref(), r#"{"event":"mediaReady"}"#);
}

#[tokio::test]
async fn resumed_events_send_last_event_id_and_reject_a_cursor_gap() {
    let body = concat!(
        "id: 8\nevent: event\ndata: {\"event\":\"mediaReady\"}\n\n",
        "id: 10\nevent: event\ndata: {\"event\":\"mediaReady\"}\n\n",
    );
    let mut server = RawEventServer::start(body).await;
    let client = ActiveCallClient::connect(server.config()).unwrap();
    let session_id = ChannelAgentSessionId::parse("agent-session-001").unwrap();

    let mut events = client
        .events_after(&session_id, ActiveCallEventCursor::new(7))
        .await
        .unwrap();
    let first = events.next_event().await.unwrap().unwrap();
    assert_eq!(first.cursor(), Some(ActiveCallEventCursor::new(8)));

    let error = events.next_event().await.unwrap_err();
    assert_eq!(error.kind(), ClientFailureKind::CoverageGap);
    assert_eq!(error.code(), "active_call_events_cursor_non_contiguous");
    assert!(
        server
            .request()
            .await
            .to_ascii_lowercase()
            .contains("last-event-id: 7")
    );
}

#[tokio::test]
async fn resumed_events_require_an_event_cursor() {
    let server = RawEventServer::start("event: event\ndata: {\"event\":\"mediaReady\"}\n\n").await;
    let client = ActiveCallClient::connect(server.config()).unwrap();
    let session_id = ChannelAgentSessionId::parse("agent-session-001").unwrap();

    let mut events = client
        .events_after(&session_id, ActiveCallEventCursor::START)
        .await
        .unwrap();

    let error = events.next_event().await.unwrap_err();
    assert_eq!(error.kind(), ClientFailureKind::CoverageGap);
    assert_eq!(error.code(), "active_call_events_cursor_missing");
}

#[tokio::test]
async fn expired_event_replay_is_an_explicit_coverage_gap() {
    let server = RawEventServer::start_with_status("410 Gone", "").await;
    let client = ActiveCallClient::connect(server.config()).unwrap();
    let session_id = ChannelAgentSessionId::parse("agent-session-001").unwrap();

    let error = client
        .events_after(&session_id, ActiveCallEventCursor::new(7))
        .await
        .unwrap_err();

    assert_eq!(error.kind(), ClientFailureKind::CoverageGap);
    assert_eq!(error.code(), "active_call_events_replay_unavailable");
}

#[tokio::test]
async fn playbook_reservation_uses_only_inline_content_and_returns_typed_session() {
    let fake = FakeActiveCall::accept_playbook_reservations().await;
    let client = ActiveCallClient::connect(fake.config()).unwrap();
    let playbook = InlinePlaybook::try_new("---\nname: sales-r1\n---\n# Main\nHello").unwrap();
    let session_id = ChannelAgentSessionId::parse("agent-session-001").unwrap();

    let reservation = client
        .reserve_playbook(session_id.clone(), playbook)
        .await
        .unwrap();

    assert_eq!(reservation.session_id, session_id);
    assert_eq!(fake.playbook_reservation_count(), 1);
    let request = fake.last_playbook_reservation().unwrap();
    assert_eq!(
        request["content"],
        "---\nname: sales-r1\n---\n# Main\nHello"
    );
    assert_eq!(request["session_id"], "agent-session-001");
    assert!(request.get("to").is_none());
    assert!(request.get("type").is_none());
}

#[tokio::test]
async fn playbook_reservation_query_distinguishes_pending_active_and_missing() {
    let fake = FakeActiveCall::accept_playbook_reservations().await;
    let client = ActiveCallClient::connect(fake.config()).unwrap();

    assert_eq!(
        client
            .query_playbook_reservation(
                &ChannelAgentSessionId::parse("agent-session-001").unwrap(),
            )
            .await
            .unwrap(),
        PlaybookReservationState::Pending,
    );
    assert_eq!(
        client
            .query_playbook_reservation(
                &ChannelAgentSessionId::parse("agent-session-attached").unwrap(),
            )
            .await
            .unwrap(),
        PlaybookReservationState::Attached,
    );
    assert_eq!(
        client
            .query_playbook_reservation(
                &ChannelAgentSessionId::parse("agent-session-media-ready").unwrap(),
            )
            .await
            .unwrap(),
        PlaybookReservationState::MediaReady,
    );
    assert_eq!(
        client
            .query_playbook_reservation(
                &ChannelAgentSessionId::parse("agent-session-disclosure-completed").unwrap(),
            )
            .await
            .unwrap(),
        PlaybookReservationState::DisclosureCompleted,
    );
    assert_eq!(
        client
            .query_playbook_reservation(
                &ChannelAgentSessionId::parse("agent-session-started").unwrap(),
            )
            .await
            .unwrap(),
        PlaybookReservationState::Started,
    );
    assert_eq!(
        client
            .query_playbook_reservation(
                &ChannelAgentSessionId::parse("agent-session-terminal").unwrap(),
            )
            .await
            .unwrap(),
        PlaybookReservationState::Terminal,
    );
    assert_eq!(
        client
            .query_playbook_reservation(
                &ChannelAgentSessionId::parse("agent-session-active").unwrap(),
            )
            .await
            .unwrap(),
        PlaybookReservationState::Active,
    );
    assert_eq!(
        client
            .query_playbook_reservation(
                &ChannelAgentSessionId::parse("agent-session-missing").unwrap(),
            )
            .await
            .unwrap(),
        PlaybookReservationState::NotFound,
    );
}

#[tokio::test]
async fn conversation_start_is_one_idempotent_session_bound_mutation() {
    let fake = FakeActiveCall::accept_playbook_reservations().await;
    let client = ActiveCallClient::connect(fake.config()).unwrap();
    let session_id = ChannelAgentSessionId::parse("agent-session-attached").unwrap();

    let first = client
        .start_playbook_conversation(session_id.clone())
        .await
        .unwrap();
    let replay = client
        .start_playbook_conversation(session_id.clone())
        .await
        .unwrap();

    assert_eq!(first.session_id, session_id);
    assert_eq!(replay.session_id, session_id);
    assert_eq!(fake.playbook_start_count(), 2);
}

#[tokio::test]
async fn conversation_start_timeout_is_unknown_and_not_retried() {
    let fake = FakeActiveCall::accept_playbook_reservations().await;
    let client = ActiveCallClient::connect(fake.config()).unwrap();

    let error = client
        .start_playbook_conversation(
            ChannelAgentSessionId::parse("agent-session-start-timeout").unwrap(),
        )
        .await
        .unwrap_err();

    assert_eq!(error.kind(), ClientFailureKind::OutcomeUnknown);
    assert_eq!(fake.playbook_start_count(), 1);
}

#[tokio::test]
async fn playbook_reservation_response_identity_drift_is_outcome_unknown() {
    let fake = FakeActiveCall::mismatch_playbook_reservations().await;
    let client = ActiveCallClient::connect(fake.config()).unwrap();
    let playbook = InlinePlaybook::try_new("---\nname: sales-r1\n---\n# Main\nHello").unwrap();

    assert_eq!(
        client
            .reserve_playbook(
                ChannelAgentSessionId::parse("agent-session-001").unwrap(),
                playbook,
            )
            .await
            .unwrap_err()
            .kind(),
        ClientFailureKind::OutcomeUnknown,
    );
}

#[test]
fn inline_playbook_rejects_non_playbook_or_unbounded_content() {
    assert!(InlinePlaybook::try_new("plain prompt").is_err());
    assert!(InlinePlaybook::try_new(format!("---\n{}", "x".repeat(65_537))).is_err());
    assert!(InlinePlaybook::try_new("---\nname: bad\0value").is_err());
}

struct RawEventServer {
    endpoint: String,
    request: Option<oneshot::Receiver<String>>,
    task: JoinHandle<()>,
}

impl RawEventServer {
    async fn start(body: &'static str) -> Self {
        Self::start_with_status("200 OK", body).await
    }

    async fn start_with_status(status: &'static str, body: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, request) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request_bytes = vec![0_u8; 4_096];
            let count = stream.read(&mut request_bytes).await.unwrap();
            request_bytes.truncate(count);
            request_tx
                .send(String::from_utf8(request_bytes).unwrap())
                .unwrap();
            let headers = format!(
                "HTTP/1.1 {status}\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len(),
            );
            stream.write_all(headers.as_bytes()).await.unwrap();
            stream.write_all(body.as_bytes()).await.unwrap();
        });
        Self {
            endpoint: format!("http://{address}"),
            request: Some(request),
            task,
        }
    }

    fn config(&self) -> ClientConfig {
        ClientConfig::new(&self.endpoint, 200, 1_024).unwrap()
    }

    async fn request(&mut self) -> String {
        self.request.take().unwrap().await.unwrap()
    }
}

impl Drop for RawEventServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test]
async fn playbook_reservation_timeout_is_outcome_unknown() {
    let fake = FakeActiveCall::timeout_playbook_reservations().await;
    let client = ActiveCallClient::connect(fake.config()).unwrap();
    let playbook = InlinePlaybook::try_new("---\nname: sales-r1\n---\n# Main\nHello").unwrap();

    assert_eq!(
        client
            .reserve_playbook(
                ChannelAgentSessionId::parse("agent-session-001").unwrap(),
                playbook,
            )
            .await
            .unwrap_err()
            .kind(),
        ClientFailureKind::OutcomeUnknown,
    );
    assert_eq!(fake.playbook_reservation_count(), 1);
}
