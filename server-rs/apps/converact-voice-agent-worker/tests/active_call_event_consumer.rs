use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use converact_active_call_adapter::{
    ActiveCallClient, ActiveCallEventCursor, AdapterContext, ClientConfig, NormalizedEvent,
};
use converact_postgres_store::PostgresActiveCallEventStore;
use converact_voice_agent_contracts::{
    AgentReleaseId, CallAttemptId, CallId, CampaignContactId, CampaignId, ChannelAgentSessionId,
    EnvelopeContext, EnvelopeContextInput, ExecutionGeneration, InteractionId,
    VOICE_AGENT_SCHEMA_VERSION,
};
use converact_voice_agent_worker::{
    ActiveAttemptLeasePort, ActiveCallDurableEvent, ActiveCallEventAppendDecision,
    ActiveCallEventConsumerOutcome, ActiveCallEventCycle, ActiveCallEventInboxError,
    ActiveCallEventInboxPort, ActiveCallEventInboxSnapshot, ActiveCallEventInboxStatus,
    ActiveCallEventProcessingError, ActiveCallEventProcessorPort, ActiveCallEventReconcileReason,
    ActiveCallSessionSupervisor, ActiveCallSessionSupervisorConfig,
    ActiveCallSessionSupervisorOutcome, ShutdownToken, WorkerError,
    consume_active_call_events_once,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[test]
fn postgres_event_store_implements_the_worker_inbox_port() {
    fn assert_port<T: ActiveCallEventInboxPort>() {}
    assert_port::<PostgresActiveCallEventStore>();
}

#[tokio::test]
async fn event_is_durable_before_processing_and_cursor_advances_in_order() {
    let server = TestServer::spawn(vec![Response::sse(
        "id: 1\nevent: event\ndata: {\"event\":\"mediaReady\",\"trackId\":\"customer-track\",\"timestamp\":1200}\n\n\
         event: command\ndata: {\"command\":\"ignored\"}\n\n\
         id: 2\nevent: event\ndata: {\"event\":\"hangup\",\"trackId\":\"customer-track\",\"timestamp\":1500,\"startTime\":\"2026-09-01T00:00:00Z\",\"hangupTime\":\"2026-09-01T00:01:00Z\"}\n\n",
    )])
    .await;
    let context = context();
    let log = Arc::new(Mutex::new(Vec::new()));
    let inbox = Inbox::empty(Arc::clone(&log));
    let processor = Processor::new(Arc::clone(&log));

    let outcome = consume_active_call_events_once(
        &client(server.endpoint()),
        &inbox,
        &processor,
        &AdapterContext::new(context),
        &ShutdownToken::default(),
    )
    .await
    .unwrap();

    assert_eq!(
        outcome,
        ActiveCallEventConsumerOutcome::Completed {
            cursor: ActiveCallEventCursor::new(2)
        }
    );
    assert_eq!(
        *log.lock().unwrap(),
        [
            "append:1",
            "process:media_ready",
            "apply:1",
            "append:2",
            "process:terminal",
            "apply:2",
        ]
    );
    let requests = server.finish().await;
    assert_eq!(requests.len(), 1);
    assert!(requests[0].contains("GET /events/session-001 HTTP/1.1"));
    assert!(
        requests[0]
            .to_ascii_lowercase()
            .contains("last-event-id: 0")
    );
}

#[tokio::test]
async fn restart_applies_pending_terminal_before_opening_another_stream() {
    let context = context();
    let log = Arc::new(Mutex::new(Vec::new()));
    let payload = r#"{"event":"hangup","trackId":"customer-track","timestamp":1500,"startTime":"2026-09-01T00:00:00Z","hangupTime":"2026-09-01T00:01:00Z"}"#;
    let event =
        ActiveCallDurableEvent::try_new(ActiveCallEventCursor::new(1), payload, true).unwrap();
    let inbox = Inbox::with_snapshot(
        Arc::clone(&log),
        ActiveCallEventInboxSnapshot::try_new(
            ActiveCallEventInboxStatus::Active,
            ActiveCallEventCursor::new(1),
            ActiveCallEventCursor::START,
            Some(ActiveCallEventCursor::new(1)),
            vec![event],
        )
        .unwrap(),
    );
    let processor = Processor::new(Arc::clone(&log));

    let outcome = consume_active_call_events_once(
        &client("http://127.0.0.1:9/".to_owned()),
        &inbox,
        &processor,
        &AdapterContext::new(context),
        &ShutdownToken::default(),
    )
    .await
    .unwrap();

    assert_eq!(
        outcome,
        ActiveCallEventConsumerOutcome::Completed {
            cursor: ActiveCallEventCursor::new(1)
        }
    );
    assert_eq!(*log.lock().unwrap(), ["process:terminal", "apply:1"]);
}

#[tokio::test]
async fn clean_stream_end_queries_session_and_requests_resume_when_still_active() {
    let server = TestServer::spawn(vec![
        Response::sse(""),
        Response::json(r#"{"active_calls":[{"id":"session-001"}]}"#),
    ])
    .await;
    let context = context();
    let log = Arc::new(Mutex::new(Vec::new()));
    let inbox = Inbox::empty(Arc::clone(&log));
    let processor = Processor::new(Arc::clone(&log));

    let outcome = consume_active_call_events_once(
        &client(server.endpoint()),
        &inbox,
        &processor,
        &AdapterContext::new(context),
        &ShutdownToken::default(),
    )
    .await
    .unwrap();

    assert_eq!(
        outcome,
        ActiveCallEventConsumerOutcome::Reconnect {
            cursor: ActiveCallEventCursor::START
        }
    );
    assert!(log.lock().unwrap().is_empty());
    let requests = server.finish().await;
    assert_eq!(requests.len(), 2);
    assert!(requests[1].contains("GET /list HTTP/1.1"));
}

#[tokio::test]
async fn session_supervisor_reconnects_the_real_durable_event_cycle() {
    let server = TestServer::spawn(vec![
        Response::sse(""),
        Response::json(r#"{"active_calls":[{"id":"session-001"}]}"#),
        Response::sse(
            "id: 1\nevent: event\ndata: {\"event\":\"hangup\",\"trackId\":\"customer-track\",\"timestamp\":1500,\"startTime\":\"2026-09-01T00:00:00Z\",\"hangupTime\":\"2026-09-01T00:01:00Z\"}\n\n",
        ),
    ])
    .await;
    let client = client(server.endpoint());
    let log = Arc::new(Mutex::new(Vec::new()));
    let inbox = Inbox::empty(Arc::clone(&log));
    let processor = Processor::new(Arc::clone(&log));
    let adapter_context = AdapterContext::new(context());
    let shutdown = ShutdownToken::default();
    let cycle = ActiveCallEventCycle::new(&client, &inbox, &processor, &adapter_context, &shutdown);
    let lease = RenewalCounter::default();
    let supervisor = ActiveCallSessionSupervisor::new(
        &cycle,
        &lease,
        ActiveCallSessionSupervisorConfig::new(Duration::from_millis(50), Duration::from_millis(1))
            .unwrap(),
        &shutdown,
    );

    let outcome = supervisor.run().await.unwrap();

    assert_eq!(outcome, ActiveCallSessionSupervisorOutcome::Completed);
    assert_eq!(lease.renewals.load(Ordering::SeqCst), 1);
    assert_eq!(
        *log.lock().unwrap(),
        ["append:1", "process:terminal", "apply:1"]
    );
    let requests = server.finish().await;
    assert_eq!(requests.len(), 3);
    assert!(requests[1].contains("GET /list HTTP/1.1"));
    assert!(requests[2].contains("GET /events/session-001 HTTP/1.1"));
}

#[tokio::test]
async fn replay_coverage_gap_is_durably_reconciled_without_processing() {
    let server = TestServer::spawn(vec![Response::gone()]).await;
    let context = context();
    let log = Arc::new(Mutex::new(Vec::new()));
    let inbox = Inbox::empty(Arc::clone(&log));
    let processor = Processor::new(Arc::clone(&log));

    let outcome = consume_active_call_events_once(
        &client(server.endpoint()),
        &inbox,
        &processor,
        &AdapterContext::new(context),
        &ShutdownToken::default(),
    )
    .await
    .unwrap();

    assert_eq!(
        outcome,
        ActiveCallEventConsumerOutcome::ReconcileRequired {
            cursor: ActiveCallEventCursor::START,
            reason: ActiveCallEventReconcileReason::CoverageGap,
        }
    );
    assert_eq!(*log.lock().unwrap(), ["reconcile:coverage_gap"]);
    server.finish().await;
}

#[tokio::test]
async fn disappeared_session_is_durably_reconciled_after_clean_eof() {
    let server = TestServer::spawn(vec![
        Response::sse(""),
        Response::json(r#"{"active_calls":[]}"#),
    ])
    .await;
    let log = Arc::new(Mutex::new(Vec::new()));
    let inbox = Inbox::empty(Arc::clone(&log));

    let outcome = consume_active_call_events_once(
        &client(server.endpoint()),
        &inbox,
        &Processor::new(Arc::clone(&log)),
        &AdapterContext::new(context()),
        &ShutdownToken::default(),
    )
    .await
    .unwrap();

    assert_eq!(
        outcome,
        ActiveCallEventConsumerOutcome::ReconcileRequired {
            cursor: ActiveCallEventCursor::START,
            reason: ActiveCallEventReconcileReason::SessionDisappeared,
        }
    );
    assert_eq!(*log.lock().unwrap(), ["reconcile:session_disappeared"]);
    server.finish().await;
}

#[tokio::test]
async fn processing_failure_leaves_the_durable_event_pending() {
    let server = TestServer::spawn(vec![Response::sse(
        "id: 1\nevent: event\ndata: {\"event\":\"mediaReady\",\"trackId\":\"customer-track\",\"timestamp\":1200}\n\n",
    )])
    .await;
    let log = Arc::new(Mutex::new(Vec::new()));
    let inbox = Inbox::empty(Arc::clone(&log));

    let error = consume_active_call_events_once(
        &client(server.endpoint()),
        &inbox,
        &FailingProcessor,
        &AdapterContext::new(context()),
        &ShutdownToken::default(),
    )
    .await
    .unwrap_err();

    assert_eq!(error.code(), "active_call_event_consumer_processing_failed");
    let cursors = {
        let snapshot = inbox.snapshot.lock().unwrap();
        (
            snapshot.last_received_cursor(),
            snapshot.last_applied_cursor(),
        )
    };
    assert_eq!(cursors.0, ActiveCallEventCursor::new(1));
    assert_eq!(cursors.1, ActiveCallEventCursor::START);
    assert_eq!(*log.lock().unwrap(), ["append:1"]);
    server.finish().await;
}

#[tokio::test]
async fn oversized_but_parseable_event_requires_reconciliation_before_append() {
    let payload = format!(
        "{{\"event\":\"mediaReady\",\"trackId\":\"customer-track\",\"timestamp\":1200,\"padding\":\"{}\"}}",
        "x".repeat(131_072)
    );
    let server = TestServer::spawn(vec![Response::sse(format!(
        "id: 1\nevent: event\ndata: {payload}\n\n"
    ))])
    .await;
    let log = Arc::new(Mutex::new(Vec::new()));
    let inbox = Inbox::empty(Arc::clone(&log));

    let outcome = consume_active_call_events_once(
        &client_with_max_event_bytes(server.endpoint(), 262_144),
        &inbox,
        &Processor::new(Arc::clone(&log)),
        &AdapterContext::new(context()),
        &ShutdownToken::default(),
    )
    .await
    .unwrap();

    assert_eq!(
        outcome,
        ActiveCallEventConsumerOutcome::ReconcileRequired {
            cursor: ActiveCallEventCursor::START,
            reason: ActiveCallEventReconcileReason::InvalidEvent,
        }
    );
    assert_eq!(*log.lock().unwrap(), ["reconcile:invalid_event"]);
    server.finish().await;
}

#[test]
fn snapshot_rejects_hidden_terminal_event_and_non_postgres_cursor() {
    let payload = r#"{"event":"hangup","trackId":"customer-track","timestamp":1500,"startTime":"2026-09-01T00:00:00Z","hangupTime":"2026-09-01T00:01:00Z"}"#;
    let terminal =
        ActiveCallDurableEvent::try_new(ActiveCallEventCursor::new(1), payload, true).unwrap();

    assert!(
        ActiveCallEventInboxSnapshot::try_new(
            ActiveCallEventInboxStatus::Active,
            ActiveCallEventCursor::new(1),
            ActiveCallEventCursor::START,
            None,
            vec![terminal],
        )
        .is_err()
    );
    assert!(
        ActiveCallDurableEvent::try_new(
            ActiveCallEventCursor::new((i64::MAX as u64) + 1),
            r#"{"event":"mediaReady","trackId":"customer-track","timestamp":1200}"#,
            false,
        )
        .is_err()
    );
}

struct Processor {
    log: Arc<Mutex<Vec<&'static str>>>,
}

#[derive(Default)]
struct RenewalCounter {
    renewals: AtomicUsize,
}

impl ActiveAttemptLeasePort for RenewalCounter {
    async fn renew_active_lease(&self) -> Result<(), WorkerError> {
        self.renewals.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct FailingProcessor;

impl ActiveCallEventProcessorPort for FailingProcessor {
    async fn process(
        &self,
        _context: &EnvelopeContext,
        _event: &NormalizedEvent,
    ) -> Result<(), ActiveCallEventProcessingError> {
        Err(ActiveCallEventProcessingError::new(
            "test_processing_failed",
        ))
    }
}

impl Processor {
    const fn new(log: Arc<Mutex<Vec<&'static str>>>) -> Self {
        Self { log }
    }
}

impl ActiveCallEventProcessorPort for Processor {
    async fn process(
        &self,
        context: &EnvelopeContext,
        event: &NormalizedEvent,
    ) -> Result<(), ActiveCallEventProcessingError> {
        assert_eq!(context, event.authority());
        assert_eq!(context.call_attempt_id().as_str(), "attempt-001");
        self.log.lock().unwrap().push(match event {
            NormalizedEvent::MediaReady { .. } => "process:media_ready",
            NormalizedEvent::ConversationCompleted { .. } => "process:terminal",
            _ => "process:other",
        });
        Ok(())
    }
}

struct Inbox {
    snapshot: Mutex<ActiveCallEventInboxSnapshot>,
    log: Arc<Mutex<Vec<&'static str>>>,
}

impl Inbox {
    fn empty(log: Arc<Mutex<Vec<&'static str>>>) -> Self {
        Self::with_snapshot(log, ActiveCallEventInboxSnapshot::empty())
    }

    const fn with_snapshot(
        log: Arc<Mutex<Vec<&'static str>>>,
        snapshot: ActiveCallEventInboxSnapshot,
    ) -> Self {
        Self {
            snapshot: Mutex::new(snapshot),
            log,
        }
    }
}

impl ActiveCallEventInboxPort for Inbox {
    async fn load(
        &self,
        _context: &EnvelopeContext,
    ) -> Result<ActiveCallEventInboxSnapshot, ActiveCallEventInboxError> {
        Ok(self.snapshot.lock().unwrap().clone())
    }

    async fn append(
        &self,
        _context: &EnvelopeContext,
        expected_previous_cursor: ActiveCallEventCursor,
        event: &ActiveCallDurableEvent,
    ) -> Result<ActiveCallEventAppendDecision, ActiveCallEventInboxError> {
        let mut snapshot = self.snapshot.lock().unwrap();
        assert_eq!(snapshot.last_received_cursor(), expected_previous_cursor);
        self.log
            .lock()
            .unwrap()
            .push(log_cursor("append", event.cursor()));
        snapshot.record_appended(event.clone()).unwrap();
        Ok(ActiveCallEventAppendDecision::Appended)
    }

    async fn mark_applied(
        &self,
        _context: &EnvelopeContext,
        event: &ActiveCallDurableEvent,
    ) -> Result<(), ActiveCallEventInboxError> {
        self.log
            .lock()
            .unwrap()
            .push(log_cursor("apply", event.cursor()));
        self.snapshot.lock().unwrap().record_applied(event).unwrap();
        Ok(())
    }

    async fn require_reconcile(
        &self,
        _context: &EnvelopeContext,
        reason: ActiveCallEventReconcileReason,
    ) -> Result<(), ActiveCallEventInboxError> {
        self.log.lock().unwrap().push(match reason {
            ActiveCallEventReconcileReason::CoverageGap => "reconcile:coverage_gap",
            ActiveCallEventReconcileReason::SessionDisappeared => "reconcile:session_disappeared",
            ActiveCallEventReconcileReason::InvalidEvent => "reconcile:invalid_event",
        });
        self.snapshot.lock().unwrap().mark_reconcile(reason);
        Ok(())
    }
}

fn log_cursor(prefix: &'static str, cursor: ActiveCallEventCursor) -> &'static str {
    match (prefix, cursor.get()) {
        ("append", 1) => "append:1",
        ("append", 2) => "append:2",
        ("apply", 1) => "apply:1",
        ("apply", 2) => "apply:2",
        _ => panic!("unexpected test cursor"),
    }
}

fn client(endpoint: String) -> ActiveCallClient {
    client_with_max_event_bytes(endpoint, 131_072)
}

fn client_with_max_event_bytes(endpoint: String, max_event_bytes: usize) -> ActiveCallClient {
    ActiveCallClient::connect(ClientConfig::new(endpoint, 1_000, max_event_bytes).unwrap()).unwrap()
}

fn context() -> EnvelopeContext {
    EnvelopeContext::try_new(EnvelopeContextInput {
        schema_version: VOICE_AGENT_SCHEMA_VERSION,
        tenant_id: "tenant-a".to_owned(),
        interaction_id: InteractionId::parse("interaction-001").unwrap(),
        campaign_id: CampaignId::parse("campaign-001").unwrap(),
        campaign_contact_id: CampaignContactId::parse("contact-001").unwrap(),
        call_attempt_id: CallAttemptId::parse("attempt-001").unwrap(),
        call_id: Some(CallId::parse("call-001").unwrap()),
        agent_release_id: AgentReleaseId::parse("agent-release-001").unwrap(),
        channel_agent_session_id: Some(ChannelAgentSessionId::parse("session-001").unwrap()),
        execution_generation: ExecutionGeneration::new(7).unwrap(),
        trace_id: "trace-001".to_owned(),
    })
    .unwrap()
}

struct Response {
    status: &'static str,
    content_type: &'static str,
    body: String,
}

impl Response {
    fn sse(body: impl Into<String>) -> Self {
        Self {
            status: "200 OK",
            content_type: "text/event-stream",
            body: body.into(),
        }
    }

    fn json(body: impl Into<String>) -> Self {
        Self {
            status: "200 OK",
            content_type: "application/json",
            body: body.into(),
        }
    }

    fn gone() -> Self {
        Self {
            status: "410 Gone",
            content_type: "text/plain",
            body: String::new(),
        }
    }
}

struct TestServer {
    endpoint: String,
    task: tokio::task::JoinHandle<Vec<String>>,
}

impl TestServer {
    async fn spawn(responses: Vec<Response>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let mut requests = Vec::with_capacity(responses.len());
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = vec![0_u8; 8_192];
                let read = socket.read(&mut request).await.unwrap();
                requests.push(String::from_utf8(request[..read].to_vec()).unwrap());
                let head = format!(
                    "HTTP/1.1 {}\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    response.status,
                    response.content_type,
                    response.body.len()
                );
                socket.write_all(head.as_bytes()).await.unwrap();
                socket.write_all(response.body.as_bytes()).await.unwrap();
                socket.shutdown().await.unwrap();
            }
            requests
        });
        Self {
            endpoint: format!("http://{address}/"),
            task,
        }
    }

    fn endpoint(&self) -> String {
        self.endpoint.clone()
    }

    async fn finish(self) -> Vec<String> {
        self.task.await.unwrap()
    }
}
