import {
  MEDIA_CONTROL_PROTOCOL_VERSION,
  checkedMediaControlCommand,
  checkedMediaControlReconcileInput,
  compareMediaOwnerEpoch,
  mediaControlCommandHash,
  mediaControlIdempotencyHash,
  type MediaControlAction,
  type MediaControlCommand,
  type MediaControlReconcileInput,
  type MediaControlResult,
  type MediaSessionSnapshot,
  type MediaSessionState
} from './protocol.js';
import type {
  MediaTransportCommand,
  MediaTransportOutcome,
  MediaTransportPort,
  MediaTransportSessionSnapshot
} from './transport.js';
import {
  MediaControlMetrics,
  type MediaControlMetricSessionState
} from './metrics.js';
import { KeyedSerialExecutor } from './serial-executor.js';

const MAX_MEDIA_CONTROL_LEASE_HORIZON_MS = 60_000;

export interface MediaControlAuthorization {
  owner_epoch: string;
  reservation_expires_at: string;
  node_lease_expires_at: string;
}

export interface MediaControlAuthorizationFailure {
  admission_reservation_id: string;
  call_id: string;
  owner_epoch: string;
  operation: 'open' | 'mutate' | 'close';
  error_code: string;
  status: number;
  retryable: boolean;
}

export interface MediaControlAuthorityPort {
  authorize(input: {
    admission_reservation_id: string;
    call_id: string;
    owner_epoch: string;
    operation: 'open' | 'mutate' | 'close';
  }, now: Date): Promise<MediaControlAuthorization>;
}

export interface MediaControlOrphanProof {
  owner_exists: boolean;
  session_exists: boolean;
}

export interface MediaControlOrphanProbe {
  inspect(input: {
    tenant_id: string;
    call_id: string;
    cell_id: string;
    owner_node_id: string;
    owner_epoch: string;
    media_reservation_id: string;
    reservation_expires_at: string;
  }, now: Date): Promise<MediaControlOrphanProof>;
}

interface RecordedCommand {
  hash: string;
  idempotency_hash: string;
  command: MediaControlCommand;
  result: MediaControlResult;
}

interface MediaControlRecord {
  media_reservation_id: string;
  tenant_id: string;
  call_id: string;
  leg_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  last_sequence: number;
  expires_at: string;
  session?: MediaSessionSnapshot;
  commands: Map<string, RecordedCommand>;
  idempotency_keys: Map<string, string>;
  unresolved_command_id: string;
  terminal_at: number;
  metric_state: MediaControlMetricSessionState;
  deadline_revision: number;
  deadline_at: number;
  deadline_kind: '' | 'lease' | 'evict';
  cleanup_retry_count: number;
}

interface MediaControlDeadline {
  at: number;
  media_reservation_id: string;
  revision: number;
  kind: 'lease' | 'evict';
}

export class MediaControlAgent {
  readonly #authority: MediaControlAuthorityPort;
  readonly #transport: MediaTransportPort;
  readonly #maxReservations: number;
  readonly #maxTerminalReservations: number;
  readonly #maxCommandsPerReservation: number;
  readonly #terminalRetentionMs: number;
  readonly #orphanProbe?: MediaControlOrphanProbe;
  readonly #orphanBatchSize: number;
  readonly #metrics: MediaControlMetrics;
  readonly #authorizationFailureObserver?: (
    failure: MediaControlAuthorizationFailure
  ) => void;
  readonly #records = new Map<string, MediaControlRecord>();
  readonly #deadlines: MediaControlDeadline[] = [];
  readonly #terminalOrder: MediaControlDeadline[] = [];
  readonly #serial = new KeyedSerialExecutor();
  #activeReservations = 0;
  #terminalReservations = 0;
  #orphanCursor = '';

  constructor(input: {
    authority: MediaControlAuthorityPort;
    transport: MediaTransportPort;
    max_reservations?: number;
    max_terminal_reservations?: number;
    max_commands_per_reservation?: number;
    terminal_retention_ms?: number;
    orphan_probe?: MediaControlOrphanProbe;
    orphan_batch_size?: number;
    metrics?: MediaControlMetrics;
    authorization_failure_observer?: (
      failure: MediaControlAuthorizationFailure
    ) => void;
  }) {
    this.#authority = input.authority;
    this.#transport = input.transport;
    this.#maxReservations = boundedInteger(
      input.max_reservations ?? 100_000,
      1,
      1_000_000,
      'max_reservations'
    );
    this.#maxTerminalReservations = boundedInteger(
      input.max_terminal_reservations ?? this.#maxReservations,
      1,
      1_000_000,
      'max_terminal_reservations'
    );
    this.#maxCommandsPerReservation = boundedInteger(
      input.max_commands_per_reservation ?? 16,
      4,
      256,
      'max_commands_per_reservation'
    );
    this.#terminalRetentionMs = boundedInteger(
      input.terminal_retention_ms ?? 300_000,
      1_000,
      86_400_000,
      'terminal_retention_ms'
    );
    this.#orphanProbe = input.orphan_probe;
    this.#orphanBatchSize = boundedInteger(
      input.orphan_batch_size ?? 256,
      1,
      10_000,
      'orphan_batch_size'
    );
    this.#metrics = input.metrics ?? new MediaControlMetrics();
    this.#authorizationFailureObserver =
      input.authorization_failure_observer;
  }

  async execute(
    rawCommand: MediaControlCommand,
    now: Date
  ): Promise<MediaControlResult> {
    const timestamp = validNow(now);
    let command: MediaControlCommand;
    let hash: string;
    let idempotencyHash: string;
    try {
      command = checkedMediaControlCommand(rawCommand);
      hash = mediaControlCommandHash(command);
      idempotencyHash = mediaControlIdempotencyHash(command);
    } catch (error) {
      throw protocolError(error);
    }

    try {
      return await this.#serial.run(command.media_reservation_id, () =>
        this.#executeChecked(
          command,
          hash,
          idempotencyHash,
          timestamp,
          now
        )
      );
    } catch (error) {
      if (!(error instanceof MediaControlError)) throw error;
      const result = this.#projectControlError(command, error);
      this.#metrics.recordCommand(command.action, result.result_class);
      return result;
    }
  }

  async #executeChecked(
    command: MediaControlCommand,
    hash: string,
    idempotencyHash: string,
    timestamp: number,
    now: Date
  ): Promise<MediaControlResult> {
    let record = this.#records.get(command.media_reservation_id);
    if (record) {
      this.#assertIdentity(record, command);
      const epochComparison = compareMediaOwnerEpoch(
        command.owner_epoch,
        record.owner_epoch
      );
      if (epochComparison < 0) {
        throw new MediaControlError('stale_owner_epoch', 409, false);
      }
      if (epochComparison === 0) {
        const replay = record.commands.get(command.command_id);
        if (replay) {
          if (replay.hash !== hash) {
            throw new MediaControlError(
              'command_payload_conflict',
              409,
              false
            );
          }
          const result = this.#publicRecordedResult(record, replay);
          this.#metrics.recordCommand(command.action, result.result_class);
          return result;
        }
        const idempotentCommandId = record.idempotency_keys.get(
          command.idempotency_key
        );
        const idempotentReplay = idempotentCommandId
          ? record.commands.get(idempotentCommandId)
          : undefined;
        if (idempotentReplay) {
          if (idempotentReplay.idempotency_hash !== idempotencyHash) {
            throw new MediaControlError(
              'idempotency_key_conflict',
              409,
              false
            );
          }
          const result = this.#publicRecordedResult(
            record,
            idempotentReplay,
            command.command_id
          );
          this.#metrics.recordCommand(command.action, result.result_class);
          return result;
        }
      }
    }

    if (command.action !== 'delete') {
      const expiresAt = Date.parse(command.expires_at);
      if (expiresAt <= timestamp) {
        throw new MediaControlError('media_control_lease_expired', 409, true);
      }
      if (expiresAt > timestamp + MAX_MEDIA_CONTROL_LEASE_HORIZON_MS) {
        throw new MediaControlError(
          'media_control_lease_horizon_exceeded',
          400,
          false
        );
      }
    }

    await this.#authorize(command, now);
    if (!record) {
      const recovered = await this.#recoverFromTransport(
        command,
        hash,
        idempotencyHash,
        timestamp
      );
      record = recovered.record;
      if (recovered.result) {
        this.#metrics.recordCommand(
          command.action,
          recovered.result.result_class
        );
        return structuredClone(recovered.result);
      }
    }
    if (!record && command.action !== 'offer') {
      throw new MediaControlError('media_session_not_found', 404, false);
    }
    if (!record && this.#activeReservations >= this.#maxReservations) {
      throw new MediaControlError(
        'media_control_capacity_exhausted',
        503,
        true
      );
    }

    if (record && compareMediaOwnerEpoch(command.owner_epoch, record.owner_epoch) > 0) {
      if (command.command_sequence !== 1) {
        throw new MediaControlError('owner_takeover_sequence_invalid', 409, false);
      }
      record.owner_epoch = command.owner_epoch;
      record.owner_node_id = command.owner_node_id;
      record.last_sequence = 0;
      record.commands.clear();
      record.idempotency_keys.clear();
      record.unresolved_command_id = '';
      if (record.session) record.session.owner_epoch = command.owner_epoch;
    }

    if (!record) {
      if (command.command_sequence !== 1) {
        throw new MediaControlError('sequence_gap', 409, false);
      }
      record = this.#createRecord(command, 'pending');
    }

    if (record.unresolved_command_id) {
      throw new MediaControlError('command_reconciliation_required', 409, true);
    }
    if (command.command_sequence <= record.last_sequence) {
      throw new MediaControlError('stale_sequence', 409, false);
    }
    if (command.command_sequence !== record.last_sequence + 1) {
      throw new MediaControlError('sequence_gap', 409, false);
    }
    if (!this.#makeJournalSpace(record)) {
      throw new MediaControlError('command_journal_exhausted', 503, true);
    }
    this.#assertTransition(record, command);

    const transportCommand = this.#transportCommand(record, command);
    const outcome = await this.#executeTransport(transportCommand);
    const result = this.#applyOutcome(record, command, outcome, timestamp);
    if (result.result_class === 'committed' ||
        result.result_class === 'unknown') {
      record.last_sequence = command.command_sequence;
    }
    record.expires_at = command.expires_at;
    record.unresolved_command_id =
      result.result_class === 'unknown' ? command.command_id : '';
    record.commands.set(
      command.command_id,
      compactRecordedCommand(command, hash, idempotencyHash, result)
    );
    record.idempotency_keys.set(
      command.idempotency_key,
      command.command_id
    );
    this.#metrics.recordCommand(command.action, result.result_class);
    this.#scheduleRecord(record);
    return structuredClone(result);
  }

  async reconcile(
    rawInput: MediaControlReconcileInput,
    now: Date
  ): Promise<MediaControlResult> {
    const timestamp = validNow(now);
    let input: MediaControlReconcileInput;
    try {
      input = checkedMediaControlReconcileInput(rawInput);
    } catch (error) {
      throw protocolError(error);
    }
    try {
      return await this.#serial.run(input.command.media_reservation_id, () =>
        this.#reconcileChecked(input, timestamp, now)
      );
    } catch (error) {
      if (!(error instanceof MediaControlError)) throw error;
      const result = this.#projectControlError(input.command, error);
      this.#metrics.recordReconciliation(result.result_class);
      return result;
    }
  }

  async #reconcileChecked(
    input: MediaControlReconcileInput,
    timestamp: number,
    now: Date
  ): Promise<MediaControlResult> {
    const command = input.command;
    const hash = mediaControlCommandHash(command);
    const record = this.#records.get(command.media_reservation_id);
    if (!record) {
      const result = await this.#executeChecked(
        command,
        hash,
        mediaControlIdempotencyHash(command),
        timestamp,
        now
      );
      this.#metrics.recordReconciliation(result.result_class);
      return result;
    }
    if (record.call_id !== command.call_id) {
      throw new MediaControlError('media_session_not_found', 404, false);
    }
    const comparison = compareMediaOwnerEpoch(
      command.owner_epoch,
      record.owner_epoch
    );
    if (comparison !== 0) {
      throw new MediaControlError(
        comparison < 0 ? 'stale_owner_epoch' : 'owner_epoch_ahead',
        409,
        comparison > 0
      );
    }
    const recorded = record.commands.get(command.command_id);
    if (!recorded) {
      throw new MediaControlError('media_command_not_found', 404, false);
    }
    if (recorded.hash !== hash) {
      throw new MediaControlError('command_payload_conflict', 409, false);
    }
    await this.#authorize(recorded.command, now);
    if (recorded.result.result_class !== 'unknown') {
      return this.#publicRecordedResult(record, recorded);
    }

    const query = await this.#transport.queryCommand({
      command_id: command.command_id,
      media_reservation_id: command.media_reservation_id,
      owner_epoch: command.owner_epoch,
      command_hash: recorded.hash
    });
    const outcome = query.found
      ? query.outcome
      : await this.#executeTransport(
          this.#transportCommand(record, recorded.command)
        );
    const result = this.#applyOutcome(
      record,
      recorded.command,
      outcome,
      timestamp
    );
    recorded.result = structuredClone(result);
    record.unresolved_command_id =
      result.result_class === 'unknown' ? command.command_id : '';
    if (result.result_class !== 'unknown' &&
        result.result_class !== 'committed' &&
        result.result_class !== 'replayed') {
      record.last_sequence = command.command_sequence - 1;
    }
    this.#metrics.recordReconciliation(result.result_class);
    this.#scheduleRecord(record);
    return structuredClone(result);
  }

  session(reservationId: string): MediaSessionSnapshot | undefined {
    const session = this.#records.get(reservationId)?.session;
    return session ? structuredClone(session) : undefined;
  }

  reservationCount(): number {
    return this.#records.size;
  }

  activeReservationCount(): number {
    return this.#activeReservations;
  }

  terminalReservationCount(): number {
    return this.#terminalReservations;
  }

  renderMetrics(): string {
    return this.#metrics.render();
  }

  async sweep(now: Date): Promise<number> {
    const timestamp = validNow(now);
    let expired = 0;
    while (this.#deadlines[0] && this.#deadlines[0].at <= timestamp) {
      const deadline = popDeadline(this.#deadlines)!;
      expired += await this.#serial.run(deadline.media_reservation_id, async () => {
        const record = this.#records.get(deadline.media_reservation_id);
        if (!record || deadline.revision !== record.deadline_revision) return 0;
        record.deadline_at = 0;
        record.deadline_kind = '';
        if (deadline.kind === 'evict') {
          this.#removeRecord(record);
          return 0;
        }
        return this.#expireLease(record, now, timestamp);
      });
    }
    return expired;
  }

  async sweepOrphans(
    now: Date,
    requestedLimit = this.#orphanBatchSize
  ): Promise<{
    inspected: number;
    released: number;
    deferred: number;
  }> {
    const timestamp = validNow(now);
    const limit = boundedInteger(
      requestedLimit,
      1,
      this.#orphanBatchSize,
      'orphan_sweep_limit'
    );
    const result = { inspected: 0, released: 0, deferred: 0 };
    if (!this.#orphanProbe) return result;

    const page = await this.#transport.scanOrphanCandidates({
      after: this.#orphanCursor,
      limit
    });
    this.#orphanCursor = page.next_cursor;
    for (const candidate of page.items) {
      const expiresAt = Date.parse(candidate.expires_at);
      if (!Number.isFinite(expiresAt)) {
        result.inspected += 1;
        result.deferred += 1;
        continue;
      }
      if (expiresAt > timestamp) continue;
      await this.#serial.run(candidate.media_reservation_id, async () => {
        const record = this.#records.get(candidate.media_reservation_id);
        if (record && (
          record.terminal_at > 0 ||
          record.call_id !== candidate.call_id ||
          record.owner_epoch !== candidate.owner_epoch ||
          record.owner_node_id !== candidate.owner_node_id
        )) {
          result.deferred += 1;
          return;
        }
        result.inspected += 1;
        try {
          const proof = await this.#orphanProbe!.inspect({
            tenant_id: candidate.tenant_id,
            call_id: candidate.call_id,
            cell_id: candidate.cell_id,
            owner_node_id: candidate.owner_node_id,
            owner_epoch: candidate.owner_epoch,
            media_reservation_id: candidate.media_reservation_id,
            reservation_expires_at: candidate.expires_at
          }, now);
          if (proof.owner_exists || proof.session_exists) {
            result.deferred += 1;
            return;
          }
          await this.#transport.releaseSession(
            candidate.transport_session_id,
            'orphaned_owner_and_session'
          );
          if (record?.session) {
            record.session.state = 'closed';
            record.session.updated_at = now.toISOString();
            record.terminal_at = timestamp;
            record.cleanup_retry_count = 0;
            this.#transitionMetric(record, 'closed');
            this.#scheduleRecord(record);
          }
          result.released += 1;
        } catch {
          result.deferred += 1;
          if (record) this.#rescheduleCleanup(record, timestamp);
        }
      });
    }
    return result;
  }

  scheduledDeadlineCount(): number {
    return this.#deadlines.length;
  }

  async #authorize(
    command: MediaControlCommand,
    now: Date
  ): Promise<MediaControlAuthorization> {
    const operation = authorityOperation(command.action);
    try {
      const authorization = await this.#authority.authorize({
        admission_reservation_id: command.admission_reservation_id,
        call_id: command.call_id,
        owner_epoch: command.owner_epoch,
        operation
      }, now);
      const comparison = compareMediaOwnerEpoch(
        command.owner_epoch,
        authorization.owner_epoch
      );
      if (comparison !== 0) {
        throw new MediaControlError(
          comparison < 0 ? 'stale_owner_epoch' : 'owner_epoch_ahead',
          409,
          comparison > 0
        );
      }
      const nodeLease = Date.parse(authorization.node_lease_expires_at);
      if (command.action !== 'delete' &&
          (!Number.isFinite(nodeLease) || nodeLease <= now.getTime())) {
        throw new MediaControlError(
          'component_node_lease_expired',
          503,
          true
        );
      }
      return authorization;
    } catch (error) {
      const projected = projectAuthorizationError(error);
      try {
        this.#authorizationFailureObserver?.({
          admission_reservation_id: command.admission_reservation_id,
          call_id: command.call_id,
          owner_epoch: command.owner_epoch,
          operation,
          error_code: projected.code,
          status: projected.status,
          retryable: projected.retryable
        });
      } catch {
        // Diagnostics must not change media authorization behavior.
      }
      throw projected;
    }
  }

  async #executeTransport(
    command: MediaTransportCommand
  ): Promise<MediaTransportOutcome> {
    try {
      return await this.#transport.execute(command);
    } catch {
      return {
        state: 'unknown',
        command_id: command.command_id,
        error_code: 'transport_unavailable',
        retryable: true
      };
    }
  }

  #transportCommand(
    record: MediaControlRecord,
    command: MediaControlCommand
  ): MediaTransportCommand {
    return {
      action: command.action,
      command_id: command.command_id,
      tenant_id: command.tenant_id,
      call_id: command.call_id,
      leg_id: command.leg_id,
      cell_id: command.cell_id,
      owner_node_id: command.owner_node_id,
      owner_epoch: command.owner_epoch,
      media_reservation_id: command.media_reservation_id,
      expires_at: command.expires_at,
      command_sequence: command.command_sequence,
      idempotency_key: command.idempotency_key,
      payload_hash: command.payload_hash,
      command_hash: mediaControlCommandHash(command),
      transport_session_id: record.session?.transport_session_id,
      payload: structuredClone(command.payload)
    };
  }

  #applyOutcome(
    record: MediaControlRecord,
    command: MediaControlCommand,
    outcome: MediaTransportOutcome,
    timestamp: number
  ): MediaControlResult {
    if (outcome.state === 'unknown') {
      return {
        protocol_version: MEDIA_CONTROL_PROTOCOL_VERSION,
        result_class: 'unknown',
        command_id: command.command_id,
        error_code: outcome.error_code,
        retryable: true,
        ...(record.session ? { session: structuredClone(record.session) } : {})
      };
    }
    if (outcome.state === 'failed') {
      if (!record.session) {
        this.#transitionMetric(record, 'failed');
        record.terminal_at = timestamp;
      }
      return {
        protocol_version: MEDIA_CONTROL_PROTOCOL_VERSION,
        result_class: mediaControlFailureClass(outcome.error_code),
        command_id: command.command_id,
        error_code: outcome.error_code,
        retryable: outcome.retryable,
        ...(record.session ? { session: structuredClone(record.session) } : {})
      };
    }
    const state = outcome.session_state;
    const session: MediaSessionSnapshot = {
      media_reservation_id: command.media_reservation_id,
      call_id: command.call_id,
      owner_epoch: command.owner_epoch,
      last_sequence: command.command_sequence,
      state,
      transport_session_id: outcome.transport_session_id,
      effective_sdp: outcome.effective_sdp,
      expires_at: command.expires_at,
      updated_at: canonicalTransportTime(outcome.applied_at, timestamp)
    };
    record.session = session;
    this.#transitionMetric(record, state);
    record.terminal_at = isTerminal(state) ? timestamp : 0;
    return {
      protocol_version: MEDIA_CONTROL_PROTOCOL_VERSION,
      result_class: 'committed',
      command_id: command.command_id,
      session: structuredClone(session)
    };
  }

  #projectControlError(
    command: MediaControlCommand,
    error: MediaControlError
  ): MediaControlResult {
    const resultClass = mediaControlFailureClass(error.code);
    const session = this.#records.get(
      command.media_reservation_id
    )?.session;
    return {
      protocol_version: MEDIA_CONTROL_PROTOCOL_VERSION,
      result_class: resultClass,
      command_id: command.command_id,
      error_code: error.code,
      retryable: error.retryable,
      ...(session ? { session: structuredClone(session) } : {})
    };
  }

  #assertIdentity(
    record: MediaControlRecord,
    command: MediaControlCommand
  ): void {
    if (record.tenant_id !== command.tenant_id ||
        record.call_id !== command.call_id ||
        record.leg_id !== command.leg_id ||
        record.cell_id !== command.cell_id) {
      throw new MediaControlError('reservation_identity_conflict', 409, false);
    }
    const epoch = compareMediaOwnerEpoch(
      command.owner_epoch,
      record.owner_epoch
    );
    if (epoch <= 0 &&
        record.owner_node_id !== command.owner_node_id) {
      throw new MediaControlError(
        epoch < 0 ? 'stale_owner_epoch' : 'owner_node_conflict',
        409,
        false
      );
    }
  }

  #transitionMetric(
    record: MediaControlRecord,
    next: MediaControlMetricSessionState
  ): void {
    const wasTerminal = isMetricTerminal(record.metric_state);
    const willBeTerminal = isMetricTerminal(next);
    if (wasTerminal !== willBeTerminal) {
      if (willBeTerminal) {
        this.#activeReservations -= 1;
        this.#terminalReservations += 1;
      } else {
        this.#terminalReservations -= 1;
        this.#activeReservations += 1;
      }
    }
    this.#metrics.transitionSession(record.metric_state, next);
    record.metric_state = next;
  }

  #assertTransition(
    record: MediaControlRecord,
    command: MediaControlCommand
  ): void {
    const state = record.session?.state;
    const allowed = command.action === 'offer'
      ? state === undefined || state === 'prepared'
      : command.action === 'delete'
        ? state === 'prepared' || state === 'committed'
        : command.action !== 'drain_node' &&
          (state === 'prepared' || state === 'committed');
    if (!allowed) {
      throw new MediaControlError('media_session_transition_invalid', 409, false);
    }
  }

  #makeJournalSpace(record: MediaControlRecord): boolean {
    if (record.commands.size < this.#maxCommandsPerReservation) return true;
    for (const [commandId, command] of record.commands) {
      if (command.result.result_class === 'unknown') continue;
      record.commands.delete(commandId);
      if (record.idempotency_keys.get(
        command.command.idempotency_key
      ) === commandId) {
        record.idempotency_keys.delete(
          command.command.idempotency_key
        );
      }
      return true;
    }
    return false;
  }

  #publicRecordedResult(
    record: MediaControlRecord,
    command: RecordedCommand,
    responseCommandId = command.command.command_id
  ): MediaControlResult {
    const result = structuredClone(command.result);
    result.command_id = responseCommandId;
    if (result.result_class === 'committed') {
      result.result_class = 'replayed';
    }
    if (result.session &&
        !result.session.effective_sdp &&
        record.session?.transport_session_id ===
          result.session.transport_session_id) {
      result.session.effective_sdp = record.session.effective_sdp;
    }
    return result;
  }

  async #recoverFromTransport(
    command: MediaControlCommand,
    hash: string,
    idempotencyHash: string,
    timestamp: number
  ): Promise<{
    record?: MediaControlRecord;
    result?: MediaControlResult;
  }> {
    let transportSession: MediaTransportSessionSnapshot | undefined;
    let query: Awaited<ReturnType<MediaTransportPort['queryCommand']>>;
    try {
      [transportSession, query] = await Promise.all([
        this.#transport.querySession({
          media_reservation_id: command.media_reservation_id,
          call_id: command.call_id
        }),
        this.#transport.queryCommand({
          command_id: command.command_id,
          media_reservation_id: command.media_reservation_id,
          owner_epoch: command.owner_epoch,
          command_hash: hash
        })
      ]);
    } catch {
      throw new MediaControlError(
        'media_control_transport_unavailable',
        503,
        true
      );
    }

    const recoveredState = transportSession?.state ||
      (query.found && query.outcome.state === 'succeeded'
        ? query.outcome.session_state
        : undefined);
    if (recoveredState && !isTerminal(recoveredState) &&
        this.#activeReservations >= this.#maxReservations) {
      throw new MediaControlError(
        'media_control_capacity_exhausted',
        503,
        true
      );
    }

    let record = transportSession
      ? this.#recordFromTransport(command, transportSession)
      : undefined;
    if (!query.found) return { record };

    if (!record) record = this.#createRecord(command, 'pending');
    const result = this.#projectRecoveredOutcome(
      record,
      command,
      query.outcome,
      timestamp
    );
    record.commands.set(
      command.command_id,
      compactRecordedCommand(command, hash, idempotencyHash, result)
    );
    record.idempotency_keys.set(
      command.idempotency_key,
      command.command_id
    );
    record.unresolved_command_id = '';
    if (!transportSession) {
      record.last_sequence = command.command_sequence;
      if (result.session) {
        record.session = structuredClone(result.session);
        this.#transitionMetric(record, result.session.state);
      } else {
        record.terminal_at = timestamp;
        this.#transitionMetric(record, 'failed');
      }
    }
    this.#scheduleRecord(record);
    return { record, result };
  }

  #recordFromTransport(
    command: MediaControlCommand,
    session: MediaTransportSessionSnapshot
  ): MediaControlRecord {
    const record = this.#createRecord(command, session.state);
    record.owner_epoch = session.owner_epoch;
    record.last_sequence = session.last_sequence;
    record.session = {
      media_reservation_id: session.media_reservation_id,
      call_id: session.call_id,
      owner_epoch: session.owner_epoch,
      last_sequence: session.last_sequence,
      state: session.state,
      transport_session_id: session.transport_session_id,
      effective_sdp: session.effective_sdp,
      expires_at: command.expires_at,
      updated_at: session.updated_at
    };
    if (isTerminal(session.state)) {
      record.terminal_at = Date.parse(session.updated_at);
    }
    this.#scheduleRecord(record);
    return record;
  }

  #createRecord(
    command: MediaControlCommand,
    metricState: MediaControlMetricSessionState
  ): MediaControlRecord {
    const record: MediaControlRecord = {
      media_reservation_id: command.media_reservation_id,
      tenant_id: command.tenant_id,
      call_id: command.call_id,
      leg_id: command.leg_id,
      cell_id: command.cell_id,
      owner_node_id: command.owner_node_id,
      owner_epoch: command.owner_epoch,
      last_sequence: 0,
      expires_at: command.expires_at,
      commands: new Map(),
      idempotency_keys: new Map(),
      unresolved_command_id: '',
      terminal_at: 0,
      metric_state: metricState,
      deadline_revision: 0,
      deadline_at: 0,
      deadline_kind: '',
      cleanup_retry_count: 0
    };
    this.#records.set(record.media_reservation_id, record);
    this.#metrics.addSession(metricState);
    if (isMetricTerminal(metricState)) this.#terminalReservations += 1;
    else this.#activeReservations += 1;
    return record;
  }

  #projectRecoveredOutcome(
    record: MediaControlRecord,
    command: MediaControlCommand,
    outcome: Exclude<MediaTransportOutcome, { state: 'unknown' }>,
    timestamp: number
  ): MediaControlResult {
    if (outcome.state === 'failed') {
      return {
        protocol_version: MEDIA_CONTROL_PROTOCOL_VERSION,
        result_class: mediaControlFailureClass(outcome.error_code),
        command_id: command.command_id,
        error_code: outcome.error_code,
        retryable: outcome.retryable,
        ...(record.session ? { session: structuredClone(record.session) } : {})
      };
    }
    return {
      protocol_version: MEDIA_CONTROL_PROTOCOL_VERSION,
      result_class: 'replayed',
      command_id: command.command_id,
      session: {
        media_reservation_id: command.media_reservation_id,
        call_id: command.call_id,
        owner_epoch: command.owner_epoch,
        last_sequence: command.command_sequence,
        state: outcome.session_state,
        transport_session_id: outcome.transport_session_id,
        effective_sdp: outcome.effective_sdp,
        expires_at: command.expires_at,
        updated_at: canonicalTransportTime(outcome.applied_at, timestamp)
      }
    };
  }

  async #expireLease(
    record: MediaControlRecord,
    now: Date,
    timestamp: number
  ): Promise<number> {
    try {
      if (record.unresolved_command_id) {
        const unresolved = record.commands.get(record.unresolved_command_id);
        if (unresolved) {
          const query = await this.#transport.queryCommand({
            command_id: unresolved.command.command_id,
            media_reservation_id: unresolved.command.media_reservation_id,
            owner_epoch: unresolved.command.owner_epoch,
            command_hash: unresolved.hash
          });
          let outcome: MediaTransportOutcome | undefined;
          if (query.found) {
            outcome = query.outcome;
          } else if (unresolved.command.action === 'delete') {
            try {
              await this.#authorize(unresolved.command, now);
            } catch (error) {
              if (error instanceof MediaControlError && !error.retryable) {
                this.#failStaleCleanup(record, unresolved, error, timestamp);
                return 0;
              }
              throw error;
            }
            outcome = await this.#executeTransport(
              this.#transportCommand(record, unresolved.command)
            );
          }
          if (outcome) {
            const result = this.#applyOutcome(
              record,
              unresolved.command,
              outcome,
              timestamp
            );
            unresolved.result = structuredClone(result);
            this.#metrics.recordReconciliation(result.result_class);
            if (result.result_class === 'unknown') {
              this.#rescheduleCleanup(record, timestamp);
              return 0;
            }
          } else {
            unresolved.result = {
              protocol_version: MEDIA_CONTROL_PROTOCOL_VERSION,
              result_class: 'terminal_error',
              command_id: unresolved.command.command_id,
              error_code: 'media_control_lease_expired',
              retryable: false,
              ...(record.session
                ? { session: structuredClone(record.session) }
                : {})
            };
            this.#metrics.recordReconciliation('terminal_error');
          }
        }
        record.unresolved_command_id = '';
      }

      if (record.session?.state === 'prepared') {
        await this.#transport.releaseSession(
          record.session.transport_session_id,
          'lease_expired'
        );
        record.session.state = 'expired';
        record.session.updated_at = now.toISOString();
        this.#transitionMetric(record, 'expired');
        record.terminal_at = timestamp;
        record.cleanup_retry_count = 0;
        this.#scheduleRecord(record);
        return 1;
      }
      if (!record.session && record.metric_state === 'pending') {
        this.#transitionMetric(record, 'expired');
        record.terminal_at = timestamp;
        record.cleanup_retry_count = 0;
        this.#scheduleRecord(record);
        return 1;
      }
      record.cleanup_retry_count = 0;
      this.#scheduleRecord(record);
      return 0;
    } catch {
      this.#rescheduleCleanup(record, timestamp);
      return 0;
    }
  }

  #scheduleRecord(
    record: MediaControlRecord,
    overrideAt?: number
  ): void {
    let kind: '' | 'lease' | 'evict' = '';
    let at = 0;
    if (record.terminal_at > 0) {
      kind = 'evict';
      at = record.terminal_at + this.#terminalRetentionMs;
    } else if (
      record.unresolved_command_id ||
      record.session?.state === 'prepared'
    ) {
      kind = 'lease';
      at = overrideAt ?? Date.parse(record.expires_at);
    }
    if (record.deadline_kind === kind && record.deadline_at === at) return;
    record.deadline_revision += 1;
    record.deadline_kind = kind;
    record.deadline_at = at;
    if (!kind) return;
    pushDeadline(this.#deadlines, {
      at,
      media_reservation_id: record.media_reservation_id,
      revision: record.deadline_revision,
      kind
    });
    if (kind === 'evict') {
      pushDeadline(this.#terminalOrder, {
        at,
        media_reservation_id: record.media_reservation_id,
        revision: record.deadline_revision,
        kind
      });
      this.#enforceTerminalBound();
    }
  }

  #rescheduleCleanup(record: MediaControlRecord, timestamp: number): void {
    record.cleanup_retry_count = Math.min(
      record.cleanup_retry_count + 1,
      10
    );
    const delay = Math.min(
      1_000 * 2 ** (record.cleanup_retry_count - 1),
      30_000
    );
    this.#scheduleRecord(record, timestamp + delay);
  }

  #failStaleCleanup(
    record: MediaControlRecord,
    command: RecordedCommand,
    error: MediaControlError,
    timestamp: number
  ): void {
    command.result = {
      protocol_version: MEDIA_CONTROL_PROTOCOL_VERSION,
      result_class: 'rejected_epoch',
      command_id: command.command.command_id,
      error_code: error.code,
      retryable: false,
      ...(record.session ? { session: structuredClone(record.session) } : {})
    };
    record.unresolved_command_id = '';
    record.terminal_at = timestamp;
    record.cleanup_retry_count = 0;
    this.#transitionMetric(record, 'failed');
    this.#metrics.recordReconciliation('rejected_epoch');
    this.#scheduleRecord(record);
  }

  #enforceTerminalBound(): void {
    while (this.#terminalReservations > this.#maxTerminalReservations) {
      const deadline = popDeadline(this.#terminalOrder);
      if (!deadline) {
        throw new Error('media control terminal index is inconsistent');
      }
      const record = this.#records.get(deadline.media_reservation_id);
      if (!record ||
          deadline.revision !== record.deadline_revision ||
          record.deadline_kind !== 'evict') {
        continue;
      }
      this.#removeRecord(record);
    }
  }

  #removeRecord(record: MediaControlRecord): void {
    if (!this.#records.delete(record.media_reservation_id)) return;
    if (isMetricTerminal(record.metric_state)) {
      this.#terminalReservations -= 1;
    } else {
      this.#activeReservations -= 1;
    }
    this.#metrics.removeSession(record.metric_state);
  }
}

function projectAuthorizationError(error: unknown): MediaControlError {
  if (error instanceof MediaControlError) return error;
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    retryable?: unknown;
  };
  const code = String(candidate?.code || '');
  const status = Number(candidate?.status);
  if (/^[a-z][a-z0-9_]{1,127}$/.test(code) &&
      Number.isInteger(status) &&
      status >= 400 &&
      status <= 599) {
    return new MediaControlError(
      code,
      status,
      candidate.retryable === true
    );
  }
  return new MediaControlError(
    'media_control_authority_unavailable',
    503,
    true
  );
}

export class MediaControlError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean
  ) {
    super(code);
    this.name = 'MediaControlError';
  }
}

function compactRecordedCommand(
  command: MediaControlCommand,
  hash: string,
  idempotencyHash: string,
  result: MediaControlResult
): RecordedCommand {
  const storedCommand = structuredClone(command);
  const storedResult = structuredClone(result);
  if (result.result_class !== 'unknown') storedCommand.payload = {};
  if (storedResult.session) storedResult.session.effective_sdp = '';
  return {
    hash,
    idempotency_hash: idempotencyHash,
    command: storedCommand,
    result: storedResult
  };
}

function mediaControlFailureClass(
  errorCode: string
): 'rejected_capacity' | 'rejected_epoch' | 'terminal_error' {
  if ([
    'media_control_capacity_exhausted',
    'command_journal_exhausted',
    'transport_capacity_exhausted',
    'transport_command_capacity_exhausted'
  ].includes(errorCode)) {
    return 'rejected_capacity';
  }
  if ([
    'stale_owner_epoch',
    'owner_epoch_ahead',
    'owner_takeover_sequence_invalid'
  ].includes(errorCode)) {
    return 'rejected_epoch';
  }
  return 'terminal_error';
}

function isTerminal(state: MediaSessionState): boolean {
  return state === 'cancelled' || state === 'closed' || state === 'expired';
}

function isMetricTerminal(state: MediaControlMetricSessionState): boolean {
  return state === 'cancelled' ||
    state === 'closed' ||
    state === 'expired' ||
    state === 'failed';
}

function canonicalTransportTime(value: string, fallback: number): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value
    ? value
    : new Date(fallback).toISOString();
}

function protocolError(error: unknown): MediaControlError {
  const code = error instanceof Error
    ? error.message
    : 'media_control_command_invalid';
  return new MediaControlError(code, 400, false);
}

function validNow(now: Date): number {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new MediaControlError('media_control_now_invalid', 400, false);
  }
  return timestamp;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function authorityOperation(
  action: MediaControlAction
): 'open' | 'mutate' | 'close' {
  if (action === 'offer') return 'open';
  if (action === 'delete') return 'close';
  return 'mutate';
}

function pushDeadline(
  heap: MediaControlDeadline[],
  value: MediaControlDeadline
): void {
  heap.push(value);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (deadlineOrder(heap[parent], value) <= 0) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = value;
}

function popDeadline(
  heap: MediaControlDeadline[]
): MediaControlDeadline | undefined {
  const first = heap[0];
  const last = heap.pop();
  if (!first || !last || heap.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) break;
    const right = left + 1;
    const child = right < heap.length &&
      deadlineOrder(heap[right], heap[left]) < 0
      ? right
      : left;
    if (deadlineOrder(heap[child], last) >= 0) break;
    heap[index] = heap[child];
    index = child;
  }
  heap[index] = last;
  return first;
}

function deadlineOrder(
  left: MediaControlDeadline,
  right: MediaControlDeadline
): number {
  if (left.at !== right.at) return left.at - right.at;
  if (left.media_reservation_id !== right.media_reservation_id) {
    return left.media_reservation_id < right.media_reservation_id ? -1 : 1;
  }
  return left.revision - right.revision;
}
