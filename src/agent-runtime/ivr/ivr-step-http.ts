/**
 * RustPBX Step IVR HTTP Provider — /api/ivr/rustpbx/step (+ /start, /end).
 */

import { verifyRustpbxWebhookKey } from '../call-center/application.js';
import { findSessionByRustpbxCallId } from '../call-center/outbound-dialer.js';
import { advanceIvrStep } from './ivr-inbound-routing.js';
import { buildLiveIvrStepInput } from './ivr-live-input.js';
import { IvrSessionStore } from './ivr-session-store.js';
import {
  advanceRuntimeStep,
  shouldAutoWalkAfterAdvance,
  walkToPromptableAction,
} from './ivr-runtime.js';
import { stripWalkConsumerInput } from './ivr-step-lifecycle.js';
import type { IvrAction } from './ivr-executor.js';
import {
  ivrActionToStepNode,
  stepEventToAdvanceInput,
  type StepActionNode,
  type StepIvrRequest,
} from './ivr-step-adapter.js';

const STEP_PREFIX = '/api/ivr/rustpbx/step';

async function resolveSessionStartAction(
  db: unknown,
  tenantId: string,
  callSessionId: string,
  stored: NonNullable<ReturnType<IvrSessionStore['get']>>,
  sessionStore: IvrSessionStore
): Promise<IvrAction | undefined> {
  if (stored.last_action) {
    sessionStore.upsert({
      callSessionId,
      tenantId,
      flowId: stored.flow_id,
      context: stored.context,
      stepCount: stored.step_count,
      terminated: Boolean(stored.terminated),
      lastAction: stored.last_action,
    });
    return stored.last_action;
  }

  if (!shouldAutoWalkAfterAdvance(stored.context)) {
    const stepped = await advanceRuntimeStep(stored.context, stripWalkConsumerInput({}));
    sessionStore.upsert({
      callSessionId,
      tenantId,
      flowId: stored.flow_id,
      context: stepped.context,
      stepCount: stored.step_count,
      terminated: stepped.terminated,
      lastAction: stepped.action,
    });
    return stepped.action;
  }

  const walked = await walkToPromptableAction(
    stored.context,
    buildLiveIvrStepInput(db, tenantId, { callSessionId })
  );
  sessionStore.upsert({
    callSessionId,
    tenantId,
    flowId: stored.flow_id,
    context: walked.context,
    stepCount: stored.step_count,
    terminated: walked.terminated,
    lastAction: walked.action,
  });
  return walked.action;
}

async function handleStep(
  db: unknown,
  body: StepIvrRequest
): Promise<StepActionNode | { status: string }> {
  const rustpbxCallId = body.session_id;
  if (!rustpbxCallId) {
    throw Object.assign(new Error('session_id required'), { status: 400 });
  }

  const voiceRow = findSessionByRustpbxCallId(db, rustpbxCallId);
  if (!voiceRow) {
    console.warn('[ivr-step] no voice session for', rustpbxCallId);
    return { type: 'hangup' };
  }

  const tenantId = String(voiceRow.tenant_id);
  const callSessionId = String(voiceRow.id);
  const sessionStore = new IvrSessionStore(db);
  const stored = sessionStore.get(callSessionId, tenantId);

  if (!stored) {
    console.warn('[ivr-step] no ivr session for', callSessionId);
    return { type: 'hangup' };
  }

  if (stored.terminated) {
    return { type: 'hangup' };
  }

  const eventType = body.event?.type ?? 'session_start';

  if (eventType === 'session_start') {
    const action = await resolveSessionStartAction(
      db,
      tenantId,
      callSessionId,
      stored,
      sessionStore
    );
    const node = ivrActionToStepNode(action);
    console.info('[ivr-step] session_start', rustpbxCallId, '→', node?.type ?? 'hangup');
    return node ?? { type: 'hangup' };
  }

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
    ...stepEventToAdvanceInput(body.event),
    callSessionId,
  });

  let context = step.state.context;
  let terminated = step.terminated;
  let action = step.action;
  let stepCount = step.state.stepCount;

  if (!terminated && shouldAutoWalkAfterAdvance(context)) {
    const walked = await walkToPromptableAction(
      context,
      buildLiveIvrStepInput(db, tenantId, { callSessionId })
    );
    context = walked.context;
    terminated = walked.terminated;
    if (walked.action) {
      action = walked.action;
      stepCount += 1;
    }
  }

  sessionStore.upsert({
    callSessionId,
    tenantId,
    flowId: step.state.flowId,
    context,
    stepCount,
    terminated,
    lastAction: action,
  });

  if (terminated && !action) {
    return { type: 'hangup' };
  }

  const node = ivrActionToStepNode(action);
  console.info('[ivr-step]', eventType, rustpbxCallId, '→', node?.type ?? 'hangup');
  return node ?? { type: 'hangup' };
}

export async function routeRustpbxStepIvrApi(
  db: unknown,
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  if (method !== 'POST') return undefined;
  if (path !== STEP_PREFIX && path !== `${STEP_PREFIX}/start` && path !== `${STEP_PREFIX}/end`) {
    return undefined;
  }

  verifyRustpbxWebhookKey(headers);

  if (path.endsWith('/start') || path.endsWith('/end')) {
    const req = (body || {}) as StepIvrRequest;
    console.info('[ivr-step]', path.endsWith('/start') ? 'start' : 'end', req.session_id ?? '');
    return { status: 'ok' };
  }

  const result = await handleStep(db, (body || {}) as StepIvrRequest);
  return result;
}
