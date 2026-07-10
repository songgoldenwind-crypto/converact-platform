/**
 * Production IVR ↔ RustPBX bridge: subscribes to ivr_bot, answers inbound calls,
 * dispatches ivr-rwi-bridge commands and feeds DTMF events back into advance.
 */

import { findSessionByRustpbxCallId } from '../call-center/outbound-dialer.js';
import { RwiV1Client, readRwiV1Config } from '../call-center/rwi-v1-client.js';
import type { VoiceStore } from '../voice/voice-store.js';
import { buildLiveIvrStepInput } from './ivr-live-input.js';
import { IvrSessionStore } from './ivr-session-store.js';
import { advanceIvrStep } from './ivr-inbound-routing.js';
import { ivrActionToRwi, type RwiCommandEnvelope } from './ivr-rwi-bridge.js';
import { walkToPromptableAction } from './ivr-runtime.js';

const IVR_CONTEXT = process.env.OPC_IVR_RWI_CONTEXT || 'ivr_bot';

let client: RwiV1Client | null = null;
let started = false;

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

function readDtmfEvent(message: Record<string, unknown>): { callId: string; digits?: string; timedOut?: boolean } | null {
  const collected = message.dtmf_collected;
  if (collected && typeof collected === 'object') {
    const row = collected as Record<string, unknown>;
    const callId = String(row.call_id || '');
    const digits = String(row.digits || '');
    if (callId && digits) return { callId, digits };
  }
  const timeout = message.dtmf_collection_timeout;
  if (timeout && typeof timeout === 'object') {
    const callId = String((timeout as Record<string, unknown>).call_id || '');
    if (callId) return { callId, timedOut: true };
  }
  return null;
}

async function dispatchRwi(
  db: unknown,
  rustpbxCallId: string,
  tenantId: string,
  callSessionId: string,
  envelope: RwiCommandEnvelope | null
): Promise<void> {
  if (!envelope || !client?.isConnected()) return;

  const params = { ...envelope.params, call_id: rustpbxCallId };
  try {
    client.sendLegacyCommand(envelope.command, params);
    console.info('[ivr-rwi] sent', envelope.command, 'rustpbx_call=', rustpbxCallId, 'opc_session=', callSessionId);
  } catch (error) {
    console.warn('[ivr-rwi] command failed:', error instanceof Error ? error.message : error);
  }

  if (envelope.command === 'hangup') {
    try {
      client.hangup(rustpbxCallId);
    } catch {
      /* best-effort */
    }
  }
}

async function handleIncomingCall(db: unknown, rustpbxCallId: string): Promise<void> {
  if (!client?.isConnected()) return;

  const voiceRow = findSessionByRustpbxCallId(db, rustpbxCallId);
  if (!voiceRow) {
    console.warn('[ivr-rwi] call_incoming without voice session', rustpbxCallId);
    return;
  }

  const tenantId = String(voiceRow.tenant_id);
  const callSessionId = String(voiceRow.id);

  try {
    client.answer(rustpbxCallId);
  } catch (error) {
    console.warn('[ivr-rwi] answer failed:', error instanceof Error ? error.message : error);
    return;
  }

  const ivrStore = new IvrSessionStore(db);
  const stored = ivrStore.get(callSessionId, tenantId);
  if (!stored) {
    console.warn('[ivr-rwi] no ivr session for', callSessionId);
    return;
  }

  const walked = await walkToPromptableAction(
    stored.context,
    buildLiveIvrStepInput(db, tenantId, { callSessionId })
  );

  ivrStore.upsert({
    callSessionId,
    tenantId,
    flowId: stored.flow_id,
    context: walked.context,
    stepCount: stored.step_count,
    terminated: walked.terminated,
    lastAction: walked.action,
  });

  const envelope = walked.action ? ivrActionToRwi(walked.action, rustpbxCallId) : null;
  await dispatchRwi(db, rustpbxCallId, tenantId, callSessionId, envelope);
}

async function handleDtmf(
  db: unknown,
  event: { callId: string; digits?: string; timedOut?: boolean }
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
    dtmf: event.digits,
    timedOut: event.timedOut,
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
  });

  const envelope = step.action ? ivrActionToRwi(step.action, event.callId) : null;
  await dispatchRwi(db, event.callId, tenantId, callSessionId, envelope);
}

export async function startIvrRwiRuntime(db: unknown, _voiceStore: VoiceStore): Promise<void> {
  if (started || process.env.OPC_DISABLE_IVR_RWI === '1') return;

  const config = readRwiV1Config();
  if (!config.url) {
    console.warn('[ivr-rwi] RUSTPBX_RWI_URL not set; IVR media bridge disabled');
    return;
  }

  client = new RwiV1Client({ url: config.url, authToken: config.authToken });
  client.onMessage((message) => {
    void (async () => {
      const callId = extractRustpbxCallId(message);
      if (isIncomingCallEvent(message) && callId) {
        await handleIncomingCall(db, callId);
        return;
      }
      const dtmf = readDtmfEvent(message);
      if (dtmf) {
        await handleDtmf(db, dtmf);
      }
    })().catch((error) => {
      console.warn('[ivr-rwi] event error:', error instanceof Error ? error.message : error);
    });
  });

  await client.connect();
  client.subscribe([IVR_CONTEXT]);
  started = true;
  console.info('[ivr-rwi] subscribed to context', IVR_CONTEXT, 'at', config.url);
}

export function stopIvrRwiRuntime(): void {
  client?.disconnect();
  client = null;
  started = false;
}
