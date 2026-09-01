use std::{collections::VecDeque, error::Error, fmt, future::Future};

use converact_active_call_adapter::{
    ActiveCallClient, ActiveCallEventCursor, ActiveCallEventKind, ActiveCallEventStream,
    ActiveCallSessionState, AdapterContext, ClientError, ClientFailureKind, NormalizedEvent,
    normalize_event,
};
use converact_contracts::canonical_sha256;
use converact_conversation_result_store::TranscriptHistoryLimit;
use converact_voice_agent_contracts::{EnvelopeContext, ExecutionGeneration};

use crate::{
    ActiveCallTranscriptBinding, ActiveCallTranscriptDurabilityPort,
    ActiveCallUnderstandingEventError, FinalTranscriptUnderstandingPort, ShutdownToken,
    TranscriptUnderstandingAppendReceipt, TranscriptUnderstandingHistoryPort,
    process_active_call_understanding_event,
};

const MAX_EVENT_BYTES: usize = 131_072;
const MAX_PENDING_EVENTS: usize = 1_024;
const MAX_DURABLE_CURSOR: u64 = i64::MAX as u64;

/// One normalized upstream event persisted before any model or projection work.
#[derive(Clone, Eq, PartialEq)]
pub struct ActiveCallDurableEvent {
    cursor: ActiveCallEventCursor,
    payload_digest: Box<str>,
    payload: Box<str>,
    terminal: bool,
}

impl ActiveCallDurableEvent {
    /// Validates and content-hashes one bounded JSON event.
    ///
    /// # Errors
    ///
    /// Rejects cursor zero, malformed/unbounded JSON or a payload that cannot be canonicalized.
    pub fn try_new(
        cursor: ActiveCallEventCursor,
        payload: impl AsRef<str>,
        terminal: bool,
    ) -> Result<Self, ActiveCallEventInboxError> {
        let payload = payload.as_ref();
        if cursor == ActiveCallEventCursor::START
            || cursor.get() > MAX_DURABLE_CURSOR
            || payload.is_empty()
            || payload.len() > MAX_EVENT_BYTES
        {
            return Err(ActiveCallEventInboxError::new(
                "active_call_event_inbox_event_invalid",
            ));
        }
        let value: serde_json::Value = serde_json::from_str(payload)
            .map_err(|_| ActiveCallEventInboxError::new("active_call_event_inbox_event_invalid"))?;
        let payload_digest = canonical_sha256(&value)
            .map_err(|_| ActiveCallEventInboxError::new("active_call_event_inbox_event_invalid"))?;
        Ok(Self {
            cursor,
            payload_digest: payload_digest.into(),
            payload: payload.into(),
            terminal,
        })
    }

    #[must_use]
    pub const fn cursor(&self) -> ActiveCallEventCursor {
        self.cursor
    }

    #[must_use]
    pub fn payload_digest(&self) -> &str {
        &self.payload_digest
    }

    #[must_use]
    pub fn payload(&self) -> &str {
        &self.payload
    }

    #[must_use]
    pub const fn is_terminal(&self) -> bool {
        self.terminal
    }
}

impl fmt::Debug for ActiveCallDurableEvent {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActiveCallDurableEvent")
            .field("cursor", &self.cursor)
            .field("payload_digest", &self.payload_digest)
            .field("payload_bytes", &self.payload.len())
            .field("terminal", &self.terminal)
            .finish_non_exhaustive()
    }
}

/// Durable lifecycle of one Active Call event stream generation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveCallEventInboxStatus {
    Active,
    Completed,
    ReconcileRequired,
}

/// Closed reason that automatic event consumption can no longer prove complete coverage.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveCallEventReconcileReason {
    CoverageGap,
    SessionDisappeared,
    InvalidEvent,
}

impl ActiveCallEventReconcileReason {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CoverageGap => "coverage_gap",
            Self::SessionDisappeared => "session_disappeared",
            Self::InvalidEvent => "invalid_event",
        }
    }
}

/// Validated persisted head plus its bounded contiguous unapplied suffix.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActiveCallEventInboxSnapshot {
    status: ActiveCallEventInboxStatus,
    last_received_cursor: ActiveCallEventCursor,
    last_applied_cursor: ActiveCallEventCursor,
    terminal_cursor: Option<ActiveCallEventCursor>,
    reconcile_reason: Option<ActiveCallEventReconcileReason>,
    pending: VecDeque<ActiveCallDurableEvent>,
}

impl ActiveCallEventInboxSnapshot {
    #[must_use]
    pub fn empty() -> Self {
        Self {
            status: ActiveCallEventInboxStatus::Active,
            last_received_cursor: ActiveCallEventCursor::START,
            last_applied_cursor: ActiveCallEventCursor::START,
            terminal_cursor: None,
            reconcile_reason: None,
            pending: VecDeque::new(),
        }
    }

    /// Revalidates one Store snapshot before any source or model operation.
    ///
    /// # Errors
    ///
    /// Rejects cursor holes, an unbounded pending suffix and inconsistent terminal state.
    pub fn try_new(
        status: ActiveCallEventInboxStatus,
        last_received_cursor: ActiveCallEventCursor,
        last_applied_cursor: ActiveCallEventCursor,
        terminal_cursor: Option<ActiveCallEventCursor>,
        pending: Vec<ActiveCallDurableEvent>,
    ) -> Result<Self, ActiveCallEventInboxError> {
        if status == ActiveCallEventInboxStatus::ReconcileRequired {
            return Err(invalid_snapshot());
        }
        let received = last_received_cursor.get();
        let applied = last_applied_cursor.get();
        let pending_count = received.checked_sub(applied).ok_or_else(invalid_snapshot)?;
        if pending_count > MAX_PENDING_EVENTS as u64
            || usize::try_from(pending_count).ok() != Some(pending.len())
            || pending.iter().enumerate().any(|(index, event)| {
                event.cursor().get()
                    != applied.saturating_add(u64::try_from(index).unwrap_or(u64::MAX) + 1)
            })
        {
            return Err(invalid_snapshot());
        }
        let terminal_valid = match terminal_cursor {
            None => {
                status == ActiveCallEventInboxStatus::Active
                    && pending
                        .iter()
                        .all(|event| !ActiveCallDurableEvent::is_terminal(event))
            }
            Some(terminal) => {
                terminal != ActiveCallEventCursor::START
                    && terminal == last_received_cursor
                    && match status {
                        ActiveCallEventInboxStatus::Active => {
                            terminal > last_applied_cursor
                                && pending.iter().filter(|event| event.is_terminal()).count() == 1
                                && pending
                                    .last()
                                    .is_some_and(ActiveCallDurableEvent::is_terminal)
                        }
                        ActiveCallEventInboxStatus::Completed => {
                            terminal == last_applied_cursor && pending.is_empty()
                        }
                        ActiveCallEventInboxStatus::ReconcileRequired => false,
                    }
            }
        };
        if !terminal_valid {
            return Err(invalid_snapshot());
        }
        Ok(Self {
            status,
            last_received_cursor,
            last_applied_cursor,
            terminal_cursor,
            reconcile_reason: None,
            pending: pending.into(),
        })
    }

    #[must_use]
    pub const fn status(&self) -> ActiveCallEventInboxStatus {
        self.status
    }

    #[must_use]
    pub const fn last_received_cursor(&self) -> ActiveCallEventCursor {
        self.last_received_cursor
    }

    #[must_use]
    pub const fn last_applied_cursor(&self) -> ActiveCallEventCursor {
        self.last_applied_cursor
    }

    #[must_use]
    pub const fn terminal_cursor(&self) -> Option<ActiveCallEventCursor> {
        self.terminal_cursor
    }

    #[must_use]
    pub const fn reconcile_reason(&self) -> Option<ActiveCallEventReconcileReason> {
        self.reconcile_reason
    }

    /// Applies the same contiguous append transition required from the durable Store.
    ///
    /// # Errors
    ///
    /// Rejects a non-active stream, a cursor gap, post-terminal input or an excessive backlog.
    pub fn record_appended(
        &mut self,
        event: ActiveCallDurableEvent,
    ) -> Result<(), ActiveCallEventInboxError> {
        let expected = self
            .last_received_cursor
            .get()
            .checked_add(1)
            .ok_or_else(invalid_snapshot)?;
        if self.status != ActiveCallEventInboxStatus::Active
            || self.terminal_cursor.is_some()
            || event.cursor().get() != expected
            || self.pending.len() >= MAX_PENDING_EVENTS
        {
            return Err(invalid_snapshot());
        }
        self.last_received_cursor = event.cursor();
        if event.is_terminal() {
            self.terminal_cursor = Some(event.cursor());
        }
        self.pending.push_back(event);
        Ok(())
    }

    /// Applies the same ordered projection acknowledgement required from the durable Store.
    ///
    /// # Errors
    ///
    /// Rejects out-of-order, mismatched or post-terminal acknowledgements.
    pub fn record_applied(
        &mut self,
        event: &ActiveCallDurableEvent,
    ) -> Result<(), ActiveCallEventInboxError> {
        if self.status != ActiveCallEventInboxStatus::Active
            || self.pending.front() != Some(event)
            || event.cursor().get()
                != self
                    .last_applied_cursor
                    .get()
                    .checked_add(1)
                    .ok_or_else(invalid_snapshot)?
            || (event.is_terminal()
                && (self.terminal_cursor != Some(event.cursor())
                    || self.last_received_cursor != event.cursor()
                    || self.pending.len() != 1))
        {
            return Err(invalid_snapshot());
        }
        self.pending.pop_front();
        self.last_applied_cursor = event.cursor();
        if event.is_terminal() {
            self.status = ActiveCallEventInboxStatus::Completed;
        }
        Ok(())
    }

    pub fn mark_reconcile(&mut self, reason: ActiveCallEventReconcileReason) {
        self.status = ActiveCallEventInboxStatus::ReconcileRequired;
        self.reconcile_reason = Some(reason);
    }

    fn pending_front(&self) -> Option<&ActiveCallDurableEvent> {
        self.pending.front()
    }
}

/// Exact durable append classification after a possibly ambiguous previous transaction result.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveCallEventAppendDecision {
    Appended,
    ReplayedPending,
    ReplayedApplied,
}

/// Sanitized durable-inbox failure without event or transcript content.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActiveCallEventInboxError {
    code: &'static str,
}

impl ActiveCallEventInboxError {
    #[must_use]
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for ActiveCallEventInboxError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for ActiveCallEventInboxError {}

/// Durable source cursor and pending-event boundary for one exact session generation.
pub trait ActiveCallEventInboxPort: Sync {
    fn load(
        &self,
        context: &EnvelopeContext,
    ) -> impl Future<Output = Result<ActiveCallEventInboxSnapshot, ActiveCallEventInboxError>> + Send;

    fn append(
        &self,
        context: &EnvelopeContext,
        expected_previous_cursor: ActiveCallEventCursor,
        event: &ActiveCallDurableEvent,
    ) -> impl Future<Output = Result<ActiveCallEventAppendDecision, ActiveCallEventInboxError>> + Send;

    fn mark_applied(
        &self,
        context: &EnvelopeContext,
        event: &ActiveCallDurableEvent,
    ) -> impl Future<Output = Result<(), ActiveCallEventInboxError>> + Send;

    fn require_reconcile(
        &self,
        context: &EnvelopeContext,
        reason: ActiveCallEventReconcileReason,
    ) -> impl Future<Output = Result<(), ActiveCallEventInboxError>> + Send;
}

/// Sanitized processing failure; the durable event remains pending for later recovery.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ActiveCallEventProcessingError {
    code: &'static str,
}

impl ActiveCallEventProcessingError {
    #[must_use]
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }

    #[must_use]
    pub const fn code(self) -> &'static str {
        self.code
    }
}

impl fmt::Display for ActiveCallEventProcessingError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code)
    }
}

impl Error for ActiveCallEventProcessingError {}

/// Projection boundary invoked only after one event and its cursor are durable.
pub trait ActiveCallEventProcessorPort: Sync {
    fn process(
        &self,
        context: &EnvelopeContext,
        event: &NormalizedEvent,
    ) -> impl Future<Output = Result<(), ActiveCallEventProcessingError>> + Send;
}

/// Adapter that connects the durable SSE consumer to final-transcript understanding.
pub struct ActiveCallUnderstandingEventProcessor<'a, D, P> {
    store: &'a D,
    processor: &'a P,
    binding: &'a ActiveCallTranscriptBinding,
    current_generation: ExecutionGeneration,
    history_limit: TranscriptHistoryLimit,
}

impl<'a, D, P> ActiveCallUnderstandingEventProcessor<'a, D, P> {
    #[must_use]
    pub const fn new(
        store: &'a D,
        processor: &'a P,
        binding: &'a ActiveCallTranscriptBinding,
        current_generation: ExecutionGeneration,
        history_limit: TranscriptHistoryLimit,
    ) -> Self {
        Self {
            store,
            processor,
            binding,
            current_generation,
            history_limit,
        }
    }
}

impl<D, P> ActiveCallEventProcessorPort for ActiveCallUnderstandingEventProcessor<'_, D, P>
where
    D: ActiveCallTranscriptDurabilityPort + TranscriptUnderstandingHistoryPort + Sync,
    D::Append: TranscriptUnderstandingAppendReceipt,
    P: FinalTranscriptUnderstandingPort,
{
    async fn process(
        &self,
        context: &EnvelopeContext,
        event: &NormalizedEvent,
    ) -> Result<(), ActiveCallEventProcessingError> {
        if context != event.authority() {
            return Err(ActiveCallEventProcessingError::new(
                "active_call_event_processor_authority_invalid",
            ));
        }
        process_active_call_understanding_event(
            self.store,
            self.processor,
            self.binding,
            event,
            self.current_generation,
            self.history_limit,
        )
        .await
        .map(|_| ())
        .map_err(map_understanding_error)
    }
}

/// One bounded invocation result. `Reconnect` is scheduled by the worker with bounded backoff.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveCallEventConsumerOutcome {
    Completed {
        cursor: ActiveCallEventCursor,
    },
    Reconnect {
        cursor: ActiveCallEventCursor,
    },
    Draining {
        cursor: ActiveCallEventCursor,
    },
    ReconcileRequired {
        cursor: ActiveCallEventCursor,
        reason: ActiveCallEventReconcileReason,
    },
}

/// Stable consumer failure. Store/model failures leave the last accepted event recoverable.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveCallEventConsumerError {
    AuthorityInvalid,
    InboxUnavailable,
    ProcessingFailed,
    SourceUnavailable,
    SourceConfigurationInvalid,
}

impl ActiveCallEventConsumerError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::AuthorityInvalid => "active_call_event_consumer_authority_invalid",
            Self::InboxUnavailable => "active_call_event_consumer_inbox_unavailable",
            Self::ProcessingFailed => "active_call_event_consumer_processing_failed",
            Self::SourceUnavailable => "active_call_event_consumer_source_unavailable",
            Self::SourceConfigurationInvalid => {
                "active_call_event_consumer_source_configuration_invalid"
            }
        }
    }
}

impl fmt::Display for ActiveCallEventConsumerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl Error for ActiveCallEventConsumerError {}

/// Recovers pending input, then consumes one live SSE connection from the last durable cursor.
///
/// Every accepted event is appended before projection. A source disconnect is reconciled through
/// `/list`; this function never sleeps or creates a background retry task.
///
/// # Errors
///
/// Returns only stable authority, Store, processor or source categories. A persisted pending event
/// remains available after processor failure.
pub async fn consume_active_call_events_once<D, P>(
    client: &ActiveCallClient,
    inbox: &D,
    processor: &P,
    adapter_context: &AdapterContext,
    shutdown: &ShutdownToken,
) -> Result<ActiveCallEventConsumerOutcome, ActiveCallEventConsumerError>
where
    D: ActiveCallEventInboxPort,
    P: ActiveCallEventProcessorPort,
{
    let context = adapter_context.authority();
    let session_id = context
        .channel_agent_session_id()
        .ok_or(ActiveCallEventConsumerError::AuthorityInvalid)?;
    let mut snapshot = inbox
        .load(context)
        .await
        .map_err(|_| ActiveCallEventConsumerError::InboxUnavailable)?;
    match snapshot.status() {
        ActiveCallEventInboxStatus::Completed => {
            return Ok(ActiveCallEventConsumerOutcome::Completed {
                cursor: snapshot.last_applied_cursor(),
            });
        }
        ActiveCallEventInboxStatus::ReconcileRequired => {
            return Ok(ActiveCallEventConsumerOutcome::ReconcileRequired {
                cursor: snapshot.last_received_cursor(),
                reason: snapshot
                    .reconcile_reason()
                    .ok_or(ActiveCallEventConsumerError::InboxUnavailable)?,
            });
        }
        ActiveCallEventInboxStatus::Active => {}
    }

    while let Some(event) = snapshot.pending_front().cloned() {
        let Some(outcome) = process_durable_event(
            inbox,
            processor,
            adapter_context,
            context,
            &mut snapshot,
            &event,
        )
        .await?
        else {
            continue;
        };
        return Ok(outcome);
    }
    if shutdown.is_cancelled() {
        return Ok(ActiveCallEventConsumerOutcome::Draining {
            cursor: snapshot.last_received_cursor(),
        });
    }

    let stream = match client
        .events_after(session_id, snapshot.last_received_cursor())
        .await
    {
        Ok(stream) => stream,
        Err(error) => {
            return resolve_source_end(client, inbox, context, &snapshot, error).await;
        }
    };
    LiveEventConsumer {
        client,
        inbox,
        processor,
        adapter_context,
        context,
        shutdown,
    }
    .consume(snapshot, stream)
    .await
}

struct LiveEventConsumer<'a, D, P> {
    client: &'a ActiveCallClient,
    inbox: &'a D,
    processor: &'a P,
    adapter_context: &'a AdapterContext,
    context: &'a EnvelopeContext,
    shutdown: &'a ShutdownToken,
}

impl<D, P> LiveEventConsumer<'_, D, P>
where
    D: ActiveCallEventInboxPort,
    P: ActiveCallEventProcessorPort,
{
    async fn consume(
        &self,
        mut snapshot: ActiveCallEventInboxSnapshot,
        mut stream: ActiveCallEventStream,
    ) -> Result<ActiveCallEventConsumerOutcome, ActiveCallEventConsumerError> {
        loop {
            if self.shutdown.is_cancelled() {
                return Ok(ActiveCallEventConsumerOutcome::Draining {
                    cursor: snapshot.last_received_cursor(),
                });
            }
            let frame = match stream.next_event().await {
                Ok(Some(frame)) => frame,
                Ok(None) => {
                    return resolve_clean_source_end(
                        self.client,
                        self.inbox,
                        self.context,
                        &snapshot,
                    )
                    .await;
                }
                Err(error) => {
                    return resolve_source_end(
                        self.client,
                        self.inbox,
                        self.context,
                        &snapshot,
                        error,
                    )
                    .await;
                }
            };
            if frame.kind == ActiveCallEventKind::Command {
                continue;
            }
            let Some(cursor) = frame.cursor() else {
                return reconcile(
                    self.inbox,
                    self.context,
                    &snapshot,
                    ActiveCallEventReconcileReason::CoverageGap,
                )
                .await;
            };
            let Ok(normalized) = normalize_event(self.adapter_context, &frame.data) else {
                return reconcile(
                    self.inbox,
                    self.context,
                    &snapshot,
                    ActiveCallEventReconcileReason::InvalidEvent,
                )
                .await;
            };
            let terminal = matches!(normalized, NormalizedEvent::ConversationCompleted { .. });
            let Ok(durable) = ActiveCallDurableEvent::try_new(cursor, &frame.data, terminal) else {
                return reconcile(
                    self.inbox,
                    self.context,
                    &snapshot,
                    ActiveCallEventReconcileReason::InvalidEvent,
                )
                .await;
            };
            let append = self
                .inbox
                .append(self.context, snapshot.last_received_cursor(), &durable)
                .await
                .map_err(|_| ActiveCallEventConsumerError::InboxUnavailable)?;
            snapshot
                .record_appended(durable.clone())
                .map_err(|_| ActiveCallEventConsumerError::InboxUnavailable)?;
            if append == ActiveCallEventAppendDecision::ReplayedApplied {
                snapshot
                    .record_applied(&durable)
                    .map_err(|_| ActiveCallEventConsumerError::InboxUnavailable)?;
                if snapshot.status() == ActiveCallEventInboxStatus::Completed {
                    return Ok(ActiveCallEventConsumerOutcome::Completed { cursor });
                }
                continue;
            }
            let Some(outcome) = process_normalized_event(
                self.inbox,
                self.processor,
                self.context,
                &mut snapshot,
                &durable,
                &normalized,
            )
            .await?
            else {
                continue;
            };
            return Ok(outcome);
        }
    }
}

async fn process_durable_event<D, P>(
    inbox: &D,
    processor: &P,
    adapter_context: &AdapterContext,
    context: &EnvelopeContext,
    snapshot: &mut ActiveCallEventInboxSnapshot,
    event: &ActiveCallDurableEvent,
) -> Result<Option<ActiveCallEventConsumerOutcome>, ActiveCallEventConsumerError>
where
    D: ActiveCallEventInboxPort,
    P: ActiveCallEventProcessorPort,
{
    let normalized = match normalize_event(adapter_context, event.payload()) {
        Ok(normalized)
            if event.is_terminal()
                == matches!(normalized, NormalizedEvent::ConversationCompleted { .. }) =>
        {
            normalized
        }
        _ => {
            inbox
                .require_reconcile(context, ActiveCallEventReconcileReason::InvalidEvent)
                .await
                .map_err(|_| ActiveCallEventConsumerError::InboxUnavailable)?;
            snapshot.mark_reconcile(ActiveCallEventReconcileReason::InvalidEvent);
            return Ok(Some(ActiveCallEventConsumerOutcome::ReconcileRequired {
                cursor: snapshot.last_received_cursor(),
                reason: ActiveCallEventReconcileReason::InvalidEvent,
            }));
        }
    };
    process_normalized_event(inbox, processor, context, snapshot, event, &normalized).await
}

async fn process_normalized_event<D, P>(
    inbox: &D,
    processor: &P,
    context: &EnvelopeContext,
    snapshot: &mut ActiveCallEventInboxSnapshot,
    event: &ActiveCallDurableEvent,
    normalized: &NormalizedEvent,
) -> Result<Option<ActiveCallEventConsumerOutcome>, ActiveCallEventConsumerError>
where
    D: ActiveCallEventInboxPort,
    P: ActiveCallEventProcessorPort,
{
    processor
        .process(context, normalized)
        .await
        .map_err(|_| ActiveCallEventConsumerError::ProcessingFailed)?;
    inbox
        .mark_applied(context, event)
        .await
        .map_err(|_| ActiveCallEventConsumerError::InboxUnavailable)?;
    snapshot
        .record_applied(event)
        .map_err(|_| ActiveCallEventConsumerError::InboxUnavailable)?;
    Ok(
        (snapshot.status() == ActiveCallEventInboxStatus::Completed).then_some(
            ActiveCallEventConsumerOutcome::Completed {
                cursor: event.cursor(),
            },
        ),
    )
}

async fn resolve_clean_source_end<D>(
    client: &ActiveCallClient,
    inbox: &D,
    context: &EnvelopeContext,
    snapshot: &ActiveCallEventInboxSnapshot,
) -> Result<ActiveCallEventConsumerOutcome, ActiveCallEventConsumerError>
where
    D: ActiveCallEventInboxPort,
{
    match client
        .query_session(
            context
                .channel_agent_session_id()
                .ok_or(ActiveCallEventConsumerError::AuthorityInvalid)?,
        )
        .await
        .map_err(|_| ActiveCallEventConsumerError::SourceUnavailable)?
    {
        ActiveCallSessionState::Active => Ok(ActiveCallEventConsumerOutcome::Reconnect {
            cursor: snapshot.last_received_cursor(),
        }),
        ActiveCallSessionState::NotFound => {
            reconcile(
                inbox,
                context,
                snapshot,
                ActiveCallEventReconcileReason::SessionDisappeared,
            )
            .await
        }
    }
}

async fn resolve_source_end<D>(
    client: &ActiveCallClient,
    inbox: &D,
    context: &EnvelopeContext,
    snapshot: &ActiveCallEventInboxSnapshot,
    error: ClientError,
) -> Result<ActiveCallEventConsumerOutcome, ActiveCallEventConsumerError>
where
    D: ActiveCallEventInboxPort,
{
    match error.kind() {
        ClientFailureKind::CoverageGap => {
            reconcile(
                inbox,
                context,
                snapshot,
                ActiveCallEventReconcileReason::CoverageGap,
            )
            .await
        }
        ClientFailureKind::InvalidConfiguration => {
            Err(ActiveCallEventConsumerError::SourceConfigurationInvalid)
        }
        ClientFailureKind::Unavailable
        | ClientFailureKind::OutcomeUnknown
        | ClientFailureKind::Rejected
        | ClientFailureKind::InvalidResponse => {
            resolve_clean_source_end(client, inbox, context, snapshot).await
        }
    }
}

async fn reconcile<D>(
    inbox: &D,
    context: &EnvelopeContext,
    snapshot: &ActiveCallEventInboxSnapshot,
    reason: ActiveCallEventReconcileReason,
) -> Result<ActiveCallEventConsumerOutcome, ActiveCallEventConsumerError>
where
    D: ActiveCallEventInboxPort,
{
    inbox
        .require_reconcile(context, reason)
        .await
        .map_err(|_| ActiveCallEventConsumerError::InboxUnavailable)?;
    Ok(ActiveCallEventConsumerOutcome::ReconcileRequired {
        cursor: snapshot.last_received_cursor(),
        reason,
    })
}

const fn map_understanding_error(
    _error: ActiveCallUnderstandingEventError,
) -> ActiveCallEventProcessingError {
    ActiveCallEventProcessingError::new("active_call_event_understanding_processing_failed")
}

fn invalid_snapshot() -> ActiveCallEventInboxError {
    ActiveCallEventInboxError::new("active_call_event_inbox_snapshot_invalid")
}
