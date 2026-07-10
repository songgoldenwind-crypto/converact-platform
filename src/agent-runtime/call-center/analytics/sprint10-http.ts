import { resolveAuthContext } from '../../../middleware/auth.js';
import {
  createBatchJob,
  getBatchJob,
  runBatchRecordingAnalysis
} from '../analytics/recording-batch-analyzer.js';
import { getUnifiedCustomerJourney } from '../omnichannel/customer-journey.js';
import { createLiveKitRoomCommand, issueLiveKitTokenCommand } from '../application.js';
import { createLiveKitMediaModule } from '../../livekit/index.js';

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

export async function routeSprint10Api(
  db: unknown,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  if (path === '/api/call-center/journey/unified' && method === 'GET') {
    const ctx = requireAuth(headers);
    const phone = url.searchParams.get('phone') || undefined;
    const email = url.searchParams.get('email') || undefined;
    const customerId = url.searchParams.get('customer_id') || undefined;
    if (!phone && !email && !customerId) {
      return { status: 400, data: { error: 'phone, email, or customer_id required' } };
    }
    return {
      data: getUnifiedCustomerJourney(db, ctx.tenantId!, { phone, email, customer_id: customerId })
    };
  }

  if (path === '/api/call-center/recordings/batch-analyze' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as {
      q?: string;
      date_from?: string;
      date_to?: string;
      limit?: number;
    };
    const jobId = createBatchJob(db, {
      tenant_id: ctx.tenantId!,
      q: input.q,
      date_from: input.date_from,
      date_to: input.date_to,
      limit: input.limit
    });
    const result = await runBatchRecordingAnalysis(db, jobId);
    return { status: 201, data: { job_id: jobId, result } };
  }

  const batchMatch = path.match(/^\/api\/call-center\/recordings\/batch-analyze\/([^/]+)$/);
  if (batchMatch && method === 'GET') {
    const ctx = requireAuth(headers);
    const job = getBatchJob(db, batchMatch[1]);
    if (!job || job.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'job not found' } };
    }
    return { data: job };
  }

  if (path === '/api/call-center/video/start' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as {
      call_session_id?: string;
      customer_phone?: string;
      customer_channel?: string;
      enable_screen_share?: boolean;
    };
    // Customer leg channel — webrtc (H5) today; sip_volte (4G VoLTE) later.
    // Recorded in room metadata so the join mechanism stays pluggable.
    const customerChannel = input.customer_channel || 'webrtc';
    const roomResult = await createLiveKitRoomCommand(db, {
      tenant_id: ctx.tenantId!,
      purpose: input.enable_screen_share ? 'screen_share' : 'video_service',
      call_session_id: input.call_session_id,
      metadata: {
        customer_phone: input.customer_phone,
        initiated_by: 'agent',
        customer_leg_type: customerChannel
      }
    });
    const room = (roomResult as { data: { room_name: string } }).data;
    const agentToken = await issueLiveKitTokenCommand(db, {
      room_name: room.room_name,
      identity: `agent-${ctx.userId}`,
      role: 'agent',
      tenant_id: ctx.tenantId!
    });

    // Prepare the customer's join plan through the reusable media module.
    // webrtc → H5 join path; sip_volte → SIP dial instructions for RustPBX.
    const media = createLiveKitMediaModule({ db });
    const customerPlan = await media.joins.prepareJoin(customerChannel, {
      tenantId: ctx.tenantId!,
      roomName: room.room_name,
      identity: `customer-${room.room_name.slice(-6)}`,
      role: 'customer',
      media: 'video',
      contact: { phone: input.customer_phone }
    });

    return {
      data: {
        room,
        agent_token: (agentToken as { data: unknown }).data,
        customer_channel: customerChannel,
        // Back-compat: keep customer_join_path for webrtc H5 callers.
        customer_join_path:
          customerPlan.mode === 'webrtc'
            ? customerPlan.joinPath
            : undefined,
        customer_join_plan: customerPlan
      }
    };
  }

  return undefined;
}
