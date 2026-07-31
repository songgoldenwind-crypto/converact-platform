import { resolveBrandEnv } from '../../config/converact-env.js';
import { one, parseJson } from '../../db.js';
import {
  broadcastCallAnswered,
  broadcastCallRecordingFailed,
  broadcastCallEnded,
  broadcastCallIncoming,
  broadcastOutboundTaskUpdated,
  broadcastSeatStatusChanged,
  broadcastAgentAssist,
  broadcastSentimentAlert,
  broadcastTranscript,
  broadcastIntercomIncoming,
  broadcastIntercomAccepted,
  broadcastIntercomDeclined
} from '../../call-center-events.js';
import { getPostgresOrNull } from '../../db-pg.js';
import {
  deleteCallSessionCache,
  getCallSessionCache,
  incrementCallSessionTurnCount,
  initCallSessionCache,
  patchCallSessionCache
} from '../../redis-session-cache.js';
import { readEgressConfigFromEnv, shouldRecordCall } from '../../recording-policy.js';
import { VoiceStore } from '../voice/voice-store.js';
import { decideCallRoute } from './call-router.js';
import { buildInboundRouterDeps, routeInboundCall } from './inbound/inbound-router.js';
import { AutoAttendantService } from './inbound/auto-attendant.js';
import { CallQueueStore } from './inbound/call-queue.js';
import { DidStore } from './inbound/did-store.js';
import { QueueCallbackService } from './inbound/queue-callback.js';
import { AcdEngine } from './inbound/acd-engine.js';
import type { AcdStrategy, DidRouteType } from './inbound/types.js';
import { CallHoldService } from './agent-tools/call-hold.js';
import { CallTransferService, type TransferMode } from './agent-tools/call-transfer.js';
import { ConferenceService } from './agent-tools/conference.js';
import { DispositionStore } from './agent-tools/disposition.js';
import { ParkPickupService } from './agent-tools/park-pickup.js';
import { SupervisorService, type SupervisorMode } from './agent-tools/supervisor.js';
import { VoicemailStore } from './agent-tools/voicemail.js';
import { WallboardService, adjustQueueEntryPriority, listWallboardAlerts } from './agent-tools/wallboard.js';
import { generateCallSummary } from './agent-tools/auto-summary.js';
import { buildPostCallSurveyIvrPrompt } from './dialer/post-call-survey.js';
import { CampaignLauncher } from './dialer/campaign-service.js';
import { OutboundCampaignStore } from './dialer/campaign-store.js';
import { AgentScriptStore, AgentScriptTracker } from './agent-tools/agent-script.js';
import { RecordingPciService } from './agent-tools/recording-pci.js';
import { searchRecordings } from './agent-tools/recording-search.js';
import { resolveIvrSelection, getIvrMenu } from './agent-tools/ivr-menu.js';
import { resolveTenantIvrSelection } from './ivr/ivr-marketplace-store.js';
import { generateAssistSuggestion } from './knowledge/agent-assist.js';
import { detectSentiment, recordJourneyEvent, buildCustomerKey } from './omnichannel/omni-service.js';
import { emitTenantWebhookEvent } from './webhooks/webhook-emitter.js';
import { KnowledgeStore } from './knowledge/knowledge-store.js';
import { triggerAutoQmEvaluation } from './qm/auto-evaluate.js';
import { ingestRustpbxCdr } from './cdr-receiver.js';
import { AgentSeatStore } from './seat-store.js';
import { OutboundTaskStore } from './outbound-task-store.js';
import { TransferOrchestrator } from './transfer-orchestrator.js';
import { EgressManager } from './egress-manager.js';
import { ConversationTurnStore } from './conversation-turn-store.js';
import {
  AGENT_SEAT_STATUSES,
  type AgentDispatchRequest,
  type AgentSeatStatus,
  type CallRouterRequest,
  type CreateOutboundTaskInput,
  type CreateVoiceAgentSpecInput,
  type GenerateVoiceAgentSpecInput,
  type ImportIvrVoiceAgentInput,
  type NavigateCallFlowRequest,
  type ReportIntentRequest,
  type ReportTurnRequest,
  type UpsertAgentSeatInput
} from './types.js';
import { LiveKitRoomStore } from '../livekit/room-store.js';
import { handleLiveKitWebhook } from '../livekit/webhook-handler.js';
import { createLiveKitMediaModule } from '../livekit/index.js';
import { VoiceAgentSpecStore } from './voice-agent-spec-store.js';
import { generateVoiceAgentSpec } from './voice-agent-spec-generator.js';
import { importIvrToVoiceAgentSpec } from './voice-agent-ivr-importer.js';
import { persistNavigationResult } from './voice-agent-navigation-session.js';
import { dialerWaitRegistry } from './dialer-wait-registry.js';

function resolveDefaultTenantId(db: unknown): string | null {
  const row = one(db, 'SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1');
  return row?.id ? String(row.id) : null;
}

function buildCallCenterDeps(db: unknown, harness: { voiceStore?: VoiceStore }) {
  const defaultTenantId = resolveDefaultTenantId(db);
  return {
    defaultTenantId,
    seatStore: new AgentSeatStore(db),
    outboundTaskStore: new OutboundTaskStore(db),
    roomStore: new LiveKitRoomStore(db),
    voiceStore: harness.voiceStore || new VoiceStore(db)
  };
}

export async function handleCallRouterCommand(db: unknown, harness: { voiceStore?: VoiceStore }, body: CallRouterRequest) {
  const deps = buildCallCenterDeps(db, harness);
  if (body.direction === 'inbound') {
    const inboundDeps = buildInboundRouterDeps(db, {
      voiceStore: deps.voiceStore,
      defaultTenantId: deps.defaultTenantId
    });
    const result = await routeInboundCall(body, inboundDeps);
    return { ...result.response, _context: result.context };
  }
  return decideCallRoute(body, deps);
}

export function handleRustpbxCdrWebhook(db: unknown, harness: { voiceStore?: VoiceStore }, body: Record<string, unknown> | string) {
  const deps = buildCallCenterDeps(db, harness);
  const payload = typeof body === 'string' ? JSON.parse(body || '{}') : body;
  const session = ingestRustpbxCdr(payload as any, deps);
  return { ok: true, call_session_id: session.id, status: session.status };
}

export async function handleLiveKitWebhookCommand(
  db: unknown,
  rawBody: string,
  authHeader: string | undefined
) {
  const deps = { roomStore: new LiveKitRoomStore(db), participantEvents: dialerWaitRegistry };
  return handleLiveKitWebhook(rawBody, authHeader, deps);
}

export function listOutboundTasksCommand(db: unknown, tenantId: string, status: string | null = null) {
  const store = new OutboundTaskStore(db);
  return { data: store.listTasks(tenantId, status as any) };
}

export function createOutboundTaskCommand(db: unknown, body: CreateOutboundTaskInput) {
  const store = new OutboundTaskStore(db);
  const task = store.createTask(body);
  broadcastOutboundTaskUpdated(body.tenant_id, task as unknown as Record<string, unknown>);
  return { status: 201, data: task };
}

export function cancelOutboundTaskCommand(db: unknown, taskId: string) {
  const store = new OutboundTaskStore(db);
  const data = store.cancelTask(taskId);
  if (!data) throw Object.assign(new Error('outbound task not found'), { status: 404 });
  return { data };
}

export async function createLiveKitRoomCommand(
  db: unknown,
  body: {
    tenant_id: string;
    purpose: 'ai_outbound' | 'video_service' | 'screen_share' | 'conference' | 'pstn_bridge';
    call_session_id?: string;
    metadata?: Record<string, unknown>;
    room_name?: string;
  }
) {
  if (!body?.tenant_id || !body?.purpose) {
    throw Object.assign(new Error('tenant_id and purpose are required'), { status: 400 });
  }
  const store = new LiveKitRoomStore(db);
  return { status: 201, data: await store.createRoom(body) };
}

export async function issueLiveKitTokenCommand(
  db: unknown,
  query: { room_name: string; identity: string; role: 'agent' | 'customer'; tenant_id?: string }
) {
  const media = createLiveKitMediaModule({ db });
  return { data: await media.tokens.issueParticipantToken(query) };
}

export function listAgentSeatsCommand(db: unknown, tenantId: string) {
  const store = new AgentSeatStore(db);
  return { data: store.listSeats(tenantId) };
}

export function upsertAgentSeatCommand(db: unknown, body: UpsertAgentSeatInput) {
  if (!body.tenant_id || !body.user_id || !body.display_name) {
    throw Object.assign(new Error('tenant_id, user_id, and display_name are required'), { status: 400 });
  }
  const store = new AgentSeatStore(db);
  return { status: 201, data: store.upsertSeat(body) };
}

export function updateAgentSeatStatusCommand(
  db: unknown,
  tenantId: string,
  seatId: string,
  body: { status: AgentSeatStatus; call_session_id?: string | null }
) {
  if (!AGENT_SEAT_STATUSES.includes(body.status) && body.status !== 'break') {
    throw Object.assign(new Error(`invalid seat status: ${body.status}`), { status: 400 });
  }
  const store = new AgentSeatStore(db);
  const existing = store.getSeat(seatId);
  if (!existing || existing.tenant_id !== tenantId) {
    throw Object.assign(new Error('seat not found'), { status: 404 });
  }
  const oldStatus = existing.status;
  const data = store.updateStatus(tenantId, seatId, body.status, body.call_session_id || null);
  if (!data) throw Object.assign(new Error('seat not found'), { status: 404 });
  if (oldStatus !== data.status) {
    broadcastSeatStatusChanged(tenantId, {
      seat_id: seatId,
      old_status: oldStatus,
      new_status: data.status,
      user_id: data.user_id
    });
  }
  return { data };
}

export function heartbeatAgentSeatCommand(db: unknown, tenantId: string, seatId: string) {
  const store = new AgentSeatStore(db);
  const data = store.heartbeat(tenantId, seatId);
  if (!data) throw Object.assign(new Error('seat not found'), { status: 404 });
  return { data };
}

export function getCallCenterDashboardCommand(db: unknown, tenantId: string) {
  const outbound = new OutboundTaskStore(db);
  const seats = new AgentSeatStore(db);
  const seatRows = seats.listSeats(tenantId);
  const pendingTasks = outbound.listTasks(tenantId, 'pending');
  const dialingTasks = outbound.listTasks(tenantId, 'dialing');
  const connectedTasks = outbound.listTasks(tenantId, 'connected');
  const completedToday = outbound.listTasks(tenantId, 'completed', 200);

  return {
    data: {
      today: {
        total_outbound: completedToday.length + dialingTasks.length + connectedTasks.length,
        connected: connectedTasks.length + completedToday.length,
        pending: pendingTasks.length
      },
      seats: {
        online: seatRows.filter((seat) => seat.status !== 'offline').length,
        idle: seatRows.filter((seat) => seat.status === 'idle').length,
        busy: seatRows.filter((seat) => seat.status === 'busy').length
      },
      queue: {
        pending_tasks: pendingTasks.length,
        in_progress: dialingTasks.length + connectedTasks.length
      }
    }
  };
}

export function verifyRustpbxWebhookKey(headers: Record<string, string | string[] | undefined>): void {
  const expected = process.env.RUSTPBX_WEBHOOK_KEY || resolveBrandEnv(process.env, 'RUSTPBX_WEBHOOK_KEY');
  if (!expected) return;
  const provided = String(headers['x-pbx-key'] || headers['X-PBX-Key'] || '');
  if (provided !== expected) {
    throw Object.assign(new Error('invalid rustpbx webhook key'), { status: 401 });
  }
}

export function verifyOpcApiKey(headers: Record<string, string | string[] | undefined>): void {
  const expected = resolveBrandEnv(process.env, 'API_KEY');
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      throw Object.assign(new Error('opc api key is required'), { status: 401 });
    }
    return;
  }
  const provided = String(headers['x-api-key'] || headers['X-API-Key'] || '');
  if (provided !== expected) {
    throw Object.assign(new Error('invalid opc api key'), { status: 401 });
  }
}

export function reportConversationTurnCommand(
  db: unknown,
  callSessionId: string,
  body: ReportTurnRequest
) {
  if (!body.role || !body.content) {
    throw Object.assign(new Error('role and content are required'), { status: 400 });
  }
  const store = new ConversationTurnStore(db);
  const turn = store.appendTurn(callSessionId, body);
  void incrementCallSessionTurnCount(callSessionId).catch((error) => {
    console.warn('[session-cache] turn increment failed:', error);
  });

  const voiceStore = new VoiceStore(db);
  const session = voiceStore.getCallSessionById(callSessionId);
  if (session?.tenant_id && body.role === 'customer') {
    const sentiment = detectSentiment(body.content);
    if (sentiment.label === 'angry' || sentiment.score >= 0.7) {
      broadcastSentimentAlert(session.tenant_id, {
        conversation_id: callSessionId,
        channel: 'voice',
        label: sentiment.label,
        score: sentiment.score,
        snippet: body.content.slice(0, 80),
        call_session_id: callSessionId
      });
      void emitTenantWebhookEvent(db, session.tenant_id, 'sentiment.alert', {
        call_session_id: callSessionId,
        label: sentiment.label,
        score: sentiment.score,
        snippet: body.content.slice(0, 80)
      }).catch((err) => console.warn('[webhook] sentiment.alert failed:', err));
    }
    void (async () => {
      try {
        const kb = new KnowledgeStore(db);
        const docs = kb.searchDocuments(session.tenant_id, body.content, { limit: 5 });
        const suggestion = await generateAssistSuggestion(
          body.content,
          [],
          docs.map((doc) => ({ id: doc.id, title: doc.title, content: doc.content })),
          {}
        );
        if (suggestion) {
          broadcastAgentAssist(session.tenant_id, {
            call_session_id: callSessionId,
            type: suggestion.type,
            content: suggestion.content,
            source: suggestion.source,
            confidence: suggestion.confidence
          });
        }
      } catch (error) {
        console.warn('[agent-assist] suggestion failed:', error);
      }
    })();
  }

  // Push transcript to all connected agent panels via WebSocket.
  // This enables real-time conversation view for supervisors/agents
  // watching the call. Previously: transcript event type existed in
  // sse-manager but had zero producers.
  if (session?.tenant_id) {
    broadcastTranscript(session.tenant_id, {
      call_session_id: callSessionId,
      turn_index: turn.turn_index,
      role: body.role,
      content: body.content,
      timestamp: new Date().toISOString()
    });
  }

  return { status: 201, data: turn };
}

export function listConversationTurnsCommand(db: unknown, callSessionId: string) {
  const store = new ConversationTurnStore(db);
  return { data: store.listTurns(callSessionId) };
}

export function reportIntentCommand(
  db: unknown,
  harness: { voiceStore?: VoiceStore },
  callSessionId: string,
  body: ReportIntentRequest
) {
  const voiceStore = harness.voiceStore || new VoiceStore(db);
  const session = voiceStore.getCallSessionById(callSessionId);
  if (!session?.tenant_id) throw Object.assign(new Error('call session not found'), { status: 404 });

  const turnStore = new ConversationTurnStore(db);
  turnStore.updateLatestIntent(callSessionId, body.intent_score);

  const existingMeta =
    session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
      ? (session.metadata as Record<string, unknown>)
      : {};
  voiceStore.updateCallSession(String(session.tenant_id), callSessionId, {
    metadata: {
      ...existingMeta,
      intent_score: body.intent_score,
      intent_signals: body.signals || []
    }
  });

  return { data: { intent_score: body.intent_score, signals: body.signals || [] } };
}

export function handleAgentDispatchCommand(
  db: unknown,
  harness: { voiceStore?: VoiceStore },
  body: AgentDispatchRequest
) {
  if (!body.tenant_id) {
    throw Object.assign(new Error('tenant_id is required'), { status: 400 });
  }
  if (!body.room_name || !body.action) {
    throw Object.assign(new Error('room_name and action are required'), { status: 400 });
  }

  const roomStore = new LiveKitRoomStore(db);
  const room = roomStore.getRoomByName(body.room_name);
  if (!room || room.tenant_id !== body.tenant_id) {
    throw Object.assign(new Error('room not found'), { status: 404 });
  }
  const voiceStore = harness.voiceStore || new VoiceStore(db);

  if (body.action === 'transfer_to_human') {
    const seatStore = new AgentSeatStore(db);
    const orchestrator = new TransferOrchestrator(seatStore, voiceStore);
    const tenantId = room.tenant_id;
    const callSessionId = room.call_session_id || body.call_session_id || '';
    const result = orchestrator.execute({
      tenantId,
      callSessionId,
      roomName: body.room_name,
      requiredSkills: body.required_skills,
      reason: body.reason,
      customerSummary: body.customer_summary,
      language: body.language
    });

    if (result.action_taken === 'seat_assigned' && result.seat && tenantId && callSessionId) {
      const session = voiceStore.getCallSession(tenantId, callSessionId);
      const metadata =
        session?.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
          ? (session.metadata as Record<string, unknown>)
          : {};
      const seat = seatStore.getSeat(result.seat.id);
      broadcastCallIncoming(tenantId, {
        call_session_id: callSessionId,
        room_name: body.room_name,
        seat_id: result.seat.id,
        target_user_id: seat?.user_id || '',
        from: String(session?.phone_redacted || ''),
        customer_summary: body.customer_summary || String(metadata.customer_summary || ''),
        intent_score: Number(metadata.intent_score ?? body.intent_score ?? 0),
        transfer_reason: body.reason || ''
      });
    }

    return { data: result };
  }

  if (body.action === 'end_call' && room.call_session_id) {
    voiceStore.updateCallSession(room.tenant_id, room.call_session_id, {
      status: 'completed',
      ended_at: new Date().toISOString(),
      ai_handled: 1
    });
    return {
      data: {
        action_taken: 'call_ended',
        message_for_customer: '通話を終了しました。'
      }
    };
  }

  if (body.action === 'schedule_callback') {
    const tenantId = room.tenant_id;
    const outbound = new OutboundTaskStore(db);
    const phone = body.callback_phone || '';
    if (!phone) throw Object.assign(new Error('callback_phone is required'), { status: 400 });
    const task = outbound.createTask({
      tenant_id: tenantId,
      phone_number: phone,
      channel: 'pstn_voice',
      scheduled_at: body.callback_time || null,
      strategy: { language: (body.language as any) || 'ja' }
    });
    return {
      data: {
        action_taken: 'callback_scheduled',
        message_for_customer: 'ご希望の時間に折り返しご連絡いたします。',
        scheduled_task_id: task.id
      }
    };
  }

  throw Object.assign(new Error('unsupported dispatch action'), { status: 400 });
}

export function getVoiceAgentSpecCommand(db: unknown, specId: string, tenantId?: string | null) {
  const store = new VoiceAgentSpecStore(db);
  const data = store.getSpec(specId, tenantId);
  if (!data) throw Object.assign(new Error('voice agent spec not found'), { status: 404 });
  return { data };
}

export function listVoiceAgentSpecsCommand(db: unknown, tenantId: string, status: string | null = null) {
  const store = new VoiceAgentSpecStore(db);
  return {
    data: store.listSpecs(tenantId, status as any)
  };
}

export function createVoiceAgentSpecCommand(db: unknown, body: CreateVoiceAgentSpecInput) {
  if (!body.tenant_id || !body.runtime?.system_prompt || !body.runtime?.greeting) {
    throw Object.assign(new Error('tenant_id, runtime.system_prompt, and runtime.greeting are required'), {
      status: 400
    });
  }
  const store = new VoiceAgentSpecStore(db);
  return { status: 201, data: store.createSpec(body) };
}

export async function generateVoiceAgentSpecCommand(db: unknown, body: GenerateVoiceAgentSpecInput) {
  const { payload, source } = await generateVoiceAgentSpec(body);
  const store = new VoiceAgentSpecStore(db);
  const spec = store.createSpec({
    tenant_id: body.tenant_id,
    language: payload.language,
    goal: payload.goal || body.goal,
    status: body.publish ? 'published' : 'draft',
    tools: payload.tools,
    compliance: payload.compliance,
    runtime: payload.runtime,
    nodes: payload.nodes
  });
  return { status: 201, data: { ...spec, generation_source: source } };
}

export function publishVoiceAgentSpecCommand(db: unknown, specId: string, tenantId: string) {
  const store = new VoiceAgentSpecStore(db);
  const data = store.publishSpec(specId, tenantId);
  if (!data) throw Object.assign(new Error('voice agent spec not found'), { status: 404 });
  return { data };
}

export function importIvrVoiceAgentSpecCommand(db: unknown, body: ImportIvrVoiceAgentInput) {
  const draft = importIvrToVoiceAgentSpec(body);
  const store = new VoiceAgentSpecStore(db);
  return { status: 201, data: store.createSpec(draft) };
}

export function navigateCallFlowCommand(
  db: unknown,
  harness: { voiceStore?: VoiceStore },
  callSessionId: string,
  body: NavigateCallFlowRequest
) {
  if (!body.trigger) {
    throw Object.assign(new Error('trigger is required'), { status: 400 });
  }

  const voiceStore = harness.voiceStore || new VoiceStore(db);
  const session = voiceStore.getCallSessionById(callSessionId);
  if (!session?.tenant_id) throw Object.assign(new Error('call session not found'), { status: 404 });

  const tenantId = String(session.tenant_id);
  const existingMeta =
    session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
      ? (session.metadata as Record<string, unknown>)
      : {};
  const agentSpecId = String(body.agent_spec_id || existingMeta.agent_spec_id || '');
  if (!agentSpecId) {
    throw Object.assign(new Error('agent_spec_id is required on session or request body'), { status: 400 });
  }

  const specStore = new VoiceAgentSpecStore(db);
  const spec = specStore.getSpec(agentSpecId, tenantId);
  if (!spec) throw Object.assign(new Error('voice agent spec not found'), { status: 404 });

  const navigation = persistNavigationResult(voiceStore, tenantId, callSessionId, spec, {
    agentSpecId,
    trigger: body.trigger,
    customerText: body.customer_text
  });

  return { data: navigation };
}

export async function getCallSessionCacheCommand(callSessionId: string) {
  const data = await getCallSessionCache(callSessionId);
  if (!data) throw Object.assign(new Error('session cache not found'), { status: 404 });
  return { data };
}

export async function patchCallSessionCacheCommand(
  callSessionId: string,
  body: Record<string, unknown>
) {
  const fields: Record<string, string> = {};
  if (body.state !== undefined) fields.state = String(body.state);
  if (body.current_node !== undefined) fields.current_node = String(body.current_node);
  if (body.variables !== undefined) fields.variables = JSON.stringify(body.variables);
  if (body.turn_count !== undefined) fields.turn_count = String(body.turn_count);

  const data = await patchCallSessionCache(callSessionId, fields);
  if (!data) throw Object.assign(new Error('session cache not found'), { status: 404 });
  return { data };
}

export async function deleteCallSessionCacheCommand(callSessionId: string) {
  await deleteCallSessionCache(callSessionId);
  return { data: { deleted: true } };
}

export { initCallSessionCache };

export function getCallSessionDetailCommand(db: unknown, tenantId: string, callSessionId: string) {
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.getCallSession(tenantId, callSessionId);
  if (!session) throw Object.assign(new Error('call session not found'), { status: 404 });
  const turnStore = new ConversationTurnStore(db);
  const turns = turnStore.listTurns(callSessionId);
  const metadata =
    session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
      ? (session.metadata as Record<string, unknown>)
      : {};
  return {
    data: {
      id: session.id,
      tenant_id: session.tenant_id,
      phone: session.phone_redacted || session.phone,
      status: session.status,
      direction: session.direction,
      intent_score: metadata.intent_score ?? null,
      customer_summary: metadata.customer_summary || metadata.transfer_reason || '',
      metadata,
      turns
    }
  };
}

export async function acceptTransferCommand(
  db: unknown,
  tenantId: string,
  seatId: string,
  callSessionId: string,
  userId: string
) {
  const seatStore = new AgentSeatStore(db);
  const seat = seatStore.getSeat(seatId);
  if (!seat || seat.tenant_id !== tenantId) {
    throw Object.assign(new Error('seat not found'), { status: 404 });
  }
  if (seat.user_id !== userId) {
    throw Object.assign(new Error('seat does not belong to current user'), { status: 403 });
  }

  const voiceStore = new VoiceStore(db);
  const session = voiceStore.getCallSession(tenantId, callSessionId);
  if (!session) throw Object.assign(new Error('call session not found'), { status: 404 });

  const roomStore = new LiveKitRoomStore(db);
  let room = roomStore.getRoomByCallSession(callSessionId);
  if (!room) {
    const roomName =
      String((session as { livekit_room_name?: string }).livekit_room_name || '') ||
      `${tenantId}-pstn_bridge-${callSessionId.slice(-8)}`;
    room = await roomStore.createRoom({
      tenant_id: tenantId,
      purpose: 'pstn_bridge',
      call_session_id: callSessionId,
      room_name: roomName,
      metadata: { call_session_id: callSessionId, tenant_id: tenantId }
    });
  }

  const oldStatus = seat.status;
  seatStore.updateStatus(tenantId, seatId, 'busy', callSessionId);
  if (oldStatus !== 'busy') {
    broadcastSeatStatusChanged(tenantId, {
      seat_id: seatId,
      old_status: oldStatus,
      new_status: 'busy',
      user_id: seat.user_id
    });
  }

  voiceStore.updateCallSession(tenantId, callSessionId, {
    status: 'active',
    metadata: {
      ...(typeof session.metadata === 'object' && session.metadata ? session.metadata : {}),
      answered_by_seat_id: seatId,
      answered_at: new Date().toISOString()
    }
  });

  const media = createLiveKitMediaModule({ db });
  const token = await media.tokens.issueParticipantToken({
    room_name: room.room_name,
    identity: seat.livekit_identity || `seat_${seatId}`,
    role: 'agent',
    tenant_id: tenantId
  });

  const pg = getPostgresOrNull();
  const metadata =
    session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
      ? (session.metadata as Record<string, unknown>)
      : {};
  const recordingExplicitlyDenied = metadata.recording_consent === 'denied';

  broadcastCallAnswered(tenantId, {
    call_session_id: callSessionId,
    seat_id: seatId,
    room_name: room.room_name
  });

  if (!recordingExplicitlyDenied) {
    scheduleCallRecording(db, pg, tenantId, callSessionId, room.room_name, metadata);
  }

  return {
    data: {
      livekit: token,
      room_name: room.room_name,
      call_session_id: callSessionId,
      seat_id: seatId,
      call_status: 'active',
      recording: null,
      recording_failure: null,
      recording_status: recordingExplicitlyDenied ? 'not_requested' : 'scheduled'
    }
  };
}

function scheduleCallRecording(
  db: unknown,
  pg: ReturnType<typeof getPostgresOrNull>,
  tenantId: string,
  callSessionId: string,
  roomName: string,
  metadata: Record<string, unknown>
): void {
  void (async () => {
    if (!await shouldRecordCall(pg, callSessionId, metadata)) return;
    const egress = new EgressManager(db, readEgressConfigFromEnv());
    await egress.startRecording(tenantId, callSessionId, roomName, {
      format: 'ogg',
      hasVideo: false
    });
  })().catch((error) => {
    const failure = safeRecordingStartFailure(error);
    console.warn(
      `[call-center] recording start failed without interrupting call ${callSessionId}: ${failure.code}`
    );
    broadcastCallRecordingFailed(tenantId, {
      call_session_id: callSessionId,
      room_name: roomName,
      failure_code: failure.code,
      ...(failure.recording_id ? { recording_id: failure.recording_id } : {})
    });
  });
}

const SAFE_RECORDING_START_FAILURE_CODES = new Set([
  'livekit_egress_admission_activation_failed',
  'livekit_egress_compensation_failed',
  'livekit_egress_persistence_failed',
  'livekit_egress_reservation_failed',
  'livekit_egress_start_failed',
  'recording_start_failed'
]);

function safeRecordingStartFailure(error: unknown): { code: string; recording_id?: string } {
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; recording_id?: unknown }
    : {};
  const rawCode = String(candidate.code || 'recording_start_failed');
  const code = SAFE_RECORDING_START_FAILURE_CODES.has(rawCode)
    ? rawCode
    : 'recording_start_failed';
  const recordingId = String(candidate.recording_id || '');
  return {
    code,
    ...(/^[A-Za-z0-9_-]{1,128}$/.test(recordingId) ? { recording_id: recordingId } : {})
  };
}

// --- Agent-to-agent intercom (internal seat-to-seat calls) ---
// Unlike transfers/conferences, intercom calls are not anchored to a customer
// call_session — they're a direct call from one seat to another (voice or
// video). The LiveKit room is the media hub; both seats publish/subscribe
// audio (+video) tracks into it.

/**
 * Seat A starts an intercom call to seat B.
 * Creates a conference room, issues A's token directly, and broadcasts
 * intercom.incoming so B's client rings.
 */
export async function startIntercomCommand(
  db: unknown,
  tenantId: string,
  fromUserId: string,
  input: { from_seat_id: string; target_seat_id: string; media?: 'voice' | 'video' }
) {
  const seatStore = new AgentSeatStore(db);
  const fromSeat = seatStore.getSeat(input.from_seat_id);
  if (!fromSeat || fromSeat.tenant_id !== tenantId) {
    throw Object.assign(new Error('caller seat not found'), { status: 404 });
  }
  if (fromSeat.user_id !== fromUserId) {
    throw Object.assign(new Error('caller seat does not belong to current user'), { status: 403 });
  }
  const targetSeat = seatStore.getSeat(input.target_seat_id);
  if (!targetSeat || targetSeat.tenant_id !== tenantId) {
    throw Object.assign(new Error('target seat not found'), { status: 404 });
  }
  if (targetSeat.id === fromSeat.id) {
    throw Object.assign(new Error('cannot intercom yourself'), { status: 400 });
  }

  const media: 'voice' | 'video' = input.media === 'video' ? 'video' : 'voice';
  const roomName = `${tenantId}-intercom-${input.from_seat_id.slice(-6)}-${input.target_seat_id.slice(-6)}`;

  const roomStore = new LiveKitRoomStore(db);
  let room = roomStore.getRoomByName(roomName);
  if (!room) {
    room = await roomStore.createRoom({
      tenant_id: tenantId,
      purpose: 'conference',
      room_name: roomName,
      metadata: {
        intercom: true,
        media,
        from_seat_id: input.from_seat_id,
        target_seat_id: input.target_seat_id
      }
    });
  }

  // Caller (agent) joins via the webrtc media gateway. Routing through the
  // gateway registry keeps the join mechanism pluggable — a future SIP/VoLTE
  // participant would use a different channel without changing this flow.
  const mediaModule = createLiveKitMediaModule({ db });
  const callerPlan = await mediaModule.joins.prepareJoin('webrtc', {
    tenantId,
    roomName: room.room_name,
    identity: fromSeat.livekit_identity || `seat_${fromSeat.id}`,
    role: 'agent',
    media
  });
  const callerToken = callerPlan.mode === 'webrtc' ? callerPlan.token : null;

  broadcastIntercomIncoming(tenantId, {
    room_name: room.room_name,
    media,
    from_seat_id: fromSeat.id,
    from_user_id: fromSeat.user_id,
    from_display_name: fromSeat.display_name || fromSeat.user_id,
    target_seat_id: targetSeat.id,
    target_user_id: targetSeat.user_id
  });

  return {
    data: {
      room_name: room.room_name,
      media,
      caller_token: callerToken,
      target_seat_id: targetSeat.id,
      target_user_id: targetSeat.user_id
    }
  };
}

/**
 * Seat B accepts an intercom call. Issues B's token for the existing room
 * and broadcasts intercom.accepted so A knows B joined.
 */
export async function acceptIntercomCommand(
  db: unknown,
  tenantId: string,
  userId: string,
  input: { room_name: string; seat_id: string }
) {
  const seatStore = new AgentSeatStore(db);
  const seat = seatStore.getSeat(input.seat_id);
  if (!seat || seat.tenant_id !== tenantId) {
    throw Object.assign(new Error('seat not found'), { status: 404 });
  }
  if (seat.user_id !== userId) {
    throw Object.assign(new Error('seat does not belong to current user'), { status: 403 });
  }

  const roomStore = new LiveKitRoomStore(db);
  const room = roomStore.getRoomByName(input.room_name);
  if (!room || room.tenant_id !== tenantId) {
    throw Object.assign(new Error('intercom room not found'), { status: 404 });
  }

  const mediaModule = createLiveKitMediaModule({ db });
  const plan = await mediaModule.joins.prepareJoin('webrtc', {
    tenantId,
    roomName: room.room_name,
    identity: seat.livekit_identity || `seat_${seat.id}`,
    role: 'agent',
    media: 'video'
  });
  const token = plan.mode === 'webrtc' ? plan.token : null;

  broadcastIntercomAccepted(tenantId, {
    room_name: room.room_name,
    from_user_id: String((room.metadata as Record<string, unknown> | undefined)?.from_seat_id || ''),
    target_user_id: userId,
    target_seat_id: seat.id
  });

  return {
    data: {
      room_name: room.room_name,
      livekit: token,
      seat_id: seat.id
    }
  };
}

/**
 * Decline or cancel an intercom call. Broadcasts intercom.declined so the
 * other party stops ringing / waiting.
 */
export function declineIntercomCommand(
  db: unknown,
  tenantId: string,
  userId: string,
  input: { room_name: string; from_user_id?: string; target_user_id?: string; reason?: 'declined' | 'cancelled' | 'timeout' }
) {
  // No DB mutation needed — intercom rooms are ephemeral. Just signal.
  broadcastIntercomDeclined(tenantId, {
    room_name: input.room_name,
    from_user_id: input.from_user_id || '',
    target_user_id: input.target_user_id || userId,
    reason: input.reason === 'cancelled' ? 'cancelled' : input.reason === 'timeout' ? 'timeout' : 'declined'
  });
  return { data: { room_name: input.room_name, ok: true } };
}

export async function endAgentCallCommand(
  db: unknown,
  tenantId: string,
  seatId: string,
  callSessionId: string,
  userId: string,
  body: { disposition?: string; notes?: string } = {}
) {
  const seatStore = new AgentSeatStore(db);
  const seat = seatStore.getSeat(seatId);
  if (!seat || seat.tenant_id !== tenantId || seat.user_id !== userId) {
    throw Object.assign(new Error('seat not found'), { status: 404 });
  }

  const voiceStore = new VoiceStore(db);
  const session = voiceStore.getCallSession(tenantId, callSessionId);
  const endedAt = new Date().toISOString();

  const dispositionCode = body.disposition || 'completed';
  const dispositionStore = new DispositionStore(db);
  dispositionStore.setCallDisposition(
    callSessionId,
    dispositionCode,
    typeof (body as { notes?: string }).notes === 'string' ? (body as { notes?: string }).notes! : null
  );

  const recording = new EgressManager(db, readEgressConfigFromEnv()).getRecordingBySession(callSessionId);
  if (recording?.egress_id) {
    void new EgressManager(db, readEgressConfigFromEnv()).stopRecording(recording.egress_id).catch((error) => {
      console.warn('[call] stopRecording failed:', error instanceof Error ? error.message : error);
    });
  }

  voiceStore.updateCallSession(tenantId, callSessionId, {
    status: 'completed',
    ended_at: endedAt
  });

  const oldStatus = seat.status;
  seatStore.updateStatus(tenantId, seatId, 'wrap_up', null);
  broadcastSeatStatusChanged(tenantId, {
    seat_id: seatId,
    old_status: oldStatus,
    new_status: 'wrap_up',
    user_id: userId
  });

  const startedAt = session?.started_at ? new Date(String(session.started_at)).getTime() : Date.now();
  const durationSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));

  broadcastCallEnded(tenantId, {
    call_session_id: callSessionId,
    seat_id: seatId,
    duration_sec: durationSec,
    disposition: dispositionCode
  });

  void emitTenantWebhookEvent(db, tenantId, 'call.completed', {
    call_session_id: callSessionId,
    seat_id: seatId,
    duration_sec: durationSec,
    disposition: dispositionCode
  }).catch((err) => console.warn('[webhook] call.completed failed:', err));

  void deleteCallSessionCache(callSessionId).catch(() => undefined);
  void triggerAutoQmEvaluation(db, tenantId, callSessionId).catch((error) => {
    console.warn('[call] auto QM evaluation failed:', error instanceof Error ? error.message : error);
  });
  void generateCallSummary(db, tenantId, callSessionId).catch((error) => {
    console.warn('[auto-summary] failed:', error);
  });

  const customerPhone =
    session?.metadata && typeof session.metadata === 'object'
      ? String((session.metadata as Record<string, unknown>).customer_phone || (session.metadata as Record<string, unknown>).from_number || '')
      : '';
  if (customerPhone) {
    recordJourneyEvent(db, {
      tenant_id: tenantId,
      customer_key: buildCustomerKey({ customer_phone: customerPhone }),
      event_type: 'call_completed',
      channel: 'voice',
      summary: `通话结束 · ${dispositionCode} · ${durationSec}s`,
      ref_id: callSessionId,
      metadata: { disposition: dispositionCode, duration_sec: durationSec }
    });
  }

  const sessionMeta =
    session?.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
      ? (session.metadata as Record<string, unknown>)
      : {};
  if (sessionMeta.enable_post_call_survey === true || resolveBrandEnv(process.env, 'ENABLE_POST_CALL_SURVEY') === '1') {
    voiceStore.mergeCallSessionMetadata(tenantId, callSessionId, (existing) => ({
      ...existing,
      post_call_survey_pending: true,
      post_call_survey_prompt: buildPostCallSurveyIvrPrompt()
    }));
  }

  const campaignContactId = sessionMeta.campaign_contact_id ? String(sessionMeta.campaign_contact_id) : null;
  const campaignId = sessionMeta.campaign_id ? String(sessionMeta.campaign_id) : null;
  if (campaignContactId && campaignId) {
    try {
      const launcher = new CampaignLauncher(db, new OutboundCampaignStore(db), new OutboundTaskStore(db));
      launcher.reportOutcome({
        campaign_id: campaignId,
        campaign_contact_id: campaignContactId,
        disposition: dispositionCode,
        success: dispositionCode !== 'failed' && dispositionCode !== 'no_answer'
      });
    } catch (error) {
      console.warn('[campaign] outcome report failed:', error);
    }
  }

  return { data: { call_session_id: callSessionId, status: 'completed', duration_sec: durationSec } };
}

export function listQueuesCommand(db: unknown, tenantId: string) {
  const store = new CallQueueStore(db);
  return { data: store.listQueues(tenantId) };
}

export function createQueueCommand(db: unknown, tenantId: string, body: Record<string, unknown>) {
  const name = String(body.name || '').trim();
  if (!name) throw Object.assign(new Error('name is required'), { status: 400 });
  const store = new CallQueueStore(db);
  const queue = store.createQueue({
    tenant_id: tenantId,
    name,
    strategy: (body.strategy as AcdStrategy) || 'longest_idle',
    max_wait_sec: body.max_wait_sec !== undefined ? Number(body.max_wait_sec) : undefined,
    max_size: body.max_size !== undefined ? Number(body.max_size) : undefined,
    overflow_target: body.overflow_target ? String(body.overflow_target) : null,
    music_url: body.music_url ? String(body.music_url) : null,
    callback_after_sec: body.callback_after_sec !== undefined ? Number(body.callback_after_sec) : undefined
  });
  const seatIds = Array.isArray(body.member_seat_ids) ? (body.member_seat_ids as string[]) : [];
  for (const seatId of seatIds) store.addMember(queue.id, seatId, 1);
  return { status: 201, data: queue };
}

export function getQueueStatusCommand(db: unknown, tenantId: string, queueIdOrName: string) {
  const store = new CallQueueStore(db);
  const queue =
    store.getQueue(queueIdOrName) || store.getQueueByName(tenantId, queueIdOrName);
  if (!queue || queue.tenant_id !== tenantId) {
    throw Object.assign(new Error('queue not found'), { status: 404 });
  }
  const seatStore = new AgentSeatStore(db);
  const acd = new AcdEngine(db, seatStore, store);
  const available = acd.countAvailableAgents(queue.id);
  return { data: store.getQueueStatus(queue.id, available) };
}

export function requestQueueCallbackCommand(
  db: unknown,
  tenantId: string,
  queueIdOrName: string,
  body: Record<string, unknown>
) {
  const queueStore = new CallQueueStore(db);
  const queue =
    queueStore.getQueue(queueIdOrName) || queueStore.getQueueByName(tenantId, queueIdOrName);
  if (!queue || queue.tenant_id !== tenantId) {
    throw Object.assign(new Error('queue not found'), { status: 404 });
  }
  const phone = String(body.phone_number || '').trim();
  if (!phone) throw Object.assign(new Error('phone_number is required'), { status: 400 });
  const callback = new QueueCallbackService(db).createCallback({
    tenant_id: tenantId,
    queue_id: queue.id,
    call_session_id: body.call_session_id ? String(body.call_session_id) : null,
    phone_number: phone
  });
  return { status: 201, data: callback };
}

export function listDidNumbersCommand(db: unknown, tenantId: string) {
  return { data: new DidStore(db).listDids(tenantId) };
}

export function createDidNumberCommand(db: unknown, tenantId: string, body: Record<string, unknown>) {
  const number = String(body.number || '').trim();
  if (!number) throw Object.assign(new Error('number is required'), { status: 400 });
  const did = new DidStore(db).createDid({
    tenant_id: tenantId,
    number,
    label: body.label ? String(body.label) : undefined,
    route_type: (body.route_type as DidRouteType) || 'queue',
    route_target: body.route_target ? String(body.route_target) : null
  });
  return { status: 201, data: did };
}

export function updateAutoAttendantCommand(db: unknown, tenantId: string, body: Record<string, unknown>) {
  const service = new AutoAttendantService(db);
  const config = service.upsertConfig(tenantId, {
    timezone: body.timezone ? String(body.timezone) : undefined,
    business_hours: body.business_hours as Record<string, [number, number]> | undefined,
    after_hours_route_type: body.after_hours_route_type as any,
    after_hours_route_target: body.after_hours_route_target ? String(body.after_hours_route_target) : undefined,
    announcement_text: body.announcement_text ? String(body.announcement_text) : undefined
  });
  return { data: config };
}

export async function acceptInboundCallCommand(
  db: unknown,
  tenantId: string,
  seatId: string,
  callSessionId: string,
  userId: string
) {
  const queueStore = new CallQueueStore(db);
  const entry = queueStore.getActiveEntryByCallSession(callSessionId, tenantId);
  if (entry) queueStore.markAnswered(entry.id);
  return acceptTransferCommand(db, tenantId, seatId, callSessionId, userId);
}

export function listDispositionCodesCommand(db: unknown, tenantId: string) {
  const store = new DispositionStore(db);
  store.seedDefaults(tenantId);
  return { data: store.listCodes(tenantId) };
}

export function setCallDispositionCommand(
  db: unknown,
  tenantId: string,
  callSessionId: string,
  body: Record<string, unknown>
) {
  const voiceStore = new VoiceStore(db);
  const session = voiceStore.getCallSession(tenantId, callSessionId);
  if (!session) throw Object.assign(new Error('call session not found'), { status: 404 });
  const code = String(body.disposition_code || body.disposition || '').trim();
  if (!code) throw Object.assign(new Error('disposition_code is required'), { status: 400 });
  const store = new DispositionStore(db);
  const row = store.setCallDisposition(callSessionId, code, body.notes ? String(body.notes) : null);
  return { data: row };
}

export function holdCallCommand(
  db: unknown,
  tenantId: string,
  callSessionId: string,
  seatId: string,
  userId: string
) {
  assertSeatOwnership(db, tenantId, seatId, userId);
  const service = new CallHoldService(new VoiceStore(db));
  return service.hold(tenantId, callSessionId, seatId).then((data) => ({ data }));
}

export function resumeCallCommand(
  db: unknown,
  tenantId: string,
  callSessionId: string,
  seatId: string,
  userId: string
) {
  assertSeatOwnership(db, tenantId, seatId, userId);
  const service = new CallHoldService(new VoiceStore(db));
  return service.resume(tenantId, callSessionId, seatId).then((data) => ({ data }));
}

export function transferCallCommand(
  db: unknown,
  tenantId: string,
  callSessionId: string,
  body: { from_seat_id: string; target_seat_id: string; mode?: string; reason?: string },
  userId: string
) {
  assertSeatOwnership(db, tenantId, body.from_seat_id, userId);
  const mode = (body.mode || 'blind') as TransferMode;
  const service = new CallTransferService(
    new VoiceStore(db),
    new AgentSeatStore(db),
    new LiveKitRoomStore(db)
  );
  return {
    data: service.transfer({
      tenantId,
      callSessionId,
      fromSeatId: body.from_seat_id,
      targetSeatId: body.target_seat_id,
      mode,
      reason: body.reason
    })
  };
}

export async function addConferenceParticipantCommand(
  db: unknown,
  tenantId: string,
  callSessionId: string,
  body: { seat_id: string; participant_identity: string; participant_label?: string },
  userId: string
) {
  assertSeatOwnership(db, tenantId, body.seat_id, userId);
  const service = new ConferenceService(new VoiceStore(db), new LiveKitRoomStore(db));
  return {
    data: await service.addParticipant({
      tenantId,
      callSessionId,
      seatId: body.seat_id,
      participantIdentity: body.participant_identity,
      participantLabel: body.participant_label
    })
  };
}

function assertSeatOwnership(db: unknown, tenantId: string, seatId: string, userId: string): void {
  const seat = new AgentSeatStore(db).getSeat(seatId);
  if (!seat || seat.tenant_id !== tenantId || seat.user_id !== userId) {
    throw Object.assign(new Error('seat not found'), { status: 404 });
  }
}

export function getWallboardCommand(db: unknown, tenantId: string) {
  const service = new WallboardService(db, new AgentSeatStore(db), new CallQueueStore(db));
  return {
    data: {
      snapshot: service.getSnapshot(tenantId),
      alerts: listWallboardAlerts(db, tenantId)
    }
  };
}

export function listRecordingsCommand(
  db: unknown,
  tenantId: string,
  opts: { call_session_id?: string; limit?: number; q?: string; date_from?: string; date_to?: string } = {}
) {
  const recordings = searchRecordings(db, {
    tenant_id: tenantId,
    call_session_id: opts.call_session_id,
    limit: opts.limit || 50,
    q: opts.q,
    date_from: opts.date_from,
    date_to: opts.date_to
  });
  return { data: recordings };
}

export function listVoicemailsCommand(db: unknown, tenantId: string, status: string | null) {
  const store = new VoicemailStore(db);
  const allowed = status === 'new' || status === 'read' || status === 'archived' ? status : null;
  return { data: store.listVoicemails(tenantId, allowed) };
}

export async function ingestVoicemailCommand(db: unknown, body: Record<string, unknown>) {
  const tenantId = String(body.tenant_id || '').trim();
  const fromNumber = String(body.from_number || '').trim();
  if (!tenantId || !fromNumber) {
    throw Object.assign(new Error('tenant_id and from_number are required'), { status: 400 });
  }
  const recordingUrl = body.recording_url ? String(body.recording_url) : '';
  const vm = new VoicemailStore(db).createVoicemail({
    tenant_id: tenantId,
    call_session_id: body.call_session_id ? String(body.call_session_id) : null,
    from_number: fromNumber,
    mailbox: body.mailbox ? String(body.mailbox) : undefined,
    recording_url: recordingUrl || undefined,
    transcript: body.transcript ? String(body.transcript) : null,
    duration_sec: body.duration_sec != null ? Number(body.duration_sec) : null
  });

  if (recordingUrl && !body.transcript) {
    const { transcribeAndUpdateVoicemail } = await import('./agent-tools/voicemail-transcribe.js');
    void transcribeAndUpdateVoicemail(db, vm.id, recordingUrl).catch((error) => {
      console.warn('[voicemail] async transcribe failed:', error);
    });
  }

  return { status: 201, data: vm };
}

export async function supervisorMonitorCommand(
  db: unknown,
  tenantId: string,
  supervisorUserId: string,
  callSessionId: string,
  mode: string
) {
  const allowed: SupervisorMode[] = ['listen', 'barge', 'whisper'];
  if (!allowed.includes(mode as SupervisorMode)) {
    throw Object.assign(new Error('mode must be listen, barge, or whisper'), { status: 400 });
  }
  const service = new SupervisorService(new VoiceStore(db), new LiveKitRoomStore(db));
  return {
    data: await service.joinMonitor({
      tenantId,
      supervisorUserId,
      callSessionId,
      mode: mode as SupervisorMode
    })
  };
}

export function forceDisconnectCallCommand(
  db: unknown,
  tenantId: string,
  callSessionId: string,
  seatId: string | null
) {
  const service = new SupervisorService(new VoiceStore(db), new LiveKitRoomStore(db));
  service.forceDisconnect(tenantId, callSessionId, seatId);
  return { data: { call_session_id: callSessionId, status: 'force_disconnected' } };
}

export function parkCallCommand(
  db: unknown,
  tenantId: string,
  callSessionId: string,
  seatId: string,
  userId: string,
  slot?: number
) {
  assertSeatOwnership(db, tenantId, seatId, userId);
  const service = new ParkPickupService(db, new VoiceStore(db), new AgentSeatStore(db));
  return { data: service.parkCall(tenantId, callSessionId, seatId, slot || 1) };
}

export function pickupParkedCallCommand(
  db: unknown,
  tenantId: string,
  slot: number,
  seatId: string,
  userId: string
) {
  assertSeatOwnership(db, tenantId, seatId, userId);
  const service = new ParkPickupService(db, new VoiceStore(db), new AgentSeatStore(db));
  return { data: service.pickupCall(tenantId, slot, seatId) };
}

export function adjustQueuePriorityCommand(
  db: unknown,
  tenantId: string,
  queueId: string,
  entryId: string,
  priority: number
) {
  const ok = adjustQueueEntryPriority(db, tenantId, queueId, entryId, priority);
  if (!ok) throw Object.assign(new Error('queue entry not found'), { status: 404 });
  return { data: { queue_id: queueId, entry_id: entryId, priority } };
}

export function processIvrRouteCommand(db: unknown, body: Record<string, unknown>) {
  const menuId = String(body.menu_id || 'default');
  const digit = body.digit != null ? String(body.digit) : null;
  const tenantId = String(body.tenant_id || '').trim();
  if (tenantId && db) {
    const resolved = resolveTenantIvrSelection(db, tenantId, menuId, digit);
    return {
      data: {
        menu: resolved.menu,
        route: {
          route_type: resolved.route_type,
          route_target: resolved.route_target,
          label: resolved.label
        }
      }
    };
  }
  const route = resolveIvrSelection(menuId, digit);
  const menu = getIvrMenu(menuId);
  return { data: { menu, route } };
}

export async function pausePciRecordingCommand(
  db: unknown,
  tenantId: string,
  callSessionId: string
) {
  const service = new RecordingPciService(db, new VoiceStore(db));
  return { data: await service.pauseForPci(tenantId, callSessionId) };
}

export async function resumePciRecordingCommand(
  db: unknown,
  tenantId: string,
  callSessionId: string,
  roomName: string
) {
  const service = new RecordingPciService(db, new VoiceStore(db));
  return { data: await service.resumeAfterPci(tenantId, callSessionId, roomName) };
}

export function listAgentScriptsCommand(db: unknown, tenantId: string) {
  const store = new AgentScriptStore(db);
  store.seedDefault(tenantId);
  return { data: store.listTemplates(tenantId) };
}

export function getAgentScriptProgressCommand(db: unknown, tenantId: string, callSessionId: string) {
  const scriptStore = new AgentScriptStore(db);
  scriptStore.seedDefault(tenantId);
  const template = scriptStore.listTemplates(tenantId)[0];
  if (!template) throw Object.assign(new Error('no script template'), { status: 404 });
  const tracker = new AgentScriptTracker(new VoiceStore(db));
  return { data: tracker.getProgress(tenantId, callSessionId, template) };
}

export function advanceAgentScriptCommand(db: unknown, tenantId: string, callSessionId: string) {
  const scriptStore = new AgentScriptStore(db);
  const template = scriptStore.listTemplates(tenantId)[0];
  if (!template) throw Object.assign(new Error('no script template'), { status: 404 });
  const tracker = new AgentScriptTracker(new VoiceStore(db));
  return { data: tracker.advanceStep(tenantId, callSessionId, template) };
}

export function completeWarmTransferCommand(
  db: unknown,
  tenantId: string,
  callSessionId: string,
  body: { from_seat_id: string; target_seat_id: string; reason?: string },
  userId: string
) {
  assertSeatOwnership(db, tenantId, body.from_seat_id, userId);
  const service = new CallTransferService(
    new VoiceStore(db),
    new AgentSeatStore(db),
    new LiveKitRoomStore(db)
  );
  return {
    data: service.completeWarmTransfer({
      tenantId,
      callSessionId,
      fromSeatId: body.from_seat_id,
      targetSeatId: body.target_seat_id,
      reason: body.reason
    })
  };
}
