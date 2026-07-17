import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';

import { canonicalSha256 } from '../canonical-json.js';

export interface TinodeShardInput {
  endpoint: string;
  api_key: string;
  run_id: string;
  shard_id: string;
  ordinal_start: number;
  ordinal_end_exclusive: number;
  worker_id: string;
  lease_epoch: string;
  auth_for_ordinal(ordinal: number): {
    scheme: 'token' | 'basic';
    secret: string;
  } | Promise<{ scheme: 'token' | 'basic'; secret: string }>;
  topic_for_ordinal(ordinal: number): string | Promise<string>;
  messages_per_interaction: number;
  body_for_message(ordinal: number, messageIndex: number): string;
  presence_enabled: boolean;
  typing_enabled: boolean;
  receipts_enabled: boolean;
  maximum_reconnects: number;
  reconnect_delay_ms: number;
  request_timeout_ms: number;
  concurrency: number;
}

export interface TinodeShardResult {
  protocol: 'tinode_websocket';
  evidence_level: 'controlled';
  status: 'controlled_pass' | 'controlled_failed';
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
  attempted_count: number;
  accepted_count: number;
  active_peak_count: number;
  closed_count: number;
  socket_attempt_count: number;
  reconnect_count: number;
  published_message_count: number;
  presence_query_count: number;
  typing_note_count: number;
  receipt_note_count: number;
  error_count: number;
  errors: string[];
  elapsed_ms: number;
  journal_sha256: string;
}

interface TinodeClientResult {
  accepted: boolean;
  socketAttempts: number;
  reconnects: number;
  published: number;
  presenceQueries: number;
  typingNotes: number;
  receiptNotes: number;
  errors: string[];
  journal: Array<{
    ordinal: number;
    message_index: number;
    message_id: string;
    topic: string;
    provider_sequence: string;
  }>;
}

export async function runTinodeInteractionShard(input: TinodeShardInput): Promise<TinodeShardResult> {
  validateInput(input);
  const startedAt = performance.now();
  let active = 0;
  let activePeak = 0;
  const ordinals = Array.from(
    { length: input.ordinal_end_exclusive - input.ordinal_start },
    (_, index) => input.ordinal_start + index
  );
  const results = await mapConcurrent(ordinals, input.concurrency, (ordinal) => runInteraction(
    input,
    ordinal,
    () => {
      active += 1;
      activePeak = Math.max(activePeak, active);
    },
    () => { active = Math.max(0, active - 1); }
  ));
  const allErrors = results.flatMap((result) => result.errors);
  const errors = allErrors.slice(0, 1_000);
  const journal = results.flatMap((result) => result.journal)
    .sort((left, right) => left.ordinal - right.ordinal || left.message_index - right.message_index);
  const accepted = results.filter((result) => result.accepted).length;
  const published = sum(results, (result) => result.published);
  const expectedMessages = ordinals.length * input.messages_per_interaction;
  const expectedPresenceQueries = input.presence_enabled ? ordinals.length : 0;
  const expectedTypingNotes = input.typing_enabled ? ordinals.length : 0;
  const expectedReceiptNotes = input.receipts_enabled ? expectedMessages * 2 : 0;
  const presenceQueries = sum(results, (result) => result.presenceQueries);
  const typingNotes = sum(results, (result) => result.typingNotes);
  const receiptNotes = sum(results, (result) => result.receiptNotes);
  return {
    protocol: 'tinode_websocket',
    evidence_level: 'controlled',
    status: accepted === ordinals.length && published === expectedMessages &&
      presenceQueries === expectedPresenceQueries && typingNotes === expectedTypingNotes &&
      receiptNotes === expectedReceiptNotes && allErrors.length === 0
      ? 'controlled_pass'
      : 'controlled_failed',
    run_id: input.run_id,
    shard_id: input.shard_id,
    worker_id: input.worker_id,
    lease_epoch: input.lease_epoch,
    attempted_count: ordinals.length,
    accepted_count: accepted,
    active_peak_count: activePeak,
    closed_count: results.length,
    socket_attempt_count: sum(results, (result) => result.socketAttempts),
    reconnect_count: sum(results, (result) => result.reconnects),
    published_message_count: published,
    presence_query_count: presenceQueries,
    typing_note_count: typingNotes,
    receipt_note_count: receiptNotes,
    error_count: allErrors.length,
    errors,
    elapsed_ms: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
    journal_sha256: canonicalSha256(journal)
  };
}

async function runInteraction(
  input: TinodeShardInput,
  ordinal: number,
  becameActive: () => void,
  becameInactive: () => void
): Promise<TinodeClientResult> {
  const auth = await input.auth_for_ordinal(ordinal);
  const topic = await input.topic_for_ordinal(ordinal);
  if (!auth.secret) throw new Error(`Tinode auth secret is missing for ordinal ${ordinal}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(topic)) {
    throw new Error(`Tinode topic is invalid for ordinal ${ordinal}`);
  }
  const result: TinodeClientResult = {
    accepted: false,
    socketAttempts: 0,
    reconnects: 0,
    published: 0,
    presenceQueries: 0,
    typingNotes: 0,
    receiptNotes: 0,
    errors: [],
    journal: []
  };
  let nextMessage = 0;
  let attempts = 0;
  while (true) {
    attempts += 1;
    result.socketAttempts += 1;
    const session = new TinodeWireSession(endpointWithApiKey(input.endpoint, input.api_key), input.request_timeout_ms);
    let active = false;
    try {
      await session.open();
      active = true;
      becameActive();
      await session.request('hi', { ver: '0.22', ua: 'iveKit capacity generator' });
      await session.request('login', auth);
      await session.request('sub', { topic });
      result.accepted = true;
      if (input.presence_enabled) {
        await session.request('get', { topic, what: 'sub desc' });
        result.presenceQueries += 1;
      }
      if (input.typing_enabled) {
        session.note({ topic, what: 'kp' });
        result.typingNotes += 1;
      }
      while (nextMessage < input.messages_per_interaction) {
        const messageId = `${input.run_id}/tinode_im/${ordinal}/message/${nextMessage}`;
        const body = input.body_for_message(ordinal, nextMessage);
        if (typeof body !== 'string' || body.length === 0 || body.length > 65_536) {
          throw new Error(`Tinode message body is invalid for ordinal ${ordinal}`);
        }
        const ctrl = await session.request('pub', {
          topic,
          noecho: false,
          head: {
            'x-opc-message-id': messageId.slice(0, 128),
            'x-opc-idempotency-key': messageId.slice(0, 128)
          },
          content: body
        });
        const sequence = String(ctrl.params?.seq || ctrl.params?.seq_id || '');
        if (!/^\d+$/.test(sequence)) throw new Error('Tinode publish acknowledgement has no sequence');
        result.journal.push({
          ordinal,
          message_index: nextMessage,
          message_id: messageId,
          topic,
          provider_sequence: sequence
        });
        result.published += 1;
        nextMessage += 1;
        if (input.receipts_enabled) {
          session.note({ topic, what: 'recv', seq: Number(sequence) });
          session.note({ topic, what: 'read', seq: Number(sequence) });
          result.receiptNotes += 2;
        }
      }
      await session.closeGracefully();
      if (active) becameInactive();
      return result;
    } catch (error) {
      session.close();
      if (active) becameInactive();
      if (attempts <= input.maximum_reconnects) {
        result.reconnects += 1;
        await delay(input.reconnect_delay_ms);
        continue;
      }
      result.errors.push(`ordinal ${ordinal}: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  }
}

class TinodeWireSession {
  #socket: WebSocket | null = null;
  #nextId = 1;
  #pending = new Map<string, {
    resolve: (value: Record<string, any>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();

  constructor(private readonly endpoint: string, private readonly timeoutMs: number) {}

  async open(): Promise<void> {
    const socket = new WebSocket(this.endpoint);
    this.#socket = socket;
    socket.on('message', (raw) => this.#handleMessage(raw));
    socket.on('close', () => this.#rejectAll(new Error('Tinode WebSocket closed')));
    socket.on('error', (error) => this.#rejectAll(error));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('Tinode WebSocket open timeout'));
      }, this.timeoutMs);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  request(kind: 'hi' | 'login' | 'sub' | 'get' | 'pub', payload: Record<string, unknown>): Promise<Record<string, any>> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Tinode WebSocket is not open'));
    }
    const id = `load-${this.#nextId++}`;
    const promise = new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Tinode ${kind} acknowledgement timed out`));
      }, this.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    try {
      socket.send(JSON.stringify({ [kind]: { id, ...payload } }));
    } catch (error) {
      const pending = this.#pending.get(id);
      if (pending) clearTimeout(pending.timer);
      this.#pending.delete(id);
      return Promise.reject(error);
    }
    return promise;
  }

  note(payload: Record<string, unknown>): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Tinode WebSocket is not open');
    socket.send(JSON.stringify({ note: payload }));
  }

  async flush(): Promise<void> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Tinode WebSocket is not open');
    const deadline = Date.now() + this.timeoutMs;
    while (socket.bufferedAmount > 0) {
      if (Date.now() >= deadline) throw new Error('Tinode WebSocket send queue did not drain');
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  async closeGracefully(): Promise<void> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Tinode WebSocket is not open');
    await this.flush();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error('Tinode WebSocket close handshake timed out'));
      }, this.timeoutMs);
      socket.once('close', () => {
        clearTimeout(timer);
        this.#socket = null;
        resolve();
      });
      socket.close(1000, 'complete');
    });
  }

  close(): void {
    this.#rejectAll(new Error('Tinode session closed'));
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.close(1000, 'complete');
    else if (this.#socket?.readyState === WebSocket.CONNECTING) this.#socket.terminate();
    this.#socket = null;
  }

  #handleMessage(raw: WebSocket.RawData): void {
    let packet: Record<string, any>;
    try {
      packet = JSON.parse(String(raw));
    } catch {
      return;
    }
    const ctrl = packet.ctrl;
    if (!ctrl?.id) return;
    const pending = this.#pending.get(String(ctrl.id));
    if (!pending) return;
    this.#pending.delete(String(ctrl.id));
    clearTimeout(pending.timer);
    if (Number(ctrl.code || 0) >= 300) {
      pending.reject(new Error(`Tinode request rejected with ${ctrl.code}: ${ctrl.text || 'error'}`));
      return;
    }
    pending.resolve(ctrl);
  }

  #rejectAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }
}

function validateInput(input: TinodeShardInput): void {
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') throw new Error('Tinode endpoint must use ws or wss');
  if (!input.api_key || !input.run_id || !input.worker_id) throw new Error('Tinode API key, run ID and worker ID are required');
  if (!Number.isInteger(input.ordinal_start) || !Number.isInteger(input.ordinal_end_exclusive) ||
      input.ordinal_start < 0 || input.ordinal_end_exclusive <= input.ordinal_start) {
    throw new Error('Tinode shard ordinal range is invalid');
  }
  const expectedShardId = `interaction/tinode_im/${input.ordinal_start}-${input.ordinal_end_exclusive}`;
  if (input.shard_id !== expectedShardId) throw new Error(`Tinode shard ID must be ${expectedShardId}`);
  if (!/^[1-9][0-9]{0,18}$/.test(input.lease_epoch)) throw new Error('invalid Tinode lease_epoch');
  for (const [field, value] of Object.entries({
    messages_per_interaction: input.messages_per_interaction,
    maximum_reconnects: input.maximum_reconnects,
    reconnect_delay_ms: input.reconnect_delay_ms,
    request_timeout_ms: input.request_timeout_ms,
    concurrency: input.concurrency
  })) {
    const minimum = ['messages_per_interaction', 'request_timeout_ms', 'concurrency'].includes(field) ? 1 : 0;
    if (!Number.isInteger(value) || value < minimum) throw new Error(`invalid Tinode ${field}`);
  }
}

function endpointWithApiKey(endpoint: string, apiKey: string): string {
  const url = new URL(endpoint);
  url.searchParams.set('apikey', apiKey);
  return url.toString();
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
}

function sum<T>(items: T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
