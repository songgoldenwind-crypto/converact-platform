import { observeIvrSessionEvent } from './metrics.js';
import type { IvrSessionResult } from './session-service.js';

export type IvrSessionEventType =
  | 'ivr.session.started'
  | 'ivr.session.step_completed'
  | 'ivr.session.waiting'
  | 'ivr.session.completed';

export interface IvrSessionEvent {
  tenant_id: string;
  type: IvrSessionEventType;
  data: Record<string, unknown>;
}

export type IvrSessionEventPublisher = (
  tenantId: string,
  type: IvrSessionEventType,
  data: Record<string, unknown>
) => void | Promise<void>;

export function projectIvrSessionEvents(
  result: IvrSessionResult,
  options: { started?: boolean } = {}
): IvrSessionEvent[] {
  if (result.replayed) return [];
  const data = eventData(result);
  const events: IvrSessionEvent[] = [];
  if (options.started) events.push(event(result, 'ivr.session.started', data));
  if (result.steps_appended > 0) {
    events.push(event(result, 'ivr.session.step_completed', data));
  }
  if (result.session.state === 'waiting') {
    events.push(event(result, 'ivr.session.waiting', data));
  } else if (isTerminal(result.session.state)) {
    events.push(event(result, 'ivr.session.completed', data));
  }
  return events;
}

export async function emitIvrSessionEvents(
  events: readonly IvrSessionEvent[],
  publish: IvrSessionEventPublisher
): Promise<void> {
  let failures = 0;
  for (const item of events) {
    observeIvrSessionEvent({ type: item.type, state: String(item.data.state || '') });
    try {
      await publish(item.tenant_id, item.type, item.data);
    } catch {
      failures += 1;
    }
  }
  if (failures) throw new Error(`${failures} IVR session event publication(s) failed`);
}

function eventData(result: IvrSessionResult): Record<string, unknown> {
  const { session } = result;
  return {
    ivr_session_id: session.id,
    voice_call_id: session.call_id,
    flow_id: session.flow_id,
    flow_version: session.flow_version,
    state: session.state,
    node_id: session.current_node_id,
    step_count: session.step_count,
    steps_appended: result.steps_appended,
    revision: session.revision,
    action_kind: result.action?.kind ?? '',
    waiting_reason: session.waiting_reason,
    termination_reason: session.termination_reason
  };
}

function event(
  result: IvrSessionResult,
  type: IvrSessionEventType,
  data: Record<string, unknown>
): IvrSessionEvent {
  return { tenant_id: result.session.tenant_id, type, data: { ...data } };
}

function isTerminal(state: string): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}
