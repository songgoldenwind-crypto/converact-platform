import { readLiveKitConfig } from '../../livekit/config.js';
import { broadcastCallIncoming } from '../../../call-center-events.js';
import { VoiceStore } from '../../voice/voice-store.js';
import { AgentSeatStore } from '../seat-store.js';
import type { CallRouterRequest, CallRouterResponse } from '../types.js';
import { resolveCallRouterTenantId } from '../call-router.js';
import { AcdEngine } from './acd-engine.js';
import { AutoAttendantService } from './auto-attendant.js';
import { CallQueueStore } from './call-queue.js';
import { DidStore, normalizeDidNumber } from './did-store.js';
import { QueueCallbackService } from './queue-callback.js';
import { VoicemailStore } from '../agent-tools/voicemail.js';
import { resolveIvrRoute } from '../../ivr/ivr-inbound-routing.js';
import { buildChannelVariablesFromInbound } from '../../ivr/ivr-channel-vars.js';
import { IvrSessionStore } from '../../ivr/ivr-session-store.js';
import { performQueueEnqueueCore } from '../../ivr/ivr-acd-adapter.js';
import type { DidRouteType, InboundRouteContext } from './types.js';

export interface InboundRouterDeps {
  didStore: DidStore;
  queueStore: CallQueueStore;
  acdEngine: AcdEngine;
  seatStore: AgentSeatStore;
  voiceStore: VoiceStore;
  autoAttendant: AutoAttendantService;
  queueCallback: QueueCallbackService;
  defaultTenantId?: string | null;
}

export interface InboundRouteResult {
  response: CallRouterResponse;
  context: InboundRouteContext;
}

function extractPhone(uri: string): string {
  const match = String(uri).match(/\+?\d{8,15}/);
  return match ? match[0] : '';
}

function extractDid(request: CallRouterRequest): string {
  return normalizeDidNumber(extractPhone(request.to_uri || request.to || ''));
}

function rejectCall(reason: string, code: number): CallRouterResponse {
  return { action: 'reject', code, reason, record: false };
}

function buildLivekitForward(metadata: Record<string, string>, routedTo: string): CallRouterResponse {
  const livekitTarget = readLiveKitConfig().sipBridgeTarget;
  return {
    action: 'forward',
    targets: [livekitTarget],
    record: true,
    timeout_sec: 30,
    metadata: { ...metadata, routed_to: routedTo }
  };
}

export async function routeInboundCall(request: CallRouterRequest, deps: InboundRouterDeps): Promise<InboundRouteResult> {
  const didNumber = extractDid(request);
  const did = didNumber ? deps.didStore.findByNumber(didNumber) : null;
  const headerTenant = resolveCallRouterTenantId(request, deps.defaultTenantId || null);
  const tenantId = did?.tenant_id || headerTenant;

  const metadata: Record<string, string> = {
    call_id: request.call_id,
    direction: request.direction
  };
  if (tenantId) metadata.tenant_id = tenantId;

  if (!tenantId) {
    return {
      response: rejectCall('missing tenant', 603),
      context: { tenant_id: '' }
    };
  }

  const callerPhone = extractPhone(request.from_uri || request.from || '');
  const session = deps.voiceStore.createCallSession({
    tenant_id: tenantId,
    direction: 'inbound',
    rustpbx_call_id: request.call_id,
    phone: callerPhone,
    status: 'ringing',
    metadata: {
      did: didNumber,
      from_display: request.from_display || '',
      trunk_name: request.trunk_name || ''
    }
  });

  metadata.call_session_id = session.id;

  try {
    if (!deps.autoAttendant.isWithinBusinessHours(tenantId)) {
      const config = deps.autoAttendant.getConfig(tenantId);
      const afterHours = await routeByType(
        tenantId,
        config.after_hours_route_type as DidRouteType,
        config.after_hours_route_target,
        request,
        deps,
        session.id,
        metadata,
        { announcement_text: config.announcement_text }
      );
      return {
        ...afterHours,
        context: { ...afterHours.context, tenant_id: tenantId, call_session_id: session.id, after_hours: true }
      };
    }

    const routeType = (did?.route_type || inferLegacyRouteType(deps, tenantId)) as DidRouteType;
    const routeTarget = did?.route_target || 'default';

    const routed = await routeByType(tenantId, routeType, routeTarget, request, deps, session.id, metadata, {
      vip_priority: Number(request.headers?.['X-VIP-Priority'] || request.headers?.['x-vip-priority'] || 0)
    });
    return {
      ...routed,
      context: { ...routed.context, tenant_id: tenantId, call_session_id: session.id }
    };
  } catch (err) {
    // Routing failed after session was created — mark session as failed
    // to prevent orphan 'ringing' records that pollute wallboard counts.
    try {
      deps.voiceStore.updateCallSession(tenantId, session.id, {
        status: 'failed',
        ended_at: new Date().toISOString()
      });
    } catch { /* best-effort cleanup */ }
    throw err;
  }
}

function inferLegacyRouteType(deps: InboundRouterDeps, tenantId: string): DidRouteType {
  const idleSeats = deps.seatStore.countIdleSeats(tenantId);
  return idleSeats > 0 ? 'queue' : 'ai';
}

async function routeByType(
  tenantId: string,
  routeType: DidRouteType | 'announcement',
  routeTarget: string | null,
  request: CallRouterRequest,
  deps: InboundRouterDeps,
  callSessionId: string,
  metadata: Record<string, string>,
  options: { announcement_text?: string; vip_priority?: number } = {}
): Promise<InboundRouteResult> {
  switch (routeType) {
    case 'ai':
      return {
        response: buildLivekitForward(metadata, 'ai_inbound_agent'),
        context: { tenant_id: tenantId, call_session_id: callSessionId }
      };
    case 'ivr': {
      const channelVariables = buildChannelVariablesFromInbound(request, metadata);
      const mediaType =
        metadata.media_type === 'video' ? ('video' as const) : undefined;
      const ivrRoute = await resolveIvrRoute(
        deps.voiceStore.db,
        tenantId,
        callSessionId,
        routeTarget || undefined,
        { channelVariables, mediaType }
      );
      if (ivrRoute.hasFlow && ivrRoute.session) {
        const sessionStore = new IvrSessionStore(deps.voiceStore.db);
        sessionStore.upsert({
          callSessionId,
          tenantId,
          flowId: ivrRoute.session.flowId,
          context: ivrRoute.session.context,
          stepCount: ivrRoute.session.stepCount,
          terminated: ivrRoute.session.terminated,
          lastAction: ivrRoute.session.lastAction,
        });
      }
      if (!ivrRoute.hasFlow) {
        return {
          response: rejectCall('ivr flow unavailable', 603),
          context: { tenant_id: tenantId, call_session_id: callSessionId },
        };
      }
      // RustPBX HTTP Router only accepts forward|reject|abort|not_handled|spam.
      // Session + IVR state are already persisted; static route app=rwi picks up the call.
      return {
        response: {
          action: 'not_handled' as const,
          record: true,
          metadata: {
            ...metadata,
            ivr_target: routeTarget || 'default',
            ivr_flow_id: ivrRoute.flowId,
            ivr_has_flow: 'true',
            ivr_first_prompt: ivrRoute.firstPrompt,
          },
        },
        context: { tenant_id: tenantId, call_session_id: callSessionId },
      };
    }
    case 'voicemail': {
      const callerPhone = extractPhone(request.from_uri || request.from || '');
      new VoicemailStore(deps.voiceStore.db).createVoicemail({
        tenant_id: tenantId,
        call_session_id: callSessionId,
        from_number: callerPhone,
        mailbox: routeTarget || 'default'
      });
      return {
        response: {
          action: 'voicemail',
          record: true,
          metadata: { ...metadata, mailbox: routeTarget || 'default' }
        },
        context: { tenant_id: tenantId, call_session_id: callSessionId }
      };
    }
    case 'announcement':
      return {
        response: {
          action: 'ivr',
          record: false,
          metadata: {
            ...metadata,
            announcement: options.announcement_text || '非工作时间，请稍后再拨。'
          }
        },
        context: { tenant_id: tenantId, call_session_id: callSessionId, after_hours: true }
      };
    case 'queue':
    default:
      return await routeToQueue(tenantId, routeTarget || 'default', callSessionId, request, deps, metadata, options);
  }
}

async function routeToQueue(
  tenantId: string,
  queueNameOrId: string,
  callSessionId: string,
  request: CallRouterRequest,
  deps: InboundRouterDeps,
  metadata: Record<string, string>,
  options: { vip_priority?: number }
): Promise<InboundRouteResult> {
  let queue =
    deps.queueStore.getQueue(queueNameOrId) ||
    deps.queueStore.getQueueByName(tenantId, queueNameOrId) ||
    ensureDefaultQueue(deps, tenantId);

  if (!queue.is_active) {
    return {
      response: rejectCall('queue inactive', 603),
      context: { tenant_id: tenantId, call_session_id: callSessionId, queue_id: queue.id }
    };
  }

  const waitingCount = deps.queueStore.countWaiting(queue.id);
  if (waitingCount >= queue.max_size && queue.overflow_target) {
    const overflow = resolveOverflowRoute(deps, tenantId, queue.overflow_target);
    const overflowResult = await routeByType(
      tenantId,
      overflow.routeType,
      overflow.routeTarget,
      request,
      deps,
      callSessionId,
      { ...metadata, overflow_from_queue: queue.id },
      options
    );
    return {
      ...overflowResult,
      context: { ...overflowResult.context, overflow_applied: true }
    };
  }

  const vipPriority = options.vip_priority || 0;
  const core = performQueueEnqueueCore({
    queueStore: deps.queueStore,
    acdEngine: deps.acdEngine,
    queueId: queue.id,
    callSessionId,
    strategy: queue.strategy,
    priority: vipPriority,
  });
  const entry = deps.queueStore.getEntry(core.queueEntryId);
  const availableAgents = deps.acdEngine.countAvailableAgents(queue.id);
  const status = deps.queueStore.getQueueStatus(queue.id, availableAgents);
  const waitSec = status.estimated_wait_sec;

  metadata.queue_id = queue.id;
  metadata.queue_name = queue.name;
  metadata.queue_position = String(entry?.position ?? 1);
  metadata.estimated_wait_sec = String(waitSec);
  metadata.position_announcement = `您前面还有 ${Math.max(0, (entry?.position ?? 1) - 1)} 位，预计等待 ${Math.ceil(waitSec / 60)} 分钟`;
  if (queue.music_url) metadata.hold_music_url = queue.music_url;
  if (deps.queueCallback.shouldOfferCallback(queue.id, waitSec)) {
    metadata.callback_available = 'true';
  }

  let seat: { id: string; user_id: string } | undefined;
  if (core.status === 'connected') {
    seat = deps.seatStore.getSeat(core.agentId) ?? undefined;
    deps.voiceStore.updateCallSession(tenantId, callSessionId, {
      metadata: {
        queue_id: queue.id,
        queue_entry_id: core.queueEntryId,
        assigned_seat_id: core.agentId,
      },
    });
    const roomName = `${tenantId}-pstn_bridge-${callSessionId.slice(-8)}`;
    broadcastCallIncoming(tenantId, {
      call_session_id: callSessionId,
      room_name: roomName,
      seat_id: core.agentId,
      target_user_id: seat?.user_id ?? '',
      from: extractPhone(request.from_uri || request.from || ''),
      customer_summary: `呼入队列 ${queue.name}`,
      intent_score: vipPriority > 0 ? 0.9 : undefined,
      transfer_reason: 'inbound_acd',
    });
    metadata.assigned_seat_id = core.agentId;
  }

  return {
    response: {
      action: 'queue',
      queue_name: queue.name,
      priority: vipPriority,
      record: true,
      metadata
    },
    context: {
      tenant_id: tenantId,
      call_session_id: callSessionId,
      queue_id: queue.id,
      queue_entry_id: core.queueEntryId,
      queue_position: entry?.position ?? 1,
      estimated_wait_sec: waitSec,
      assigned_seat_id: seat?.id
    }
  };
}

function ensureDefaultQueue(deps: InboundRouterDeps, tenantId: string): ReturnType<CallQueueStore['createQueue']> {
  const existing = deps.queueStore.getQueueByName(tenantId, 'default');
  if (existing) return existing;
  // Handle TOCTOU race: concurrent first-callers may both reach here.
  // UNIQUE(tenant_id, name) constraint will reject the second INSERT;
  // catch and re-fetch instead of crashing the inbound call.
  try {
    const queue = deps.queueStore.createQueue({ tenant_id: tenantId, name: 'default' });
    for (const seat of deps.seatStore.listSeats(tenantId)) {
      deps.queueStore.addMember(queue.id, seat.id, 1);
    }
    return queue;
  } catch {
    const raced = deps.queueStore.getQueueByName(tenantId, 'default');
    if (raced) return raced;
    throw new Error('failed to ensure default queue');
  }
}

function resolveOverflowRoute(
  deps: InboundRouterDeps,
  tenantId: string,
  overflowTarget: string
): { routeType: DidRouteType | 'announcement'; routeTarget: string | null } {
  const asQueue = deps.queueStore.getQueue(overflowTarget) || deps.queueStore.getQueueByName(tenantId, overflowTarget);
  if (asQueue) return { routeType: 'queue', routeTarget: asQueue.id };
  if (overflowTarget === 'ai') return { routeType: 'ai', routeTarget: null };
  if (overflowTarget === 'voicemail') return { routeType: 'voicemail', routeTarget: 'overflow' };
  return { routeType: 'ai', routeTarget: null };
}

export function buildInboundRouterDeps(
  db: unknown,
  harness: { voiceStore?: VoiceStore; defaultTenantId?: string | null }
): InboundRouterDeps {
  const seatStore = new AgentSeatStore(db);
  const queueStore = new CallQueueStore(db);
  return {
    didStore: new DidStore(db),
    queueStore,
    acdEngine: new AcdEngine(db, seatStore, queueStore),
    seatStore,
    voiceStore: harness.voiceStore || new VoiceStore(db),
    autoAttendant: new AutoAttendantService(db),
    queueCallback: new QueueCallbackService(db),
    defaultTenantId: harness.defaultTenantId || null
  };
}
