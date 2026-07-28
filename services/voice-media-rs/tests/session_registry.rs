use std::sync::Arc;
use std::thread;
use voice_media_rs::capacity::CodecPairCapacity;
use voice_media_rs::codec::{AudioCodec, CodecPair};
use voice_media_rs::session::{
    ProcessingAction, ProcessingCommand, ProcessingProfile, ProcessingSessionRegistry,
    ProcessingSessionRegistryConfig, ProcessingSessionState, ReconcileCommand, SessionError,
};

fn profile() -> ProcessingProfile {
    ProcessingProfile {
        leg_a_codec: AudioCodec::Pcmu,
        leg_b_codec: AudioCodec::Opus,
        packetization_ms: 20,
        leg_a_payload_type: 0,
        leg_b_payload_type: 111,
    }
}

fn config() -> ProcessingSessionRegistryConfig {
    ProcessingSessionRegistryConfig {
        max_sessions: 32,
        max_commands_per_session: 8,
        terminal_retention_ms: 100,
        max_lease_horizon_ms: 60_000,
        shard_count: 8,
        rtp_port_start: 20_000,
        rtp_port_end: 20_030,
    }
}

fn command(
    reservation: &str,
    action: ProcessingAction,
    sequence: u32,
    epoch: u64,
) -> ProcessingCommand {
    ProcessingCommand {
        action,
        command_id: format!("cmd-{epoch}-{sequence}"),
        tenant_id: "tenant-a".to_owned(),
        call_id: format!("call-{reservation}"),
        leg_id: "leg-a".to_owned(),
        cell_id: "cell-a".to_owned(),
        owner_node_id: format!("owner-{epoch}"),
        owner_epoch: epoch,
        admission_reservation_id: format!("admission-{reservation}"),
        media_reservation_id: reservation.to_owned(),
        command_sequence: sequence,
        idempotency_key: format!("idem-{epoch}-{sequence}"),
        expires_at_ms: 10_000,
        command_hash: [sequence as u8; 32],
        idempotency_hash: [(sequence as u8).wrapping_add(64); 32],
        profile: (action == ProcessingAction::Offer).then(profile),
    }
}

fn new_registry(capacity: Arc<CodecPairCapacity>) -> ProcessingSessionRegistry {
    ProcessingSessionRegistry::new(config(), capacity).expect("processing session registry")
}

#[test]
fn lifecycle_allocates_once_commits_and_releases_all_resources() {
    let capacity = Arc::new(CodecPairCapacity::uniform(4));
    let registry = new_registry(Arc::clone(&capacity));
    let forward = CodecPair::new(AudioCodec::Pcmu, AudioCodec::Opus).expect("pair");
    let reverse = CodecPair::new(AudioCodec::Opus, AudioCodec::Pcmu).expect("pair");
    let available_ports = registry.available_port_count();

    let offer = command("media-1", ProcessingAction::Offer, 1, 1);
    let prepared = registry.execute(offer.clone(), 1_000).expect("offer");
    assert_eq!(prepared.snapshot.state, ProcessingSessionState::Prepared);
    assert!(prepared.snapshot.resources_active);
    assert_eq!(prepared.snapshot.last_sequence, 1);
    assert_eq!(capacity.snapshot(forward).used, 1);
    assert_eq!(capacity.snapshot(reverse).used, 1);
    assert_eq!(registry.available_port_count(), available_ports - 2);

    let replay = registry.execute(offer, 1_001).expect("offer replay");
    assert!(replay.replayed);
    assert_eq!(replay.applied_command_id, "cmd-1-1");
    assert_eq!(capacity.snapshot(forward).used, 1);
    assert_eq!(registry.active_session_count(), 1);

    let committed = registry
        .execute(command("media-1", ProcessingAction::Answer, 2, 1), 1_002)
        .expect("answer");
    assert_eq!(committed.snapshot.state, ProcessingSessionState::Committed);

    registry
        .execute(command("media-1", ProcessingAction::Update, 3, 1), 1_003)
        .expect("update");
    let queried = registry
        .execute(command("media-1", ProcessingAction::Query, 4, 1), 1_004)
        .expect("query");
    assert_eq!(queried.snapshot.state, ProcessingSessionState::Committed);

    let delete = command("media-1", ProcessingAction::Delete, 5, 1);
    let closed = registry.execute(delete.clone(), 1_005).expect("delete");
    assert_eq!(closed.snapshot.state, ProcessingSessionState::Closed);
    assert!(!closed.snapshot.resources_active);
    assert_eq!(capacity.snapshot(forward).used, 0);
    assert_eq!(capacity.snapshot(reverse).used, 0);
    assert_eq!(registry.available_port_count(), available_ports);
    assert_eq!(registry.active_session_count(), 0);
    assert_eq!(registry.session_count(), 1);

    let reconciled = registry
        .reconcile(ReconcileCommand {
            media_reservation_id: delete.media_reservation_id,
            owner_epoch: delete.owner_epoch,
            command_id: delete.command_id,
            command_hash: delete.command_hash,
        })
        .expect("reconcile")
        .expect("recorded delete");
    assert!(reconciled.replayed);
    assert_eq!(reconciled.snapshot.state, ProcessingSessionState::Closed);
    assert!(registry
        .reconcile(ReconcileCommand {
            media_reservation_id: "media-1".to_owned(),
            owner_epoch: 1,
            command_id: "cmd-unknown".to_owned(),
            command_hash: [42; 32],
        })
        .expect("unknown reconcile")
        .is_none());
}

#[test]
fn command_and_idempotency_replay_are_conflict_safe() {
    let capacity = Arc::new(CodecPairCapacity::uniform(4));
    let registry = new_registry(capacity);
    let offer = command("media-2", ProcessingAction::Offer, 1, 1);
    registry.execute(offer.clone(), 1_000).expect("offer");

    let mut command_conflict = offer.clone();
    command_conflict.command_hash = [99; 32];
    assert_eq!(
        registry
            .execute(command_conflict, 1_001)
            .expect_err("command hash conflict"),
        SessionError::CommandPayloadConflict
    );

    let mut idempotent_replay = command("media-2", ProcessingAction::Offer, 2, 1);
    idempotent_replay.command_id = "cmd-retry".to_owned();
    idempotent_replay.idempotency_key = offer.idempotency_key.clone();
    idempotent_replay.idempotency_hash = offer.idempotency_hash;
    let replayed = registry
        .execute(idempotent_replay, 1_002)
        .expect("idempotent replay");
    assert!(replayed.replayed);
    assert_eq!(replayed.snapshot.last_sequence, 1);

    let mut idempotency_conflict = command("media-2", ProcessingAction::Offer, 2, 1);
    idempotency_conflict.command_id = "cmd-conflict".to_owned();
    idempotency_conflict.idempotency_key = offer.idempotency_key;
    assert_eq!(
        registry
            .execute(idempotency_conflict, 1_003)
            .expect_err("idempotency conflict"),
        SessionError::IdempotencyKeyConflict
    );
}

#[test]
fn owner_epoch_and_sequence_fence_every_mutation() {
    let capacity = Arc::new(CodecPairCapacity::uniform(4));
    let registry = new_registry(capacity);
    registry
        .execute(command("media-3", ProcessingAction::Offer, 1, 2), 1_000)
        .expect("offer");
    registry
        .execute(command("media-3", ProcessingAction::Answer, 2, 2), 1_001)
        .expect("answer");

    assert_eq!(
        registry
            .execute(command("media-3", ProcessingAction::Query, 3, 1), 1_002,)
            .expect_err("stale owner"),
        SessionError::StaleOwnerEpoch
    );
    assert_eq!(
        registry
            .execute(command("media-3", ProcessingAction::Query, 2, 3), 1_003,)
            .expect_err("takeover must restart sequence"),
        SessionError::OwnerTakeoverSequenceInvalid
    );

    let takeover = registry
        .execute(command("media-3", ProcessingAction::Query, 1, 3), 1_004)
        .expect("owner takeover");
    assert_eq!(takeover.snapshot.owner_epoch, 3);
    assert_eq!(takeover.snapshot.last_sequence, 1);

    assert_eq!(
        registry
            .execute(command("media-3", ProcessingAction::Query, 3, 3), 1_005,)
            .expect_err("sequence gap"),
        SessionError::SequenceGap {
            expected: 2,
            actual: 3,
        }
    );
    assert_eq!(
        registry
            .execute(command("media-3", ProcessingAction::Query, 3, 2), 1_006,)
            .expect_err("old owner remains fenced"),
        SessionError::StaleOwnerEpoch
    );
}

#[test]
fn partial_codec_and_port_admission_failures_are_fully_compensated() {
    let forward = CodecPair::new(AudioCodec::Pcmu, AudioCodec::Opus).expect("pair");
    let reverse = CodecPair::new(AudioCodec::Opus, AudioCodec::Pcmu).expect("pair");
    let limits = CodecPair::ALL.map(|codec_pair| if codec_pair == reverse { 0 } else { 1 });
    let capacity = Arc::new(CodecPairCapacity::from_limits(limits));
    let registry = new_registry(Arc::clone(&capacity));
    let ports = registry.available_port_count();

    assert_eq!(
        registry
            .execute(
                command("media-codec-full", ProcessingAction::Offer, 1, 1),
                1_000,
            )
            .expect_err("reverse codec pair exhausted"),
        SessionError::CodecCapacityExhausted {
            pair: reverse,
            limit: 0,
        }
    );
    assert_eq!(capacity.snapshot(forward).used, 0);
    assert_eq!(capacity.snapshot(reverse).used, 0);
    assert_eq!(registry.available_port_count(), ports);
    assert_eq!(registry.session_count(), 0);

    let capacity = Arc::new(CodecPairCapacity::uniform(2));
    let mut port_limited = config();
    port_limited.rtp_port_start = 21_000;
    port_limited.rtp_port_end = 21_002;
    let registry = ProcessingSessionRegistry::new(port_limited, Arc::clone(&capacity))
        .expect("port-limited registry");
    registry
        .execute(
            command("media-port-1", ProcessingAction::Offer, 1, 1),
            1_000,
        )
        .expect("first offer");
    assert_eq!(
        registry
            .execute(
                command("media-port-2", ProcessingAction::Offer, 1, 1),
                1_001,
            )
            .expect_err("ports exhausted"),
        SessionError::PortCapacityExhausted
    );
    assert_eq!(capacity.snapshot(forward).used, 1);
    assert_eq!(capacity.snapshot(reverse).used, 1);
    assert_eq!(registry.session_count(), 1);
}

#[test]
fn expired_prepared_sessions_release_resources_but_committed_media_survives() {
    let capacity = Arc::new(CodecPairCapacity::uniform(4));
    let registry = new_registry(Arc::clone(&capacity));
    let mut offer = command("media-expire", ProcessingAction::Offer, 1, 1);
    offer.expires_at_ms = 1_010;
    registry.execute(offer, 1_000).expect("offer");

    let expired = registry.sweep(1_011, 32).expect("expiry sweep");
    assert_eq!(expired.expired, 1);
    assert_eq!(registry.active_session_count(), 0);
    assert_eq!(
        registry
            .snapshot("media-expire")
            .expect("expired snapshot")
            .state,
        ProcessingSessionState::Expired
    );

    let evicted = registry.sweep(1_111, 32).expect("terminal sweep");
    assert_eq!(evicted.evicted, 1);
    assert_eq!(registry.session_count(), 0);

    let committed = new_registry(Arc::new(CodecPairCapacity::uniform(4)));
    let mut durable_offer = command("media-committed", ProcessingAction::Offer, 1, 1);
    durable_offer.expires_at_ms = 1_010;
    committed
        .execute(durable_offer, 1_000)
        .expect("durable offer");
    committed
        .execute(
            command("media-committed", ProcessingAction::Answer, 2, 1),
            1_001,
        )
        .expect("commit");
    let report = committed.sweep(50_000, 32).expect("committed sweep");
    assert_eq!(report.expired, 0);
    assert_eq!(committed.active_session_count(), 1);
    assert_eq!(
        committed
            .snapshot("media-committed")
            .expect("committed snapshot")
            .state,
        ProcessingSessionState::Committed
    );
}

#[test]
fn bounded_sweeps_eventually_visit_every_shard_and_session() {
    let capacity = Arc::new(CodecPairCapacity::uniform(8));
    let mut sweep_config = config();
    sweep_config.terminal_retention_ms = 100_000;
    let registry = ProcessingSessionRegistry::new(sweep_config, capacity).expect("registry");

    for index in 0..8 {
        let mut offer = command(
            &format!("media-sweep-{index}"),
            ProcessingAction::Offer,
            1,
            1,
        );
        offer.expires_at_ms = 1_010;
        registry.execute(offer, 1_000).expect("offer");
    }

    let mut expired = 0;
    for _ in 0..64 {
        expired += registry.sweep(1_011, 1).expect("bounded sweep").expired;
        if expired == 8 {
            break;
        }
    }
    assert_eq!(expired, 8);
    assert_eq!(registry.active_session_count(), 0);
}

#[test]
fn journal_and_session_counts_are_hard_bounded() {
    let capacity = Arc::new(CodecPairCapacity::uniform(4));
    let mut bounded = config();
    bounded.max_sessions = 1;
    bounded.max_commands_per_session = 4;
    let registry = ProcessingSessionRegistry::new(bounded, capacity).expect("registry");

    registry
        .execute(command("media-bound", ProcessingAction::Offer, 1, 1), 1_000)
        .expect("offer");
    registry
        .execute(
            command("media-bound", ProcessingAction::Answer, 2, 1),
            1_001,
        )
        .expect("answer");
    for sequence in 3..=6 {
        registry
            .execute(
                command("media-bound", ProcessingAction::Query, sequence, 1),
                1_000 + u64::from(sequence),
            )
            .expect("query");
    }
    assert_eq!(registry.command_count("media-bound"), 4);

    assert_eq!(
        registry
            .execute(
                command("media-overflow", ProcessingAction::Offer, 1, 1),
                1_010,
            )
            .expect_err("session bound"),
        SessionError::SessionCapacityExhausted { limit: 1 }
    );
}

#[test]
fn concurrent_replay_creates_exactly_one_session_and_one_resource_lease() {
    let capacity = Arc::new(CodecPairCapacity::uniform(8));
    let registry = Arc::new(new_registry(Arc::clone(&capacity)));
    let command = command("media-race", ProcessingAction::Offer, 1, 1);
    let mut workers = Vec::new();

    for _ in 0..16 {
        let registry = Arc::clone(&registry);
        let command = command.clone();
        workers.push(thread::spawn(move || {
            registry.execute(command, 1_000).expect("replay")
        }));
    }

    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().expect("worker"))
        .collect();
    assert_eq!(results.iter().filter(|result| !result.replayed).count(), 1);
    assert_eq!(results.iter().filter(|result| result.replayed).count(), 15);
    assert_eq!(registry.session_count(), 1);
    assert_eq!(registry.active_session_count(), 1);

    let forward = CodecPair::new(AudioCodec::Pcmu, AudioCodec::Opus).expect("pair");
    let reverse = CodecPair::new(AudioCodec::Opus, AudioCodec::Pcmu).expect("pair");
    assert_eq!(capacity.snapshot(forward).used, 1);
    assert_eq!(capacity.snapshot(reverse).used, 1);
}

#[test]
#[ignore = "100k bounded-state stress test"]
fn one_hundred_thousand_terminal_sessions_stay_within_declared_bounds() {
    let capacity = Arc::new(CodecPairCapacity::uniform(1));
    let mut stress_config = config();
    stress_config.max_sessions = 100_000;
    stress_config.max_commands_per_session = 4;
    stress_config.terminal_retention_ms = u64::MAX;
    stress_config.shard_count = 256;
    stress_config.rtp_port_start = 22_000;
    stress_config.rtp_port_end = 22_002;
    let registry = ProcessingSessionRegistry::new(stress_config, Arc::clone(&capacity))
        .expect("stress registry");

    for index in 0..100_000 {
        let reservation = format!("media-stress-{index}");
        registry
            .execute(command(&reservation, ProcessingAction::Offer, 1, 1), 1_000)
            .expect("stress offer");
        registry
            .execute(command(&reservation, ProcessingAction::Delete, 2, 1), 1_001)
            .expect("stress delete");
    }

    assert_eq!(registry.session_count(), 100_000);
    assert_eq!(registry.active_session_count(), 0);
    assert_eq!(registry.available_port_count(), 2);
    assert_eq!(
        registry
            .execute(
                command("media-stress-overflow", ProcessingAction::Offer, 1, 1,),
                1_002,
            )
            .expect_err("100k bound"),
        SessionError::SessionCapacityExhausted { limit: 100_000 }
    );

    let forward = CodecPair::new(AudioCodec::Pcmu, AudioCodec::Opus).expect("pair");
    let reverse = CodecPair::new(AudioCodec::Opus, AudioCodec::Pcmu).expect("pair");
    assert_eq!(capacity.snapshot(forward).used, 0);
    assert_eq!(capacity.snapshot(reverse).used, 0);
}
