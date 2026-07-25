import type {
  MediaTransportCommand,
  MediaTransportOutcome,
  MediaTransportPort,
  MediaTransportQuery
} from './transport.js';

export type SimulatedFailure =
  | 'before_apply_timeout'
  | 'after_apply_timeout';

interface SimulatedSession {
  reservation_id: string;
  interaction_id: string;
  transport_session_id: string;
  effective_sdp: string;
  state: 'prepared' | 'committed' | 'cancelled' | 'closed' | 'expired';
  owner_epoch: string;
  last_sequence: number;
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

  constructor(input: { now?: () => Date } = {}) {
    this.#now = input.now ?? (() => new Date());
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
    const current = this.#sessions.get(command.reservation_id);
    if (current && compareEpoch(command.owner_epoch, current.owner_epoch) < 0) {
      return failedOutcome(command, 'stale_owner_epoch');
    }
    if (recorded) {
      return recorded.command_hash === command.command_hash
        ? structuredClone(recorded.outcome)
        : failedOutcome(command, 'command_payload_conflict');
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
    reservation_id: string;
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
    if (reason === 'lease_expired') session.state = 'expired';
    session.updated_at = this.#now().toISOString();
  }

  async querySession(input: {
    reservation_id: string;
    interaction_id: string;
  }) {
    const session = this.#sessions.get(input.reservation_id);
    if (!session || session.interaction_id !== input.interaction_id) {
      return undefined;
    }
    return {
      reservation_id: session.reservation_id,
      interaction_id: session.interaction_id,
      owner_epoch: session.owner_epoch,
      last_sequence: session.last_sequence,
      state: session.state,
      transport_session_id: session.transport_session_id,
      effective_sdp: session.effective_sdp,
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

  #apply(
    command: MediaTransportCommand
  ): Exclude<MediaTransportOutcome, { state: 'unknown' }> {
    const current = this.#sessions.get(command.reservation_id);
    if (command.action === 'prepare') {
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
      const offerSdp = String(command.payload.offer_sdp ?? '');
      const session: SimulatedSession = {
        reservation_id: command.reservation_id,
        interaction_id: command.interaction_id,
        transport_session_id: `transport-${this.#nextSession++}`,
        effective_sdp: offerSdp.includes('a=ivekit-media-node:')
          ? offerSdp
          : `${offerSdp}a=ivekit-media-node:simulator\r\n`,
        state: 'prepared',
        owner_epoch: command.owner_epoch,
        last_sequence: command.sequence,
        forwarding: false,
        forwarded_packets: 0,
        updated_at: this.#now().toISOString()
      };
      this.#sessions.set(command.reservation_id, session);
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

    if (command.action === 'commit') {
      current.state = 'committed';
      current.forwarding = true;
    } else if (command.action === 'cancel') {
      current.state = 'cancelled';
      current.forwarding = false;
    } else {
      current.state = 'closed';
      current.forwarding = false;
    }
    current.updated_at = this.#now().toISOString();
    this.#increment(command.action);
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

function commandKey(input: {
  command_id: string;
  reservation_id: string;
  owner_epoch: string;
}): string {
  return `${input.reservation_id}\0${input.owner_epoch}\0${input.command_id}`;
}

function applyFence(
  session: SimulatedSession,
  command: MediaTransportCommand
): string {
  const epoch = compareEpoch(command.owner_epoch, session.owner_epoch);
  if (epoch < 0) return 'stale_owner_epoch';
  if (epoch > 0) {
    if (command.sequence !== 1) return 'owner_takeover_sequence_invalid';
    session.owner_epoch = command.owner_epoch;
    session.last_sequence = 0;
  }
  if (command.sequence <= session.last_sequence) return 'stale_sequence';
  if (command.sequence !== session.last_sequence + 1) return 'sequence_gap';
  session.last_sequence = command.sequence;
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
    retryable: false
  };
}
