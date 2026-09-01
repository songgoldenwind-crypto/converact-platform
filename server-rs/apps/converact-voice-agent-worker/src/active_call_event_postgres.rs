use converact_active_call_adapter::ActiveCallEventCursor;
use converact_postgres_store::{
    PostgresActiveCallEventAppendDecision, PostgresActiveCallEventReconcileReason,
    PostgresActiveCallEventSnapshot, PostgresActiveCallEventStatus, PostgresActiveCallEventStore,
};
use converact_voice_agent_contracts::EnvelopeContext;

use crate::{
    ActiveCallDurableEvent, ActiveCallEventAppendDecision, ActiveCallEventInboxError,
    ActiveCallEventInboxPort, ActiveCallEventInboxSnapshot, ActiveCallEventInboxStatus,
    ActiveCallEventReconcileReason,
};

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
