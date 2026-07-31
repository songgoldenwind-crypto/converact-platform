import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rustDeskGatewayEventValidationError } from '../src/agent-runtime/collaboration/rustdesk-gateway-event.js';

export interface RustDeskForwardEventInput {
  external_id?: string;
  event_type: string;
  actor_identity?: string;
  target?: string;
  idempotency_key?: string;
  metadata?: Record<string, unknown>;
  occurred_at?: string;
}

export interface RustDeskEventForwarderConfig {
  baseUrl: string;
  apiToken: string;
  defaultExternalId: string;
  defaultActorIdentity: string;
  validateOnly?: boolean;
  retryAttempts?: number;
  retryDelayMs?: number;
  deadLetterFile?: string;
  replayDeadLetterFile?: string;
  replayRemainingFile?: string;
  inlineEvent?: RustDeskForwardEventInput;
  eventFile?: string;
  templateFile?: string;
  templateTarget?: string;
  templateOccurredAt?: string;
}

export interface RustDeskEventForwarderResult {
  forwarded: number;
  validated?: number;
  generated?: number;
  mode?: 'validate-only' | 'template';
  events: string[];
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type SleepLike = (delayMs: number) => Promise<void>;
interface LoadedRustDeskForwardEvent {
  input: RustDeskForwardEventInput;
  previousAttempts: number;
}

interface PreparedRustDeskForwardEvent {
  externalId: string;
  eventType: string;
  body: Record<string, unknown>;
}

export function createRustDeskEventForwarderConfigFromEnv(env: NodeJS.ProcessEnv): RustDeskEventForwarderConfig {
  const rawBaseUrl = env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL || env.OPC_REMOTE_GATEWAY_BASE_URL || env.OPC_BASE_URL || '';
  const baseUrlEnvName = env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL
    ? 'OPC_RUSTDESK_CONTROL_PLANE_BASE_URL'
    : env.OPC_REMOTE_GATEWAY_BASE_URL
      ? 'OPC_REMOTE_GATEWAY_BASE_URL'
      : 'OPC_BASE_URL';
  const apiToken = String(env.OPC_RUSTDESK_API_TOKEN || env.OPC_REMOTE_GATEWAY_API_TOKEN || '').trim();
  const defaultExternalId = String(env.OPC_RUSTDESK_EVENT_EXTERNAL_ID || '').trim();
  const defaultActorIdentity = String(env.OPC_RUSTDESK_EVENT_ACTOR_IDENTITY || 'rustdesk-event-forwarder').trim();
  const eventType = String(env.OPC_RUSTDESK_EVENT_TYPE || '').trim();
  const eventFile = String(env.OPC_RUSTDESK_EVENT_FILE || '').trim();
  const deadLetterFile = String(env.OPC_RUSTDESK_EVENT_DEAD_LETTER_FILE || '').trim();
  const replayDeadLetterFile = String(env.OPC_RUSTDESK_EVENT_REPLAY_DEAD_LETTER_FILE || '').trim();
  const replayRemainingFile = String(env.OPC_RUSTDESK_EVENT_REPLAY_REMAINING_FILE || '').trim();
  const validateOnly = booleanFlag(env.OPC_RUSTDESK_EVENT_VALIDATE_ONLY, 'OPC_RUSTDESK_EVENT_VALIDATE_ONLY');
  const templateFile = String(env.OPC_RUSTDESK_EVENT_TEMPLATE_FILE || '').trim();

  const hasBaseUrl = Boolean(stripTrailingSlash(rawBaseUrl));
  if (!hasBaseUrl && !validateOnly && !templateFile) {
    throw new Error('OPC_RUSTDESK_CONTROL_PLANE_BASE_URL or OPC_REMOTE_GATEWAY_BASE_URL is required');
  }
  const baseUrl = hasBaseUrl ? normalizeHttpBaseUrl(rawBaseUrl, baseUrlEnvName) : '';
  if (!apiToken && !validateOnly && !templateFile) throw new Error('OPC_RUSTDESK_API_TOKEN or OPC_REMOTE_GATEWAY_API_TOKEN is required');
  if (!defaultExternalId && !replayDeadLetterFile && !(validateOnly && eventFile) && !templateFile) {
    throw new Error('OPC_RUSTDESK_EVENT_EXTERNAL_ID is required');
  }

  return {
    baseUrl,
    apiToken,
    defaultExternalId,
    defaultActorIdentity,
    validateOnly,
    retryAttempts: nonNegativeInteger(env.OPC_RUSTDESK_EVENT_RETRY_ATTEMPTS, 'OPC_RUSTDESK_EVENT_RETRY_ATTEMPTS', 2),
    retryDelayMs: nonNegativeInteger(env.OPC_RUSTDESK_EVENT_RETRY_DELAY_MS, 'OPC_RUSTDESK_EVENT_RETRY_DELAY_MS', 1000),
    deadLetterFile: deadLetterFile || undefined,
    replayDeadLetterFile: replayDeadLetterFile || undefined,
    replayRemainingFile: replayRemainingFile || undefined,
    eventFile: eventFile || undefined,
    templateFile: templateFile || undefined,
    templateTarget: optionalString(env.OPC_RUSTDESK_EVENT_TEMPLATE_TARGET || env.OPC_RUSTDESK_EVENT_TARGET),
    templateOccurredAt: optionalString(env.OPC_RUSTDESK_EVENT_TEMPLATE_OCCURRED_AT || env.OPC_RUSTDESK_EVENT_OCCURRED_AT),
    inlineEvent: eventType
      ? compactEvent({
        external_id: defaultExternalId,
        event_type: eventType,
        actor_identity: defaultActorIdentity,
        target: optionalString(env.OPC_RUSTDESK_EVENT_TARGET),
        idempotency_key: optionalString(env.OPC_RUSTDESK_EVENT_IDEMPOTENCY_KEY),
        metadata: parseMetadata(env.OPC_RUSTDESK_EVENT_METADATA_JSON),
        occurred_at: optionalString(env.OPC_RUSTDESK_EVENT_OCCURRED_AT)
      })
      : undefined
  };
}

export async function forwardRustDeskEvents(
  config: RustDeskEventForwarderConfig,
  fetchImpl: FetchLike = fetch,
  sleepImpl: SleepLike = sleep
): Promise<RustDeskEventForwarderResult> {
  const events = loadEvents(config);
  if (!events.length) {
    throw new Error(
      'RustDesk event forwarder requires an inline event, OPC_RUSTDESK_EVENT_FILE, or OPC_RUSTDESK_EVENT_REPLAY_DEAD_LETTER_FILE'
    );
  }
  if (config.validateOnly) {
    const validated = events.map((event) => prepareEvent(config, event.input).eventType);
    return {
      forwarded: 0,
      validated: validated.length,
      mode: 'validate-only',
      events: validated
    };
  }
  const forwarded: string[] = [];
  const replayFailures: Array<{ input: RustDeskForwardEventInput; error: unknown; previousAttempts: number }> = [];
  for (const event of events) {
    try {
      await postEvent(config, event.input, fetchImpl, sleepImpl);
    } catch (error) {
      if (config.replayDeadLetterFile) {
        replayFailures.push({ input: event.input, error, previousAttempts: event.previousAttempts });
        continue;
      }
      writeDeadLetter(config, event.input, error);
      throw error;
    }
    forwarded.push(event.input.event_type);
  }
  if (config.replayDeadLetterFile) {
    writeReplayRemaining(config, replayFailures);
    if (replayFailures.length) {
      throw new Error(`RustDesk dead-letter replay failed: ${replayFailures.length} of ${events.length} events`);
    }
  }
  return {
    forwarded: forwarded.length,
    events: forwarded
  };
}

export function writeRustDeskEventTemplate(config: RustDeskEventForwarderConfig): RustDeskEventForwarderResult {
  if (!config.templateFile) throw new Error('OPC_RUSTDESK_EVENT_TEMPLATE_FILE is required');
  const events = rustDeskEventTemplateEvents(config);
  const eventTypes = events.map((event) => prepareEvent(config, event).eventType);
  mkdirSync(dirname(config.templateFile), { recursive: true });
  writeFileSync(config.templateFile, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  return {
    forwarded: 0,
    generated: events.length,
    mode: 'template',
    events: eventTypes
  };
}

function loadEvents(config: RustDeskEventForwarderConfig): LoadedRustDeskForwardEvent[] {
  const events: LoadedRustDeskForwardEvent[] = [];
  if (config.inlineEvent) events.push({ input: config.inlineEvent, previousAttempts: 0 });
  if (config.eventFile) {
    const content = readFileSync(config.eventFile, 'utf8');
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      events.push({
        input: parseJsonLine<RustDeskForwardEventInput>(
          trimmed,
          'OPC_RUSTDESK_EVENT_FILE',
          config.eventFile,
          index + 1
        ),
        previousAttempts: 0
      });
    }
  }
  if (config.replayDeadLetterFile) {
    const content = readFileSync(config.replayDeadLetterFile, 'utf8');
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const row = parseJsonLine<Record<string, unknown>>(
        trimmed,
        'OPC_RUSTDESK_EVENT_REPLAY_DEAD_LETTER_FILE',
        config.replayDeadLetterFile,
        index + 1
      );
      events.push({
        input: deadLetterEvent(row),
        previousAttempts: deadLetterAttempts(
          row,
          'OPC_RUSTDESK_EVENT_REPLAY_DEAD_LETTER_FILE',
          config.replayDeadLetterFile,
          index + 1
        )
      });
    }
  }
  return events;
}

function parseJsonLine<T>(line: string, envName: string, filePath: string, lineNumber: number): T {
  try {
    return JSON.parse(line) as T;
  } catch (error) {
    throw new Error(`${envName} invalid JSON at ${filePath}:${lineNumber}: ${errorMessage(error)}`);
  }
}

async function postEvent(
  config: RustDeskEventForwarderConfig,
  input: RustDeskForwardEventInput,
  fetchImpl: FetchLike,
  sleepImpl: SleepLike
): Promise<void> {
  if (!stripTrailingSlash(config.baseUrl)) throw new Error('RustDesk event forwarder baseUrl is required');
  if (!String(config.apiToken || '').trim()) throw new Error('RustDesk event forwarder apiToken is required');
  const prepared = prepareEvent(config, input);
  const maxRetries = Math.max(0, Math.floor(config.retryAttempts ?? 2));
  const retryDelayMs = Math.max(0, Math.floor(config.retryDelayMs ?? 1000));
  let retryCount = 0;
  while (true) {
    let response: Response;
    try {
      response = await fetchImpl(
        `${config.baseUrl}/api/opc/rustdesk/sessions/${encodeURIComponent(prepared.externalId)}/events`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiToken}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify(prepared.body)
        }
      );
    } catch (error) {
      if (retryCount >= maxRetries) {
        throw forwardFailure(
          `RustDesk event forward failed: ${prepared.eventType} ${(error as Error).message}`,
          retryCount + 1
        );
      }
      retryCount += 1;
      await sleepImpl(retryDelayMs);
      continue;
    }
    if (response.ok) return;
    if (!isRetryableStatus(response.status) || retryCount >= maxRetries) {
      const detail = await responseErrorDetail(response);
      throw forwardFailure(
        `RustDesk event forward failed: ${prepared.eventType} ${response.status}${detail ? ` ${detail}` : ''}`,
        retryCount + 1
      );
    }
    retryCount += 1;
    await sleepImpl(retryDelayMs);
  }
}

function prepareEvent(
  config: RustDeskEventForwarderConfig,
  input: RustDeskForwardEventInput
): PreparedRustDeskForwardEvent {
  const externalId = String(input.external_id || config.defaultExternalId || '').trim();
  const eventType = String(input.event_type || '').trim();
  if (!externalId) throw new Error('RustDesk event external_id is required');
  if (!eventType) throw new Error('RustDesk event_type is required');
  const metadata = eventMetadata(input.metadata);
  const eventValidationError = rustDeskGatewayEventValidationError(eventType, metadata);
  if (eventValidationError) throw new Error(eventValidationError);
  const idempotencyKey = optionalStringValue(input.idempotency_key) || derivedIdempotencyKey(eventType, metadata);
  return {
    externalId,
    eventType,
    body: {
      event_type: eventType,
      actor_identity: String(input.actor_identity || config.defaultActorIdentity || 'rustdesk-event-forwarder'),
      ...(input.target ? { target: input.target } : {}),
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      metadata,
      ...(input.occurred_at ? { occurred_at: input.occurred_at } : {})
    }
  };
}

function rustDeskEventTemplateEvents(config: RustDeskEventForwarderConfig): RustDeskForwardEventInput[] {
  const externalId = config.defaultExternalId || 'rdgw_example';
  const actorIdentity = config.defaultActorIdentity || 'rustdesk-event-forwarder';
  const target = config.templateTarget || '123456789';
  const occurredAt = config.templateOccurredAt || '2026-07-06T00:00:00.000Z';
  const baseEvent = {
    external_id: externalId,
    actor_identity: actorIdentity,
    target,
    occurred_at: occurredAt
  };
  return [
    {
      ...baseEvent,
      event_type: 'remote.rustdesk.control_action.performed',
      metadata: {
        operation_id: 'operation-example-1',
        action: 'mouse_click',
        permission: 'control_mouse_keyboard',
        button: 'left'
      }
    },
    {
      ...baseEvent,
      event_type: 'remote.rustdesk.file_transfer.started',
      metadata: {
        transfer_id: 'transfer-example-1',
        direction: 'upload',
        file_name: 'example.txt',
        bytes: 1024
      }
    },
    {
      ...baseEvent,
      event_type: 'remote.rustdesk.file_transfer.completed',
      metadata: {
        transfer_id: 'transfer-example-1',
        direction: 'upload',
        file_name: 'example.txt',
        bytes: 1024,
        status: 'completed'
      }
    },
    {
      ...baseEvent,
      event_type: 'remote.rustdesk.recording.started',
      metadata: {
        recording_id: 'recording-example-1',
        evidence_type: 'screen_recording'
      }
    },
    {
      ...baseEvent,
      event_type: 'remote.rustdesk.recording.stopped',
      metadata: {
        recording_id: 'recording-example-1',
        evidence_type: 'screen_recording',
        duration_ms: 30000
      }
    },
    {
      ...baseEvent,
      event_type: 'remote.rustdesk.clipboard.synced',
      metadata: {
        clipboard_id: 'clipboard-example-1',
        direction: 'agent_to_device'
      }
    }
  ];
}

async function responseErrorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  if (!text) return '';
  try {
    const payload = JSON.parse(text) as Record<string, unknown>;
    const detail = payload.error || payload.message || payload.detail;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
  } catch {
    // Fall through to raw text for non-JSON upstream errors.
  }
  return text.slice(0, 500);
}

function writeDeadLetter(
  config: RustDeskEventForwarderConfig,
  input: RustDeskForwardEventInput,
  error: unknown
): void {
  if (!config.deadLetterFile) return;
  mkdirSync(dirname(config.deadLetterFile), { recursive: true });
  appendFileSync(
    config.deadLetterFile,
    `${JSON.stringify({
      error: errorMessage(error),
      attempts: errorAttempts(error),
      event: failedEvent(config, input)
    })}\n`,
    'utf8'
  );
}

function writeReplayRemaining(
  config: RustDeskEventForwarderConfig,
  failures: Array<{ input: RustDeskForwardEventInput; error: unknown; previousAttempts: number }>
): void {
  if (!config.replayRemainingFile) return;
  mkdirSync(dirname(config.replayRemainingFile), { recursive: true });
  const content = failures.map((failure) => JSON.stringify({
    error: errorMessage(failure.error),
    attempts: failure.previousAttempts + errorAttempts(failure.error),
    event: failedEvent(config, failure.input)
  })).join('\n');
  writeFileSync(config.replayRemainingFile, content ? `${content}\n` : '', 'utf8');
}

function deadLetterEvent(row: Record<string, unknown>): RustDeskForwardEventInput {
  const event = ((row.event || {}) as Record<string, unknown>);
  return compactEvent({
    external_id: optionalStringValue(event.external_id),
    event_type: String(event.event_type || ''),
    actor_identity: optionalStringValue(event.actor_identity),
    target: optionalStringValue(event.target),
    idempotency_key: optionalStringValue(event.idempotency_key),
    metadata: recordValue(event.metadata),
    occurred_at: optionalStringValue(event.occurred_at)
  });
}

function deadLetterAttempts(row: Record<string, unknown>, envName: string, filePath: string, lineNumber: number): number {
  if (row.attempts === undefined || row.attempts === null) return 0;
  const attempts = Number(row.attempts);
  if (!Number.isInteger(attempts) || attempts < 0) {
    throw new Error(`${envName} attempts must be a non-negative integer at ${filePath}:${lineNumber}`);
  }
  return attempts;
}

function failedEvent(
  config: RustDeskEventForwarderConfig,
  input: RustDeskForwardEventInput
): Record<string, unknown> {
  const eventType = String(input.event_type || '').trim();
  const metadata = recordValue(input.metadata);
  const idempotencyKey = optionalStringValue(input.idempotency_key) || derivedIdempotencyKey(eventType, metadata);
  return Object.fromEntries(
    Object.entries({
      external_id: String(input.external_id || config.defaultExternalId || '').trim(),
      event_type: eventType,
      actor_identity: String(input.actor_identity || config.defaultActorIdentity || 'rustdesk-event-forwarder'),
      target: input.target,
      idempotency_key: idempotencyKey,
      metadata,
      occurred_at: input.occurred_at,
      failed_at: new Date().toISOString()
    }).filter((entry) => entry[1] !== undefined)
  );
}

function forwardFailure(message: string, attempts: number): Error {
  return Object.assign(new Error(message), { attempts });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorAttempts(error: unknown): number {
  const attempts = Number((error as { attempts?: unknown })?.attempts);
  return Number.isFinite(attempts) && attempts >= 0 ? Math.floor(attempts) : 1;
}

function parseMetadata(value: string | undefined): Record<string, unknown> {
  if (!value || !value.trim()) return {};
  try {
    return eventMetadata(JSON.parse(value) as unknown, 'OPC_RUSTDESK_EVENT_METADATA_JSON must be a JSON object');
  } catch {
    throw new Error('OPC_RUSTDESK_EVENT_METADATA_JSON must be a JSON object');
  }
}

function eventMetadata(
  value: unknown,
  message = 'RustDesk event metadata must be a JSON object'
): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error(message);
}

function derivedIdempotencyKey(eventType: string, metadata: Record<string, unknown>): string | undefined {
  if (eventType === 'remote.rustdesk.operation.observed') {
    const operationId = optionalStringValue(metadata.operation_id);
    const status = optionalStringValue(metadata.status);
    return operationId && status ? `rustdesk-observation:${operationId}:${status}` : undefined;
  }
  if (eventType === 'remote.rustdesk.control_action.performed') {
    return knownEventKey('control-action', metadata.operation_id);
  }
  if (
    eventType === 'remote.rustdesk.file_transfer.started' ||
    eventType === 'remote.rustdesk.file_transfer.completed' ||
    eventType === 'remote.rustdesk.file_transfer.failed'
  ) {
    return knownEventKey('file-transfer', metadata.transfer_id);
  }
  if (
    eventType === 'remote.rustdesk.recording.started' ||
    eventType === 'remote.rustdesk.recording.stopped' ||
    eventType === 'remote.rustdesk.recording.failed'
  ) {
    return knownEventKey('recording', metadata.recording_id);
  }
  if (eventType === 'remote.rustdesk.clipboard.synced') {
    return knownEventKey('clipboard', metadata.clipboard_id);
  }
  return undefined;
}

function knownEventKey(kind: string, value: unknown): string | undefined {
  const id = optionalStringValue(value);
  return id ? `rustdesk-event:${kind}:${id}` : undefined;
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim();
  return trimmed || undefined;
}

function optionalStringValue(value: unknown): string | undefined {
  const trimmed = String(value || '').trim();
  return trimmed || undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function compactEvent(input: RustDeskForwardEventInput): RustDeskForwardEventInput {
  return Object.fromEntries(
    Object.entries(input).filter((entry) => entry[1] !== undefined)
  ) as RustDeskForwardEventInput;
}

function stripTrailingSlash(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

function normalizeHttpBaseUrl(value: string, envName: string): string {
  const baseUrl = stripTrailingSlash(value);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`${envName} must be a valid URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${envName} must use http(s)`);
  }
  return baseUrl;
}

function nonNegativeInteger(value: string | undefined, envName: string, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${envName} must be a non-negative integer`);
  }
  return parsed;
}

function booleanFlag(value: string | undefined, envName: string): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return false;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${envName} must be one of 1, 0, true, false, yes, no, on, off`);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function main(): Promise<void> {
  const config = createRustDeskEventForwarderConfigFromEnv(process.env);
  const result = config.templateFile
    ? writeRustDeskEventTemplate(config)
    : await forwardRustDeskEvents(config);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
