use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use converact_active_call_adapter::ActiveCallEventCursor;
use converact_voice_agent_worker::{
    ActiveAttemptLeasePort, ActiveCallEventConsumerError, ActiveCallEventConsumerOutcome,
    ActiveCallEventCyclePort, ActiveCallSessionSupervisor, ActiveCallSessionSupervisorConfig,
    ActiveCallSessionSupervisorOutcome, ShutdownToken, WorkerError,
};
use tokio::sync::Notify;

#[tokio::test]
async fn pending_event_stream_renews_lease_until_completion() {
    let renewals = Arc::new(AtomicUsize::new(0));
    let completed = Arc::new(Notify::new());
    let cycle = PendingThenCompleted {
        completed: Arc::clone(&completed),
    };
    let lease = LeaseProbe {
        renewals: Arc::clone(&renewals),
        completed,
    };
    let shutdown = ShutdownToken::default();
    let supervisor = ActiveCallSessionSupervisor::new(&cycle, &lease, config(), &shutdown);

    let outcome = supervisor.run().await.unwrap();

    assert_eq!(outcome, ActiveCallSessionSupervisorOutcome::Completed);
    assert_eq!(renewals.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn reconnect_renews_lease_before_opening_the_next_event_stream() {
    let cycle = ReconnectThenCompleted::default();
    let lease = ReconnectLeaseProbe {
        renewals: AtomicUsize::new(0),
        event_cycles: &cycle.calls,
    };
    let shutdown = ShutdownToken::default();
    let supervisor = ActiveCallSessionSupervisor::new(&cycle, &lease, config(), &shutdown);

    let outcome = supervisor.run().await.unwrap();

    assert_eq!(outcome, ActiveCallSessionSupervisorOutcome::Completed);
    assert_eq!(cycle.calls.load(Ordering::SeqCst), 2);
    assert_eq!(lease.renewals.load(Ordering::SeqCst), 1);
}

fn config() -> ActiveCallSessionSupervisorConfig {
    ActiveCallSessionSupervisorConfig::new(Duration::from_millis(1), Duration::from_millis(1))
        .unwrap()
}

struct PendingThenCompleted {
    completed: Arc<Notify>,
}

impl ActiveCallEventCyclePort for PendingThenCompleted {
    async fn consume_once(
        &self,
    ) -> Result<ActiveCallEventConsumerOutcome, ActiveCallEventConsumerError> {
        self.completed.notified().await;
        Ok(ActiveCallEventConsumerOutcome::Completed {
            cursor: ActiveCallEventCursor::new(1),
        })
    }
}

struct LeaseProbe {
    renewals: Arc<AtomicUsize>,
    completed: Arc<Notify>,
}

impl ActiveAttemptLeasePort for LeaseProbe {
    async fn renew_active_lease(&self) -> Result<(), WorkerError> {
        if self.renewals.fetch_add(1, Ordering::SeqCst) + 1 == 2 {
            self.completed.notify_one();
        }
        Ok(())
    }
}

#[derive(Default)]
struct ReconnectThenCompleted {
    calls: AtomicUsize,
}

impl ActiveCallEventCyclePort for ReconnectThenCompleted {
    async fn consume_once(
        &self,
    ) -> Result<ActiveCallEventConsumerOutcome, ActiveCallEventConsumerError> {
        if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
            Ok(ActiveCallEventConsumerOutcome::Reconnect {
                cursor: ActiveCallEventCursor::new(1),
            })
        } else {
            Ok(ActiveCallEventConsumerOutcome::Completed {
                cursor: ActiveCallEventCursor::new(2),
            })
        }
    }
}

struct ReconnectLeaseProbe<'a> {
    renewals: AtomicUsize,
    event_cycles: &'a AtomicUsize,
}

impl ActiveAttemptLeasePort for ReconnectLeaseProbe<'_> {
    async fn renew_active_lease(&self) -> Result<(), WorkerError> {
        assert_eq!(self.event_cycles.load(Ordering::SeqCst), 1);
        self.renewals.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
