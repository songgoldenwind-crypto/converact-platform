import { createHash, randomBytes } from 'node:crypto';

import type {
  BencodeDictionary,
  BencodeValue
} from './bencode.js';
import {
  MediaCommandJournal,
  type MediaCommandJournalRecord
} from './journal.js';
import {
  RtpengineNgClient,
  RtpengineNgRequestError
} from './rtpengine-ng.js';
import type {
  MediaTransportCommand,
  MediaTransportCommandIdentity,
  MediaTransportOrphanCandidate,
  MediaTransportOutcome,
  MediaTransportPort,
  MediaTransportQuery,
  MediaTransportSessionSnapshot
} from './transport.js';

const TERMINAL_STATES = new Set(['cancelled', 'closed', 'expired']);
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/;
const SIP_TAG = /^[A-Za-z0-9.!%*_+`'~-]{1,256}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_LOGICAL_SDP_BYTES = 16 * 1024;
const MAX_EFFECTIVE_SDP_BYTES = 256 * 1024;
const NEGOTIATION_ACTIONS = new Set<MediaTransportCommand['action']>([
  'offer',
  'answer',
  'update'
]);
const MUTATING_ACTIONS = new Set<MediaTransportCommand['action']>([
  'offer',
  'answer',
  'update',
  'delete',
  'block_media',
  'unblock_media',
  'start_forward',
  'stop_forward',
  'start_recording_fork',
  'stop_recording_fork',
  'play_media',
  'stop_media',
  'inject_dtmf',
  'query',
  'subscribe_quality',
  'drain_node'
]);

interface RtpengineNgPort {
  request(
    command: BencodeDictionary,
    identity: {
      command_id: string;
      command_hash: string;
    },
    options?: { deadlineAt?: number }
  ): Promise<BencodeDictionary>;
  close(): Promise<void>;
}

interface RtpengineCommandStatus {
  state: 'applied' | 'unseen' | 'conflict';
  guardEntryFound: boolean;
  response: BencodeDictionary;
}

interface ReplayAckTask {
  key: string;
  command: MediaTransportCommand;
  attempts: number;
  nextAttemptAt: number;
  escalated: boolean;
}

interface TerminalExpiration {
  reservationId: string;
  recordedAt: string;
  expiresAt: number;
}

interface ResolvedRtpengineResponse {
  outcome: MediaTransportOutcome;
  forcedSessionState?: MediaTransportSessionSnapshot['state'];
}

export interface RtpengineMediaTransportOptions {
  client: RtpengineNgPort;
  journal: MediaCommandJournal;
  now?: () => Date;
  recoveryConcurrency?: number;
  replayAckRetryBaseMs?: number;
  replayAckRetryMaxMs?: number;
  replayAckMaxAttempts?: number;
  journalCompactionRetryBaseMs?: number;
  journalCompactionRetryMaxMs?: number;
  maxSessions?: number;
  maxCommands?: number;
  terminalRetentionMs?: number;
}

export class RtpengineMediaTransportError extends Error {
  constructor(readonly code: string, options: { cause?: unknown } = {}) {
    super(code, options);
    this.name = 'RtpengineMediaTransportError';
  }
}

export class RtpengineMediaTransport implements MediaTransportPort {
  readonly #client: RtpengineNgPort;
  readonly #journal: MediaCommandJournal;
  readonly #now: () => Date;
  readonly #recoveryConcurrency: number;
  readonly #replayAckRetryBaseMs: number;
  readonly #replayAckRetryMaxMs: number;
  readonly #replayAckMaxAttempts: number;
  readonly #journalCompactionRetryBaseMs: number;
  readonly #journalCompactionRetryMaxMs: number;
  readonly #maxSessions: number;
  readonly #maxCommands: number;
  readonly #terminalRetentionMs: number;
  readonly #commands = new Map<string, MediaCommandJournalRecord>();
  readonly #commandKeysByReservation = new Map<string, Set<string>>();
  readonly #sessions = new Map<string, MediaTransportSessionSnapshot>();
  readonly #sessionsByTransportId = new Map<string, string>();
  readonly #tails = new Map<string, Promise<void>>();
  readonly #quality = new Map<string, BencodeDictionary>();
  readonly #pendingReplayAcks = new Map<string, ReplayAckTask>();
  #terminalExpirations: TerminalExpiration[] = [];
  #terminalExpirationCursor = 0;
  readonly #startupNonce = randomBytes(16).toString('hex');
  #replayAckTimer: NodeJS.Timeout | null = null;
  #replayAckDrain: Promise<void> | null = null;
  #journalCompaction: Promise<void> | null = null;
  #journalCompactionRetryTimer: NodeJS.Timeout | null = null;
  #journalCompactionRequested = false;
  #journalCompactionDirty = false;
  #journalCompactionAttempts = 0;
  #replayAckFailures = 0;
  #replayAckSucceeded = 0;
  #replayAckEscalated = 0;
  #replayAckAbandoned = 0;
  #journalCompactionFailures = 0;
  #closed = false;

  private constructor(options: RtpengineMediaTransportOptions) {
    this.#client = options.client;
    this.#journal = options.journal;
    this.#now = options.now ?? (() => new Date());
    this.#recoveryConcurrency = integer(
      options.recoveryConcurrency ?? 32,
      1,
      256,
      'recovery_concurrency'
    );
    this.#replayAckRetryBaseMs = integer(
      options.replayAckRetryBaseMs ?? 100,
      1,
      60_000,
      'replay_ack_retry_base_ms'
    );
    this.#replayAckRetryMaxMs = integer(
      options.replayAckRetryMaxMs ?? 5_000,
      this.#replayAckRetryBaseMs,
      300_000,
      'replay_ack_retry_max_ms'
    );
    this.#replayAckMaxAttempts = integer(
      options.replayAckMaxAttempts ?? 8,
      1,
      100,
      'replay_ack_max_attempts'
    );
    this.#journalCompactionRetryBaseMs = integer(
      options.journalCompactionRetryBaseMs ?? 1_000,
      1,
      60_000,
      'journal_compaction_retry_base_ms'
    );
    this.#journalCompactionRetryMaxMs = integer(
      options.journalCompactionRetryMaxMs ?? 60_000,
      this.#journalCompactionRetryBaseMs,
      300_000,
      'journal_compaction_retry_max_ms'
    );
    this.#maxSessions = integer(
      options.maxSessions ?? 100_000,
      1,
      10_000_000,
      'max_sessions'
    );
    this.#maxCommands = integer(
      options.maxCommands ?? 1_600_000,
      1,
      10_000_000,
      'max_commands'
    );
    this.#terminalRetentionMs = integer(
      options.terminalRetentionMs ?? 300_000,
      0,
      30 * 24 * 60 * 60 * 1_000,
      'terminal_retention_ms'
    );
  }

  static async open(
    options: RtpengineMediaTransportOptions
  ): Promise<RtpengineMediaTransport> {
    const transport = new RtpengineMediaTransport(options);
    await transport.#restore();
    return transport;
  }

  execute(command: MediaTransportCommand): Promise<MediaTransportOutcome> {
    return this.#serial(command.media_reservation_id, async () => {
      this.#assertOpen();
      return this.#execute(command);
    });
  }

  queryCommand(
    identity: MediaTransportCommandIdentity
  ): Promise<MediaTransportQuery> {
    return this.#serial(identity.media_reservation_id, async () => {
      this.#assertOpen();
      const record = this.#commands.get(commandKey(identity));
      if (!record) return { found: false };
      if (record.command_hash !== identity.command_hash) {
        return {
          found: true,
          outcome: failed(
            identity.command_id,
            'command_payload_conflict',
            false
          )
        };
      }
      if (record.result_class === 'unknown') return { found: false };
      return {
        found: true,
        outcome: outcomeFromRecord(record)
      };
    });
  }

  querySession(input: {
    media_reservation_id: string;
    call_id: string;
  }): Promise<MediaTransportSessionSnapshot | undefined> {
    return this.#serial(input.media_reservation_id, async () => {
      this.#assertOpen();
      const session = this.#sessions.get(input.media_reservation_id);
      if (!session || session.call_id !== input.call_id) return undefined;
      return structuredClone(session);
    });
  }

  async scanOrphanCandidates(input: {
    after: string;
    limit: number;
  }): Promise<{
    items: MediaTransportOrphanCandidate[];
    next_cursor: string;
  }> {
    this.#assertOpen();
    const limit = integer(input.limit, 1, 10_000, 'orphan_scan_limit');
    if (typeof input.after !== 'string' || input.after.length > 256) {
      throw new RtpengineMediaTransportError('orphan_scan_cursor_invalid');
    }
    const sessions = [...this.#sessions.values()].filter(
      (session): session is MediaTransportSessionSnapshot & {
        tenant_id: string;
        leg_id: string;
        cell_id: string;
        owner_node_id: string;
        expires_at: string;
        state: 'prepared' | 'committed';
      } => (
        (session.state === 'prepared' || session.state === 'committed') &&
        completeSessionIdentity(session)
      )
    );
    if (sessions.length === 0) return { items: [], next_cursor: '' };
    const previous = input.after
      ? sessions.findIndex(
          (session) => session.media_reservation_id === input.after
        )
      : -1;
    const items: MediaTransportOrphanCandidate[] = [];
    for (let offset = 1;
      offset <= sessions.length && items.length < limit;
      offset += 1) {
      const session = sessions[(previous + offset) % sessions.length]!;
      items.push({
        tenant_id: session.tenant_id,
        call_id: session.call_id,
        leg_id: session.leg_id,
        cell_id: session.cell_id,
        owner_node_id: session.owner_node_id,
        owner_epoch: session.owner_epoch,
        media_reservation_id: session.media_reservation_id,
        transport_session_id: session.transport_session_id,
        expires_at: session.expires_at,
        state: session.state
      });
    }
    return {
      items,
      next_cursor: items.at(-1)?.media_reservation_id ?? ''
    };
  }

  releaseSession(
    transportSessionId: string,
    reason: string
  ): Promise<void> {
    const reservationId = this.#sessionsByTransportId.get(transportSessionId);
    const session = reservationId
      ? this.#sessions.get(reservationId)
      : undefined;
    if (!session || TERMINAL_STATES.has(session.state)) {
      return Promise.resolve();
    }
    return this.#serial(session.media_reservation_id, async () => {
      this.#assertOpen();
      const current = this.#sessions.get(session.media_reservation_id);
      if (!current || TERMINAL_STATES.has(current.state)) return;
      const fromTag = current.from_tag;
      if (!fromTag) {
        throw new RtpengineMediaTransportError(
          'rtpengine_dialog_tag_missing'
        );
      }
      const commandId = `release-${digest([
        current.media_reservation_id,
        current.owner_epoch,
        reason
      ].join('\0')).slice(0, 48)}`;
      const commandHash = digest([
        commandId,
        current.call_id,
        fromTag,
        String(current.last_sequence + 1)
      ].join('\0'));
      const outcome = await this.#execute({
        action: 'delete',
        command_id: commandId,
        tenant_id: current.tenant_id ?? 'ivekit-system',
        call_id: current.call_id,
        leg_id: current.leg_id ?? 'ivekit-system',
        cell_id: current.cell_id ?? 'ivekit-system',
        owner_node_id: current.owner_node_id ?? 'ivekit-system',
        owner_epoch: current.owner_epoch,
        admission_reservation_id: current.media_reservation_id,
        media_reservation_id: current.media_reservation_id,
        expires_at: current.expires_at ?? canonicalNow(this.#now()),
        command_sequence: current.last_sequence + 1,
        idempotency_key: commandId,
        payload_hash: digest(JSON.stringify({
          from_tag: fromTag,
          ...(current.to_tag ? { to_tag: current.to_tag } : {})
        })),
        command_hash: commandHash,
        transport_session_id: current.transport_session_id,
        payload: {
          from_tag: fromTag,
          ...(current.to_tag ? { to_tag: current.to_tag } : {})
        }
      });
      if (outcome.state !== 'succeeded') {
        throw new RtpengineMediaTransportError(
          outcome.error_code,
          { cause: outcome }
        );
      }
    });
  }

  qualitySnapshot(callId: string): BencodeDictionary | undefined {
    const value = this.#quality.get(callId);
    return value ? structuredClone(value) : undefined;
  }

  replayAckMetrics(): {
    pending: number;
    failed_total: number;
    succeeded_total: number;
    escalated_total: number;
    abandoned_total: number;
  } {
    return {
      pending: this.#pendingReplayAcks.size,
      failed_total: this.#replayAckFailures,
      succeeded_total: this.#replayAckSucceeded,
      escalated_total: this.#replayAckEscalated,
      abandoned_total: this.#replayAckAbandoned
    };
  }

  runtimeMetrics(): {
    commands: number;
    sessions: number;
    transport_session_index: number;
    quality_snapshots: number;
    journal_compaction_failures_total: number;
    command_limit: number;
    session_limit: number;
  } {
    return {
      commands: this.#commands.size,
      sessions: this.#sessions.size,
      transport_session_index: this.#sessionsByTransportId.size,
      quality_snapshots: this.#quality.size,
      journal_compaction_failures_total: this.#journalCompactionFailures,
      command_limit: this.#maxCommands,
      session_limit: this.#maxSessions
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#replayAckTimer) {
      clearTimeout(this.#replayAckTimer);
      this.#replayAckTimer = null;
    }
    if (this.#journalCompactionRetryTimer) {
      clearTimeout(this.#journalCompactionRetryTimer);
      this.#journalCompactionRetryTimer = null;
    }
    await Promise.all([...this.#tails.values()]);
    await this.#replayAckDrain;
    await this.#journalCompaction;
    if (this.#journalCompactionDirty) {
      try {
        await this.#journal.compact(this.#now());
        this.#journalCompactionDirty = false;
      } catch {
        this.#journalCompactionFailures += 1;
      }
    }
    const failures: unknown[] = [];
    await this.#client.close().catch((error) => failures.push(error));
    await this.#journal.close().catch((error) => failures.push(error));
    if (failures.length > 0) {
      throw new AggregateError(failures, 'rtpengine_transport_close_failed');
    }
  }

  async #execute(
    command: MediaTransportCommand
  ): Promise<MediaTransportOutcome> {
    if (this.#cleanupExpiredTerminals(this.#now().getTime()) > 0) {
      this.#scheduleJournalCompaction();
    }
    const key = commandKey(command);
    const recorded = this.#commands.get(key);
    const current = this.#sessions.get(command.media_reservation_id);
    if (!recorded && this.#commands.size >= this.#maxCommands) {
      return failed(
        command.command_id,
        'transport_command_capacity_exhausted',
        true
      );
    }
    if (!current &&
        command.action !== 'query' &&
        command.action !== 'subscribe_quality' &&
        command.action !== 'drain_node' &&
        this.#sessions.size >= this.#maxSessions) {
      return failed(
        command.command_id,
        'transport_session_capacity_exhausted',
        true
      );
    }
    if ((command.action === 'query' ||
          command.action === 'subscribe_quality') &&
        !this.#quality.has(command.call_id) &&
        this.#quality.size >= this.#maxSessions) {
      return failed(
        command.command_id,
        'transport_quality_capacity_exhausted',
        true
      );
    }
    if (recorded) {
      if (recorded.command_hash !== command.command_hash) {
        return failed(command.command_id, 'command_payload_conflict', false);
      }
      if (recorded.result_class !== 'unknown') {
        const outcome = outcomeFromRecord(recorded);
        await this.#ackReplay(command, outcome);
        return outcome;
      }
      if (recorded.error_code ===
          'rtpengine_invalid_sdp_cleanup_unconfirmed') {
        const resolved = await this.#resolveInvalidSdpCleanup(
          command,
          current,
          true
        );
        return this.#persist(
          command,
          resolved.outcome,
          resolved.forcedSessionState
        );
      }
      let status: RtpengineCommandStatus;
      try {
        status = await this.#queryCommandStatus(command);
      } catch (error) {
        return unknown(
          command.command_id,
          error instanceof RtpengineMediaTransportError
            ? error.code
            : 'rtpengine_recovery_unavailable'
        );
      }
      if (status.state === 'applied') {
        const resolved = await this.#resolveResponse(
          command,
          status.response,
          current
        );
        const persisted = await this.#persist(
          command,
          resolved.outcome,
          resolved.forcedSessionState
        );
        await this.#ackReplay(command, persisted);
        return persisted;
      }
      if (status.state === 'conflict') {
        return this.#persist(
          command,
          failed(command.command_id, 'rtpengine_command_conflict', false)
        );
      }
      if (!status.guardEntryFound) {
        let query: { found: boolean; response: BencodeDictionary };
        try {
          query = await this.#queryCall(
            command.call_id,
            [
              'command-reconcile',
              this.#startupNonce,
              command.command_id,
              command.command_hash
            ].join(':')
          );
        } catch (error) {
          return unknown(
            command.command_id,
            error instanceof RtpengineMediaTransportError
              ? error.code
              : 'rtpengine_recovery_unavailable'
          );
        }
        if (command.action === 'delete' && !query.found) {
          return this.#persist(command, {
            state: 'succeeded',
            command_id: command.command_id,
            transport_session_id: command.call_id,
            effective_sdp: current?.effective_sdp ?? '',
            session_state: 'closed',
            applied_at: canonicalNow(this.#now())
          });
        }
        if (!(command.action === 'offer' &&
              command.command_sequence === 1 &&
              !query.found)) {
          return this.#persist(
            command,
            unknown(
              command.command_id,
              'rtpengine_command_status_unproven'
            )
          );
        }
      }
    }

    let request: BencodeDictionary;
    try {
      request = rtpengineRequest(command);
    } catch (error) {
      const outcome = failed(
        command.command_id,
        error instanceof RtpengineMediaTransportError
          ? error.code
          : 'rtpengine_payload_invalid',
        false
      );
      return this.#persist(command, outcome);
    }

    let outcome: MediaTransportOutcome;
    try {
      const response = await this.#client.request(request, {
        command_id: command.command_id,
        command_hash: command.command_hash
      });
      const resolved = await this.#resolveResponse(
        command,
        response,
        current
      );
      outcome = resolved.outcome;
      if (resolved.forcedSessionState) {
        const persisted = await this.#persist(
          command,
          outcome,
          resolved.forcedSessionState
        );
        await this.#ackReplay(command, persisted);
        return persisted;
      }
      if (command.action === 'query' ||
          command.action === 'subscribe_quality') {
        this.#quality.set(command.call_id, structuredClone(response));
      }
    } catch (error) {
      outcome = transportErrorOutcome(command.command_id, error);
    }
    const persisted = await this.#persist(command, outcome);
    await this.#ackReplay(command, persisted);
    return persisted;
  }

  async #persist(
    command: MediaTransportCommand,
    outcome: MediaTransportOutcome,
    forcedSessionState?: MediaTransportSessionSnapshot['state']
  ): Promise<MediaTransportOutcome> {
    const now = canonicalNow(this.#now());
    const current = this.#sessions.get(command.media_reservation_id);
    const sessionState = forcedSessionState ?? (outcome.state === 'succeeded'
      ? outcome.session_state
      : current?.state ?? null);
    const terminal = outcome.state !== 'unknown' &&
      sessionState !== null &&
      TERMINAL_STATES.has(sessionState);
    const record: MediaCommandJournalRecord = {
      action: command.action,
      command_id: command.command_id,
      media_reservation_id: command.media_reservation_id,
      command_hash: command.command_hash,
      owner_epoch: command.owner_epoch,
      command_sequence: command.command_sequence,
      transport_call_id: command.call_id,
      result_class: outcome.state === 'succeeded'
        ? 'succeeded'
        : outcome.state === 'failed'
          ? 'failed'
          : 'unknown',
      error_code: outcome.state === 'succeeded'
        ? null
        : outcome.error_code,
      retryable: outcome.state === 'succeeded'
        ? null
        : outcome.retryable,
      effective_sdp: outcome.state === 'succeeded'
        ? outcome.effective_sdp
        : current?.effective_sdp ?? '',
      session_state: outcome.state === 'unknown' &&
          sessionState !== null &&
          TERMINAL_STATES.has(sessionState)
          ? null
          : sessionState,
      from_tag: payloadTag(command.payload.from_tag) ?? current?.from_tag ?? null,
      to_tag: payloadTag(command.payload.to_tag) ?? current?.to_tag ?? null,
      recorded_at: now,
      terminal_at: terminal ? now : null,
      tenant_id: current?.tenant_id ?? command.tenant_id,
      leg_id: current?.leg_id ?? command.leg_id,
      cell_id: current?.cell_id ?? command.cell_id,
      owner_node_id: current?.owner_node_id ?? command.owner_node_id,
      expires_at: command.expires_at
    };
    await this.#appendRecord(record);
    this.#applyRecord(record);
    return structuredClone(outcome);
  }

  async #restore(): Promise<void> {
    const now = this.#now();
    await this.#journal.compact(now);
    const replayed = await this.#journal.replay();
    const expiredReservations = expiredTerminalReservations(
      replayed,
      now.getTime() - this.#terminalRetentionMs
    );
    const records = replayed.filter(
      (record) => !expiredReservations.has(record.media_reservation_id)
    );
    const latestByCommand = new Map<string, MediaCommandJournalRecord>();
    for (const record of records) {
      this.#applyRecord(record);
      latestByCommand.set(commandKey(record), record);
    }
    const active = [...this.#sessions.values()].filter(
      (session) => !TERMINAL_STATES.has(session.state)
    );
    const unknownNegotiations = new Map<
      string,
      MediaCommandJournalRecord
    >();
    for (const record of latestByCommand.values()) {
      if (record.result_class !== 'unknown' ||
          !NEGOTIATION_ACTIONS.has(record.action)) {
        continue;
      }
      const current = unknownNegotiations.get(record.media_reservation_id);
      if (!current || journalCommandAfter(record, current)) {
        unknownNegotiations.set(record.media_reservation_id, record);
      }
    }
    const provenApplied = new Set<string>();
    await parallel(
      [...unknownNegotiations.values()],
      this.#recoveryConcurrency,
      async (record) => {
        const command = commandFromRecord(record);
        if (record.error_code ===
            'rtpengine_invalid_sdp_cleanup_unconfirmed') {
          const resolved = await this.#resolveInvalidSdpCleanup(
            command,
            this.#sessions.get(record.media_reservation_id),
            true
          );
          await this.#persist(
            command,
            resolved.outcome,
            resolved.forcedSessionState
          );
          return;
        }
        let status: RtpengineCommandStatus;
        try {
          status = await this.#queryCommandStatus(command);
        } catch {
          return;
        }
        if (status.state === 'applied') {
          const resolved = await this.#resolveResponse(
            command,
            status.response,
            this.#sessions.get(record.media_reservation_id)
          );
          await this.#persist(
            command,
            resolved.outcome,
            resolved.forcedSessionState
          );
          if (resolved.outcome.state === 'succeeded') {
            provenApplied.add(commandKey(command));
          }
        } else if (status.state === 'conflict') {
          await this.#persist(
            command,
            failed(command.command_id, 'rtpengine_command_conflict', false)
          );
        }
      }
    );
    const latestSucceeded = new Map<string, MediaCommandJournalRecord>();
    for (const record of this.#commands.values()) {
      if (record.result_class !== 'succeeded') continue;
      const current = latestSucceeded.get(record.media_reservation_id);
      if (!current || journalCommandAfter(record, current)) {
        latestSucceeded.set(record.media_reservation_id, record);
      }
    }
    const recoverableAcks = [...latestSucceeded.values()].filter(
      (record) => NEGOTIATION_ACTIONS.has(record.action)
    );
    await parallel(
      recoverableAcks,
      this.#recoveryConcurrency,
      async (record) => {
        const command = commandFromRecord(record);
        if (!provenApplied.has(commandKey(command))) {
          let status: RtpengineCommandStatus;
          try {
            status = await this.#queryCommandStatus(command);
          } catch {
            return;
          }
          if (status.state !== 'applied') return;
        }
        await this.#ackReplay(command, outcomeFromRecord(record));
      }
    );
    await parallel(active, this.#recoveryConcurrency, async (session) => {
      const query = await this.#queryCall(
        session.call_id,
        [
          'startup',
          this.#startupNonce,
          session.media_reservation_id,
          session.last_sequence
        ].join(':')
      );
      if (!query.found) {
        await this.#markMissing(session);
      }
    });
  }

  async #markMissing(
    session: MediaTransportSessionSnapshot
  ): Promise<void> {
    if (this.#cleanupExpiredTerminals(this.#now().getTime()) > 0) {
      this.#scheduleJournalCompaction();
    }
    if (this.#commands.size >= this.#maxCommands) {
      throw new RtpengineMediaTransportError(
        'transport_command_capacity_exhausted'
      );
    }
    const now = canonicalNow(this.#now());
    const record: MediaCommandJournalRecord = {
      action: 'delete',
      command_id: `recovery-${digest([
        session.media_reservation_id,
        session.owner_epoch,
        String(session.last_sequence),
        'missing'
      ].join('\0')).slice(0, 48)}`,
      media_reservation_id: session.media_reservation_id,
      command_hash: digest([
        session.call_id,
        session.owner_epoch,
        String(session.last_sequence),
        'closed'
      ].join('\0')),
      owner_epoch: session.owner_epoch,
      command_sequence: session.last_sequence,
      transport_call_id: session.call_id,
      result_class: 'succeeded',
      error_code: null,
      retryable: null,
      effective_sdp: session.effective_sdp,
      session_state: 'closed',
      from_tag: session.from_tag,
      to_tag: session.to_tag,
      recorded_at: now,
      terminal_at: now,
      ...journalIdentityFromSession(session)
    };
    await this.#appendRecord(record);
    this.#applyRecord(record);
  }

  async #queryCall(
    callId: string,
    identitySeed: string
  ): Promise<{ found: boolean; response: BencodeDictionary }> {
    const commandHash = digest(`rtpengine-query\0${callId}\0${identitySeed}`);
    let response: BencodeDictionary;
    try {
      response = await this.#client.request(
        {
          command: 'query',
          'call-id': callId
        },
        {
          command_id: `query-${commandHash.slice(0, 48)}`,
          command_hash: commandHash
        }
      );
    } catch (error) {
      throw new RtpengineMediaTransportError(
        'rtpengine_recovery_unavailable',
        { cause: error }
      );
    }
    const result = stringValue(response.result);
    if (result === 'ok') return { found: true, response };
    const reason = stringValue(response['error-reason']);
    if (/unknown call(?:-id)?/i.test(reason)) {
      return { found: false, response };
    }
    throw new RtpengineMediaTransportError(
      errorCode(reason || result || 'query failed')
    );
  }

  async #queryCommandStatus(
    command: MediaTransportCommand
  ): Promise<RtpengineCommandStatus> {
    const commandHash = digest([
      'rtpengine-command-status',
      command.call_id,
      command.owner_epoch,
      String(command.command_sequence),
      command.command_id,
      command.command_hash,
      command.media_reservation_id
    ].join('\0'));
    let response: BencodeDictionary;
    try {
      response = await this.#client.request(
        {
          command: 'ivekit command status',
          'call-id': command.call_id,
          'ivekit-status-owner-epoch': command.owner_epoch,
          'ivekit-status-command-sequence': String(command.command_sequence),
          'ivekit-status-command-id': command.command_id,
          'ivekit-status-command-hash': command.command_hash,
          'ivekit-status-reservation-id': command.media_reservation_id
        },
        {
          command_id: `status-${commandHash.slice(0, 48)}`,
          command_hash: commandHash
        }
      );
    } catch (error) {
      throw new RtpengineMediaTransportError(
        'rtpengine_recovery_unavailable',
        { cause: error }
      );
    }
    const result = stringValue(response.result);
    const state = stringValue(response['ivekit-command-status']);
    const entryFound = integerValue(response['ivekit-guard-entry-found']);
    if (result !== 'ok' ||
        !['applied', 'unseen', 'conflict'].includes(state) ||
        (entryFound !== 0 && entryFound !== 1) ||
        (state === 'applied' &&
          (entryFound !== 1 ||
            integerValue(response['ivekit-command-replayed']) !== 1 ||
            !validFenceAck(command, response)))) {
      throw new RtpengineMediaTransportError(
        'rtpengine_command_status_invalid'
      );
    }
    return {
      state: state as RtpengineCommandStatus['state'],
      guardEntryFound: entryFound === 1,
      response
    };
  }

  async #resolveResponse(
    command: MediaTransportCommand,
    response: BencodeDictionary,
    current: MediaTransportSessionSnapshot | undefined
  ): Promise<ResolvedRtpengineResponse> {
    const outcome = responseOutcome(
      command,
      response,
      current,
      this.#now()
    );
    if (outcome.state !== 'unknown' ||
        outcome.error_code !==
          'rtpengine_effective_sdp_invalid_applied') {
      return { outcome };
    }
    return this.#resolveInvalidSdpCleanup(command, current, false);
  }

  async #resolveInvalidSdpCleanup(
    command: MediaTransportCommand,
    current: MediaTransportSessionSnapshot | undefined,
    recover: boolean
  ): Promise<ResolvedRtpengineResponse> {
    const cleanup = invalidSdpCleanupCommand(command);
    if (!cleanup) {
      return {
        outcome: unknown(
          command.command_id,
          'rtpengine_invalid_sdp_cleanup_unavailable'
        )
      };
    }
    if (recover) {
      let status: RtpengineCommandStatus;
      try {
        status = await this.#queryCommandStatus(cleanup);
      } catch {
        return {
          outcome: unknown(
            command.command_id,
            'rtpengine_invalid_sdp_cleanup_unconfirmed'
          )
        };
      }
      if (status.state === 'applied') {
        return invalidSdpCleanupResult(
          command,
          responseOutcome(cleanup, status.response, current, this.#now())
        );
      }
      if (status.state === 'conflict') {
        return {
          outcome: unknown(
            command.command_id,
            'rtpengine_invalid_sdp_cleanup_unconfirmed'
          )
        };
      }
      if (!status.guardEntryFound) {
        try {
          const query = await this.#queryCall(
            command.call_id,
            [
              'invalid-sdp-cleanup',
              this.#startupNonce,
              cleanup.command_id,
              cleanup.command_hash
            ].join(':')
          );
          if (!query.found) {
            return invalidSdpCleanupResult(command, {
              state: 'succeeded',
              command_id: cleanup.command_id,
              transport_session_id: cleanup.call_id,
              effective_sdp: current?.effective_sdp ?? '',
              session_state: 'closed',
              applied_at: canonicalNow(this.#now())
            });
          }
        } catch {
          return {
            outcome: unknown(
              command.command_id,
              'rtpengine_invalid_sdp_cleanup_unconfirmed'
            )
          };
        }
      }
    }
    let cleanupOutcome: MediaTransportOutcome;
    try {
      const cleanupResponse = await this.#client.request(
        rtpengineRequest(cleanup),
        {
          command_id: cleanup.command_id,
          command_hash: cleanup.command_hash
        }
      );
      cleanupOutcome = responseOutcome(
        cleanup,
        cleanupResponse,
        current,
        this.#now()
      );
    } catch (error) {
      cleanupOutcome = transportErrorOutcome(cleanup.command_id, error);
    }
    return invalidSdpCleanupResult(command, cleanupOutcome);
  }

  async #ackReplay(
    command: MediaTransportCommand,
    outcome: MediaTransportOutcome
  ): Promise<void> {
    if (outcome.state !== 'succeeded' ||
        !NEGOTIATION_ACTIONS.has(command.action)) {
      return;
    }
    const task = replayAckTask(command);
    const pending = this.#pendingReplayAcks.get(task.key);
    if (pending &&
        pending.command.command_id === command.command_id &&
        pending.command.command_hash === command.command_hash) {
      return;
    }
    if (pending) this.#pendingReplayAcks.delete(task.key);
    try {
      await this.#sendReplayAck(task);
      this.#replayAckSucceeded += 1;
    } catch {
      this.#replayAckFailures += 1;
      task.attempts = 1;
      task.nextAttemptAt = Date.now() + this.#replayAckDelay(task.attempts);
      if (this.#pendingReplayAcks.size >= this.#maxSessions) {
        this.#replayAckAbandoned += 1;
        throw new RtpengineMediaTransportError(
          'rtpengine_replay_ack_capacity_exhausted'
        );
      }
      this.#pendingReplayAcks.set(task.key, task);
      this.#scheduleReplayAckDrain();
    }
  }

  async #sendReplayAck(task: ReplayAckTask): Promise<void> {
    const commandHash = digest([
      'rtpengine-replay-ack',
      task.command.call_id,
      task.command.command_id,
      task.command.command_hash
    ].join('\0'));
    const response = await this.#client.request(
      {
        command: 'ivekit replay ack',
        'call-id': task.command.call_id,
        'ivekit-ack-command-id': task.command.command_id,
        'ivekit-ack-command-hash': task.command.command_hash
      },
      {
        command_id: `ack-${commandHash.slice(0, 48)}`,
        command_hash: commandHash
      }
    );
    const acknowledged = integerValue(
      response['ivekit-replay-acknowledged']
    );
    if (stringValue(response.result) !== 'ok' ||
        (acknowledged !== 0 && acknowledged !== 1)) {
      throw new RtpengineMediaTransportError(
        'rtpengine_replay_ack_rejected'
      );
    }
  }

  #scheduleReplayAckDrain(): void {
    if (this.#closed || this.#replayAckTimer || this.#replayAckDrain ||
        this.#pendingReplayAcks.size === 0) {
      return;
    }
    let nextAttemptAt = Number.POSITIVE_INFINITY;
    for (const task of this.#pendingReplayAcks.values()) {
      nextAttemptAt = Math.min(nextAttemptAt, task.nextAttemptAt);
    }
    this.#replayAckTimer = setTimeout(() => {
      this.#replayAckTimer = null;
      if (this.#closed) return;
      const drain = this.#drainReplayAcks();
      this.#replayAckDrain = drain;
      void drain.finally(() => {
        if (this.#replayAckDrain === drain) this.#replayAckDrain = null;
        this.#scheduleReplayAckDrain();
      });
    }, Math.max(1, nextAttemptAt - Date.now()));
    this.#replayAckTimer.unref();
  }

  async #drainReplayAcks(): Promise<void> {
    const now = Date.now();
    const due: ReplayAckTask[] = [];
    for (const task of this.#pendingReplayAcks.values()) {
      if (task.nextAttemptAt <= now) due.push(task);
      if (due.length >= 1_024) break;
    }
    await parallel(due, this.#recoveryConcurrency, async (task) => {
      if (this.#pendingReplayAcks.get(task.key) !== task) return;
      try {
        await this.#sendReplayAck(task);
        this.#pendingReplayAcks.delete(task.key);
        this.#replayAckSucceeded += 1;
      } catch {
        this.#replayAckFailures += 1;
        task.attempts += 1;
        if (task.attempts >= this.#replayAckMaxAttempts) {
          task.attempts = this.#replayAckMaxAttempts;
          if (!task.escalated) {
            task.escalated = true;
            this.#replayAckEscalated += 1;
          }
        }
        task.nextAttemptAt =
          Date.now() + this.#replayAckDelay(task.attempts);
      }
    });
  }

  #replayAckDelay(attempts: number): number {
    return Math.min(
      this.#replayAckRetryMaxMs,
      this.#replayAckRetryBaseMs * 2 ** Math.min(attempts - 1, 20)
    );
  }

  async #appendRecord(record: MediaCommandJournalRecord): Promise<void> {
    if (this.#journalCompactionDirty) {
      await (this.#journalCompaction ?? this.#runJournalCompaction());
      if (this.#journalCompactionDirty) {
        await this.#runJournalCompaction();
      }
    }
    await this.#journal.append(record);
  }

  #applyRecord(record: MediaCommandJournalRecord): void {
    const key = commandKey(record);
    if (!this.#commands.has(key) && this.#commands.size >= this.#maxCommands) {
      throw new RtpengineMediaTransportError(
        'transport_command_capacity_exhausted'
      );
    }
    const restoresSession = record.session_state !== null &&
      (record.result_class === 'succeeded' ||
        TERMINAL_STATES.has(record.session_state));
    if (restoresSession &&
        record.session_state &&
        !this.#sessions.has(record.media_reservation_id) &&
        this.#sessions.size >= this.#maxSessions) {
      throw new RtpengineMediaTransportError(
        'transport_session_capacity_exhausted'
      );
    }
    this.#commands.set(key, structuredClone(record));
    if (record.result_class === 'succeeded' &&
        !NEGOTIATION_ACTIONS.has(record.action)) {
      this.#pendingReplayAcks.delete(record.media_reservation_id);
    }
    if (record.session_state &&
        TERMINAL_STATES.has(record.session_state)) {
      this.#pendingReplayAcks.delete(record.media_reservation_id);
    }
    let reservationKeys = this.#commandKeysByReservation.get(
      record.media_reservation_id
    );
    if (!reservationKeys) {
      reservationKeys = new Set();
      this.#commandKeysByReservation.set(
        record.media_reservation_id,
        reservationKeys
      );
    }
    reservationKeys.add(key);
    if (!restoresSession || !record.session_state) return;
    const previous = this.#sessions.get(record.media_reservation_id);
    if (previous) {
      this.#sessionsByTransportId.delete(previous.transport_session_id);
    }
    const session: MediaTransportSessionSnapshot = {
      media_reservation_id: record.media_reservation_id,
      call_id: record.transport_call_id,
      ...(record.tenant_id
        ? {
            tenant_id: record.tenant_id,
            leg_id: record.leg_id!,
            cell_id: record.cell_id!,
            owner_node_id: record.owner_node_id!,
            expires_at: record.expires_at!
          }
        : {}),
      owner_epoch: record.owner_epoch,
      last_sequence: record.command_sequence,
      state: record.session_state,
      transport_session_id: record.transport_call_id,
      effective_sdp: record.effective_sdp,
      from_tag: record.from_tag,
      to_tag: record.to_tag,
      updated_at: record.recorded_at
    };
    this.#sessions.set(record.media_reservation_id, session);
    this.#sessionsByTransportId.set(
      session.transport_session_id,
      session.media_reservation_id
    );
    if (TERMINAL_STATES.has(session.state)) {
      this.#quality.delete(session.call_id);
      this.#terminalExpirations.push({
        reservationId: session.media_reservation_id,
        recordedAt: session.updated_at,
        expiresAt:
          Date.parse(session.updated_at) + this.#terminalRetentionMs
      });
    }
  }

  #cleanupExpiredTerminals(now: number): number {
    if (!Number.isFinite(now)) return 0;
    let removed = 0;
    while (this.#terminalExpirationCursor < this.#terminalExpirations.length) {
      const expiration =
        this.#terminalExpirations[this.#terminalExpirationCursor]!;
      if (expiration.expiresAt > now) break;
      this.#terminalExpirationCursor += 1;
      const session = this.#sessions.get(expiration.reservationId);
      if (!session ||
          session.updated_at !== expiration.recordedAt ||
          !TERMINAL_STATES.has(session.state)) {
        continue;
      }
      this.#sessions.delete(expiration.reservationId);
      this.#sessionsByTransportId.delete(session.transport_session_id);
      this.#quality.delete(session.call_id);
      for (const key of this.#commandKeysByReservation.get(
        expiration.reservationId
      ) ?? []) {
        this.#commands.delete(key);
      }
      this.#commandKeysByReservation.delete(expiration.reservationId);
      removed += 1;
    }
    if (this.#terminalExpirationCursor >= 1_024 &&
        this.#terminalExpirationCursor * 2 >=
          this.#terminalExpirations.length) {
      this.#terminalExpirations = this.#terminalExpirations.slice(
        this.#terminalExpirationCursor
      );
      this.#terminalExpirationCursor = 0;
    }
    return removed;
  }

  #scheduleJournalCompaction(): void {
    if (this.#closed) return;
    this.#journalCompactionDirty = true;
    if (this.#journalCompaction) {
      this.#journalCompactionRequested = true;
      return;
    }
    void this.#runJournalCompaction();
  }

  #runJournalCompaction(): Promise<void> {
    if (this.#journalCompaction) return this.#journalCompaction;
    if (this.#journalCompactionRetryTimer) {
      clearTimeout(this.#journalCompactionRetryTimer);
      this.#journalCompactionRetryTimer = null;
    }
    this.#journalCompactionRequested = false;
    const run = this.#journal.compact(this.#now())
      .then(() => {
        this.#journalCompactionAttempts = 0;
        if (!this.#journalCompactionRequested) {
          this.#journalCompactionDirty = false;
        }
      })
      .catch(() => {
        this.#journalCompactionFailures += 1;
        this.#journalCompactionAttempts += 1;
        this.#journalCompactionDirty = true;
      });
    this.#journalCompaction = run;
    void run.finally(() => {
      if (this.#journalCompaction === run) {
        this.#journalCompaction = null;
      }
      if (this.#journalCompactionRequested) {
        this.#journalCompactionRequested = false;
        this.#scheduleJournalCompaction();
      } else if (this.#journalCompactionDirty) {
        this.#scheduleJournalCompactionRetry();
      }
    });
    return run;
  }

  #scheduleJournalCompactionRetry(): void {
    if (this.#closed ||
        this.#journalCompactionRetryTimer ||
        !this.#journalCompactionDirty) {
      return;
    }
    const delay = Math.min(
      this.#journalCompactionRetryMaxMs,
      this.#journalCompactionRetryBaseMs *
        2 ** Math.min(this.#journalCompactionAttempts - 1, 20)
    );
    this.#journalCompactionRetryTimer = setTimeout(() => {
      this.#journalCompactionRetryTimer = null;
      if (!this.#closed && this.#journalCompactionDirty) {
        void this.#runJournalCompaction();
      }
    }, delay);
    this.#journalCompactionRetryTimer.unref();
  }

  #serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#tails.set(key, tail);
    void tail.finally(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new RtpengineMediaTransportError('rtpengine_transport_closed');
    }
  }
}

export function rtpengineRequest(
  command: MediaTransportCommand
): BencodeDictionary {
  checkedCommandIdentity(command);
  const mapped = mappedCommand(command);
  const request: BencodeDictionary = {
    command: mapped.command,
    'call-id': command.call_id,
    ...mapped.fields
  };
  if (MUTATING_ACTIONS.has(command.action)) {
    request['ivekit-owner-epoch'] = command.owner_epoch;
    request['ivekit-command-id'] = command.command_id;
    request['ivekit-command-hash'] = command.command_hash;
    request['ivekit-command-sequence'] = String(command.command_sequence);
    request['ivekit-reservation-id'] = command.media_reservation_id;
  }
  return request;
}

function mappedCommand(command: MediaTransportCommand): {
  command: string;
  fields: BencodeDictionary;
} {
  const payload = plainPayload(command.payload);
  switch (command.action) {
    case 'offer':
      return {
        command: 'offer',
        fields: negotiationFields(payload, 'offer', true)
      };
    case 'answer':
      return {
        command: 'answer',
        fields: negotiationFields(payload, 'answer', true)
      };
    case 'update': {
      const role = exactText(payload.negotiation_role, 16);
      if (role !== 'offer' && role !== 'answer') throw payloadError();
      return {
        command: role,
        fields: negotiationFields(payload, role, false)
      };
    }
    case 'delete':
      return {
        command: 'delete',
        fields: tagFields(payload, { requireFrom: true })
      };
    case 'query':
    case 'subscribe_quality':
      return {
        command: 'query',
        fields: tagFields(payload)
      };
    case 'block_media':
      return {
        command: 'block media',
        fields: participantFields(payload, false)
      };
    case 'unblock_media':
      return {
        command: 'unblock media',
        fields: participantFields(payload, false)
      };
    case 'start_forward':
      return {
        command: 'start forwarding',
        fields: participantFields(payload, true)
      };
    case 'stop_forward':
      return {
        command: 'stop forwarding',
        fields: participantFields(payload, true)
      };
    case 'start_recording_fork':
      return { command: 'start recording', fields: tagFields(payload) };
    case 'stop_recording_fork':
      return { command: 'stop recording', fields: tagFields(payload) };
    case 'play_media': {
      const fields = participantFields(payload, true);
      fields.file = boundedText(payload.file, 1024);
      optionalInteger(fields, payload, 'repeat_times', 'repeat-times', 1, 1000);
      optionalInteger(fields, payload, 'start_pos', 'start-pos', 0, 0x7fff_ffff);
      return { command: 'play media', fields };
    }
    case 'stop_media':
      return {
        command: 'stop media',
        fields: participantFields(payload, true)
      };
    case 'inject_dtmf': {
      const fields = participantFields(payload, true);
      const digit = exactText(payload.digit ?? payload.code, 1);
      if (!/^[0-9*#A-D]$/.test(digit)) throw payloadError();
      fields.digit = digit;
      optionalInteger(fields, payload, 'duration', 'duration', 100, 5000);
      optionalInteger(fields, payload, 'volume', 'volume', 0, 63);
      optionalInteger(fields, payload, 'pause', 'pause', 100, 5000);
      return { command: 'play DTMF', fields };
    }
    case 'drain_node':
      return { command: 'ivekit drain', fields: {} };
  }
}

function negotiationFields(
  payload: Record<string, unknown>,
  role: 'offer' | 'answer',
  actionSpecificSdp: boolean
): BencodeDictionary {
  const sdpKey = actionSpecificSdp
    ? role === 'offer' ? 'offer_sdp' : 'answer_sdp'
    : 'sdp';
  const fields: BencodeDictionary = {
    sdp: boundedSdp(payload[sdpKey]),
    'from-tag': sipTag(payload.from_tag)
  };
  if (role === 'answer') fields['to-tag'] = sipTag(payload.to_tag);
  else if (payload.to_tag !== undefined) {
    fields['to-tag'] = sipTag(payload.to_tag);
  }
  const profile = payload.media_profile_id;
  if (role === 'offer' && actionSpecificSdp && profile === undefined) {
    throw payloadError();
  }
  if (profile !== undefined) fields.template = identifier(profile);
  if (payload.direction !== undefined) {
    if (role === 'answer' || !Array.isArray(payload.direction) ||
        payload.direction.length !== 2) {
      throw payloadError();
    }
    fields.direction = payload.direction.map((value) => identifier(value));
  }
  return fields;
}

function tagFields(
  payload: Record<string, unknown>,
  options: { requireFrom?: boolean } = {}
): BencodeDictionary {
  const fields: BencodeDictionary = {};
  if (options.requireFrom || payload.from_tag !== undefined) {
    fields['from-tag'] = sipTag(payload.from_tag);
  }
  if (payload.to_tag !== undefined) {
    fields['to-tag'] = sipTag(payload.to_tag);
  }
  return fields;
}

function participantFields(
  payload: Record<string, unknown>,
  required: boolean
): BencodeDictionary {
  const fields = tagFields(payload);
  if (payload.label !== undefined) fields.label = identifier(payload.label);
  if (payload.to_label !== undefined) {
    fields['to-label'] = identifier(payload.to_label);
  }
  if (payload.address !== undefined) {
    fields.address = boundedText(payload.address, 64);
  }
  if (payload.all !== undefined) {
    const all = exactText(payload.all, 32);
    if (!['all', 'offer-answer', 'except-offer-answer', 'flows'].includes(all)) {
      throw payloadError();
    }
    fields.all = all;
  }
  if (required && Object.keys(fields).length === 0) throw payloadError();
  return fields;
}

function responseOutcome(
  command: MediaTransportCommand,
  response: BencodeDictionary,
  current: MediaTransportSessionSnapshot | undefined,
  now: Date
): MediaTransportOutcome {
  const result = stringValue(response.result);
  const reason = stringValue(response['error-reason']) ||
    stringValue(response.warning) ||
    result ||
    'response invalid';
  const fencedReplay = result === 'error' &&
    integerValue(response['ivekit-command-replayed']) === 1 &&
    /ivekit command already applied/i.test(reason) &&
    validFenceAck(command, response);
  if (result !== 'ok' && !fencedReplay) {
    const code = errorCode(reason);
    return failed(command.command_id, code, retryable(code));
  }
  if (MUTATING_ACTIONS.has(command.action) &&
      command.action !== 'drain_node' &&
      !validFenceAck(command, response)) {
    return unknown(command.command_id, 'rtpengine_fence_ack_invalid');
  }
  if (NEGOTIATION_ACTIONS.has(command.action) &&
      stringValue(response['ivekit-command-result']) ===
        'invalid_effective_sdp') {
    return unknown(
      command.command_id,
      'rtpengine_effective_sdp_invalid_applied'
    );
  }

  const requiresSdp = command.action === 'offer' ||
    command.action === 'answer' ||
    command.action === 'update';
  const returnedSdp = sdpValue(response.sdp);
  if (requiresSdp &&
      (returnedSdp === null ||
        !validSdp(returnedSdp, MAX_EFFECTIVE_SDP_BYTES))) {
    return unknown(command.command_id, 'rtpengine_effective_sdp_missing');
  }
  const state = nextState(command, current);
  return {
    state: 'succeeded',
    command_id: command.command_id,
    transport_session_id: command.call_id,
    effective_sdp: returnedSdp || current?.effective_sdp || '',
    session_state: state,
    applied_at: canonicalNow(now)
  };
}

function nextState(
  command: MediaTransportCommand,
  current: MediaTransportSessionSnapshot | undefined
): MediaTransportSessionSnapshot['state'] {
  if (command.action === 'delete') return 'closed';
  if (command.action === 'answer' || command.action === 'start_forward') {
    return 'committed';
  }
  if (command.action === 'offer' && !current) return 'prepared';
  if (command.action === 'update' && !current) {
    return command.payload.negotiation_role === 'answer'
      ? 'committed'
      : 'prepared';
  }
  if (command.action === 'drain_node' && !current) return 'closed';
  return current?.state ?? 'prepared';
}

function validFenceAck(
  command: MediaTransportCommand,
  response: BencodeDictionary
): boolean {
  return stringValue(response['ivekit-owner-epoch']) === command.owner_epoch &&
    stringValue(response['ivekit-command-id']) === command.command_id &&
    stringValue(response['ivekit-command-hash']) === command.command_hash &&
    integerValue(response['ivekit-command-sequence']) ===
      command.command_sequence &&
    stringValue(response['ivekit-reservation-id']) ===
      command.media_reservation_id;
}

function outcomeFromRecord(
  record: MediaCommandJournalRecord
): Exclude<MediaTransportOutcome, { state: 'unknown' }> {
  if (record.result_class === 'failed') {
    return failed(
      record.command_id,
      record.error_code ?? 'rtpengine_journal_invalid',
      record.retryable ?? false
    );
  }
  if (record.result_class !== 'succeeded' || !record.session_state) {
    return failed(record.command_id, 'rtpengine_journal_invalid', false);
  }
  return {
    state: 'succeeded',
    command_id: record.command_id,
    transport_session_id: record.transport_call_id,
    effective_sdp: record.effective_sdp,
    session_state: record.session_state,
    applied_at: record.recorded_at
  };
}

function transportErrorOutcome(
  commandId: string,
  error: unknown
): MediaTransportOutcome {
  if (error instanceof RtpengineNgRequestError) {
    return error.resultClass === 'unknown'
      ? unknown(commandId, error.code)
      : failed(commandId, error.code, retryable(error.code));
  }
  return unknown(commandId, 'rtpengine_transport_unavailable');
}

function failed(
  commandId: string,
  errorCodeValue: string,
  retryableValue: boolean
): Extract<MediaTransportOutcome, { state: 'failed' }> {
  return {
    state: 'failed',
    command_id: commandId,
    error_code: errorCodeValue,
    retryable: retryableValue
  };
}

function unknown(
  commandId: string,
  errorCodeValue: string
): Extract<MediaTransportOutcome, { state: 'unknown' }> {
  return {
    state: 'unknown',
    command_id: commandId,
    error_code: errorCodeValue,
    retryable: true
  };
}

function checkedCommandIdentity(command: MediaTransportCommand): void {
  for (const value of [
    command.command_id,
    command.call_id,
    command.media_reservation_id
  ]) {
    if (!IDENTIFIER.test(String(value))) throw payloadError();
  }
  if (!/^[1-9][0-9]{0,19}$/.test(command.owner_epoch) ||
      BigInt(command.owner_epoch) > (1n << 64n) - 1n ||
      !HASH.test(command.command_hash) ||
      !Number.isInteger(command.command_sequence) ||
      command.command_sequence < 1 ||
      command.command_sequence > 0xffff_ffff ||
      (command.transport_session_id !== undefined &&
       command.transport_session_id !== command.call_id)) {
    throw payloadError();
  }
}

function plainPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw payloadError();
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  const text = String(value ?? '');
  if (!IDENTIFIER.test(text)) throw payloadError();
  return text;
}

function sipTag(value: unknown): string {
  const text = String(value ?? '');
  if (!SIP_TAG.test(text)) throw payloadError();
  return text;
}

function boundedText(value: unknown, maximumBytes: number): string {
  if (typeof value !== 'string' ||
      value.length < 1 ||
      Buffer.byteLength(value, 'utf8') > maximumBytes ||
      /[\0\r\n]/.test(value)) {
    throw payloadError();
  }
  return value;
}

function exactText(value: unknown, maximumBytes: number): string {
  return boundedText(value, maximumBytes);
}

function boundedSdp(value: unknown): string {
  if (typeof value !== 'string' ||
      !validSdp(value, MAX_LOGICAL_SDP_BYTES)) {
    throw payloadError();
  }
  return value;
}

function validSdp(value: string, maximumBytes: number): boolean {
  return value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximumBytes &&
    !value.includes('\0');
}

function optionalInteger(
  target: BencodeDictionary,
  source: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
  minimum: number,
  maximum: number
): void {
  if (source[sourceKey] === undefined) return;
  const value = Number(source[sourceKey]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw payloadError();
  }
  target[targetKey] = value;
}

function stringValue(value: BencodeValue | undefined): string {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8');
  }
  return '';
}

function integerValue(value: BencodeValue | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint' &&
      value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number(value);
  }
  const parsed = Number(stringValue(value));
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function errorCode(reason: string): string {
  const lower = reason.toLowerCase();
  if (lower.includes('stale owner epoch')) return 'stale_owner_epoch';
  if (lower.includes('owner epoch')) return 'owner_epoch_invalid';
  if (lower.includes('command sequence gap')) return 'sequence_gap';
  if (lower.includes('stale command sequence')) return 'stale_sequence';
  if (lower.includes('command id conflict')) return 'command_payload_conflict';
  if (lower.includes('node draining')) return 'transport_node_draining';
  if (lower.includes('active call capacity') ||
      lower.includes('guard state capacity') ||
      lower.includes('load limit')) {
    return 'transport_capacity_exhausted';
  }
  if (/unknown call(?:-id)?/.test(lower)) {
    return 'transport_session_not_found';
  }
  const normalized = lower
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  return normalized ? `rtpengine_${normalized}` : 'rtpengine_response_invalid';
}

function retryable(code: string): boolean {
  return code.includes('capacity') ||
    code.includes('deadline') ||
    code.includes('unavailable') ||
    code === 'rtpengine_ng_connect_failed' ||
    code === 'rtpengine_ng_disconnected' ||
    code === 'transport_node_draining';
}

function commandKey(identity: {
  command_id: string;
  media_reservation_id: string;
  owner_epoch: string;
}): string {
  return [
    identity.media_reservation_id,
    identity.owner_epoch,
    identity.command_id
  ].join('\0');
}

function journalCommandAfter(
  candidate: MediaCommandJournalRecord,
  current: MediaCommandJournalRecord
): boolean {
  const candidateEpoch = BigInt(candidate.owner_epoch);
  const currentEpoch = BigInt(current.owner_epoch);
  if (candidateEpoch !== currentEpoch) return candidateEpoch > currentEpoch;
  if (candidate.command_sequence !== current.command_sequence) {
    return candidate.command_sequence > current.command_sequence;
  }
  return candidate.recorded_at >= current.recorded_at;
}

function canonicalNow(now: Date): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new RtpengineMediaTransportError('rtpengine_time_invalid');
  }
  return now.toISOString();
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function payloadTag(value: unknown): string | null {
  return typeof value === 'string' && SIP_TAG.test(value)
    ? value
    : null;
}

function invalidSdpCleanupCommand(
  command: MediaTransportCommand
): MediaTransportCommand | undefined {
  const fromTag = payloadTag(command.payload.from_tag);
  if (!fromTag || command.command_sequence >= 0xffff_ffff) return undefined;
  const toTag = payloadTag(command.payload.to_tag);
  const cleanupId = `invalid-sdp-${digest([
    command.media_reservation_id,
    command.owner_epoch,
    command.command_id,
    command.command_hash
  ].join('\0')).slice(0, 48)}`;
  const payload = {
    from_tag: fromTag,
    ...(toTag ? { to_tag: toTag } : {})
  };
  return {
    ...command,
    action: 'delete',
    command_id: cleanupId,
    command_sequence: command.command_sequence + 1,
    idempotency_key: cleanupId,
    payload_hash: digest(JSON.stringify(payload)),
    command_hash: digest([
      cleanupId,
      command.call_id,
      command.owner_epoch,
      String(command.command_sequence + 1),
      JSON.stringify(payload)
    ].join('\0')),
    transport_session_id: command.call_id,
    payload
  };
}

function invalidSdpCleanupResult(
  command: MediaTransportCommand,
  cleanupOutcome: MediaTransportOutcome
): ResolvedRtpengineResponse {
  if (cleanupOutcome.state !== 'succeeded') {
    return {
      outcome: unknown(
        command.command_id,
        'rtpengine_invalid_sdp_cleanup_unconfirmed'
      )
    };
  }
  return {
    outcome: failed(
      command.command_id,
      'rtpengine_effective_sdp_invalid',
      false
    ),
    forcedSessionState: 'closed'
  };
}

function commandFromRecord(
  record: MediaCommandJournalRecord
): MediaTransportCommand {
  const payload = {
    ...(record.from_tag ? { from_tag: record.from_tag } : {}),
    ...(record.to_tag ? { to_tag: record.to_tag } : {})
  };
  return {
    action: record.action,
    command_id: record.command_id,
    tenant_id: record.tenant_id ?? 'ivekit-recovery',
    call_id: record.transport_call_id,
    leg_id: record.leg_id ?? 'ivekit-recovery',
    cell_id: record.cell_id ?? 'ivekit-recovery',
    owner_node_id: record.owner_node_id ?? 'ivekit-recovery',
    owner_epoch: record.owner_epoch,
    admission_reservation_id: record.media_reservation_id,
    media_reservation_id: record.media_reservation_id,
    expires_at: record.expires_at ?? record.recorded_at,
    command_sequence: record.command_sequence,
    idempotency_key: record.command_id,
    payload_hash: digest(JSON.stringify(payload)),
    command_hash: record.command_hash,
    transport_session_id: record.transport_call_id,
    payload
  };
}

function completeSessionIdentity(
  session: MediaTransportSessionSnapshot
): session is MediaTransportSessionSnapshot & {
  tenant_id: string;
  leg_id: string;
  cell_id: string;
  owner_node_id: string;
  expires_at: string;
} {
  return Boolean(
    session.tenant_id &&
    session.leg_id &&
    session.cell_id &&
    session.owner_node_id &&
    session.expires_at
  );
}

function journalIdentityFromSession(
  session: MediaTransportSessionSnapshot
): Pick<
  MediaCommandJournalRecord,
  'tenant_id' | 'leg_id' | 'cell_id' | 'owner_node_id' | 'expires_at'
> | Record<string, never> {
  if (!completeSessionIdentity(session)) return {};
  return {
    tenant_id: session.tenant_id,
    leg_id: session.leg_id,
    cell_id: session.cell_id,
    owner_node_id: session.owner_node_id,
    expires_at: session.expires_at
  };
}

function replayAckTask(command: MediaTransportCommand): ReplayAckTask {
  return {
    key: command.media_reservation_id,
    command: structuredClone(command),
    attempts: 0,
    nextAttemptAt: 0,
    escalated: false
  };
}

function expiredTerminalReservations(
  records: MediaCommandJournalRecord[],
  cutoff: number
): Set<string> {
  const latest = new Map<string, MediaCommandJournalRecord>();
  const unresolved = new Map<string, string>();
  for (const record of records) {
    latest.set(record.media_reservation_id, record);
    const key = commandKey(record);
    if (record.result_class === 'unknown') {
      unresolved.set(key, record.media_reservation_id);
    } else {
      unresolved.delete(key);
    }
  }
  const unresolvedReservations = new Set(unresolved.values());
  const expired = new Set<string>();
  for (const [reservationId, record] of latest) {
    if (unresolvedReservations.has(reservationId) ||
        record.terminal_at === null ||
        record.session_state === null ||
        !TERMINAL_STATES.has(record.session_state)) {
      continue;
    }
    const terminalAt = Date.parse(record.terminal_at);
    if (Number.isFinite(terminalAt) && terminalAt <= cutoff) {
      expired.add(reservationId);
    }
  }
  return expired;
}

function sdpValue(value: BencodeValue | undefined): string | null {
  if (value === undefined) return '';
  if (typeof value === 'string') {
    return value.includes('\0') ? null : value;
  }
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return null;
  const bytes = Buffer.from(value);
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function integer(
  value: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RtpengineMediaTransportError(`rtpengine_${name}_invalid`);
  }
  return value;
}

function payloadError(): RtpengineMediaTransportError {
  return new RtpengineMediaTransportError('rtpengine_payload_invalid');
}

async function parallel<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        await operation(values[index]!);
      }
    }
  );
  await Promise.all(workers);
}
