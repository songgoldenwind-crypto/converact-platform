import type { BencodeDictionary, BencodeValue } from './bencode.js';
import {
  checkedProcessingTerminalEvent,
  type ProcessingTerminalEvent
} from './processing.js';
import type { MediaControlCommand } from './protocol.js';
import type { RtpengineNgDtmfEvent } from './rtpengine-ng.js';

export const MEDIA_CONTROL_EVENT_PROTOCOL_VERSION =
  'ivekit.media-event.v1' as const;

export interface MediaControlDtmfEvent {
  protocol_version: typeof MEDIA_CONTROL_EVENT_PROTOCOL_VERSION;
  event_sequence: number;
  event_type: 'dtmf';
  tenant_id: string;
  call_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  source_tag: string;
  digit: string;
  duration: number;
  volume: number;
  rtp_timestamp: number;
}

interface MediaControlTerminalEventBase {
  protocol_version: typeof MEDIA_CONTROL_EVENT_PROTOCOL_VERSION;
  event_sequence: number;
  event_id: string;
  source: 'processing';
  source_event_sequence: string;
  tenant_id: string;
  call_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  media_reservation_id: string;
  command_id: string;
  occurred_at_ms: number;
}

export type MediaControlTerminalEvent =
  | MediaControlTerminalEventBase & {
      event_type: 'playback_completed';
      prompt_id: string;
    }
  | MediaControlTerminalEventBase & {
      event_type: 'playback_stopped';
      prompt_id: string;
      reason: 'explicit' | 'barge_in' | 'session_removed';
    }
  | MediaControlTerminalEventBase & {
      event_type: 'gather_completed';
      digits: string;
      reason:
        | 'maximum_digits'
        | 'terminator'
        | 'timeout'
        | 'explicit_stop'
        | 'session_removed';
      minimum_satisfied: boolean;
    };

export function checkedMediaControlTerminalEvent(
  value: unknown
): MediaControlTerminalEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('media_control_terminal_event_invalid');
  }
  const input = value as Record<string, unknown>;
  const commonFields = [
    'protocol_version',
    'event_sequence',
    'event_type',
    'event_id',
    'source',
    'source_event_sequence',
    'tenant_id',
    'call_id',
    'cell_id',
    'owner_node_id',
    'owner_epoch',
    'media_reservation_id',
    'command_id',
    'occurred_at_ms'
  ];
  const variantFields = input.event_type === 'playback_completed'
    ? ['prompt_id']
    : input.event_type === 'playback_stopped'
      ? ['prompt_id', 'reason']
      : input.event_type === 'gather_completed'
        ? ['digits', 'reason', 'minimum_satisfied']
        : [];
  const expected = new Set([...commonFields, ...variantFields]);
  if (variantFields.length === 0 ||
      Object.keys(input).length !== expected.size ||
      Object.keys(input).some((field) => !expected.has(field)) ||
      input.protocol_version !== MEDIA_CONTROL_EVENT_PROTOCOL_VERSION ||
      input.source !== 'processing' ||
      !Number.isSafeInteger(input.event_sequence) ||
      Number(input.event_sequence) < 1 ||
      Number(input.event_sequence) >= Number.MAX_SAFE_INTEGER ||
      !Number.isSafeInteger(input.occurred_at_ms) ||
      Number(input.occurred_at_ms) < 1) {
    throw new Error('media_control_terminal_event_invalid');
  }
  const sourceEventSequence = canonicalUint64(
    input.source_event_sequence,
    false
  );
  const ownerEpoch = canonicalUint64(input.owner_epoch, false);
  const base = {
    protocol_version: MEDIA_CONTROL_EVENT_PROTOCOL_VERSION,
    event_sequence: Number(input.event_sequence),
    event_id: terminalIdentifier(input.event_id),
    source: 'processing' as const,
    source_event_sequence: sourceEventSequence,
    tenant_id: terminalIdentifier(input.tenant_id),
    call_id: terminalIdentifier(input.call_id),
    cell_id: terminalIdentifier(input.cell_id),
    owner_node_id: terminalIdentifier(input.owner_node_id),
    owner_epoch: ownerEpoch,
    media_reservation_id: terminalIdentifier(input.media_reservation_id),
    command_id: terminalIdentifier(input.command_id),
    occurred_at_ms: Number(input.occurred_at_ms)
  };
  if (input.event_type === 'playback_completed') {
    return {
      ...base,
      event_type: 'playback_completed',
      prompt_id: terminalIdentifier(input.prompt_id)
    };
  }
  if (input.event_type === 'playback_stopped' &&
      ['explicit', 'barge_in', 'session_removed'].includes(
        String(input.reason)
      )) {
    return {
      ...base,
      event_type: 'playback_stopped',
      prompt_id: terminalIdentifier(input.prompt_id),
      reason: input.reason as
        | 'explicit'
        | 'barge_in'
        | 'session_removed'
    };
  }
  if (input.event_type === 'gather_completed' &&
      typeof input.digits === 'string' &&
      /^[0-9*#A-D]{0,1024}$/.test(input.digits) &&
      [
        'maximum_digits',
        'terminator',
        'timeout',
        'explicit_stop',
        'session_removed'
      ].includes(String(input.reason)) &&
      typeof input.minimum_satisfied === 'boolean') {
    return {
      ...base,
      event_type: 'gather_completed',
      digits: input.digits,
      reason: input.reason as
        | 'maximum_digits'
        | 'terminator'
        | 'timeout'
        | 'explicit_stop'
        | 'session_removed',
      minimum_satisfied: input.minimum_satisfied
    };
  }
  throw new Error('media_control_terminal_event_invalid');
}

export interface MediaControlEventSubscription<
  Event = MediaControlDtmfEvent
> extends AsyncIterator<Event> {
  close(): void;
}

interface OwnerBinding {
  tenant_id: string;
  call_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  media_reservation_id: string;
}

interface OwnerChannel<Event extends { event_sequence: number }> {
  next_sequence: number;
  retained: Event[];
  subscriptions: Set<BrokerSubscription<Event>>;
}

export interface MediaTerminalEventJournalPort {
  append(
    event: MediaControlTerminalEvent
  ): Promise<{ replayed: boolean }>;
}

export class MediaControlEventGapError extends Error {
  constructor() {
    super('media_control_event_gap');
    this.name = 'MediaControlEventGapError';
  }
}

export class MediaControlEventBroker {
  readonly #maxBindings: number;
  readonly #maxRetainedEventsPerOwner: number;
  readonly #maxSubscriptionsPerOwner: number;
  readonly #bindings = new Map<string, OwnerBinding>();
  readonly #channels =
    new Map<string, OwnerChannel<MediaControlDtmfEvent>>();
  readonly #terminalChannels =
    new Map<string, OwnerChannel<MediaControlTerminalEvent>>();
  readonly #terminalByEventId =
    new Map<string, MediaControlTerminalEvent>();
  readonly #terminalJournal: MediaTerminalEventJournalPort | undefined;
  #terminalTail: Promise<void> = Promise.resolve();

  constructor(options: {
    maxBindings: number;
    maxRetainedEventsPerOwner: number;
    maxSubscriptionsPerOwner?: number;
    terminalEvents?: readonly MediaControlTerminalEvent[];
    terminalJournal?: MediaTerminalEventJournalPort;
  }) {
    this.#maxBindings = integer(
      options.maxBindings,
      1,
      10_000_000,
      'max bindings'
    );
    this.#maxRetainedEventsPerOwner = integer(
      options.maxRetainedEventsPerOwner,
      1,
      1_000_000,
      'max retained events'
    );
    this.#maxSubscriptionsPerOwner = integer(
      options.maxSubscriptionsPerOwner ?? 2,
      1,
      16,
      'max subscriptions'
    );
    this.#terminalJournal = options.terminalJournal;
    for (const event of options.terminalEvents ?? []) {
      this.#restoreTerminal(event);
    }
  }

  bind(command: MediaControlCommand): void {
    const binding = bindingFrom(command);
    if (!this.#bindings.has(binding.call_id) &&
        this.#bindings.size >= this.#maxBindings) {
      throw new Error('media_control_event_binding_capacity');
    }
    this.#bindings.set(binding.call_id, binding);
    this.#channel(binding.owner_node_id);
  }

  release(callId: string, ownerEpoch?: string): boolean {
    const id = identifier(callId, 'call_id');
    const current = this.#bindings.get(id);
    if (!current || (ownerEpoch && current.owner_epoch !== ownerEpoch)) {
      return false;
    }
    return this.#bindings.delete(id);
  }

  publishRtpengineDtmf(input: RtpengineNgDtmfEvent): boolean {
    const decoded = decodeDtmf(input.payload);
    if (!decoded) return false;
    const binding = this.#bindings.get(decoded.call_id);
    if (!binding) return false;
    const channel = this.#channel(binding.owner_node_id);
    const event: MediaControlDtmfEvent = {
      protocol_version: MEDIA_CONTROL_EVENT_PROTOCOL_VERSION,
      event_sequence: channel.next_sequence,
      event_type: 'dtmf',
      tenant_id: binding.tenant_id,
      call_id: binding.call_id,
      cell_id: binding.cell_id,
      owner_node_id: binding.owner_node_id,
      owner_epoch: binding.owner_epoch,
      source_tag: decoded.source_tag,
      digit: decoded.digit,
      duration: decoded.duration,
      volume: decoded.volume,
      rtp_timestamp: decoded.rtp_timestamp
    };
    channel.next_sequence += 1;
    channel.retained.push(event);
    if (channel.retained.length > this.#maxRetainedEventsPerOwner) {
      channel.retained.shift();
    }
    for (const subscription of channel.subscriptions) {
      subscription.enqueue(event);
    }
    return true;
  }

  publishProcessingTerminal(
    input: ProcessingTerminalEvent
  ): Promise<{
    event: MediaControlTerminalEvent;
    replayed: boolean;
  }> {
    const operation = this.#terminalTail.then(
      () => this.#publishProcessingTerminal(input)
    );
    this.#terminalTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  subscribe(input: {
    owner_node_id: string;
    after_sequence: number;
  }): MediaControlEventSubscription {
    const ownerNodeId = identifier(input.owner_node_id, 'owner_node_id');
    const afterSequence = integer(
      input.after_sequence,
      0,
      Number.MAX_SAFE_INTEGER,
      'after sequence'
    );
    const channel = this.#channel(ownerNodeId);
    if (channel.subscriptions.size >= this.#maxSubscriptionsPerOwner) {
      throw new Error('media_control_event_subscription_capacity');
    }
    const oldest = channel.retained[0]?.event_sequence;
    if (oldest !== undefined && afterSequence < oldest - 1) {
      throw new MediaControlEventGapError();
    }
    const subscription = new BrokerSubscription(
      channel,
      afterSequence,
      this.#maxRetainedEventsPerOwner
    );
    channel.subscriptions.add(subscription);
    return subscription;
  }

  subscribeTerminal(input: {
    owner_node_id: string;
    after_sequence: number;
  }): MediaControlEventSubscription<MediaControlTerminalEvent> {
    const ownerNodeId = identifier(input.owner_node_id, 'owner_node_id');
    const afterSequence = integer(
      input.after_sequence,
      0,
      Number.MAX_SAFE_INTEGER,
      'after sequence'
    );
    const channel = this.#terminalChannel(ownerNodeId);
    if (channel.subscriptions.size >= this.#maxSubscriptionsPerOwner) {
      throw new Error('media_control_event_subscription_capacity');
    }
    const oldest = channel.retained[0]?.event_sequence;
    if (oldest !== undefined && afterSequence < oldest - 1) {
      throw new MediaControlEventGapError();
    }
    const subscription = new BrokerSubscription(
      channel,
      afterSequence,
      this.#maxRetainedEventsPerOwner
    );
    channel.subscriptions.add(subscription);
    return subscription;
  }

  #channel(ownerNodeId: string): OwnerChannel<MediaControlDtmfEvent> {
    let channel = this.#channels.get(ownerNodeId);
    if (!channel) {
      channel = {
        next_sequence: 1,
        retained: [],
        subscriptions: new Set()
      };
      this.#channels.set(ownerNodeId, channel);
    }
    return channel;
  }

  #terminalChannel(
    ownerNodeId: string
  ): OwnerChannel<MediaControlTerminalEvent> {
    let channel = this.#terminalChannels.get(ownerNodeId);
    if (!channel) {
      channel = {
        next_sequence: 1,
        retained: [],
        subscriptions: new Set()
      };
      this.#terminalChannels.set(ownerNodeId, channel);
    }
    return channel;
  }

  async #publishProcessingTerminal(
    input: ProcessingTerminalEvent
  ): Promise<{
    event: MediaControlTerminalEvent;
    replayed: boolean;
  }> {
    const source = checkedProcessingTerminalEvent(input);
    const existing = this.#terminalByEventId.get(source.event_id);
    if (existing) {
      const replay = terminalEventFrom(source, existing.event_sequence);
      if (JSON.stringify(replay) !== JSON.stringify(existing)) {
        throw new Error('media_control_terminal_event_identity_conflict');
      }
      return { event: structuredClone(existing), replayed: true };
    }
    const binding = bindingFromProcessingEvent(source);
    this.#bindOrAssert(binding);
    const journal = this.#terminalJournal;
    if (!journal) {
      throw new Error('media_control_terminal_event_journal_required');
    }
    const channel = this.#terminalChannel(binding.owner_node_id);
    if (channel.next_sequence >= Number.MAX_SAFE_INTEGER) {
      throw new Error('media_control_terminal_event_sequence_exhausted');
    }
    const event = terminalEventFrom(source, channel.next_sequence);
    const appended = await journal.append(event);
    this.#rememberTerminal(event, true);
    return {
      event: structuredClone(event),
      replayed: appended.replayed
    };
  }

  #bindOrAssert(binding: OwnerBinding): void {
    const existing = this.#bindings.get(binding.call_id);
    if (existing) {
      if (!sameBinding(existing, binding)) {
        throw new Error('media_control_terminal_event_owner_mismatch');
      }
      return;
    }
    if (this.#bindings.size >= this.#maxBindings) {
      throw new Error('media_control_event_binding_capacity');
    }
    this.#bindings.set(binding.call_id, binding);
  }

  #restoreTerminal(input: MediaControlTerminalEvent): void {
    const event = checkedMediaControlTerminalEvent(input);
    const existing = this.#terminalByEventId.get(event.event_id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) {
        throw new Error('media_control_terminal_event_identity_conflict');
      }
      return;
    }
    const channel = this.#terminalChannel(event.owner_node_id);
    if (channel.retained.length === 0 && channel.next_sequence === 1) {
      channel.next_sequence = event.event_sequence;
    }
    this.#rememberTerminal(event, false);
  }

  #rememberTerminal(
    event: MediaControlTerminalEvent,
    notify: boolean
  ): void {
    const channel = this.#terminalChannel(event.owner_node_id);
    if (event.event_sequence !== channel.next_sequence) {
      throw new Error('media_control_terminal_event_sequence_gap');
    }
    channel.next_sequence += 1;
    channel.retained.push(structuredClone(event));
    if (channel.retained.length > this.#maxRetainedEventsPerOwner) {
      channel.retained.shift();
    }
    this.#terminalByEventId.set(event.event_id, structuredClone(event));
    if (!notify) return;
    for (const subscription of channel.subscriptions) {
      subscription.enqueue(event);
    }
  }
}

class BrokerSubscription<Event extends { event_sequence: number }>
implements MediaControlEventSubscription<Event> {
  readonly #channel: OwnerChannel<Event>;
  readonly #maximumQueued: number;
  readonly #queued: Event[];
  #waiting: {
    resolve: (value: IteratorResult<Event>) => void;
    reject: (error: Error) => void;
  } | null = null;
  #closed = false;

  constructor(
    channel: OwnerChannel<Event>,
    afterSequence: number,
    maximumQueued: number
  ) {
    this.#channel = channel;
    this.#maximumQueued = maximumQueued;
    this.#queued = channel.retained.filter(
      (event) => event.event_sequence > afterSequence
    );
  }

  next(): Promise<IteratorResult<Event>> {
    if (this.#queued.length > 0) {
      return Promise.resolve({
        done: false,
        value: this.#queued.shift()!
      });
    }
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    if (this.#waiting) {
      return Promise.reject(new Error('media_control_event_concurrent_next'));
    }
    return new Promise((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#channel.subscriptions.delete(this);
    this.#queued.length = 0;
    this.#waiting?.resolve({ done: true, value: undefined });
    this.#waiting = null;
  }

  enqueue(event: Event): void {
    if (this.#closed) return;
    if (this.#waiting) {
      const waiting = this.#waiting;
      this.#waiting = null;
      waiting.resolve({ done: false, value: event });
      return;
    }
    if (this.#queued.length >= this.#maximumQueued) {
      const waiting = this.#waiting;
      this.#waiting = null;
      this.#closed = true;
      this.#channel.subscriptions.delete(this);
      waiting?.reject(new MediaControlEventGapError());
      return;
    }
    this.#queued.push(event);
  }
}

function bindingFrom(command: MediaControlCommand): OwnerBinding {
  return {
    tenant_id: identifier(command.tenant_id, 'tenant_id'),
    call_id: identifier(command.call_id, 'call_id'),
    cell_id: identifier(command.cell_id, 'cell_id'),
    owner_node_id: identifier(command.owner_node_id, 'owner_node_id'),
    owner_epoch: ownerEpoch(command.owner_epoch),
    media_reservation_id: identifier(
      command.media_reservation_id,
      'media_reservation_id'
    )
  };
}

function bindingFromProcessingEvent(
  event: ProcessingTerminalEvent
): OwnerBinding {
  return {
    tenant_id: identifier(event.tenant_id, 'tenant_id'),
    call_id: identifier(event.call_id, 'call_id'),
    cell_id: identifier(event.cell_id, 'cell_id'),
    owner_node_id: identifier(event.owner_node_id, 'owner_node_id'),
    owner_epoch: ownerEpoch(event.owner_epoch),
    media_reservation_id: identifier(
      event.media_reservation_id,
      'media_reservation_id'
    )
  };
}

function sameBinding(left: OwnerBinding, right: OwnerBinding): boolean {
  return left.tenant_id === right.tenant_id &&
    left.call_id === right.call_id &&
    left.cell_id === right.cell_id &&
    left.owner_node_id === right.owner_node_id &&
    left.owner_epoch === right.owner_epoch &&
    left.media_reservation_id === right.media_reservation_id;
}

function terminalEventFrom(
  source: ProcessingTerminalEvent,
  sequence: number
): MediaControlTerminalEvent {
  const base = {
    protocol_version: MEDIA_CONTROL_EVENT_PROTOCOL_VERSION,
    event_sequence: sequence,
    event_id: source.event_id,
    source: 'processing' as const,
    source_event_sequence: source.event_sequence,
    tenant_id: source.tenant_id,
    call_id: source.call_id,
    cell_id: source.cell_id,
    owner_node_id: source.owner_node_id,
    owner_epoch: source.owner_epoch,
    media_reservation_id: source.media_reservation_id,
    command_id: source.command_id,
    occurred_at_ms: source.occurred_at_ms
  };
  if (source.event_type === 'playback_completed') {
    return checkedMediaControlTerminalEvent({
      ...base,
      event_type: source.event_type,
      prompt_id: source.prompt_id
    });
  }
  if (source.event_type === 'playback_stopped') {
    return checkedMediaControlTerminalEvent({
      ...base,
      event_type: source.event_type,
      prompt_id: source.prompt_id,
      reason: source.reason
    });
  }
  return checkedMediaControlTerminalEvent({
    ...base,
    event_type: source.event_type,
    digits: source.digits,
    reason: source.reason,
    minimum_satisfied: source.minimum_satisfied
  });
}

function decodeDtmf(payload: BencodeDictionary): {
  call_id: string;
  source_tag: string;
  digit: string;
  duration: number;
  volume: number;
  rtp_timestamp: number;
} | undefined {
  if (text(payload.notify)?.toLowerCase() !== 'ondtmf' ||
      !dictionary(payload.data) ||
      text(payload.data.type)?.toLowerCase() !== 'dtmf') {
    return undefined;
  }
  const callId = text(payload.data.callid);
  const sourceTag = text(payload.data.source_tag);
  const event = exactInteger(payload.data.event, 0, 15);
  if (!callId || !sourceTag || event === undefined) return undefined;
  try {
    return {
      call_id: identifier(callId, 'call_id'),
      source_tag: sipTag(sourceTag),
      digit: DTMF_DIGITS[event],
      duration: exactInteger(payload.data.duration, 0, 65_535) ?? 0,
      volume: exactInteger(payload.data.volume, 0, 63) ?? 0,
      rtp_timestamp:
        exactInteger(payload.data.timestamp, 0, Number.MAX_SAFE_INTEGER) ?? 0
    };
  } catch {
    return undefined;
  }
}

const DTMF_DIGITS = [
  '0', '1', '2', '3', '4', '5', '6', '7',
  '8', '9', '*', '#', 'A', 'B', 'C', 'D'
] as const;

function text(value: BencodeValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8');
  }
  return undefined;
}

function dictionary(
  value: BencodeValue | undefined
): value is BencodeDictionary {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Buffer.isBuffer(value) &&
    !(value instanceof Uint8Array) &&
    !Array.isArray(value)
  );
}

function exactInteger(
  value: BencodeValue | undefined,
  minimum: number,
  maximum: number
): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function terminalIdentifier(value: unknown): string {
  if (typeof value !== 'string' ||
      !/^[A-Za-z0-9._:@/-]{1,256}$/.test(value)) {
    throw new Error('media_control_terminal_event_invalid');
  }
  return value;
}

function canonicalUint64(value: unknown, allowZero: boolean): string {
  if (typeof value !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new Error('media_control_terminal_event_invalid');
  }
  const parsed = BigInt(value);
  if (parsed > (1n << 64n) - 1n || (!allowZero && parsed === 0n)) {
    throw new Error('media_control_terminal_event_invalid');
  }
  return value;
}

function identifier(value: unknown, name: string): string {
  const output = String(value ?? '');
  if (!/^[A-Za-z0-9._:@/-]{1,256}$/.test(output)) {
    throw new Error(`media_control_event_${name}_invalid`);
  }
  return output;
}

function sipTag(value: string): string {
  if (!/^[A-Za-z0-9.!%*_+`'~-]{1,256}$/.test(value)) {
    throw new Error('media_control_event_source_tag_invalid');
  }
  return value;
}

function ownerEpoch(value: unknown): string {
  const output = String(value ?? '');
  if (!/^(?:0|[1-9][0-9]{0,19})$/.test(output) || BigInt(output) === 0n) {
    throw new Error('media_control_event_owner_epoch_invalid');
  }
  return output;
}

function integer(
  value: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`media control event ${name} is invalid`);
  }
  return value;
}
