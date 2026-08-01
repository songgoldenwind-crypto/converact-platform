use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use voice_media_rs::event_outbox::{
    EventReconcileState, ProcessingEventOutbox, ProcessingEventOutboxConfig,
    ProcessingEventOutboxError, ProcessingTerminalEvent, ProcessingTerminalEventInput,
};

static NEXT_DIRECTORY: AtomicU64 = AtomicU64::new(1);

#[test]
fn durable_outbox_replays_pending_events_and_preserves_monotonic_sequence() {
    let directory = TestDirectory::new();
    let path = directory.path().join("processing-events.wal");
    let first = event(
        "call-1",
        "media-1",
        "play-1",
        ProcessingTerminalEvent::PlaybackCompleted {
            prompt_id: "welcome".to_owned(),
        },
    );

    let outbox = ProcessingEventOutbox::open(config(&path)).expect("open event outbox");
    let appended = outbox.append(first.clone()).expect("append event");
    assert_eq!(appended.record.event_sequence, 1);
    assert!(!appended.replayed);

    let replayed = outbox.append(first).expect("replay event");
    assert_eq!(replayed.record, appended.record);
    assert!(replayed.replayed);
    drop(outbox);

    let reopened = ProcessingEventOutbox::open(config(&path)).expect("reopen event outbox");
    let scan = reopened.scan(0, 16).expect("scan pending events");
    assert_eq!(scan.items, vec![appended.record.clone()]);
    assert_eq!(scan.acknowledged_through, 0);
    assert_eq!(scan.next_sequence, 2);

    let second = reopened
        .append(event(
            "call-1",
            "media-1",
            "gather-1",
            ProcessingTerminalEvent::GatherCompleted {
                digits: "42".to_owned(),
                reason: "maximum_digits".to_owned(),
                minimum_satisfied: true,
            },
        ))
        .expect("append second event");
    assert_eq!(second.record.event_sequence, 2);
}

#[test]
fn durable_outbox_requires_identity_matched_contiguous_acknowledgement() {
    let directory = TestDirectory::new();
    let path = directory.path().join("processing-events.wal");
    let outbox = ProcessingEventOutbox::open(config(&path)).expect("open event outbox");
    let first = outbox
        .append(event(
            "call-2",
            "media-2",
            "play-2",
            ProcessingTerminalEvent::PlaybackStopped {
                prompt_id: "menu".to_owned(),
                reason: "barge_in".to_owned(),
            },
        ))
        .expect("append first event")
        .record;
    let second = outbox
        .append(event(
            "call-2",
            "media-2",
            "gather-2",
            ProcessingTerminalEvent::GatherCompleted {
                digits: "7".to_owned(),
                reason: "terminator".to_owned(),
                minimum_satisfied: true,
            },
        ))
        .expect("append second event")
        .record;

    assert_eq!(
        outbox.acknowledge(second.event_sequence, &second.event_id),
        Err(ProcessingEventOutboxError::AcknowledgementGap)
    );
    assert_eq!(
        outbox.acknowledge(first.event_sequence, "processing-event-wrong"),
        Err(ProcessingEventOutboxError::AcknowledgementIdentityConflict)
    );
    outbox
        .acknowledge(first.event_sequence, &first.event_id)
        .expect("ack first event");
    assert_eq!(
        outbox.reconcile(&first.event_id).expect("reconcile first"),
        EventReconcileState::Acknowledged(first.clone())
    );
    assert_eq!(
        outbox
            .reconcile(&second.event_id)
            .expect("reconcile second"),
        EventReconcileState::Pending(second.clone())
    );
    assert_eq!(
        outbox.scan(0, 16).expect("scan after ack").items,
        vec![second]
    );
}

#[test]
fn durable_outbox_rejects_payload_conflicts_and_pending_capacity_exhaustion() {
    let directory = TestDirectory::new();
    let path = directory.path().join("processing-events.wal");
    let mut bounded = config(&path);
    bounded.max_pending_events = 1;
    let outbox = ProcessingEventOutbox::open(bounded).expect("open event outbox");
    let first = event(
        "call-3",
        "media-3",
        "play-3",
        ProcessingTerminalEvent::PlaybackCompleted {
            prompt_id: "prompt-a".to_owned(),
        },
    );
    outbox.append(first.clone()).expect("append first event");

    let conflicting = event(
        "call-3",
        "media-3",
        "play-3",
        ProcessingTerminalEvent::PlaybackCompleted {
            prompt_id: "prompt-b".to_owned(),
        },
    );
    assert_eq!(
        outbox.append(conflicting),
        Err(ProcessingEventOutboxError::EventIdentityConflict)
    );
    assert_eq!(
        outbox.append(event(
            "call-3",
            "media-3",
            "gather-3",
            ProcessingTerminalEvent::GatherCompleted {
                digits: String::new(),
                reason: "timeout".to_owned(),
                minimum_satisfied: false,
            },
        )),
        Err(ProcessingEventOutboxError::PendingCapacityExhausted)
    );
}

#[test]
fn durable_outbox_discards_only_an_incomplete_tail_frame() {
    let directory = TestDirectory::new();
    let path = directory.path().join("processing-events.wal");
    let outbox = ProcessingEventOutbox::open(config(&path)).expect("open event outbox");
    let appended = outbox
        .append(event(
            "call-4",
            "media-4",
            "play-4",
            ProcessingTerminalEvent::PlaybackCompleted {
                prompt_id: "prompt".to_owned(),
            },
        ))
        .expect("append event")
        .record;
    drop(outbox);

    let stable_bytes = fs::metadata(&path).expect("journal metadata").len();
    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .expect("open journal tail");
    file.write_all(b"IVE1\x00\x00\x10")
        .expect("append incomplete frame");
    file.sync_all().expect("sync incomplete frame");

    let reopened = ProcessingEventOutbox::open(config(&path)).expect("recover journal");
    assert_eq!(
        reopened.scan(0, 16).expect("scan recovered journal").items,
        vec![appended]
    );
    assert_eq!(
        fs::metadata(&path).expect("recovered metadata").len(),
        stable_bytes
    );
}

#[test]
fn durable_outbox_rejects_a_second_writer_for_the_same_journal() {
    let directory = TestDirectory::new();
    let path = directory.path().join("processing-events.wal");
    let _first = ProcessingEventOutbox::open(config(&path)).expect("open first writer");
    assert!(matches!(
        ProcessingEventOutbox::open(config(&path)),
        Err(ProcessingEventOutboxError::JournalLocked)
    ));
}

#[test]
fn durable_outbox_fails_closed_on_a_complete_corrupt_frame() {
    let directory = TestDirectory::new();
    let path = directory.path().join("processing-events.wal");
    let outbox = ProcessingEventOutbox::open(config(&path)).expect("open event outbox");
    outbox
        .append(event(
            "call-5",
            "media-5",
            "play-5",
            ProcessingTerminalEvent::PlaybackCompleted {
                prompt_id: "prompt".to_owned(),
            },
        ))
        .expect("append event");
    drop(outbox);

    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .expect("open journal");
    let length = file.metadata().expect("journal metadata").len();
    file.seek(SeekFrom::Start(length - 1))
        .expect("seek journal tail");
    let mut byte = [0_u8; 1];
    file.read_exact(&mut byte).expect("read journal tail");
    byte[0] ^= 0xff;
    file.seek(SeekFrom::Start(length - 1))
        .expect("seek journal tail again");
    file.write_all(&byte).expect("corrupt complete frame");
    file.sync_all().expect("sync corruption");
    drop(file);

    assert!(matches!(
        ProcessingEventOutbox::open(config(&path)),
        Err(ProcessingEventOutboxError::JournalCorrupt)
    ));
}

#[test]
fn durable_outbox_compacts_acknowledged_history_without_reusing_sequence() {
    let directory = TestDirectory::new();
    let path = directory.path().join("processing-events.wal");
    let mut bounded = config(&path);
    bounded.max_acknowledged_events = 2;
    let outbox = ProcessingEventOutbox::open(bounded.clone()).expect("open event outbox");
    let mut records = Vec::new();
    for index in 1..=6 {
        let record = outbox
            .append(event(
                "call-6",
                "media-6",
                &format!("gather-{index}"),
                ProcessingTerminalEvent::GatherCompleted {
                    digits: index.to_string(),
                    reason: "maximum_digits".to_owned(),
                    minimum_satisfied: true,
                },
            ))
            .expect("append event")
            .record;
        outbox
            .acknowledge(record.event_sequence, &record.event_id)
            .expect("ack event");
        records.push(record);
    }
    drop(outbox);

    let reopened = ProcessingEventOutbox::open(bounded).expect("reopen compacted outbox");
    let scan = reopened.scan(0, 16).expect("scan compacted outbox");
    assert!(scan.items.is_empty());
    assert_eq!(scan.acknowledged_through, 6);
    assert_eq!(scan.next_sequence, 7);
    assert_eq!(
        reopened
            .reconcile(&records[0].event_id)
            .expect("reconcile evicted history"),
        EventReconcileState::NotFound
    );
    assert_eq!(
        reopened
            .reconcile(&records[5].event_id)
            .expect("reconcile retained history"),
        EventReconcileState::Acknowledged(records[5].clone())
    );
    assert_eq!(
        reopened
            .append(event(
                "call-6",
                "media-6",
                "gather-7",
                ProcessingTerminalEvent::GatherCompleted {
                    digits: "7".to_owned(),
                    reason: "maximum_digits".to_owned(),
                    minimum_satisfied: true,
                },
            ))
            .expect("append after compaction")
            .record
            .event_sequence,
        7
    );
}

fn config(path: &Path) -> ProcessingEventOutboxConfig {
    ProcessingEventOutboxConfig {
        path: path.to_path_buf(),
        max_pending_events: 16,
        max_acknowledged_events: 8,
        max_bytes: 1024 * 1024,
        max_record_bytes: 64 * 1024,
    }
}

fn event(
    call_id: &str,
    media_reservation_id: &str,
    command_id: &str,
    event: ProcessingTerminalEvent,
) -> ProcessingTerminalEventInput {
    ProcessingTerminalEventInput {
        tenant_id: "tenant-1".to_owned(),
        call_id: call_id.to_owned(),
        cell_id: "cell-a".to_owned(),
        owner_node_id: "rustpbx-a".to_owned(),
        owner_epoch: "7".to_owned(),
        media_reservation_id: media_reservation_id.to_owned(),
        command_id: command_id.to_owned(),
        occurred_at_ms: 1_785_200_000_000,
        event,
    }
}

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new() -> Self {
        let sequence = NEXT_DIRECTORY.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "converact-processing-event-outbox-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create test directory");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.path).expect("remove test directory");
    }
}
