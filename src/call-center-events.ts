import { wsBroadcast } from './ws.js';

export function broadcastOutboundTaskUpdated(
  tenantId: string,
  task: Record<string, unknown>
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'outbound_task.updated', { task });
}

export function broadcastCallCompleted(
  tenantId: string,
  payload: {
    call_session_id: string;
    task_id?: string;
    status: string;
    phone_number?: string;
    result?: Record<string, unknown>;
  }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'call.completed', payload);
}

export function broadcastCallIncoming(
  tenantId: string,
  payload: {
    call_session_id: string;
    room_name: string;
    seat_id: string;
    target_user_id: string;
    from: string;
    customer_summary?: string;
    intent_score?: number;
    transfer_reason?: string;
  }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'call.incoming', payload);
}

export function broadcastCallAnswered(
  tenantId: string,
  payload: {
    call_session_id: string;
    seat_id: string;
    room_name: string;
  }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'call.answered', payload);
}

export function broadcastCallRecordingFailed(
  tenantId: string,
  payload: {
    call_session_id: string;
    room_name: string;
    failure_code: string;
    recording_id?: string;
  }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'call.recording_failed', payload);
}

export function broadcastCallEnded(
  tenantId: string,
  payload: {
    call_session_id: string;
    seat_id?: string;
    duration_sec?: number;
    disposition?: string;
  }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'call.ended', payload);
}

export function broadcastSeatStatusChanged(
  tenantId: string,
  payload: {
    seat_id: string;
    old_status: string;
    new_status: string;
    user_id?: string;
  }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'seat.status_changed', payload);
}

export function broadcastCallHold(
  tenantId: string,
  payload: { call_session_id: string; seat_id: string }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'call.hold', payload);
}

export function broadcastCallResumed(
  tenantId: string,
  payload: { call_session_id: string; seat_id: string }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'call.resumed', payload);
}

export function broadcastCallTransferred(
  tenantId: string,
  payload: {
    call_session_id: string;
    from_seat_id: string;
    to_seat_id: string;
    mode: string;
    status: string;
  }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'call.transferred', payload);
}

export function broadcastAgentAssist(
  tenantId: string,
  payload: {
    call_session_id: string;
    type: string;
    content: string;
    source?: string;
    confidence: number;
  }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'agent.assist', payload);
}

export function broadcastTranscript(
  tenantId: string,
  payload: {
    call_session_id: string;
    turn_index: number;
    role: string;
    content: string;
    timestamp: string;
  }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'call.transcript', payload);
}

export function broadcastQmLowScoreAlert(
  tenantId: string,
  payload: {
    evaluation_id: string;
    call_session_id: string;
    overall_score: number;
    violations: string[];
    summary: string;
  }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'qm.low_score_alert', payload);
}

export function broadcastOmniMessage(
  tenantId: string,
  payload: {
    conversation_id: string;
    message: Record<string, unknown>;
  }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'omni.message', payload);
}

export function broadcastSentimentAlert(
  tenantId: string,
  payload: {
    conversation_id: string;
    channel: string;
    label: string;
    score: number;
    snippet: string;
    call_session_id?: string;
  }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'sentiment.alert', payload);
}

// --- Agent-to-agent intercom (internal calls between seats) ---
// These follow the same tenant-broadcast + frontend-filter convention as
// call.incoming: the payload carries target_user_id and the receiving
// client filters on it. Same-tenant seats are mutually trusted.

export function broadcastIntercomIncoming(
  tenantId: string,
  payload: {
    room_name: string;
    media: 'voice' | 'video';
    from_seat_id: string;
    from_user_id: string;
    from_display_name: string;
    target_seat_id: string;
    target_user_id: string;
  }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'intercom.incoming', payload);
}

export function broadcastIntercomAccepted(
  tenantId: string,
  payload: {
    room_name: string;
    from_user_id: string;
    target_user_id: string;
    target_seat_id: string;
  }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'intercom.accepted', payload);
}

export function broadcastIntercomDeclined(
  tenantId: string,
  payload: {
    room_name: string;
    from_user_id: string;
    target_user_id: string;
    reason: 'declined' | 'cancelled' | 'timeout';
  }
): void {
  if (!tenantId) return;
  wsBroadcast(tenantId, 'intercom.declined', payload);
}
