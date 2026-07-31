import type { RemoteAssistMediaJoinPlan } from './remote-assist-join.js';

export interface RemoteAssistObserverEvent {
  remote_session_id: string;
  actor_identity: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface RemoteAssistObserverMediaJoinInput {
  remoteSessionId: string;
  identity?: string;
}

export type RemoteAssistObserverMediaJoinGetter = (path: string) => Promise<RemoteAssistMediaJoinPlan>;

export interface RemoteAssistObserverTimelineInput {
  remoteSessionId: string;
}

export type RemoteAssistObserverTimelineGetter = (path: string) => Promise<unknown>;

export interface RemoteAssistObserverState {
  sharing: boolean;
  pointer: { x: number; y: number } | null;
  lastControlResult: {
    executed: boolean;
    action?: string;
    reason?: string;
    actorIdentity: string;
    createdAt: string;
  } | null;
  lastActor: string;
  lastEventType: string;
}

export type RemoteAssistObserverEventFilter = 'all' | 'control-actions' | 'control-results';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function readRemoteAssistObserverEvent(
  type: string,
  data: unknown,
  remoteSessionId?: string
): RemoteAssistObserverEvent | null {
  if (type !== 'remote.web_assist.event' || !isRecord(data)) return null;
  if (
    typeof data.remote_session_id !== 'string' ||
    typeof data.actor_identity !== 'string' ||
    typeof data.event_type !== 'string' ||
    !isRecord(data.payload) ||
    typeof data.created_at !== 'string'
  ) {
    return null;
  }
  if (remoteSessionId && data.remote_session_id !== remoteSessionId) return null;
  return data as unknown as RemoteAssistObserverEvent;
}

export function deriveRemoteAssistObserverState(events: RemoteAssistObserverEvent[]): RemoteAssistObserverState {
  let sharing = false;
  let pointer: { x: number; y: number } | null = null;
  let lastControlResult: RemoteAssistObserverState['lastControlResult'] = null;
  let lastActor = '';
  let lastEventType = '';

  for (const event of events) {
    lastActor = event.actor_identity;
    lastEventType = event.event_type;
    if (event.event_type === 'screen.share_started') sharing = true;
    if (event.event_type === 'screen.share_stopped') sharing = false;
    if (event.event_type === 'pointer.move') {
      const x = numberValue(event.payload.x_percent) ?? numberValue(event.payload.x);
      const y = numberValue(event.payload.y_percent) ?? numberValue(event.payload.y);
      if (x !== null && y !== null) {
        pointer = { x: clampPercent(x), y: clampPercent(y) };
      }
    }
    if (event.event_type === 'control.result' && typeof event.payload.executed === 'boolean') {
      lastControlResult = {
        executed: event.payload.executed,
        action: typeof event.payload.action === 'string' ? event.payload.action : undefined,
        reason: typeof event.payload.reason === 'string' ? event.payload.reason : undefined,
        actorIdentity: event.actor_identity,
        createdAt: event.created_at
      };
    }
  }

  return { sharing, pointer, lastControlResult, lastActor, lastEventType };
}

export function filterRemoteAssistObserverEvents(
  events: RemoteAssistObserverEvent[],
  filter: RemoteAssistObserverEventFilter
): RemoteAssistObserverEvent[] {
  if (filter === 'control-actions') return events.filter((event) => event.event_type === 'control.action');
  if (filter === 'control-results') return events.filter((event) => event.event_type === 'control.result');
  return events;
}

export function readRemoteAssistObserverTimelineEvents(
  data: unknown,
  remoteSessionId?: string
): RemoteAssistObserverEvent[] {
  if (!isRecord(data) || !Array.isArray(data.audit_events)) return [];
  const events: RemoteAssistObserverEvent[] = [];
  for (const row of data.audit_events) {
    const event = readRemoteAssistObserverTimelineAuditEvent(row, remoteSessionId);
    if (event) events.push(event);
  }
  return events;
}

function readRemoteAssistObserverTimelineAuditEvent(
  row: unknown,
  remoteSessionId?: string
): RemoteAssistObserverEvent | null {
  if (!isRecord(row) || !isRecord(row.metadata)) return null;
  if (typeof row.remote_session_id !== 'string' || typeof row.actor_identity !== 'string') return null;
  if (typeof row.event_type !== 'string' || typeof row.created_at !== 'string') return null;
  if (remoteSessionId && row.remote_session_id !== remoteSessionId) return null;
  const eventType =
    typeof row.metadata.web_assist_event_type === 'string'
      ? row.metadata.web_assist_event_type
      : row.event_type.startsWith('remote.web_assist.')
        ? row.event_type.slice('remote.web_assist.'.length)
        : '';
  if (!eventType) return null;
  return {
    remote_session_id: row.remote_session_id,
    actor_identity: row.actor_identity,
    event_type: eventType,
    payload: isRecord(row.metadata.payload) ? row.metadata.payload : {},
    created_at: row.created_at
  };
}

export function buildRemoteAssistObserverTimelinePath(input: RemoteAssistObserverTimelineInput): string {
  return `/api/collaboration/remote-assistance/${encodeURIComponent(input.remoteSessionId)}/timeline`;
}

export async function fetchRemoteAssistObserverTimelineEvents(
  getter: RemoteAssistObserverTimelineGetter,
  input: RemoteAssistObserverTimelineInput
): Promise<RemoteAssistObserverEvent[]> {
  const timeline = await getter(buildRemoteAssistObserverTimelinePath(input));
  return readRemoteAssistObserverTimelineEvents(timeline, input.remoteSessionId);
}

export function buildRemoteAssistObserverMediaJoinPath(input: RemoteAssistObserverMediaJoinInput): string {
  const params = new URLSearchParams();
  if (input.identity) params.set('identity', input.identity);
  const suffix = params.toString();
  return `/api/collaboration/remote-assistance/${encodeURIComponent(input.remoteSessionId)}/media/join${suffix ? `?${suffix}` : ''}`;
}

export async function fetchRemoteAssistObserverMediaJoinPlan(
  getter: RemoteAssistObserverMediaJoinGetter,
  input: RemoteAssistObserverMediaJoinInput
): Promise<RemoteAssistMediaJoinPlan> {
  return getter(buildRemoteAssistObserverMediaJoinPath(input));
}
