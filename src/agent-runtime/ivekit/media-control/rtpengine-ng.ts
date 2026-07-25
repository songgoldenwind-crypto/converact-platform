import { createHash } from 'node:crypto';
import net, { type Socket } from 'node:net';

import {
  BencodeError,
  decodeBencodePrefix,
  encodeBencode,
  type BencodeDictionary,
  type BencodeValue
} from './bencode.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface RtpengineNgCommandIdentity {
  command_id: string;
  command_hash: string;
}

export interface RtpengineNgDtmfEvent {
  cookie: string;
  payload: BencodeDictionary;
}

export interface RtpengineNgClientOptions {
  host: string;
  port: number;
  maxConnections?: number;
  maxInFlight?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxQueuedBytes?: number;
  requestTimeoutMs?: number;
  reconnectMinDelayMs?: number;
  reconnectMaxDelayMs?: number;
  random?: () => number;
  onDtmf?: (event: RtpengineNgDtmfEvent) => void;
}

export interface RtpengineNgRequestOptions {
  deadlineAt?: number;
}

export class RtpengineNgRequestError extends Error {
  constructor(
    readonly code: string,
    readonly resultClass: 'rejected' | 'unknown'
  ) {
    super(code);
    this.name = 'RtpengineNgRequestError';
  }
}

interface PendingRequest {
  cookie: string;
  slot: ConnectionSlot;
  writeStarted: boolean;
  frameBytes: number;
  timer: NodeJS.Timeout;
  resolve(value: BencodeDictionary): void;
  reject(error: RtpengineNgRequestError): void;
}

interface ConnectionSlot {
  socket: Socket | null;
  opening: Socket | null;
  connecting: Promise<Socket> | null;
  buffer: Buffer;
  pending: Set<string>;
  backpressured: boolean;
  outstandingBytes: number;
  reconnectAttempt: number;
  reconnectAt: number;
}

export class RtpengineNgClient {
  readonly #host: string;
  readonly #port: number;
  readonly #maxConnections: number;
  readonly #maxInFlight: number;
  readonly #maxRequestBytes: number;
  readonly #maxResponseBytes: number;
  readonly #maxQueuedBytes: number;
  readonly #requestTimeoutMs: number;
  readonly #reconnectMinDelayMs: number;
  readonly #reconnectMaxDelayMs: number;
  readonly #random: () => number;
  readonly #onDtmf?: (event: RtpengineNgDtmfEvent) => void;
  readonly #slots: ConnectionSlot[] = [];
  readonly #pending = new Map<string, PendingRequest>();
  #closed = false;

  constructor(options: RtpengineNgClientOptions) {
    this.#host = checkedHost(options.host);
    this.#port = checkedInteger(options.port, 1, 65_535, 'port');
    this.#maxConnections = checkedInteger(
      options.maxConnections ?? 2,
      1,
      64,
      'maxConnections'
    );
    this.#maxInFlight = checkedInteger(
      options.maxInFlight ?? 256,
      1,
      100_000,
      'maxInFlight'
    );
    this.#maxRequestBytes = checkedInteger(
      options.maxRequestBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      64,
      64 * 1024 * 1024,
      'maxRequestBytes'
    );
    this.#maxResponseBytes = checkedInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      64,
      64 * 1024 * 1024,
      'maxResponseBytes'
    );
    this.#maxQueuedBytes = checkedInteger(
      options.maxQueuedBytes ?? 4 * 1024 * 1024,
      64,
      64 * 1024 * 1024,
      'maxQueuedBytes'
    );
    this.#requestTimeoutMs = checkedInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      300_000,
      'requestTimeoutMs'
    );
    this.#reconnectMinDelayMs = checkedInteger(
      options.reconnectMinDelayMs ?? 25,
      0,
      60_000,
      'reconnectMinDelayMs'
    );
    this.#reconnectMaxDelayMs = checkedInteger(
      options.reconnectMaxDelayMs ?? 2_000,
      this.#reconnectMinDelayMs,
      300_000,
      'reconnectMaxDelayMs'
    );
    this.#random = options.random ?? Math.random;
    this.#onDtmf = options.onDtmf;
  }

  request(
    command: BencodeDictionary,
    rawIdentity: RtpengineNgCommandIdentity,
    options: RtpengineNgRequestOptions = {}
  ): Promise<BencodeDictionary> {
    const identity = checkedIdentity(rawIdentity);
    const now = Date.now();
    const deadlineAt = checkedDeadline(
      options.deadlineAt ?? now + this.#requestTimeoutMs
    );
    if (deadlineAt <= now) {
      return Promise.reject(rejected('rtpengine_ng_deadline'));
    }
    if (this.#closed) {
      return Promise.reject(rejected('rtpengine_ng_client_closed'));
    }
    if (this.#pending.size >= this.#maxInFlight) {
      return Promise.reject(rejected('rtpengine_ng_capacity'));
    }

    const cookie = rtpengineNgCookie(identity);
    if (this.#pending.has(cookie)) {
      return Promise.reject(rejected('rtpengine_ng_duplicate_cookie'));
    }

    let encoded: Buffer;
    try {
      encoded = Buffer.concat([
        Buffer.from(`${cookie} `, 'ascii'),
        encodeBencode(command, {
          maxBytes: this.#maxRequestBytes,
          maxStringBytes: this.#maxRequestBytes
        })
      ]);
    } catch {
      return Promise.reject(rejected('rtpengine_ng_request_invalid'));
    }
    if (encoded.length > this.#maxRequestBytes) {
      return Promise.reject(rejected('rtpengine_ng_request_too_large'));
    }

    const slot = this.#selectSlot();
    return new Promise<BencodeDictionary>((resolve, rejectPromise) => {
      const timer = setTimeout(
        () => this.#expire(cookie),
        Math.max(1, deadlineAt - Date.now())
      );
      timer.unref();
      const pending: PendingRequest = {
        cookie,
        slot,
        writeStarted: false,
        frameBytes: 0,
        timer,
        resolve,
        reject: rejectPromise
      };
      this.#pending.set(cookie, pending);
      slot.pending.add(cookie);
      void this.#send(pending, encoded, deadlineAt);
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of [...this.#pending.values()]) {
      this.#rejectPending(
        pending,
        new RtpengineNgRequestError(
          'rtpengine_ng_client_closed',
          pending.writeStarted ? 'unknown' : 'rejected'
        )
      );
    }
    for (const slot of this.#slots) {
      slot.opening?.destroy();
      slot.socket?.destroy();
      slot.opening = null;
      slot.socket = null;
      slot.connecting = null;
      slot.buffer = Buffer.alloc(0);
      slot.backpressured = false;
      slot.outstandingBytes = 0;
    }
  }

  #selectSlot(): ConnectionSlot {
    if (this.#slots.length === 0 ||
        (this.#slots.length < this.#maxConnections &&
         this.#pending.size >= this.#slots.length)) {
      const created = newSlot();
      this.#slots.push(created);
      return created;
    }

    let selected = this.#slots[0];
    for (const slot of this.#slots) {
      if (slot.pending.size < selected.pending.size) selected = slot;
    }
    return selected;
  }

  async #send(
    pending: PendingRequest,
    frame: Buffer,
    deadlineAt: number
  ): Promise<void> {
    try {
      const socket = await this.#connection(pending.slot, deadlineAt);
      if (!this.#pending.has(pending.cookie)) return;
      if (Date.now() >= deadlineAt) {
        this.#rejectPending(pending, rejected('rtpengine_ng_deadline'));
        return;
      }
      if (pending.slot.backpressured ||
          pending.slot.outstandingBytes + frame.length > this.#maxQueuedBytes ||
          socket.writableLength + frame.length > this.#maxQueuedBytes) {
        this.#rejectPending(
          pending,
          rejected('rtpengine_ng_backpressure')
        );
        return;
      }
      pending.writeStarted = true;
      pending.frameBytes = frame.length;
      pending.slot.outstandingBytes += frame.length;
      const accepted = socket.write(frame, (error?: Error | null) => {
        if (!error) return;
        this.#rejectPending(
          pending,
          unknown('rtpengine_ng_write_failed')
        );
        socket.destroy();
      });
      if (!accepted) {
        pending.slot.backpressured = true;
        socket.once('drain', () => {
          if (pending.slot.socket === socket) {
            pending.slot.backpressured = false;
          }
        });
      }
    } catch (error) {
      if (!this.#pending.has(pending.cookie)) return;
      this.#rejectPending(
        pending,
        error instanceof RtpengineNgRequestError
          ? error
          : rejected('rtpengine_ng_connect_failed')
      );
    }
  }

  async #connection(
    slot: ConnectionSlot,
    deadlineAt: number
  ): Promise<Socket> {
    while (!this.#closed) {
      if (slot.socket?.writable) return slot.socket;
      const waitMs = slot.reconnectAt - Date.now();
      if (waitMs > 0) {
        if (Date.now() + waitMs >= deadlineAt) {
          throw rejected('rtpengine_ng_connect_failed');
        }
        await delay(waitMs);
      }
      if (Date.now() >= deadlineAt) {
        throw rejected('rtpengine_ng_deadline');
      }
      try {
        return await this.#open(slot, deadlineAt);
      } catch {
        if (slot.reconnectAt >= deadlineAt) {
          throw rejected('rtpengine_ng_connect_failed');
        }
      }
    }
    throw rejected('rtpengine_ng_client_closed');
  }

  #open(slot: ConnectionSlot, deadlineAt: number): Promise<Socket> {
    if (slot.socket?.writable) return Promise.resolve(slot.socket);
    if (slot.connecting) return slot.connecting;

    slot.connecting = new Promise<Socket>((resolve, rejectPromise) => {
      const socket = net.createConnection({
        host: this.#host,
        port: this.#port
      });
      slot.opening = socket;
      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30_000);
      let settled = false;
      const timeout = setTimeout(() => {
        socket.destroy(new Error('connect deadline'));
      }, Math.max(1, deadlineAt - Date.now()));
      timeout.unref();

      const cleanup = (): void => {
        clearTimeout(timeout);
        socket.off('connect', onConnect);
        socket.off('error', onInitialError);
        socket.off('close', onInitialClose);
      };
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        slot.opening = null;
        if (!this.#closed) this.#scheduleReconnect(slot);
        rejectPromise(error);
      };
      const onConnect = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        slot.opening = null;
        if (this.#closed) {
          socket.destroy();
          rejectPromise(new Error('client closed'));
          return;
        }
        slot.socket = socket;
        slot.buffer = Buffer.alloc(0);
        slot.backpressured = false;
        slot.outstandingBytes = 0;
        slot.reconnectAttempt = 0;
        slot.reconnectAt = 0;
        socket.on('data', (chunk) => this.#onData(slot, socket, chunk));
        socket.on('error', () => {});
        socket.on('close', () => this.#onClose(slot, socket));
        resolve(socket);
      };
      const onInitialError = (error: Error): void => {
        fail(error);
      };
      const onInitialClose = (): void => fail(new Error('connection closed'));
      socket.once('connect', onConnect);
      socket.once('error', onInitialError);
      socket.once('close', onInitialClose);
    }).finally(() => {
      slot.connecting = null;
    });
    return slot.connecting;
  }

  #onData(slot: ConnectionSlot, socket: Socket, chunk: Buffer): void {
    if (slot.socket !== socket) return;
    slot.buffer = slot.buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([slot.buffer, chunk]);

    try {
      this.#consumeFrames(slot);
    } catch (error) {
      const code = error instanceof RtpengineNgRequestError
        ? error.code
        : 'rtpengine_ng_protocol';
      this.#failSlot(slot, code);
    }
  }

  #consumeFrames(slot: ConnectionSlot): void {
    while (slot.buffer.length > 0) {
      const separator = slot.buffer.indexOf(32);
      if (separator < 1) {
        if (slot.buffer.length > this.#maxResponseBytes) {
          throw unknown('rtpengine_ng_response_too_large');
        }
        return;
      }
      if (separator > 128) throw unknown('rtpengine_ng_protocol');
      const cookieBytes = slot.buffer.subarray(0, separator);
      if (!/^[A-Za-z0-9._:-]+$/.test(cookieBytes.toString('ascii'))) {
        throw unknown('rtpengine_ng_protocol');
      }
      const maximumPayloadBytes = this.#maxResponseBytes - separator - 1;
      if (maximumPayloadBytes < 1) {
        throw unknown('rtpengine_ng_response_too_large');
      }

      let decoded: { value: BencodeValue; bytesRead: number };
      try {
        decoded = decodeBencodePrefix(
          slot.buffer.subarray(separator + 1),
          {
            maxBytes: maximumPayloadBytes,
            maxStringBytes: maximumPayloadBytes
          }
        );
      } catch (error) {
        if (error instanceof BencodeError && error.incomplete) {
          if (slot.buffer.length > this.#maxResponseBytes) {
            throw unknown('rtpengine_ng_response_too_large');
          }
          return;
        }
        if (error instanceof BencodeError &&
            (error.code === 'bencode_bytes_exceeded' ||
             error.code === 'bencode_string_exceeded')) {
          throw unknown('rtpengine_ng_response_too_large');
        }
        if (slot.buffer.length > this.#maxResponseBytes) {
          throw unknown('rtpengine_ng_response_too_large');
        }
        throw unknown('rtpengine_ng_protocol');
      }

      const frameEnd = separator + 1 + decoded.bytesRead;
      if (frameEnd > this.#maxResponseBytes) {
        throw unknown('rtpengine_ng_response_too_large');
      }
      if (!isDictionary(decoded.value)) {
        throw unknown('rtpengine_ng_protocol');
      }

      const cookie = cookieBytes.toString('ascii');
      slot.buffer = slot.buffer.subarray(frameEnd);
      if (isDtmf(decoded.value)) {
        if (slot === this.#notificationSlot()) {
          this.#emitDtmf({ cookie, payload: decoded.value });
        }
        continue;
      }
      const pending = this.#pending.get(cookie);
      if (pending?.slot === slot) this.#resolvePending(pending, decoded.value);
    }
  }

  #emitDtmf(event: RtpengineNgDtmfEvent): void {
    try {
      this.#onDtmf?.(event);
    } catch {
      // Consumer failures must not corrupt the transport parser.
    }
  }

  #onClose(slot: ConnectionSlot, socket: Socket): void {
    if (slot.socket !== socket) return;
    slot.socket = null;
    slot.buffer = Buffer.alloc(0);
    slot.backpressured = false;
    this.#scheduleReconnect(slot);
    for (const cookie of [...slot.pending]) {
      const pending = this.#pending.get(cookie);
      if (!pending) continue;
      this.#rejectPending(
        pending,
        pending.writeStarted
          ? unknown('rtpengine_ng_disconnected')
          : rejected('rtpengine_ng_disconnected')
      );
    }
  }

  #failSlot(slot: ConnectionSlot, code: string): void {
    for (const cookie of [...slot.pending]) {
      const pending = this.#pending.get(cookie);
      if (!pending) continue;
      this.#rejectPending(
        pending,
        new RtpengineNgRequestError(
          code,
          pending.writeStarted ? 'unknown' : 'rejected'
        )
      );
    }
    slot.socket?.destroy();
  }

  #scheduleReconnect(slot: ConnectionSlot): void {
    const exponential = Math.min(
      this.#reconnectMaxDelayMs,
      this.#reconnectMinDelayMs * (2 ** Math.min(slot.reconnectAttempt, 16))
    );
    const random = this.#random();
    const fraction = Number.isFinite(random)
      ? Math.min(1, Math.max(0, random))
      : 0.5;
    const jittered = Math.floor(exponential * (0.5 + (fraction * 0.5)));
    slot.reconnectAttempt += 1;
    slot.reconnectAt = Date.now() + jittered;
  }

  #expire(cookie: string): void {
    const pending = this.#pending.get(cookie);
    if (!pending) return;
    const written = pending.writeStarted;
    this.#rejectPending(
      pending,
      new RtpengineNgRequestError(
        'rtpengine_ng_deadline',
        written ? 'unknown' : 'rejected'
      )
    );
    if (written) pending.slot.socket?.destroy();
  }

  #notificationSlot(): ConnectionSlot | undefined {
    return this.#slots.find((slot) => slot.socket?.writable);
  }

  #resolvePending(
    pending: PendingRequest,
    value: BencodeDictionary
  ): void {
    if (!this.#pending.delete(pending.cookie)) return;
    pending.slot.pending.delete(pending.cookie);
    pending.slot.outstandingBytes = Math.max(
      0,
      pending.slot.outstandingBytes - pending.frameBytes
    );
    clearTimeout(pending.timer);
    pending.resolve(value);
  }

  #rejectPending(
    pending: PendingRequest,
    error: RtpengineNgRequestError
  ): void {
    if (!this.#pending.delete(pending.cookie)) return;
    pending.slot.pending.delete(pending.cookie);
    pending.slot.outstandingBytes = Math.max(
      0,
      pending.slot.outstandingBytes - pending.frameBytes
    );
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

export function rtpengineNgCookie(
  rawIdentity: RtpengineNgCommandIdentity
): string {
  const identity = checkedIdentity(rawIdentity);
  return `ivk-${createHash('sha256')
    .update(identity.command_id, 'utf8')
    .update('\0')
    .update(identity.command_hash, 'ascii')
    .digest('hex')}`;
}

function checkedIdentity(
  identity: RtpengineNgCommandIdentity
): RtpengineNgCommandIdentity {
  const commandId = String(identity?.command_id ?? '');
  const commandHash = String(identity?.command_hash ?? '').toLowerCase();
  if (commandId.length < 1 || commandId.length > 256 ||
      /[\0\r\n]/.test(commandId)) {
    throw rejected('rtpengine_ng_identity_invalid');
  }
  if (!/^[a-f0-9]{64}$/.test(commandHash)) {
    throw rejected('rtpengine_ng_identity_invalid');
  }
  return { command_id: commandId, command_hash: commandHash };
}

function checkedHost(value: string): string {
  const host = String(value ?? '').trim();
  if (host.length < 1 || host.length > 253 || /[\0\r\n\s]/.test(host)) {
    throw new Error('RTPengine NG host is invalid');
  }
  return host;
}

function checkedDeadline(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw rejected('rtpengine_ng_deadline');
  }
  return value;
}

function checkedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`RTPengine NG ${name} is invalid`);
  }
  return value;
}

function newSlot(): ConnectionSlot {
  return {
    socket: null,
    opening: null,
    connecting: null,
    buffer: Buffer.alloc(0),
    pending: new Set(),
    backpressured: false,
    outstandingBytes: 0,
    reconnectAttempt: 0,
    reconnectAt: 0
  };
}

function isDictionary(value: BencodeValue): value is BencodeDictionary {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Buffer.isBuffer(value) &&
    !(value instanceof Uint8Array) &&
    !Array.isArray(value)
  );
}

function isDtmf(value: BencodeDictionary): boolean {
  if (bencodeText(value.notify) !== 'ondtmf') return false;
  const data = value.data;
  return isDictionary(data) && bencodeText(data.type) === 'dtmf';
}

function bencodeText(value: BencodeValue | undefined): string {
  if (typeof value === 'string') return value.toLowerCase();
  return Buffer.isBuffer(value)
    ? value.toString('ascii').toLowerCase()
    : '';
}

function rejected(code: string): RtpengineNgRequestError {
  return new RtpengineNgRequestError(code, 'rejected');
}

function unknown(code: string): RtpengineNgRequestError {
  return new RtpengineNgRequestError(code, 'unknown');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}
