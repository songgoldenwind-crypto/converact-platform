import type { AgentSeatStore } from './seat-store.js';
import type { OutboundTaskStore } from './outbound-task-store.js';
import type { CallRouterRequest, CallRouterResponse } from './types.js';
import { readLiveKitConfig } from '../livekit/config.js';

export interface CallRouterDeps {
  seatStore: AgentSeatStore;
  outboundTaskStore: OutboundTaskStore;
  defaultTenantId?: string | null;
}

export function resolveCallRouterTenantId(request: CallRouterRequest, defaultTenantId: string | null): string | null {
  const headerTenant =
    request.headers?.['X-Tenant-Id'] ||
    request.headers?.['x-tenant-id'];
  return String(headerTenant || defaultTenantId || '').trim() || null;
}

export function decideCallRoute(request: CallRouterRequest, deps: CallRouterDeps): CallRouterResponse {
  const livekitTarget = readLiveKitConfig().sipBridgeTarget;
  const tenantId = resolveCallRouterTenantId(request, deps.defaultTenantId || null);
  const metadata: Record<string, string> = {
    call_id: request.call_id,
    direction: request.direction
  };
  if (tenantId) metadata.tenant_id = tenantId;

  if (request.direction === 'outbound') {
    const phone = extractPhone(request.to_uri || request.to || '');
    const activeTask = tenantId && phone ? deps.outboundTaskStore.findActiveTaskByPhone(tenantId, phone) : null;
    if (activeTask) {
      metadata.outbound_task_id = activeTask.id;
      metadata.channel = activeTask.channel;
    }
    return {
      action: 'forward',
      targets: [livekitTarget],
      record: true,
      timeout_sec: 30,
      metadata
    };
  }

  if (!tenantId) {
    return rejectCall('missing tenant', 603);
  }

  const idleSeats = deps.seatStore.countIdleSeats(tenantId);
  if (idleSeats > 0) {
    return {
      action: 'queue',
      queue_name: 'default',
      record: true,
      metadata
    };
  }

  return {
    action: 'forward',
    targets: [livekitTarget],
    record: true,
    timeout_sec: 30,
    metadata: {
      ...metadata,
      routed_to: 'ai_agent'
    }
  };
}

function rejectCall(reason: string, code: number): CallRouterResponse {
  return { action: 'reject', code, reason, record: false };
}

function extractPhone(uri: string): string {
  const match = String(uri).match(/\+?\d{8,15}/);
  return match ? match[0] : '';
}
