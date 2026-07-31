import { resolveBrandEnv } from '../../config/converact-env.js';
/**
 * Production IVR ↔ RustPBX bridge: subscribes to ivr_bot, answers inbound calls,
 * dispatches ivr-rwi-bridge commands and feeds DTMF events back into advance.
 */

import { findSessionByRustpbxCallId } from '../call-center/outbound-dialer.js';
import { RwiV1Client, readRwiV1Config } from '../call-center/rwi-v1-client.js';
import type { VoiceStore } from '../voice/voice-store.js';
import { IvrSessionStore } from './ivr-session-store.js';
import { advanceIvrStep } from './ivr-inbound-routing.js';
import { ivrActionToRwi, type RwiCommandEnvelope } from './ivr-rwi-bridge.js';
import type { IvrStepInput } from './ivr-executor.js';

const IVR_CONTEXT = resolveBrandEnv(process.env, 'IVR_RWI_CONTEXT') || 'ivr_bot';

let client: RwiV1Client | null = null;
let started = false;
let eventQueue: IvrRwiSerialQueue | null = null;

export interface RwiV1ControlPort {
  isConnected(): boolean;
  answer(callId: string): string;
  hangup(callId: string, reason?: string): string;
  sendLegacyCommand(command: string, params: Record<string, unknown>): string;
}

export type IvrRwiQueueResult = 'accepted' | 'duplicate' | 'overloaded' | 'closed';

export class IvrRwiSerialQueue {
  private readonly maxPending: number;
  private readonly maxPendingPerCall: number;
  private readonly maxRecentEvents: number;
  private readonly onError: (error: unknown, callId: string) => void;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pendingByCall = new Map<string, number>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly queuedEventIds = new Set<string>();
  private readonly recentEventIds = new Map<string, true>();
  private pending = 0;
  private closed = false;

  constructor(options: {
    maxPending?: number;
    maxPendingPerCall?: number;
    maxRecentEvents?: number;
    onError?: (error: unknown, callId: string) => void;
  } = {}) {
    this.maxPending = positiveInteger(options.maxPending, 4096);
    this.maxPendingPerCall = positiveInteger(options.maxPendingPerCall, 32);
    this.maxRecentEvents = positiveInteger(options.maxRecentEvents, 16384);
    this.onError = options.onError ?? ((error, callId) => {
      console.warn(
        '[ivr-rwi] event error:',
        callId,
        error instanceof Error ? error.message.slice(0, 500) : 'unknown error'
      );
    });
  }

  enqueue(callId: string, task: () => Promise<void>, eventId?: string): boolean {
    return this.enqueueWithResult(callId, task, eventId) === 'accepted';
  }

  enqueueWithResult(callId: string, task: () => Promise<void>, eventId?: string): IvrRwiQueueResult {
    if (this.closed) return 'closed';
    const eventKey = eventId ? `${callId}:${eventId}` : '';
    if (eventKey && (this.queuedEventIds.has(eventKey) || this.recentEventIds.has(eventKey))) {
      return 'duplicate';
    }
    const callPending = this.pendingByCall.get(callId) ?? 0;
    if (this.pending >= this.maxPending || callPending >= this.maxPendingPerCall) {
      return 'overloaded';
    }

    this.pending += 1;
    this.pendingByCall.set(callId, callPending + 1);
    if (eventKey) this.queuedEventIds.add(eventKey);
    const previous = this.tails.get(callId) ?? Promise.resolve();
    let succeeded = false;
    let current!: Promise<void>;
    current = previous
      .catch(() => undefined)
      .then(task)
      .then(() => { succeeded = true; })
      .catch((error) => { this.onError(error, callId); })
      .finally(() => {
        this.pending -= 1;
        const remaining = (this.pendingByCall.get(callId) ?? 1) - 1;
        if (remaining > 0) this.pendingByCall.set(callId, remaining);
        else this.pendingByCall.delete(callId);
        if (this.tails.get(callId) === current) this.tails.delete(callId);
        this.tasks.delete(current);
        if (eventKey) {
          this.queuedEventIds.delete(eventKey);
          if (succeeded) this.rememberEvent(eventKey);
        }
      });
    this.tails.set(callId, current);
    this.tasks.add(current);
    return 'accepted';
  }

  close(): void {
    this.closed = true;
  }

  async drain(): Promise<void> {
    while (this.tasks.size > 0) {
      await Promise.allSettled([...this.tasks]);
    }
  }

  private rememberEvent(eventKey: string): void {
    this.recentEventIds.set(eventKey, true);
    while (this.recentEventIds.size > this.maxRecentEvents) {
      const oldest = this.recentEventIds.keys().next().value as string | undefined;
      if (!oldest) break;
      this.recentEventIds.delete(oldest);
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function extractRustpbxCallId(message: Record<string, unknown>): string | null {
  for (const key of ['call_incoming', 'call.incoming', 'call_ringing', 'dtmf_collected', 'dtmf_collection_timeout', 'media_play_finished']) {
    const nested = message[key];
    if (nested && typeof nested === 'object' && nested !== null) {
      const callId = (nested as Record<string, unknown>).call_id;
      if (typeof callId === 'string' && callId) return callId;
    }
  }
  if (typeof message.call_id === 'string' && message.call_id) return message.call_id;
  const data = message.data;
  if (data && typeof data === 'object' && data !== null) {
    const callId = (data as Record<string, unknown>).call_id;
    if (typeof callId === 'string' && callId) return callId;
  }
  return null;
}

function isIncomingCallEvent(message: Record<string, unknown>): boolean {
  return message.call_incoming != null || message.event === 'call.incoming';
}

export interface IvrRwiMediaEvent {
  callId: string;
  eventId?: string;
  input: IvrStepInput;
}

export function readIvrRwiMediaEvent(message: Record<string, unknown>): IvrRwiMediaEvent | null {
  const collected = message.dtmf_collected;
  if (collected && typeof collected === 'object') {
    const row = collected as Record<string, unknown>;
    const callId = String(row.call_id || '');
    const digits = String(row.digits || '');
    if (callId && digits) return {
      callId,
      eventId: eventIdentity(message, row, 'dtmf_collected'),
      input: { dtmf: digits },
    };
  }
  const timeout = message.dtmf_collection_timeout;
  if (timeout && typeof timeout === 'object') {
    const row = timeout as Record<string, unknown>;
    const callId = String(row.call_id || '');
    if (callId) return {
      callId,
      eventId: eventIdentity(message, row, 'dtmf_collection_timeout'),
      input: { timedOut: true },
    };
  }
  const playFinished = message.media_play_finished;
  if (playFinished && typeof playFinished === 'object') {
    const row = playFinished as Record<string, unknown>;
    const callId = String(row.call_id || '');
    if (callId) return {
      callId,
      eventId: eventIdentity(message, row, 'media_play_finished'),
      input: { playCompleted: true },
    };
  }
  return null;
}

function eventIdentity(
  message: Record<string, unknown>,
  nested: Record<string, unknown>,
  kind: string
): string | undefined {
  for (const key of ['event_id', 'action_id', 'sequence', 'event_sequence']) {
    const value = nested[key] ?? message[key];
    if (typeof value === 'string' && value) return `${kind}:${value}`;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return `${kind}:${value}`;
  }
  return undefined;
}

async function dispatchRwi(
  rwi: RwiV1ControlPort,
  rustpbxCallId: string,
  callSessionId: string,
  envelope: RwiCommandEnvelope | null
): Promise<boolean> {
  if (!envelope || !rwi.isConnected()) return false;

  const params = { ...envelope.params, call_id: rustpbxCallId };
  try {
    if (envelope.command === 'hangup') rwi.hangup(rustpbxCallId);
    else rwi.sendLegacyCommand(envelope.command, params);
    console.info('[ivr-rwi] sent', envelope.command, 'rustpbx_call=', rustpbxCallId, 'opc_session=', callSessionId);
    return true;
  } catch (error) {
    console.warn('[ivr-rwi] command failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

export async function handleIncomingIvrCall(
  db: unknown,
  rustpbxCallId: string,
  rwi: RwiV1ControlPort
): Promise<'dispatched' | 'rwi_unavailable' | 'voice_session_missing' | 'ivr_unavailable' | 'dispatch_failed'> {
  if (!rwi.isConnected()) return 'rwi_unavailable';

  const voiceRow = findSessionByRustpbxCallId(db, rustpbxCallId);
  if (!voiceRow) {
    console.warn('[ivr-rwi] call_incoming without voice session', rustpbxCallId);
    return 'voice_session_missing';
  }

  const tenantId = String(voiceRow.tenant_id);
  const callSessionId = String(voiceRow.id);

  const ivrStore = new IvrSessionStore(db);
  const stored = ivrStore.get(callSessionId, tenantId);
  const envelope = stored?.last_action && !stored.terminated
    ? ivrActionToRwi(stored.last_action, rustpbxCallId)
    : null;
  if (!stored || !envelope) {
    console.warn('[ivr-rwi] no executable ivr session for', callSessionId);
    try { rwi.hangup(rustpbxCallId, 'ivr_unavailable'); } catch { /* fail closed */ }
    return 'ivr_unavailable';
  }

  try {
    rwi.answer(rustpbxCallId);
  } catch (error) {
    console.warn('[ivr-rwi] answer failed:', error instanceof Error ? error.message : error);
    return 'dispatch_failed';
  }
  if (await dispatchRwi(rwi, rustpbxCallId, callSessionId, envelope)) return 'dispatched';
  try { rwi.hangup(rustpbxCallId, 'ivr_dispatch_failed'); } catch { /* fail closed */ }
  return 'dispatch_failed';
}

async function handleMediaEvent(
  db: unknown,
  event: IvrRwiMediaEvent,
  rwi: RwiV1ControlPort
): Promise<void> {
  const voiceRow = findSessionByRustpbxCallId(db, event.callId);
  if (!voiceRow) return;

  const tenantId = String(voiceRow.tenant_id);
  const callSessionId = String(voiceRow.id);

  const ivrStore = new IvrSessionStore(db);
  const stored = ivrStore.get(callSessionId, tenantId);
  if (!stored || stored.terminated) return;

  const state = {
    callSessionId,
    tenantId,
    flowId: stored.flow_id,
    context: stored.context,
    stepCount: stored.step_count,
    terminated: Boolean(stored.terminated),
    lastAction: stored.last_action,
  };

  const step = await advanceIvrStep(state, db, {
    ...event.input,
    callSessionId,
  });

  ivrStore.upsert({
    callSessionId,
    tenantId,
    flowId: step.state.flowId,
    context: step.state.context,
    stepCount: step.state.stepCount,
    terminated: step.terminated,
    lastAction: step.action,
    expectedRevision: stored.revision,
  });

  const envelope = step.action ? ivrActionToRwi(step.action, event.callId) : null;
  await dispatchRwi(rwi, event.callId, callSessionId, envelope);
}

export async function startIvrRwiRuntime(db: unknown, _voiceStore: VoiceStore): Promise<void> {
  if (started || resolveBrandEnv(process.env, 'DISABLE_IVR_RWI') === '1') return;

  const config = readRwiV1Config();
  if (!config.url) {
    console.warn('[ivr-rwi] RUSTPBX_RWI_URL not set; IVR media bridge disabled');
    return;
  }

  client = new RwiV1Client({ url: config.url, authToken: config.authToken });
  eventQueue = new IvrRwiSerialQueue({
    maxPending: Number(resolveBrandEnv(process.env, 'IVR_RWI_MAX_PENDING') || 4096),
    maxPendingPerCall: Number(resolveBrandEnv(process.env, 'IVR_RWI_MAX_PENDING_PER_CALL') || 32),
  });
  client.onMessage((message) => {
    const callId = extractRustpbxCallId(message);
    if (!callId || !client || !eventQueue) return;
    const incoming = isIncomingCallEvent(message);
    const mediaEvent = readIvrRwiMediaEvent(message);
    if (!incoming && !mediaEvent) return;
    const eventId = mediaEvent?.eventId ?? (incoming ? 'call_incoming' : undefined);
    const queueResult = eventQueue.enqueueWithResult(callId, async () => {
      if (!client) return;
      if (incoming) {
        await handleIncomingIvrCall(db, callId, client);
        return;
      }
      if (mediaEvent) await handleMediaEvent(db, mediaEvent, client);
    }, eventId);
    if (queueResult === 'overloaded') {
      console.error('[ivr-rwi] event queue overloaded; failing call closed', callId);
      try { client.hangup(callId, 'ivr_event_overload'); } catch { /* fail closed */ }
    }
  });

  await client.connect();
  client.subscribe([IVR_CONTEXT]);
  started = true;
  console.info('[ivr-rwi] subscribed to context', IVR_CONTEXT, 'at', config.url);
}

export function stopIvrRwiRuntime(): void {
  eventQueue?.close();
  eventQueue = null;
  client?.disconnect();
  client = null;
  started = false;
}
