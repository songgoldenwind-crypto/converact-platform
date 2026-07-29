import { createHash } from 'node:crypto';

import type {
  MediaTransportCommand,
  MediaTransportCommandIdentity,
  MediaTransportOrphanCandidate,
  MediaTransportOutcome,
  MediaTransportPort,
  MediaTransportQuery,
  MediaTransportSessionSnapshot
} from './transport.js';

const PROTOCOL_VERSION = 'ivekit.processing-control.v1';
const EVENT_PROTOCOL_VERSION = 'ivekit.processing-event.v1';
const PROMPT_CONTENT_TYPE = 'application/vnd.ivekit.pcm16le';
const MAX_UINT64 = (1n << 64n) - 1n;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const ERROR_CODE = /^[a-z][a-z0-9_.-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const SESSION_STATES = new Set([
  'prepared',
  'committed',
  'updating',
  'blocked',
  'forwarding',
  'recording',
  'closed',
  'expired'
]);
const ACTIVE_SESSION_STATES = new Set(['prepared', 'committed']);
const TERMINAL_SESSION_STATES = new Set(['closed', 'expired']);

type ProcessingReleaseContext = Omit<MediaTransportOrphanCandidate, 'state'> & {
  admission_reservation_id: string;
  last_sequence: number;
  state: 'prepared' | 'committed' | 'closed' | 'expired';
};

export interface ProcessingMediaTransportOptions {
  endpoint: string;
  bearer_token: string;
  client_identity?: string;
  request_timeout_ms?: number;
  max_response_bytes?: number;
  max_release_contexts?: number;
  max_prompt_body_bytes?: number;
}

export interface ProcessingPromptUpload {
  prompt_id: string;
  sample_rate_hz: number;
  pcm16le: Uint8Array;
}

export interface ProcessingPromptSnapshot {
  prompt_id: string;
  content_sha256: string;
  source_sample_rate_hz: number;
  canonical_sample_rate_hz: 48_000;
  frame_count: number;
  duration_ms: number;
}

interface ProcessingEventBase {
  protocol_version: typeof EVENT_PROTOCOL_VERSION;
  event_sequence: string;
  event_id: string;
  tenant_id: string;
  call_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  media_reservation_id: string;
  command_id: string;
  occurred_at_ms: number;
}

export type ProcessingTerminalEvent =
  | ProcessingEventBase & {
      event_type: 'playback_completed';
      prompt_id: string;
    }
  | ProcessingEventBase & {
      event_type: 'playback_stopped';
      prompt_id: string;
      reason: 'explicit' | 'barge_in' | 'session_removed';
    }
  | ProcessingEventBase & {
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

export interface ProcessingEventPage {
  items: ProcessingTerminalEvent[];
  acknowledged_through: string;
  next_sequence: string;
}

export type ProcessingEventQuery =
  | { found: false }
  | {
      found: true;
      state: 'pending' | 'acknowledged';
      event: ProcessingTerminalEvent;
    };

export class ProcessingMediaTransportError extends Error {
  constructor(readonly code: string, options: { cause?: unknown } = {}) {
    super(code, options);
    this.name = 'ProcessingMediaTransportError';
  }
}

export class ProcessingMediaTransport implements MediaTransportPort {
  readonly #endpoint: URL;
  readonly #bearerToken: string;
  readonly #clientIdentity: string | undefined;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #maxReleaseContexts: number;
  readonly #maxPromptBodyBytes: number;
  readonly #releaseContexts = new Map<string, ProcessingReleaseContext>();

  constructor(options: ProcessingMediaTransportOptions) {
    this.#endpoint = processingEndpoint(options.endpoint);
    this.#bearerToken = credential(options.bearer_token, 'bearer_token');
    this.#clientIdentity = options.client_identity === undefined
      ? undefined
      : credential(options.client_identity, 'client_identity');
    this.#requestTimeoutMs = boundedInteger(
      options.request_timeout_ms ?? 2_000,
      50,
      300_000,
      'request_timeout_ms'
    );
    this.#maxResponseBytes = boundedInteger(
      options.max_response_bytes ?? 262_144,
      256,
      4 * 1024 * 1024,
      'max_response_bytes'
    );
    this.#maxReleaseContexts = boundedInteger(
      options.max_release_contexts ?? 100_000,
      1,
      10_000_000,
      'max_release_contexts'
    );
    this.#maxPromptBodyBytes = boundedInteger(
      options.max_prompt_body_bytes ?? 1024 * 1024,
      2,
      64 * 1024 * 1024,
      'max_prompt_body_bytes'
    );
  }

  async execute(command: MediaTransportCommand): Promise<MediaTransportOutcome> {
    try {
      const response = await this.#json('/v1/commands', {
        method: 'POST',
        body: JSON.stringify({
          protocol_version: PROTOCOL_VERSION,
          ...structuredClone(command)
        })
      });
      const outcome = processingOutcome(response.value, command.command_id);
      if (outcome) {
        if (outcome.state === 'succeeded') {
          this.#rememberCommand(command, outcome);
        }
        return outcome;
      }
      return unknown(command.command_id, httpError(response.status));
    } catch (error) {
      return unknown(command.command_id, transportErrorCode(error));
    }
  }

  async queryCommand(
    identity: MediaTransportCommandIdentity
  ): Promise<MediaTransportQuery> {
    checkedIdentity(identity);
    const response = await this.#json('/v1/reconcile', {
      method: 'POST',
      body: JSON.stringify({
        protocol_version: PROTOCOL_VERSION,
        ...structuredClone(identity)
      })
    });
    if (response.status < 200 || response.status >= 300) {
      throw new ProcessingMediaTransportError(httpError(response.status));
    }
    const value = record(response.value);
    if (value?.found === false) return { found: false };
    const outcome = value?.found === true
      ? processingOutcome(value.outcome, identity.command_id)
      : undefined;
    if (!outcome || outcome.state === 'unknown') {
      throw new ProcessingMediaTransportError('processing_response_invalid');
    }
    return { found: true, outcome };
  }

  async querySession(input: {
    media_reservation_id: string;
    call_id: string;
  }): Promise<MediaTransportSessionSnapshot | undefined> {
    checkedIdentifier(input.media_reservation_id, 'media_reservation_id');
    checkedIdentifier(input.call_id, 'call_id');
    const response = await this.#json(
      `/v1/sessions/${encodeURIComponent(input.media_reservation_id)}`,
      { method: 'GET' }
    );
    if (response.status === 404) return undefined;
    if (response.status < 200 || response.status >= 300) {
      throw new ProcessingMediaTransportError(httpError(response.status));
    }
    return processingSession(
      response.value,
      input.media_reservation_id,
      input.call_id
    );
  }

  async scanOrphanCandidates(input: {
    after: string;
    limit: number;
  }): Promise<{
    items: MediaTransportOrphanCandidate[];
    next_cursor: string;
  }> {
    const after = checkedCursor(input.after);
    const limit = boundedInteger(
      input.limit,
      1,
      10_000,
      'orphan_scan_limit'
    );
    if (limit > this.#maxReleaseContexts) {
      throw new ProcessingMediaTransportError(
        'processing_orphan_scan_limit_exceeds_context_capacity'
      );
    }
    const query = new URLSearchParams({
      after,
      limit: String(limit)
    });
    const response = await this.#json(`/v1/sessions?${query}`, {
      method: 'GET'
    });
    if (response.status < 200 || response.status >= 300) {
      throw new ProcessingMediaTransportError(httpError(response.status));
    }
    const value = record(response.value);
    if (!value || !Array.isArray(value.items)) {
      throw new ProcessingMediaTransportError('processing_response_invalid');
    }
    const nextCursor = checkedCursor(value.next_cursor);
    const items = value.items.map((candidate) => {
      const context = processingOrphanCandidate(candidate);
      this.#rememberContext(context);
      return publicOrphanCandidate(context);
    });
    if (items.length > limit) {
      throw new ProcessingMediaTransportError('processing_response_invalid');
    }
    return { items, next_cursor: nextCursor };
  }

  async releaseSession(
    transportSessionId: string,
    reason: string
  ): Promise<void> {
    checkedIdentifier(transportSessionId, 'transport_session_id');
    checkedIdentifier(reason, 'release_reason');
    if (!transportSessionId.startsWith('processing:')) {
      throw new ProcessingMediaTransportError(
        'processing_transport_session_id_invalid'
      );
    }
    const context = this.#releaseContexts.get(transportSessionId);
    if (!context) {
      throw new ProcessingMediaTransportError(
        'processing_release_context_missing'
      );
    }
    if (TERMINAL_SESSION_STATES.has(context.state)) return;
    if (context.last_sequence >= 0xffff_ffff) {
      throw new ProcessingMediaTransportError(
        'processing_command_sequence_exhausted'
      );
    }
    const commandSequence = context.last_sequence + 1;
    const commandId = `release-${digest([
      context.media_reservation_id,
      context.owner_epoch,
      String(commandSequence),
      reason
    ].join('\0')).slice(0, 48)}`;
    const payload = { reason };
    const command: MediaTransportCommand = {
      action: 'delete',
      command_id: commandId,
      tenant_id: context.tenant_id,
      call_id: context.call_id,
      leg_id: context.leg_id,
      cell_id: context.cell_id,
      owner_node_id: context.owner_node_id,
      owner_epoch: context.owner_epoch,
      admission_reservation_id: context.admission_reservation_id,
      media_reservation_id: context.media_reservation_id,
      expires_at: context.expires_at,
      command_sequence: commandSequence,
      idempotency_key: commandId,
      payload_hash: digest(JSON.stringify(payload)),
      command_hash: '',
      transport_session_id: context.transport_session_id,
      payload
    };
    command.command_hash = digest(JSON.stringify(command));
    const outcome = await this.execute(command);
    if (outcome.state !== 'succeeded') {
      throw new ProcessingMediaTransportError(outcome.error_code, {
        cause: outcome
      });
    }
  }

  async cachePrompt(
    input: ProcessingPromptUpload
  ): Promise<ProcessingPromptSnapshot> {
    checkedIdentifier(input.prompt_id, 'prompt_id');
    const sampleRateHz = boundedInteger(
      input.sample_rate_hz,
      8_000,
      192_000,
      'prompt_sample_rate_hz'
    );
    if (!(input.pcm16le instanceof Uint8Array) ||
        input.pcm16le.byteLength === 0 ||
        input.pcm16le.byteLength % 2 !== 0) {
      throw new ProcessingMediaTransportError(
        'processing_prompt_pcm_invalid'
      );
    }
    if (input.pcm16le.byteLength > this.#maxPromptBodyBytes) {
      throw new ProcessingMediaTransportError(
        'processing_prompt_body_too_large'
      );
    }
    const body = Buffer.from(input.pcm16le);
    const contentHash = createHash('sha256').update(body).digest('hex');
    const response = await this.#json(
      `/v1/prompts/${encodeURIComponent(input.prompt_id)}`,
      {
        method: 'PUT',
        body,
        content_type: PROMPT_CONTENT_TYPE,
        headers: {
          'x-ivekit-sample-rate-hz': String(sampleRateHz),
          'x-ivekit-content-sha256': contentHash
        }
      }
    );
    if (response.status < 200 || response.status >= 300) {
      throw new ProcessingMediaTransportError(
        serverError(response.value, response.status)
      );
    }
    return processingPromptSnapshot(
      response.value,
      input.prompt_id,
      contentHash,
      sampleRateHz
    );
  }

  async removePrompt(promptId: string): Promise<boolean> {
    checkedIdentifier(promptId, 'prompt_id');
    const response = await this.#json(
      `/v1/prompts/${encodeURIComponent(promptId)}`,
      { method: 'DELETE' }
    );
    if (response.status < 200 || response.status >= 300) {
      throw new ProcessingMediaTransportError(
        serverError(response.value, response.status)
      );
    }
    const value = record(response.value);
    if (value?.protocol_version !== PROTOCOL_VERSION ||
        typeof value.removed !== 'boolean') {
      throw new ProcessingMediaTransportError('processing_response_invalid');
    }
    return value.removed;
  }

  async scanEvents(input: {
    after_sequence: string;
    limit: number;
  }): Promise<ProcessingEventPage> {
    const afterSequence = checkedEventSequence(
      input.after_sequence,
      true
    );
    const limit = boundedInteger(
      input.limit,
      1,
      10_000,
      'event_scan_limit'
    );
    const query = new URLSearchParams({
      after_sequence: afterSequence,
      limit: String(limit)
    });
    const response = await this.#json(`/v1/events?${query}`, {
      method: 'GET'
    });
    if (response.status < 200 || response.status >= 300) {
      throw new ProcessingMediaTransportError(httpError(response.status));
    }
    const value = record(response.value);
    if (!value ||
        value.protocol_version !== EVENT_PROTOCOL_VERSION ||
        !Array.isArray(value.items)) {
      throw new ProcessingMediaTransportError('processing_response_invalid');
    }
    const acknowledgedThrough = checkedEventSequence(
      value.acknowledged_through,
      true
    );
    const nextSequence = checkedEventSequence(value.next_sequence, false);
    if (BigInt(acknowledgedThrough) >= BigInt(nextSequence)) {
      throw new ProcessingMediaTransportError('processing_response_invalid');
    }
    const floor = [afterSequence, acknowledgedThrough]
      .reduce((highest, candidate) =>
        BigInt(candidate) > BigInt(highest) ? candidate : highest
      );
    let expected = BigInt(floor) + 1n;
    const items = value.items.map((item) => {
      const event = checkedProcessingTerminalEvent(item);
      if (BigInt(event.event_sequence) !== expected ||
          BigInt(event.event_sequence) >= BigInt(nextSequence)) {
        throw new ProcessingMediaTransportError(
          'processing_event_sequence_gap'
        );
      }
      expected += 1n;
      return event;
    });
    if (items.length > limit) {
      throw new ProcessingMediaTransportError('processing_response_invalid');
    }
    return {
      items,
      acknowledged_through: acknowledgedThrough,
      next_sequence: nextSequence
    };
  }

  async queryEvent(eventId: string): Promise<ProcessingEventQuery> {
    checkedIdentifier(eventId, 'event_id');
    const response = await this.#json(
      `/v1/events/${encodeURIComponent(eventId)}`,
      { method: 'GET' }
    );
    if (response.status < 200 || response.status >= 300) {
      throw new ProcessingMediaTransportError(httpError(response.status));
    }
    const value = record(response.value);
    if (value?.found === false && value.state === 'not_found') {
      return { found: false };
    }
    if (value?.found !== true ||
        !['pending', 'acknowledged'].includes(String(value.state))) {
      throw new ProcessingMediaTransportError('processing_response_invalid');
    }
    const event = checkedProcessingTerminalEvent(value.event);
    if (event.event_id !== eventId) {
      throw new ProcessingMediaTransportError('processing_response_invalid');
    }
    return {
      found: true,
      state: value.state as 'pending' | 'acknowledged',
      event
    };
  }

  async acknowledgeEvent(input: {
    event_sequence: string;
    event_id: string;
  }): Promise<void> {
    const eventSequence = checkedEventSequence(
      input.event_sequence,
      false
    );
    checkedIdentifier(input.event_id, 'event_id');
    const response = await this.#json('/v1/events/ack', {
      method: 'POST',
      body: JSON.stringify({
        protocol_version: EVENT_PROTOCOL_VERSION,
        event_sequence: eventSequence,
        event_id: input.event_id
      })
    });
    if (response.status < 200 || response.status >= 300) {
      throw new ProcessingMediaTransportError(httpError(response.status));
    }
    const value = record(response.value);
    if (value?.protocol_version !== EVENT_PROTOCOL_VERSION ||
        checkedEventSequence(value.acknowledged_through, false) !==
          eventSequence) {
      throw new ProcessingMediaTransportError('processing_response_invalid');
    }
  }

  #rememberCommand(
    command: MediaTransportCommand,
    outcome: Extract<MediaTransportOutcome, { state: 'succeeded' }>
  ): void {
    const existing = this.#releaseContexts.get(outcome.transport_session_id);
    if (TERMINAL_SESSION_STATES.has(outcome.session_state)) {
      if (existing) {
        existing.last_sequence = Math.max(
          existing.last_sequence,
          command.command_sequence
        );
        existing.state = outcome.session_state as 'closed' | 'expired';
      }
      return;
    }
    if (!ACTIVE_SESSION_STATES.has(outcome.session_state)) return;
    this.#rememberContext({
      tenant_id: command.tenant_id,
      call_id: command.call_id,
      leg_id: command.leg_id,
      cell_id: command.cell_id,
      owner_node_id: command.owner_node_id,
      owner_epoch: command.owner_epoch,
      admission_reservation_id: command.admission_reservation_id,
      media_reservation_id: command.media_reservation_id,
      transport_session_id: outcome.transport_session_id,
      last_sequence: command.command_sequence,
      expires_at: command.expires_at,
      state: outcome.session_state as 'prepared' | 'committed'
    });
  }

  #rememberContext(context: ProcessingReleaseContext): void {
    const existing = this.#releaseContexts.get(context.transport_session_id);
    if (existing &&
        existing.media_reservation_id !== context.media_reservation_id) {
      throw new ProcessingMediaTransportError(
        'processing_transport_identity_conflict'
      );
    }
    if (!existing && this.#releaseContexts.size >= this.#maxReleaseContexts) {
      const oldest = this.#releaseContexts.keys().next().value;
      if (typeof oldest === 'string') this.#releaseContexts.delete(oldest);
    }
    this.#releaseContexts.delete(context.transport_session_id);
    this.#releaseContexts.set(
      context.transport_session_id,
      structuredClone(context)
    );
  }

  async #json(
    path: string,
    init: {
      method: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: string | Buffer;
      content_type?: string;
      headers?: Record<string, string>;
    }
  ): Promise<{ status: number; value: unknown }> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.#endpoint), {
        method: init.method,
        headers: {
          authorization: `Bearer ${this.#bearerToken}`,
          accept: 'application/json',
          'accept-encoding': 'identity',
          ...(init.body
            ? { 'content-type': init.content_type ?? 'application/json' }
            : {}),
          ...(this.#clientIdentity
            ? { 'x-ivekit-client-identity': this.#clientIdentity }
            : {}),
          ...init.headers
        },
        body: init.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#requestTimeoutMs)
      });
    } catch (error) {
      throw new ProcessingMediaTransportError(
        error instanceof DOMException && error.name === 'TimeoutError'
          ? 'processing_transport_timeout'
          : 'processing_transport_unavailable',
        { cause: error }
      );
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProcessingMediaTransportError(
        'processing_transport_redirected'
      );
    }
    const encoding = response.headers.get('content-encoding');
    if (encoding && encoding.toLowerCase() !== 'identity') {
      await response.body?.cancel().catch(() => undefined);
      throw new ProcessingMediaTransportError(
        'processing_compressed_response'
      );
    }
    return {
      status: response.status,
      value: await boundedJson(response, this.#maxResponseBytes)
    };
  }
}

function processingEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ProcessingMediaTransportError('processing_endpoint_invalid');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)
      || endpoint.username
      || endpoint.password
      || endpoint.search
      || endpoint.hash
      || (endpoint.pathname !== '' && endpoint.pathname !== '/')) {
    throw new ProcessingMediaTransportError('processing_endpoint_invalid');
  }
  if (endpoint.protocol === 'http:'
      && !['127.0.0.1', '::1', 'localhost'].includes(endpoint.hostname)) {
    throw new ProcessingMediaTransportError('processing_endpoint_insecure');
  }
  endpoint.pathname = '/';
  return endpoint;
}

async function boundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProcessingMediaTransportError('processing_response_too_large');
  }
  if (!response.body) {
    throw new ProcessingMediaTransportError('processing_response_invalid');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new ProcessingMediaTransportError(
          'processing_response_too_large'
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    throw new ProcessingMediaTransportError(
      'processing_response_invalid',
      { cause: error }
    );
  }
}

function processingOutcome(
  value: unknown,
  expectedCommandId: string
): MediaTransportOutcome | undefined {
  const input = record(value);
  if (!input || input.command_id !== expectedCommandId) return undefined;
  if (input.state === 'succeeded') {
    if (!validIdentifier(input.transport_session_id)
        || !String(input.transport_session_id).startsWith('processing:')
        || typeof input.effective_sdp !== 'string'
        || !SESSION_STATES.has(String(input.session_state))
        || !validTimestamp(input.applied_at)) {
      return undefined;
    }
    return {
      state: 'succeeded',
      command_id: expectedCommandId,
      transport_session_id: String(input.transport_session_id),
      effective_sdp: input.effective_sdp,
      session_state: input.session_state as MediaTransportSessionSnapshot['state'],
      applied_at: String(input.applied_at)
    };
  }
  if (input.state === 'failed'
      && typeof input.error_code === 'string'
      && ERROR_CODE.test(input.error_code)
      && typeof input.retryable === 'boolean') {
    return {
      state: 'failed',
      command_id: expectedCommandId,
      error_code: input.error_code,
      retryable: input.retryable
    };
  }
  if (input.state === 'unknown'
      && typeof input.error_code === 'string'
      && ERROR_CODE.test(input.error_code)
      && input.retryable === true) {
    return {
      state: 'unknown',
      command_id: expectedCommandId,
      error_code: input.error_code,
      retryable: true
    };
  }
  return undefined;
}

function processingPromptSnapshot(
  value: unknown,
  expectedPromptId: string,
  expectedContentHash: string,
  expectedSampleRateHz: number
): ProcessingPromptSnapshot {
  const input = record(value);
  if (!input ||
      input.protocol_version !== PROTOCOL_VERSION ||
      input.prompt_id !== expectedPromptId ||
      input.content_sha256 !== expectedContentHash ||
      input.source_sample_rate_hz !== expectedSampleRateHz ||
      input.canonical_sample_rate_hz !== 48_000 ||
      !Number.isSafeInteger(input.frame_count) ||
      Number(input.frame_count) < 1 ||
      !Number.isSafeInteger(input.duration_ms) ||
      Number(input.duration_ms) !== Number(input.frame_count) * 20) {
    throw new ProcessingMediaTransportError('processing_response_invalid');
  }
  return {
    prompt_id: expectedPromptId,
    content_sha256: expectedContentHash,
    source_sample_rate_hz: expectedSampleRateHz,
    canonical_sample_rate_hz: 48_000,
    frame_count: Number(input.frame_count),
    duration_ms: Number(input.duration_ms)
  };
}

function processingSession(
  value: unknown,
  expectedReservationId: string,
  expectedCallId: string
): MediaTransportSessionSnapshot {
  const input = record(value);
  if (!input
      || input.media_reservation_id !== expectedReservationId
      || input.call_id !== expectedCallId
      || !/^(?:0|[1-9][0-9]{0,19})$/.test(String(input.owner_epoch))
      || !Number.isSafeInteger(input.last_sequence)
      || Number(input.last_sequence) < 0
      || !SESSION_STATES.has(String(input.state))
      || !validIdentifier(input.transport_session_id)
      || !String(input.transport_session_id).startsWith('processing:')
      || typeof input.effective_sdp !== 'string'
      || !validTimestamp(input.expires_at)
      || !validTimestamp(input.updated_at)) {
    throw new ProcessingMediaTransportError('processing_response_invalid');
  }
  return {
    media_reservation_id: expectedReservationId,
    call_id: expectedCallId,
    owner_epoch: String(input.owner_epoch),
    last_sequence: Number(input.last_sequence),
    state: input.state as MediaTransportSessionSnapshot['state'],
    transport_session_id: String(input.transport_session_id),
    effective_sdp: input.effective_sdp,
    expires_at: String(input.expires_at),
    from_tag: null,
    to_tag: null,
    updated_at: String(input.updated_at)
  };
}

function processingOrphanCandidate(value: unknown): ProcessingReleaseContext {
  const input = record(value);
  if (!input ||
      !validIdentifier(input.tenant_id) ||
      !validIdentifier(input.call_id) ||
      !validIdentifier(input.leg_id) ||
      !validIdentifier(input.cell_id) ||
      !validIdentifier(input.owner_node_id) ||
      !/^[1-9][0-9]{0,19}$/.test(String(input.owner_epoch)) ||
      !validIdentifier(input.admission_reservation_id) ||
      !validIdentifier(input.media_reservation_id) ||
      !validIdentifier(input.transport_session_id) ||
      !String(input.transport_session_id).startsWith('processing:') ||
      !Number.isSafeInteger(input.last_sequence) ||
      Number(input.last_sequence) < 1 ||
      Number(input.last_sequence) > 0xffff_ffff ||
      !validTimestamp(input.expires_at) ||
      !ACTIVE_SESSION_STATES.has(String(input.state))) {
    throw new ProcessingMediaTransportError('processing_response_invalid');
  }
  return {
    tenant_id: String(input.tenant_id),
    call_id: String(input.call_id),
    leg_id: String(input.leg_id),
    cell_id: String(input.cell_id),
    owner_node_id: String(input.owner_node_id),
    owner_epoch: String(input.owner_epoch),
    admission_reservation_id: String(input.admission_reservation_id),
    media_reservation_id: String(input.media_reservation_id),
    transport_session_id: String(input.transport_session_id),
    last_sequence: Number(input.last_sequence),
    expires_at: String(input.expires_at),
    state: input.state as 'prepared' | 'committed'
  };
}

function publicOrphanCandidate(
  context: ProcessingReleaseContext
): MediaTransportOrphanCandidate {
  if (!ACTIVE_SESSION_STATES.has(context.state)) {
    throw new ProcessingMediaTransportError('processing_response_invalid');
  }
  return {
    tenant_id: context.tenant_id,
    call_id: context.call_id,
    leg_id: context.leg_id,
    cell_id: context.cell_id,
    owner_node_id: context.owner_node_id,
    owner_epoch: context.owner_epoch,
    media_reservation_id: context.media_reservation_id,
    transport_session_id: context.transport_session_id,
    expires_at: context.expires_at,
    state: context.state as 'prepared' | 'committed'
  };
}

export function checkedProcessingTerminalEvent(
  value: unknown
): ProcessingTerminalEvent {
  const input = record(value);
  if (!input ||
      input.protocol_version !== EVENT_PROTOCOL_VERSION ||
      !validIdentifier(input.event_id) ||
      !validIdentifier(input.tenant_id) ||
      !validIdentifier(input.call_id) ||
      !validIdentifier(input.cell_id) ||
      !validIdentifier(input.owner_node_id) ||
      !/^[1-9][0-9]{0,19}$/.test(String(input.owner_epoch)) ||
      BigInt(String(input.owner_epoch)) > MAX_UINT64 ||
      !validIdentifier(input.media_reservation_id) ||
      !validIdentifier(input.command_id) ||
      !Number.isSafeInteger(input.occurred_at_ms) ||
      Number(input.occurred_at_ms) < 1) {
    throw new ProcessingMediaTransportError('processing_response_invalid');
  }
  const base: ProcessingEventBase = {
    protocol_version: EVENT_PROTOCOL_VERSION,
    event_sequence: checkedEventSequence(input.event_sequence, false),
    event_id: String(input.event_id),
    tenant_id: String(input.tenant_id),
    call_id: String(input.call_id),
    cell_id: String(input.cell_id),
    owner_node_id: String(input.owner_node_id),
    owner_epoch: String(input.owner_epoch),
    media_reservation_id: String(input.media_reservation_id),
    command_id: String(input.command_id),
    occurred_at_ms: Number(input.occurred_at_ms)
  };
  if (input.event_type === 'playback_completed' &&
      validIdentifier(input.prompt_id)) {
    return {
      ...base,
      event_type: 'playback_completed',
      prompt_id: input.prompt_id
    };
  }
  if (input.event_type === 'playback_stopped' &&
      validIdentifier(input.prompt_id) &&
      ['explicit', 'barge_in', 'session_removed'].includes(
        String(input.reason)
      )) {
    return {
      ...base,
      event_type: 'playback_stopped',
      prompt_id: input.prompt_id,
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
  throw new ProcessingMediaTransportError('processing_response_invalid');
}

function checkedEventSequence(value: unknown, allowZero: boolean): string {
  if (typeof value !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new ProcessingMediaTransportError(
      'processing_event_sequence_invalid'
    );
  }
  const sequence = BigInt(value);
  if (sequence > MAX_UINT64 || (!allowZero && sequence === 0n)) {
    throw new ProcessingMediaTransportError(
      'processing_event_sequence_invalid'
    );
  }
  return value;
}

function checkedIdentity(identity: MediaTransportCommandIdentity): void {
  checkedIdentifier(identity.command_id, 'command_id');
  checkedIdentifier(identity.media_reservation_id, 'media_reservation_id');
  if (!/^[1-9][0-9]{0,19}$/.test(identity.owner_epoch)
      || !HASH.test(identity.command_hash)) {
    throw new ProcessingMediaTransportError(
      'processing_command_identity_invalid'
    );
  }
}

function checkedCursor(value: unknown): string {
  if (typeof value !== 'string' ||
      value.length > 256 ||
      (value.length > 0 && !validIdentifier(value))) {
    throw new ProcessingMediaTransportError(
      'processing_orphan_scan_cursor_invalid'
    );
  }
  return value;
}

function checkedIdentifier(value: string, field: string): void {
  if (!validIdentifier(value)) {
    throw new ProcessingMediaTransportError(`processing_${field}_invalid`);
  }
}

function validIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function credential(value: string, field: string): string {
  const result = String(value || '');
  if (result.length < 1 || result.length > 4_096 || /[\r\n\0]/.test(result)) {
    throw new ProcessingMediaTransportError(`processing_${field}_invalid`);
  }
  return result;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ProcessingMediaTransportError(`processing_${field}_invalid`);
  }
  return value;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function httpError(status: number): string {
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? `processing_http_${status}`
    : 'processing_response_invalid';
}

function serverError(value: unknown, status: number): string {
  const error = record(value)?.error;
  return typeof error === 'string' && ERROR_CODE.test(error)
    ? error
    : httpError(status);
}

function transportErrorCode(error: unknown): string {
  return error instanceof ProcessingMediaTransportError
    ? error.code
    : 'processing_transport_unavailable';
}

function unknown(commandId: string, errorCode: string): MediaTransportOutcome {
  return {
    state: 'unknown',
    command_id: commandId,
    error_code: errorCode,
    retryable: true
  };
}
