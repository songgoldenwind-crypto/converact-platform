use crate::{app::AppState, event::SessionEvent};
use axum::{
    http::{HeaderMap, StatusCode},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
};
use std::{
    collections::{HashMap, VecDeque},
    convert::Infallible,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tokio::sync::broadcast;

const PLATFORM_EVENT_CAPACITY: usize = 1_024;
const PLATFORM_EVENT_BYTE_CAPACITY: usize = 4 * 1_024 * 1_024;
const MAX_PLATFORM_EVENT_BYTES: usize = 64 * 1_024;
const PLATFORM_UPDATE_CAPACITY: usize = 32;

#[derive(Clone)]
struct PlatformEventRecord {
    sequence: u64,
    payload: Arc<str>,
}

#[derive(Clone)]
enum PlatformEventUpdate {
    Event(PlatformEventRecord),
    CoverageGap,
    Terminal,
}

struct PlatformEventJournalState {
    records: VecDeque<PlatformEventRecord>,
    retained_bytes: usize,
    next_sequence: u64,
    coverage_gap: bool,
    terminal: bool,
    updated_at: Instant,
}

/// Bounded process-local journal for the platform-owned semantic event stream.
pub(crate) struct PlatformEventJournal {
    state: Mutex<PlatformEventJournalState>,
    updates: broadcast::Sender<PlatformEventUpdate>,
}

impl PlatformEventJournal {
    fn new() -> Self {
        let (updates, _) = broadcast::channel(PLATFORM_UPDATE_CAPACITY);
        Self {
            state: Mutex::new(PlatformEventJournalState {
                records: VecDeque::new(),
                retained_bytes: 0,
                next_sequence: 1,
                coverage_gap: false,
                terminal: false,
                updated_at: Instant::now(),
            }),
            updates,
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, PlatformEventJournalState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn record(&self, event: &SessionEvent) {
        if !platform_semantic_event(event) {
            return;
        }
        let Ok(payload) = serde_json::to_string(event) else {
            self.mark_coverage_gap();
            return;
        };
        if payload.len() > MAX_PLATFORM_EVENT_BYTES {
            self.mark_coverage_gap();
            return;
        }
        let terminal = matches!(event, SessionEvent::Hangup { .. });
        let record = {
            let mut state = self.lock_state();
            if state.coverage_gap || state.terminal {
                return;
            }
            let sequence = state.next_sequence;
            let Some(next_sequence) = sequence.checked_add(1) else {
                drop(state);
                self.mark_coverage_gap();
                return;
            };
            state.next_sequence = next_sequence;
            while state.records.len() == PLATFORM_EVENT_CAPACITY
                || state.retained_bytes + payload.len() > PLATFORM_EVENT_BYTE_CAPACITY
            {
                let Some(evicted) = state.records.pop_front() else {
                    drop(state);
                    self.mark_coverage_gap();
                    return;
                };
                state.retained_bytes -= evicted.payload.len();
            }
            let record = PlatformEventRecord {
                sequence,
                payload: payload.into(),
            };
            state.retained_bytes += record.payload.len();
            state.records.push_back(record.clone());
            state.terminal = terminal;
            state.updated_at = Instant::now();
            record
        };
        let _ = self.updates.send(PlatformEventUpdate::Event(record));
        if terminal {
            let _ = self.updates.send(PlatformEventUpdate::Terminal);
        }
    }

    fn mark_coverage_gap(&self) {
        let notify = {
            let mut state = self.lock_state();
            if state.coverage_gap {
                false
            } else {
                state.coverage_gap = true;
                state.updated_at = Instant::now();
                true
            }
        };
        if notify {
            let _ = self.updates.send(PlatformEventUpdate::CoverageGap);
        }
    }

    fn mark_terminal(&self) {
        let notify = {
            let mut state = self.lock_state();
            if state.terminal {
                false
            } else {
                state.terminal = true;
                state.updated_at = Instant::now();
                true
            }
        };
        if notify {
            let _ = self.updates.send(PlatformEventUpdate::Terminal);
        }
    }

    fn snapshot_after(
        &self,
        cursor: u64,
    ) -> Result<(VecDeque<PlatformEventRecord>, bool), PlatformReplayError> {
        let state = self.lock_state();
        if state.coverage_gap {
            return Err(PlatformReplayError::CoverageGap);
        }
        let latest = state.next_sequence.saturating_sub(1);
        if cursor > latest {
            return Err(PlatformReplayError::CoverageGap);
        }
        if let Some(first) = state.records.front()
            && cursor
                .checked_add(1)
                .is_none_or(|next| next < first.sequence)
        {
            return Err(PlatformReplayError::CoverageGap);
        }
        Ok((
            state
                .records
                .iter()
                .filter(|record| record.sequence > cursor)
                .cloned()
                .collect(),
            state.terminal,
        ))
    }

    fn expired(&self, ttl: Duration) -> bool {
        self.lock_state().updated_at.elapsed() >= ttl
    }
}

#[derive(Clone, Copy, Debug)]
enum PlatformReplayError {
    CoverageGap,
}

pub(crate) type PlatformEventJournals = HashMap<String, Arc<PlatformEventJournal>>;

pub(crate) fn ensure_platform_event_journal(
    state: &AppState,
    session_id: &str,
) -> Arc<PlatformEventJournal> {
    let mut journals = state
        .platform_event_journals
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    Arc::clone(
        journals
            .entry(session_id.to_owned())
            .or_insert_with(|| Arc::new(PlatformEventJournal::new())),
    )
}

pub(crate) async fn attach_platform_event_journal(
    state: &AppState,
    session_id: &str,
    mut events: broadcast::Receiver<SessionEvent>,
) {
    let platform_owned = state
        .platform_playbook_gates
        .lock()
        .await
        .contains_key(session_id);
    if !platform_owned {
        return;
    }
    let journal = ensure_platform_event_journal(state, session_id);
    crate::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => journal.record(&event),
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    journal.mark_coverage_gap();
                    break;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    journal.mark_terminal();
                    break;
                }
            }
        }
    });
}

pub(crate) fn retain_platform_event_journals(
    journals: &mut PlatformEventJournals,
    ttl: Duration,
    mut session_is_live: impl FnMut(&str) -> bool,
) {
    journals.retain(|session_id, journal| session_is_live(session_id) || !journal.expired(ttl));
}

pub(crate) fn last_event_cursor(headers: &HeaderMap) -> Result<Option<u64>, StatusCode> {
    let mut values = headers.get_all("last-event-id").iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    if values.next().is_some() {
        return Err(StatusCode::BAD_REQUEST);
    }
    value
        .to_str()
        .ok()
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|value| value.parse().ok())
        .map(Some)
        .ok_or(StatusCode::BAD_REQUEST)
}

pub(crate) async fn stream_platform_events(
    state: AppState,
    session_id: String,
    cursor: u64,
) -> Response {
    let journal = state
        .platform_event_journals
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&session_id)
        .cloned();
    let Some(journal) = journal else {
        return (StatusCode::NOT_FOUND, "event journal not found").into_response();
    };
    let mut updates = journal.updates.subscribe();
    let Ok((mut replay, mut terminal)) = journal.snapshot_after(cursor) else {
        return (StatusCode::GONE, "event replay unavailable").into_response();
    };

    let stream = async_stream::stream! {
        let mut last_sequence = cursor;
        loop {
            while let Some(record) = replay.pop_front() {
                if record.sequence <= last_sequence {
                    continue;
                }
                last_sequence = record.sequence;
                yield Ok::<Event, Infallible>(Event::default()
                    .event("event")
                    .id(record.sequence.to_string())
                    .data(record.payload.as_ref()));
            }
            if terminal {
                break;
            }
            match updates.recv().await {
                Ok(PlatformEventUpdate::Event(record)) => {
                    if record.sequence <= last_sequence {
                        continue;
                    }
                    last_sequence = record.sequence;
                    yield Ok::<Event, Infallible>(Event::default()
                        .event("event")
                        .id(record.sequence.to_string())
                        .data(record.payload.as_ref()));
                }
                Ok(PlatformEventUpdate::Terminal) => break,
                Ok(PlatformEventUpdate::CoverageGap) => break,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    match journal.snapshot_after(last_sequence) {
                        Ok((recovered, is_terminal)) => {
                            replay = recovered;
                            terminal = is_terminal;
                        }
                        Err(PlatformReplayError::CoverageGap) => break,
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    let mut response = Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response();
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        "text/event-stream;charset=utf-8".parse().unwrap(),
    );
    response
}

fn platform_semantic_event(event: &SessionEvent) -> bool {
    matches!(
        event,
        SessionEvent::MediaReady { .. }
            | SessionEvent::AsrFinal { .. }
            | SessionEvent::Interruption { .. }
            | SessionEvent::Hold { .. }
            | SessionEvent::Inactivity { .. }
            | SessionEvent::FunctionCall { .. }
            | SessionEvent::Hangup { .. }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media_ready(timestamp: u64) -> SessionEvent {
        SessionEvent::MediaReady {
            track_id: "session-001".to_owned(),
            timestamp,
        }
    }

    #[test]
    fn records_only_platform_semantic_events_with_contiguous_sequences() {
        let journal = PlatformEventJournal::new();
        journal.record(&SessionEvent::Ping {
            timestamp: 1,
            payload: None,
        });
        journal.record(&media_ready(2));
        journal.record(&media_ready(3));

        let (records, terminal) = journal.snapshot_after(0).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].sequence, 1);
        assert_eq!(records[1].sequence, 2);
        assert!(!terminal);
    }

    #[test]
    fn eviction_is_an_explicit_replay_gap() {
        let journal = PlatformEventJournal::new();
        for timestamp in 0..=PLATFORM_EVENT_CAPACITY as u64 {
            journal.record(&media_ready(timestamp));
        }

        assert!(journal.snapshot_after(0).is_err());
        let (records, _) = journal.snapshot_after(1).unwrap();
        assert_eq!(records.len(), PLATFORM_EVENT_CAPACITY);
        assert_eq!(records.front().unwrap().sequence, 2);
    }

    #[test]
    fn recorder_loss_poisoning_never_returns_partial_replay() {
        let journal = PlatformEventJournal::new();
        journal.record(&media_ready(1));
        journal.mark_coverage_gap();

        assert!(journal.snapshot_after(0).is_err());
        assert!(journal.snapshot_after(1).is_err());
    }

    #[test]
    fn oversized_semantic_event_is_never_retained_as_partial_coverage() {
        let journal = PlatformEventJournal::new();
        journal.record(&SessionEvent::FunctionCall {
            track_id: "session-001".to_owned(),
            call_id: "tool-call-001".to_owned(),
            name: "lookup".to_owned(),
            arguments: "x".repeat(MAX_PLATFORM_EVENT_BYTES),
            timestamp: 1,
        });

        assert!(journal.snapshot_after(0).is_err());
    }
}
