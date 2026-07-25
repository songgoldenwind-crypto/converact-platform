import {
  MEDIA_CONTROL_PROTOCOL_VERSION,
  checkedMediaControlCommand,
  checkedMediaControlReconcileInput,
  compareMediaOwnerEpoch,
  mediaControlCommandHash,
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

export interface MediaControlAuthorization {
  owner_epoch: string;
  reservation_expires_at: string;
  node_lease_expires_at: string;
}

export interface MediaControlAuthorityPort {
  authorize(input: {
    reservation_id: string;
    interaction_id: string;
    owner_epoch: string;
    operation: 'open' | 'mutate' | 'close';
  }, now: Date): Promise<MediaControlAuthorization>;
}

interface RecordedCommand {
  hash: string;
  command: MediaControlCommand;
  result: MediaControlResult;
}

interface MediaControlRecord {
  reservation_id: string;
  interaction_id: string;
  owner_epoch: string;
  last_sequence: number;
  lease_expires_at: string;
  session?: MediaSessionSnapshot;
  commands: Map<string, RecordedCommand>;
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
  reservation_id: string;
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
  readonly #metrics: MediaControlMetrics;
  readonly #records = new Map<string, MediaControlRecord>();
  readonly #deadlines: MediaControlDeadline[] = [];
  readonly #terminalOrder: MediaControlDeadline[] = [];
  readonly #serial = new KeyedSerialExecutor();
  #activeReservations = 0;
  #terminalReservations = 0;

  constructor(input: {
    authority: MediaControlAuthorityPort;
    transport: MediaTransportPort;
    max_reservations?: number;
    max_terminal_reservations?: number;
    max_commands_per_reservation?: number;
    terminal_retention_ms?: number;
    metrics?: MediaControlMetrics;
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
    this.#metrics = input.metrics ?? new MediaControlMetrics();
  }

  async execute(
    rawCommand: MediaControlCommand,
    now: Date
  ): Promise<MediaControlResult> {
    const timestamp = validNow(now);
    let command: MediaControlCommand;
    let hash: string;
    try {
      command = checkedMediaControlCommand(rawCommand);
      hash = mediaControlCommandHash(command);
    } catch (error) {
      throw protocolError(error);
    }

    return this.#serial.run(command.reservation_id, () =>
      this.#executeChecked(command, hash, timestamp, now)
    );
  }

  async #executeChecked(
    command: MediaControlCommand,
    hash: string,
    timestamp: number,
    now: Date
  ): Promise<MediaControlResult> {
    let record = this.#records.get(command.reservation_id);
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
            this.#metrics.recordCommand(command.action, 'rejected');
            throw new MediaControlError(
              'command_payload_conflict',
              409,
              false
            );
          }
          await this.#authorize(command, now);
          this.#metrics.recordCommand(command.action, 'replayed');
          return this.#publicRecordedResult(record, replay);
        }
      }
    }

    if ((command.action === 'prepare' || command.action === 'commit') &&
        Date.parse(command.lease_expires_at) <= timestamp) {
      throw new MediaControlError('media_control_lease_expired', 409, true);
    }

    await this.#authorize(command, now);
    if (!record) {
      const recovered = await this.#recoverFromTransport(
        command,
        hash,
        timestamp
      );
      record = recovered.record;
      if (recovered.result) {
        this.#metrics.recordCommand(command.action, 'replayed');
        return structuredClone(recovered.result);
      }
    }
    if (!record && command.action !== 'prepare') {
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
      if (command.sequence !== 1) {
        throw new MediaControlError('owner_takeover_sequence_invalid', 409, false);
      }
      record.owner_epoch = command.owner_epoch;
      record.last_sequence = 0;
      record.commands.clear();
      record.unresolved_command_id = '';
      if (record.session) record.session.owner_epoch = command.owner_epoch;
    }

    if (!record) {
      if (command.sequence !== 1) {
        throw new MediaControlError('sequence_gap', 409, false);
      }
      record = this.#createRecord(command, 'pending');
    }

    if (record.unresolved_command_id) {
      throw new MediaControlError('command_reconciliation_required', 409, true);
    }
    if (command.sequence <= record.last_sequence) {
      throw new MediaControlError('stale_sequence', 409, false);
    }
    if (command.sequence !== record.last_sequence + 1) {
      throw new MediaControlError('sequence_gap', 409, false);
    }
    if (!this.#makeJournalSpace(record)) {
      throw new MediaControlError('command_journal_exhausted', 503, true);
    }
    this.#assertTransition(record, command);

    const transportCommand = this.#transportCommand(record, command);
    const outcome = await this.#executeTransport(transportCommand);
    const result = this.#applyOutcome(record, command, outcome, timestamp);
    record.last_sequence = command.sequence;
    record.lease_expires_at = command.lease_expires_at;
    record.unresolved_command_id =
      result.state === 'unknown' ? command.command_id : '';
    record.commands.set(
      command.command_id,
      compactRecordedCommand(command, hash, result)
    );
    this.#metrics.recordCommand(command.action, result.state);
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
    return this.#serial.run(input.reservation_id, () =>
      this.#reconcileChecked(input, timestamp, now)
    );
  }

  async #reconcileChecked(
    input: MediaControlReconcileInput,
    timestamp: number,
    now: Date
  ): Promise<MediaControlResult> {
    const record = this.#records.get(input.reservation_id);
    if (!record || record.interaction_id !== input.interaction_id) {
      throw new MediaControlError('media_session_not_found', 404, false);
    }
    const comparison = compareMediaOwnerEpoch(input.owner_epoch, record.owner_epoch);
    if (comparison !== 0) {
      throw new MediaControlError(
        comparison < 0 ? 'stale_owner_epoch' : 'owner_epoch_ahead',
        409,
        comparison > 0
      );
    }
    const recorded = record.commands.get(input.command_id);
    if (!recorded) {
      throw new MediaControlError('media_command_not_found', 404, false);
    }
    await this.#authorize(recorded.command, now);
    if (recorded.result.state !== 'unknown') {
      return this.#publicRecordedResult(record, recorded);
    }

    const query = await this.#transport.queryCommand({
      command_id: input.command_id,
      reservation_id: input.reservation_id,
      owner_epoch: input.owner_epoch,
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
      result.state === 'unknown' ? input.command_id : '';
    this.#metrics.recordReconciliation(result.state);
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
      expired += await this.#serial.run(deadline.reservation_id, async () => {
        const record = this.#records.get(deadline.reservation_id);
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

  scheduledDeadlineCount(): number {
    return this.#deadlines.length;
  }

  async #authorize(
    command: MediaControlCommand,
    now: Date
  ): Promise<MediaControlAuthorization> {
    try {
      const authorization = await this.#authority.authorize({
        reservation_id: command.reservation_id,
        interaction_id: command.interaction_id,
        owner_epoch: command.owner_epoch,
        operation: command.action === 'prepare'
          ? 'open'
          : command.action === 'commit'
            ? 'mutate'
            : 'close'
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
      if (authorization.reservation_expires_at !== command.lease_expires_at) {
        throw new MediaControlError(
          'reservation_lease_mismatch',
          409,
          true
        );
      }
      const nodeLease = Date.parse(authorization.node_lease_expires_at);
      if (command.action !== 'cancel' &&
          command.action !== 'close' &&
          (!Number.isFinite(nodeLease) || nodeLease <= now.getTime())) {
        throw new MediaControlError(
          'component_node_lease_expired',
          503,
          true
        );
      }
      return authorization;
    } catch (error) {
      if (error instanceof MediaControlError) throw error;
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
        throw new MediaControlError(
          code,
          status,
          candidate.retryable === true
        );
      }
      throw new MediaControlError(
        'media_control_authority_unavailable',
        503,
        true
      );
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
      reservation_id: command.reservation_id,
      interaction_id: command.interaction_id,
      owner_epoch: command.owner_epoch,
      sequence: command.sequence,
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
        state: 'unknown',
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
        state: 'failed',
        command_id: command.command_id,
        error_code: outcome.error_code,
        retryable: outcome.retryable,
        ...(record.session ? { session: structuredClone(record.session) } : {})
      };
    }
    const state = outcome.session_state;
    const session: MediaSessionSnapshot = {
      reservation_id: command.reservation_id,
      interaction_id: command.interaction_id,
      owner_epoch: command.owner_epoch,
      last_sequence: command.sequence,
      state,
      transport_session_id: outcome.transport_session_id,
      effective_sdp: outcome.effective_sdp,
      lease_expires_at: command.lease_expires_at,
      updated_at: canonicalTransportTime(outcome.applied_at, timestamp)
    };
    record.session = session;
    this.#transitionMetric(record, state);
    record.terminal_at = isTerminal(state) ? timestamp : 0;
    return {
      protocol_version: MEDIA_CONTROL_PROTOCOL_VERSION,
      state: 'succeeded',
      command_id: command.command_id,
      session: structuredClone(session)
    };
  }

  #assertIdentity(
    record: MediaControlRecord,
    command: MediaControlCommand
  ): void {
    if (record.interaction_id !== command.interaction_id) {
      throw new MediaControlError('reservation_identity_conflict', 409, false);
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
    const allowed =
      (command.action === 'prepare' && state === undefined) ||
      (command.action === 'prepare' && state === 'prepared') ||
      (command.action === 'commit' && state === 'prepared') ||
      (command.action === 'commit' && state === 'committed') ||
      (command.action === 'cancel' && state === 'prepared') ||
      (command.action === 'close' && state === 'prepared') ||
      (command.action === 'close' && state === 'committed');
    if (!allowed) {
      throw new MediaControlError('media_session_transition_invalid', 409, false);
    }
  }

  #makeJournalSpace(record: MediaControlRecord): boolean {
    if (record.commands.size < this.#maxCommandsPerReservation) return true;
    for (const [commandId, command] of record.commands) {
      if (command.result.state === 'unknown') continue;
      record.commands.delete(commandId);
      return true;
    }
    return false;
  }

  #publicRecordedResult(
    record: MediaControlRecord,
    command: RecordedCommand
  ): MediaControlResult {
    const result = structuredClone(command.result);
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
          reservation_id: command.reservation_id,
          interaction_id: command.interaction_id
        }),
        this.#transport.queryCommand({
          command_id: command.command_id,
          reservation_id: command.reservation_id,
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
      compactRecordedCommand(command, hash, result)
    );
    record.unresolved_command_id = '';
    if (!transportSession) {
      record.last_sequence = command.sequence;
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
      reservation_id: session.reservation_id,
      interaction_id: session.interaction_id,
      owner_epoch: session.owner_epoch,
      last_sequence: session.last_sequence,
      state: session.state,
      transport_session_id: session.transport_session_id,
      effective_sdp: session.effective_sdp,
      lease_expires_at: command.lease_expires_at,
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
      reservation_id: command.reservation_id,
      interaction_id: command.interaction_id,
      owner_epoch: command.owner_epoch,
      last_sequence: 0,
      lease_expires_at: command.lease_expires_at,
      commands: new Map(),
      unresolved_command_id: '',
      terminal_at: 0,
      metric_state: metricState,
      deadline_revision: 0,
      deadline_at: 0,
      deadline_kind: '',
      cleanup_retry_count: 0
    };
    this.#records.set(record.reservation_id, record);
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
        state: 'failed',
        command_id: command.command_id,
        error_code: outcome.error_code,
        retryable: outcome.retryable,
        ...(record.session ? { session: structuredClone(record.session) } : {})
      };
    }
    return {
      protocol_version: MEDIA_CONTROL_PROTOCOL_VERSION,
      state: 'succeeded',
      command_id: command.command_id,
      session: {
        reservation_id: command.reservation_id,
        interaction_id: command.interaction_id,
        owner_epoch: command.owner_epoch,
        last_sequence: command.sequence,
        state: outcome.session_state,
        transport_session_id: outcome.transport_session_id,
        effective_sdp: outcome.effective_sdp,
        lease_expires_at: command.lease_expires_at,
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
            reservation_id: unresolved.command.reservation_id,
            owner_epoch: unresolved.command.owner_epoch,
            command_hash: unresolved.hash
          });
          let outcome: MediaTransportOutcome | undefined;
          if (query.found) {
            outcome = query.outcome;
          } else if (unresolved.command.action === 'cancel' ||
                     unresolved.command.action === 'close') {
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
            this.#metrics.recordReconciliation(result.state);
            if (result.state === 'unknown') {
              this.#rescheduleCleanup(record, timestamp);
              return 0;
            }
          } else {
            unresolved.result = {
              protocol_version: MEDIA_CONTROL_PROTOCOL_VERSION,
              state: 'failed',
              command_id: unresolved.command.command_id,
              error_code: 'media_control_lease_expired',
              retryable: false,
              ...(record.session
                ? { session: structuredClone(record.session) }
                : {})
            };
            this.#metrics.recordReconciliation('failed');
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
      at = overrideAt ?? Date.parse(record.lease_expires_at);
    }
    if (record.deadline_kind === kind && record.deadline_at === at) return;
    record.deadline_revision += 1;
    record.deadline_kind = kind;
    record.deadline_at = at;
    if (!kind) return;
    pushDeadline(this.#deadlines, {
      at,
      reservation_id: record.reservation_id,
      revision: record.deadline_revision,
      kind
    });
    if (kind === 'evict') {
      pushDeadline(this.#terminalOrder, {
        at,
        reservation_id: record.reservation_id,
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
      state: 'failed',
      command_id: command.command.command_id,
      error_code: error.code,
      retryable: false,
      ...(record.session ? { session: structuredClone(record.session) } : {})
    };
    record.unresolved_command_id = '';
    record.terminal_at = timestamp;
    record.cleanup_retry_count = 0;
    this.#transitionMetric(record, 'failed');
    this.#metrics.recordReconciliation('failed');
    this.#scheduleRecord(record);
  }

  #enforceTerminalBound(): void {
    while (this.#terminalReservations > this.#maxTerminalReservations) {
      const deadline = popDeadline(this.#terminalOrder);
      if (!deadline) {
        throw new Error('media control terminal index is inconsistent');
      }
      const record = this.#records.get(deadline.reservation_id);
      if (!record ||
          deadline.revision !== record.deadline_revision ||
          record.deadline_kind !== 'evict') {
        continue;
      }
      this.#removeRecord(record);
    }
  }

  #removeRecord(record: MediaControlRecord): void {
    if (!this.#records.delete(record.reservation_id)) return;
    if (isMetricTerminal(record.metric_state)) {
      this.#terminalReservations -= 1;
    } else {
      this.#activeReservations -= 1;
    }
    this.#metrics.removeSession(record.metric_state);
  }
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
  result: MediaControlResult
): RecordedCommand {
  const storedCommand = structuredClone(command);
  const storedResult = structuredClone(result);
  if (result.state !== 'unknown') storedCommand.payload = {};
  if (storedResult.session) storedResult.session.effective_sdp = '';
  return {
    hash,
    command: storedCommand,
    result: storedResult
  };
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
  if (left.reservation_id !== right.reservation_id) {
    return left.reservation_id < right.reservation_id ? -1 : 1;
  }
  return left.revision - right.revision;
}
