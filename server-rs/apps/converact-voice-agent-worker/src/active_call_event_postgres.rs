use converact_active_call_adapter::ActiveCallEventCursor;
use converact_postgres_store::{
    PostgresActiveCallEventAppendDecision, PostgresActiveCallEventReconcileReason,
    PostgresActiveCallEventSnapshot, PostgresActiveCallEventStatus, PostgresActiveCallEventStore,
};
use converact_voice_agent_contracts::EnvelopeContext;

use crate::{
    ActiveCallDurableEvent, ActiveCallEventAppendDecision, ActiveCallEventInboxError,
    ActiveCallEventInboxPort, ActiveCallEventInboxSnapshot, ActiveCallEventInboxStatus,
    ActiveCallEventProcessingError, ActiveCallEventReconcileReason, ActiveCallTranscriptBinding,
    ActiveCallTranscriptBindingInput, ActiveCallTranscriptBindingPort,
};

impl ActiveCallTranscriptBindingPort for PostgresActiveCallEventStore {
    async fn bind_media(
        &self,
        context: &EnvelopeContext,
        customer_track_id: &str,
        call_started_at_ms: u64,
    ) -> Result<(), ActiveCallEventProcessingError> {
        PostgresActiveCallEventStore::bind_media(
            self,
            context,
            customer_track_id,
            call_started_at_ms,
        )
        .await
        .map(|_| ())
        .map_err(|_| binding_error())
    }

    async fn load_binding(
        &self,
        context: &EnvelopeContext,
    ) -> Result<Option<ActiveCallTranscriptBinding>, ActiveCallEventProcessingError> {
        let Some(stored) = self
            .load_media_binding(context)
            .await
            .map_err(|_| binding_error())?
        else {
            return Ok(None);
        };
        let session_id = context
            .channel_agent_session_id()
            .ok_or_else(binding_error)?
            .clone();
        ActiveCallTranscriptBinding::try_new(ActiveCallTranscriptBindingInput {
            channel_agent_session_id: session_id,
            customer_track_id: stored.customer_track_id().to_owned(),
            call_started_at_ms: stored.call_started_at_ms(),
            language: stored.language().to_owned(),
            retention_policy_ref: stored.retention_policy_ref().to_owned(),
        })
        .map(Some)
        .map_err(|_| binding_error())
    }
}

impl ActiveCallEventInboxPort for PostgresActiveCallEventStore {
    async fn load(
        &self,
        context: &EnvelopeContext,
    ) -> Result<ActiveCallEventInboxSnapshot, ActiveCallEventInboxError> {
        self.load_snapshot(context)
            .await
            .map_err(|_| store_error())
            .and_then(|stored| map_snapshot(&stored))
    }

    async fn append(
        &self,
        context: &EnvelopeContext,
        expected_previous_cursor: ActiveCallEventCursor,
        event: &ActiveCallDurableEvent,
    ) -> Result<ActiveCallEventAppendDecision, ActiveCallEventInboxError> {
        self.append_event(
            context,
            expected_previous_cursor.get(),
            event.cursor().get(),
            event.payload_digest(),
            event.payload(),
            event.is_terminal(),
        )
        .await
        .map(|decision| match decision {
            PostgresActiveCallEventAppendDecision::Appended => {
                ActiveCallEventAppendDecision::Appended
            }
            PostgresActiveCallEventAppendDecision::ReplayedPending => {
                ActiveCallEventAppendDecision::ReplayedPending
            }
            PostgresActiveCallEventAppendDecision::ReplayedApplied => {
                ActiveCallEventAppendDecision::ReplayedApplied
            }
        })
        .map_err(|_| store_error())
    }

    async fn mark_applied(
        &self,
        context: &EnvelopeContext,
        event: &ActiveCallDurableEvent,
    ) -> Result<(), ActiveCallEventInboxError> {
        self.mark_event_applied(
            context,
            event.cursor().get(),
            event.payload_digest(),
            event.is_terminal(),
        )
        .await
        .map_err(|_| store_error())
    }

    async fn require_reconcile(
        &self,
        context: &EnvelopeContext,
        reason: ActiveCallEventReconcileReason,
    ) -> Result<(), ActiveCallEventInboxError> {
        PostgresActiveCallEventStore::require_reconcile(self, context, map_reason(reason))
            .await
            .map_err(|_| store_error())
    }
}

fn map_snapshot(
    stored: &PostgresActiveCallEventSnapshot,
) -> Result<ActiveCallEventInboxSnapshot, ActiveCallEventInboxError> {
    let pending = stored
        .pending()
        .iter()
        .map(|event| {
            let durable = ActiveCallDurableEvent::try_new(
                ActiveCallEventCursor::new(event.cursor()),
                event.payload(),
                event.is_terminal(),
            )?;
            if durable.payload_digest() != event.payload_digest() {
                return Err(store_error());
            }
            Ok(durable)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let initial_status = match stored.status() {
        PostgresActiveCallEventStatus::Completed => ActiveCallEventInboxStatus::Completed,
        PostgresActiveCallEventStatus::Active
        | PostgresActiveCallEventStatus::ReconcileRequired => ActiveCallEventInboxStatus::Active,
    };
    let mut snapshot = ActiveCallEventInboxSnapshot::try_new(
        initial_status,
        ActiveCallEventCursor::new(stored.last_received_cursor()),
        ActiveCallEventCursor::new(stored.last_applied_cursor()),
        stored.terminal_cursor().map(ActiveCallEventCursor::new),
        pending,
    )?;
    if stored.status() == PostgresActiveCallEventStatus::ReconcileRequired {
        snapshot.mark_reconcile(match stored.reconcile_reason().ok_or_else(store_error)? {
            PostgresActiveCallEventReconcileReason::CoverageGap => {
                ActiveCallEventReconcileReason::CoverageGap
            }
            PostgresActiveCallEventReconcileReason::SessionDisappeared => {
                ActiveCallEventReconcileReason::SessionDisappeared
            }
            PostgresActiveCallEventReconcileReason::InvalidEvent => {
                ActiveCallEventReconcileReason::InvalidEvent
            }
        });
    }
    Ok(snapshot)
}

const fn map_reason(
    reason: ActiveCallEventReconcileReason,
) -> PostgresActiveCallEventReconcileReason {
    match reason {
        ActiveCallEventReconcileReason::CoverageGap => {
            PostgresActiveCallEventReconcileReason::CoverageGap
        }
        ActiveCallEventReconcileReason::SessionDisappeared => {
            PostgresActiveCallEventReconcileReason::SessionDisappeared
        }
        ActiveCallEventReconcileReason::InvalidEvent => {
            PostgresActiveCallEventReconcileReason::InvalidEvent
        }
    }
}

const fn store_error() -> ActiveCallEventInboxError {
    ActiveCallEventInboxError::new("active_call_event_inbox_store_unavailable")
}

const fn binding_error() -> ActiveCallEventProcessingError {
    ActiveCallEventProcessingError::new("active_call_transcript_binding_store_unavailable")
}
