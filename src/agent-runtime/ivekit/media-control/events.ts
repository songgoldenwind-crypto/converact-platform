import type { BencodeDictionary, BencodeValue } from './bencode.js';
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

export interface MediaControlEventSubscription
  extends AsyncIterator<MediaControlDtmfEvent> {
  close(): void;
}

interface OwnerBinding {
  tenant_id: string;
  call_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
}

interface OwnerChannel {
  next_sequence: number;
  retained: MediaControlDtmfEvent[];
  subscriptions: Set<BrokerSubscription>;
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
  readonly #channels = new Map<string, OwnerChannel>();

  constructor(options: {
    maxBindings: number;
    maxRetainedEventsPerOwner: number;
    maxSubscriptionsPerOwner?: number;
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
      ...binding,
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

  #channel(ownerNodeId: string): OwnerChannel {
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
}

class BrokerSubscription implements MediaControlEventSubscription {
  readonly #channel: OwnerChannel;
  readonly #maximumQueued: number;
  readonly #queued: MediaControlDtmfEvent[];
  #waiting: {
    resolve: (value: IteratorResult<MediaControlDtmfEvent>) => void;
    reject: (error: Error) => void;
  } | null = null;
  #closed = false;

  constructor(
    channel: OwnerChannel,
    afterSequence: number,
    maximumQueued: number
  ) {
    this.#channel = channel;
    this.#maximumQueued = maximumQueued;
    this.#queued = channel.retained.filter(
      (event) => event.event_sequence > afterSequence
    );
  }

  next(): Promise<IteratorResult<MediaControlDtmfEvent>> {
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

  enqueue(event: MediaControlDtmfEvent): void {
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
    owner_epoch: ownerEpoch(command.owner_epoch)
  };
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
