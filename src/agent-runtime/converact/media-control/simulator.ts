import type {
  MediaTransportCommand,
  MediaTransportOrphanCandidate,
  MediaTransportOutcome,
  MediaTransportPort,
  MediaTransportQuery
} from './transport.js';

export type SimulatedFailure =
  | 'before_apply_timeout'
  | 'after_apply_timeout';

interface SimulatedSession {
  media_reservation_id: string;
  call_id: string;
  tenant_id: string;
  leg_id: string;
  cell_id: string;
  owner_node_id: string;
  expires_at: string;
  transport_session_id: string;
  effective_sdp: string;
  state: 'prepared' | 'committed' | 'cancelled' | 'closed' | 'expired';
  owner_epoch: string;
  last_sequence: number;
  from_tag: string | null;
  to_tag: string | null;
  forwarding: boolean;
  forwarded_packets: number;
  updated_at: string;
}

export class InMemoryMediaTransport implements MediaTransportPort {
  readonly #commands = new Map<
    string,
    {
      command_hash: string;
      outcome: Exclude<MediaTransportOutcome, { state: 'unknown' }>;
    }
  >();
  readonly #sessions = new Map<string, SimulatedSession>();
  readonly #sessionsByTransportId = new Map<string, SimulatedSession>();
  readonly #sideEffects = new Map<string, number>();
  #nextFailure: SimulatedFailure | null = null;
  #failNextQuery = false;
  #failNextRelease = false;
  #nextSession = 1;
  readonly #now: () => Date;
  readonly #maxSessions: number;
  readonly #maxCommands: number;

  constructor(input: {
    now?: () => Date;
    max_sessions?: number;
    max_commands?: number;
  } = {}) {
    this.#now = input.now ?? (() => new Date());
    this.#maxSessions = boundedLimit(
      input.max_sessions ?? 100_000,
      'max_sessions'
    );
    this.#maxCommands = boundedLimit(
      input.max_commands ?? 1_600_000,
      'max_commands'
    );
  }

  failNext(failure: SimulatedFailure): void {
    this.#nextFailure = failure;
  }

  failNextQuery(): void {
    this.#failNextQuery = true;
  }

  failNextRelease(): void {
    this.#failNextRelease = true;
  }

  async execute(command: MediaTransportCommand): Promise<MediaTransportOutcome> {
    const key = commandKey(command);
    const recorded = this.#commands.get(key);
    const current = this.#sessions.get(command.media_reservation_id);
    if (current && compareEpoch(command.owner_epoch, current.owner_epoch) < 0) {
      return failedOutcome(command, 'stale_owner_epoch');
    }
    if (recorded) {
      return recorded.command_hash === command.command_hash
        ? structuredClone(recorded.outcome)
        : failedOutcome(command, 'command_payload_conflict');
    }
    if (this.#commands.size >= this.#maxCommands) {
      return failedOutcome(command, 'transport_command_capacity_exhausted');
    }

    const failure = this.#nextFailure;
    this.#nextFailure = null;
    if (failure === 'before_apply_timeout') {
      return {
        state: 'unknown',
        command_id: command.command_id,
        error_code: 'transport_timeout',
        retryable: true
      };
    }

    const outcome = this.#apply(command);
    this.#commands.set(key, {
      command_hash: command.command_hash,
      outcome: structuredClone(outcome)
    });
    if (failure === 'after_apply_timeout') {
      return {
        state: 'unknown',
        command_id: command.command_id,
        error_code: 'transport_timeout',
        retryable: true
      };
    }
    return structuredClone(outcome);
  }

  async queryCommand(input: {
    command_id: string;
    media_reservation_id: string;
    owner_epoch: string;
    command_hash: string;
  }): Promise<MediaTransportQuery> {
    if (this.#failNextQuery) {
      this.#failNextQuery = false;
      throw new Error('simulated query failure');
    }
    const recorded = this.#commands.get(commandKey(input));
    if (recorded && recorded.command_hash !== input.command_hash) {
      return {
        found: true,
        outcome: failedOutcome(input, 'command_payload_conflict')
      };
    }
    return recorded
      ? { found: true, outcome: structuredClone(recorded.outcome) }
      : { found: false };
  }

  async releaseSession(
    transportSessionId: string,
    reason: string
  ): Promise<void> {
    if (this.#failNextRelease) {
      this.#failNextRelease = false;
      throw new Error('simulated release failure');
    }
    const session = this.#sessionsByTransportId.get(transportSessionId);
    if (!session) return;
    session.forwarding = false;
    session.state = reason === 'lease_expired' ? 'expired' : 'closed';
    session.updated_at = this.#now().toISOString();
  }

  async scanOrphanCandidates(input: {
    after: string;
    limit: number;
  }): Promise<{
    items: MediaTransportOrphanCandidate[];
    next_cursor: string;
  }> {
    const limit = boundedScanLimit(input.limit);
    const sessions = [...this.#sessions.values()].filter(
      (session) => session.state === 'prepared' ||
        session.state === 'committed'
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
      const session = sessions[(previous + offset) % sessions.length];
      items.push(orphanCandidate(session));
    }
    return {
      items,
      next_cursor: items.at(-1)?.media_reservation_id ?? ''
    };
  }

  async querySession(input: {
    media_reservation_id: string;
    call_id: string;
  }) {
    const session = this.#sessions.get(input.media_reservation_id);
    if (!session || session.call_id !== input.call_id) {
      return undefined;
    }
    return {
      media_reservation_id: session.media_reservation_id,
      call_id: session.call_id,
      owner_epoch: session.owner_epoch,
      last_sequence: session.last_sequence,
      state: session.state,
      transport_session_id: session.transport_session_id,
      effective_sdp: session.effective_sdp,
      from_tag: session.from_tag,
      to_tag: session.to_tag,
      updated_at: session.updated_at
    };
  }

  forwardPackets(reservationId: string, packets: number): number {
    if (!Number.isInteger(packets) || packets < 0) {
      throw new Error('simulated packet count is invalid');
    }
    const session = this.#sessions.get(reservationId);
    if (!session?.forwarding) return 0;
    session.forwarded_packets += packets;
    return packets;
  }

  forwardedPackets(reservationId: string): number {
    return this.#sessions.get(reservationId)?.forwarded_packets ?? 0;
  }

  isForwarding(reservationId: string): boolean {
    return this.#sessions.get(reservationId)?.forwarding ?? false;
  }

  sideEffectCount(action?: string): number {
    if (action) return this.#sideEffects.get(action) ?? 0;
    return [...this.#sideEffects.values()].reduce((sum, count) => sum + count, 0);
  }

  sessionCount(): number {
    return this.#sessions.size;
  }

  commandCount(): number {
    return this.#commands.size;
  }

  #apply(
    command: MediaTransportCommand
  ): Exclude<MediaTransportOutcome, { state: 'unknown' }> {
    const current = this.#sessions.get(command.media_reservation_id);
    if (command.action === 'offer') {
      if (current) {
        const fenceError = applyFence(current, command);
        if (fenceError) return failedOutcome(command, fenceError);
        current.updated_at = this.#now().toISOString();
        return {
          state: 'succeeded',
          command_id: command.command_id,
          transport_session_id: current.transport_session_id,
          effective_sdp: current.effective_sdp,
          session_state: current.state,
          applied_at: current.updated_at
        };
      }
      if (this.#sessions.size >= this.#maxSessions) {
        return failedOutcome(command, 'transport_capacity_exhausted');
      }
      const offerSdp = String(command.payload.offer_sdp ?? '');
      const session: SimulatedSession = {
        media_reservation_id: command.media_reservation_id,
        call_id: command.call_id,
        tenant_id: command.tenant_id,
        leg_id: command.leg_id,
        cell_id: command.cell_id,
        owner_node_id: command.owner_node_id,
        expires_at: command.expires_at,
        transport_session_id: `transport-${this.#nextSession++}`,
        effective_sdp: offerSdp.includes('a=converact-media-node:')
          ? offerSdp
          : `${offerSdp}a=converact-media-node:simulator\r\n`,
        state: 'prepared',
        owner_epoch: command.owner_epoch,
        last_sequence: command.command_sequence,
        from_tag: textTag(command.payload.from_tag),
        to_tag: textTag(command.payload.to_tag),
        forwarding: false,
        forwarded_packets: 0,
        updated_at: this.#now().toISOString()
      };
      this.#sessions.set(command.media_reservation_id, session);
      this.#sessionsByTransportId.set(session.transport_session_id, session);
      this.#increment(command.action);
      return {
        state: 'succeeded',
        command_id: command.command_id,
        transport_session_id: session.transport_session_id,
        effective_sdp: session.effective_sdp,
        session_state: session.state,
        applied_at: session.updated_at
      };
    }

    if (!current ||
        (command.transport_session_id &&
          command.transport_session_id !== current.transport_session_id)) {
      return {
        state: 'failed',
        command_id: command.command_id,
        error_code: 'transport_session_not_found',
        retryable: false
      };
    }
    const fenceError = applyFence(current, command);
    if (fenceError) return failedOutcome(command, fenceError);

    if (command.action === 'answer' || command.action === 'start_forward') {
      current.state = 'committed';
      current.forwarding = true;
    } else if (command.action === 'delete') {
      current.state = 'closed';
      current.forwarding = false;
    } else if (command.action === 'stop_forward' ||
               command.action === 'block_media') {
      current.forwarding = false;
    } else if (command.action === 'unblock_media' &&
               current.state === 'committed') {
      current.forwarding = true;
    }
    current.from_tag = textTag(command.payload.from_tag) ?? current.from_tag;
    current.to_tag = textTag(command.payload.to_tag) ?? current.to_tag;
    current.expires_at = command.expires_at;
    current.owner_node_id = command.owner_node_id;
    current.updated_at = this.#now().toISOString();
    if (command.action !== 'query') this.#increment(command.action);
    return {
      state: 'succeeded',
      command_id: command.command_id,
      transport_session_id: current.transport_session_id,
      effective_sdp: current.effective_sdp,
      session_state: current.state,
      applied_at: current.updated_at
    };
  }

  #increment(action: string): void {
    this.#sideEffects.set(action, (this.#sideEffects.get(action) ?? 0) + 1);
  }
}

function orphanCandidate(
  session: SimulatedSession
): MediaTransportOrphanCandidate {
  return {
    tenant_id: session.tenant_id,
    call_id: session.call_id,
    leg_id: session.leg_id,
    cell_id: session.cell_id,
    owner_node_id: session.owner_node_id,
    owner_epoch: session.owner_epoch,
    media_reservation_id: session.media_reservation_id,
    transport_session_id: session.transport_session_id,
    expires_at: session.expires_at,
    state: session.state as 'prepared' | 'committed'
  };
}

function boundedScanLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error('orphan scan limit is invalid');
  }
  return value;
}

function textTag(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function commandKey(input: {
  command_id: string;
  media_reservation_id: string;
  owner_epoch: string;
}): string {
  return `${input.media_reservation_id}\0${input.owner_epoch}\0${input.command_id}`;
}

function applyFence(
  session: SimulatedSession,
  command: MediaTransportCommand
): string {
  const epoch = compareEpoch(command.owner_epoch, session.owner_epoch);
  if (epoch < 0) return 'stale_owner_epoch';
  if (epoch > 0) {
    if (command.command_sequence !== 1) return 'owner_takeover_sequence_invalid';
    session.owner_epoch = command.owner_epoch;
    session.last_sequence = 0;
  }
  if (command.command_sequence <= session.last_sequence) return 'stale_sequence';
  if (command.command_sequence !== session.last_sequence + 1) return 'sequence_gap';
  session.last_sequence = command.command_sequence;
  return '';
}

function compareEpoch(left: string, right: string): -1 | 0 | 1 {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function failedOutcome(
  command: { command_id: string },
  errorCode: string
): Exclude<MediaTransportOutcome, { state: 'unknown' }> {
  return {
    state: 'failed',
    command_id: command.command_id,
    error_code: errorCode,
    retryable: errorCode === 'transport_capacity_exhausted' ||
      errorCode === 'transport_command_capacity_exhausted'
  };
}

function boundedLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000_000) {
    throw new Error(`simulated ${name} is invalid`);
  }
  return value;
}
