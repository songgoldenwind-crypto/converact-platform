import { resolveBrandEnv } from '../../../config/converact-env.js';
import { resolveAuthContext } from '../../../middleware/auth.js';
import { broadcastOmniMessage, broadcastSentimentAlert } from '../../../call-center-events.js';
import { emitTenantWebhookEvent } from '../webhooks/webhook-emitter.js';
import { createOutboundTaskCommand } from '../application.js';
import { createLiveKitRoomCommand } from '../application.js';
import { buildVideoInviteSms, createSMSSender } from '../sms-sender.js';
import { createLiveKitMediaModule } from '../../livekit/index.js';
import { receiveOmniInbound, sendOmniOutbound } from './omni-adapters.js';
import {
  buildCustomerKey,
  getCustomerJourney,
  processDueNotifications,
  recordJourneyEvent,
  scheduleNotification
} from './omni-service.js';
import { OmniStore } from './omni-store.js';

function requireAuth(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  return ctx;
}

/** Verify webhook key for external platform callbacks (SMS/email/wechat/whatsapp).
 *  Uses CONVERACT_WEBHOOK_KEY env var — external platforms must send X-Webhook-Key header. */
function requireWebhookKey(headers: Record<string, string | string[] | undefined>): void {
  const provided = (headers['X-Webhook-Key'] || headers['x-webhook-key']) as string | undefined;
  const expected = resolveBrandEnv(process.env, 'WEBHOOK_KEY');
  if (!expected || !provided || provided !== expected) {
    throw Object.assign(new Error('invalid webhook key'), { status: 401 });
  }
}

function publicJoinUrl(joinPath: string): string {
  const baseUrl = (resolveBrandEnv(process.env, 'PUBLIC_BASE_URL') || 'http://localhost:3000').replace(/\/+$/, '');
  return `${baseUrl}${joinPath.startsWith('/') ? joinPath : `/${joinPath}`}`;
}

export async function routeOmniApi(
  db: unknown,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  const store = new OmniStore(db);

  if (path === '/api/call-center/omni/inbox' && method === 'GET') {
    const ctx = requireAuth(headers);
    const status = url.searchParams.get('status') as any;
    const channel = url.searchParams.get('channel') as any;
    const seatId = url.searchParams.get('seat_id');
    return {
      data: store.listInbox(ctx.tenantId!, {
        status: status || null,
        channel: channel || null,
        seat_id: seatId || null
      })
    };
  }

  const convMatch = path.match(/^\/api\/call-center\/omni\/conversations\/([^/]+)$/);
  if (convMatch && method === 'GET') {
    const ctx = requireAuth(headers);
    const conv = store.getConversation(convMatch[1]);
    if (!conv || conv.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'conversation not found' } };
    }
    return {
      data: {
        conversation: conv,
        messages: store.listMessages(conv.id),
        journey: getCustomerJourney(db, ctx.tenantId!, buildCustomerKey(conv), 30)
      }
    };
  }

  const assignMatch = path.match(/^\/api\/call-center\/omni\/conversations\/([^/]+)\/assign$/);
  if (assignMatch && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as { seat_id?: string };
    if (!input.seat_id) return { status: 400, data: { error: 'seat_id required' } };
    const updated = store.assignConversation(assignMatch[1], ctx.tenantId!, input.seat_id);
    if (!updated) return { status: 404, data: { error: 'conversation not found' } };
    return { data: updated };
  }

  const replyMatch = path.match(/^\/api\/call-center\/omni\/conversations\/([^/]+)\/reply$/);
  if (replyMatch && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as { content?: string; seat_id?: string };
    if (!input.content?.trim()) return { status: 400, data: { error: 'content required' } };
    const conv = store.getConversation(replyMatch[1]);
    if (!conv || conv.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'conversation not found' } };
    }
    const result = await sendOmniOutbound(
      { db, store },
      {
      tenant_id: ctx.tenantId!,
      channel: conv.channel,
      conversation_id: conv.id,
      content: input.content.trim(),
      seat_id: input.seat_id
    });
    broadcastOmniMessage(ctx.tenantId!, {
      conversation_id: conv.id,
      message: result.message as unknown as Record<string, unknown>
    });
    return { data: result };
  }

  const voiceMatch = path.match(/^\/api\/call-center\/omni\/conversations\/([^/]+)\/escalate-voice$/);
  if (voiceMatch && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as { phone_number?: string; agent_spec_id?: string; seat_id?: string };
    const conv = store.getConversation(voiceMatch[1]);
    if (!conv || conv.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'conversation not found' } };
    }
    const phone = input.phone_number || conv.customer_phone;
    if (!phone) return { status: 400, data: { error: 'phone_number required' } };

    const taskResult = createOutboundTaskCommand(db, {
      tenant_id: ctx.tenantId!,
      phone_number: phone,
      channel: 'pstn_voice',
      strategy: {
        agent_spec_id: input.agent_spec_id,
        omni_conversation_id: conv.id,
        context_summary: conv.last_message_preview,
        source: 'omni_escalate'
      },
      priority: 8
    });
    const task = (taskResult as { data: { id: string } }).data;
    store.updateConversation(conv.id, {
      metadata: { ...conv.metadata, escalated_task_id: task.id },
      status: 'assigned'
    });
    if (input.seat_id) store.assignConversation(conv.id, ctx.tenantId!, input.seat_id);

    recordJourneyEvent(db, {
      tenant_id: ctx.tenantId!,
      customer_key: buildCustomerKey(conv),
      event_type: 'escalate_voice',
      channel: conv.channel,
      summary: `聊天升级外呼 ${phone}`,
      ref_id: task.id
    });

    return { data: { task, conversation_id: conv.id } };
  }

  const videoMatch = path.match(/^\/api\/call-center\/omni\/conversations\/([^/]+)\/escalate-video$/);
  if (videoMatch && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as { phone_number?: string; identity?: string };
    const conv = store.getConversation(videoMatch[1]);
    if (!conv || conv.tenant_id !== ctx.tenantId) {
      return { status: 404, data: { error: 'conversation not found' } };
    }
    const phone = input.phone_number || conv.customer_phone;
    if (!phone) return { status: 400, data: { error: 'phone_number required' } };

    const roomResult = await createLiveKitRoomCommand(db, {
      tenant_id: ctx.tenantId!,
      purpose: 'video_service',
      metadata: { omni_conversation_id: conv.id, source_channel: conv.channel }
    });
    const room = (roomResult as { data: { room_name: string } }).data;
    const media = createLiveKitMediaModule({ db });
    const customerPlan = await media.joins.prepareJoin('webrtc', {
      tenantId: ctx.tenantId!,
      roomName: room.room_name,
      identity: input.identity || `customer-${phone}`,
      role: 'customer',
      media: 'video',
      contact: { phone }
    });
    if (customerPlan.mode !== 'webrtc' || !customerPlan.joinPath) {
      throw Object.assign(new Error('customer video join path unavailable'), { status: 500 });
    }
    const joinUrl = publicJoinUrl(customerPlan.joinPath);
    const smsBody = buildVideoInviteSms({ url: joinUrl, company: 'OPC' });
    const sms = createSMSSender();
    await sms.send({ to: phone, body: smsBody, tenant_id: ctx.tenantId! });

    store.updateConversation(conv.id, {
      metadata: { ...conv.metadata, video_room: room.room_name },
      status: 'assigned'
    });

    recordJourneyEvent(db, {
      tenant_id: ctx.tenantId!,
      customer_key: buildCustomerKey(conv),
      event_type: 'escalate_video',
      channel: conv.channel,
      summary: `发起视频通话 ${room.room_name}`,
      ref_id: conv.id
    });

    return { data: { room, token: customerPlan.token, join_url: joinUrl, customer_join_plan: customerPlan } };
  }

  if (path === '/api/call-center/omni/journey' && method === 'GET') {
    const ctx = requireAuth(headers);
    const customerKey = url.searchParams.get('customer_key');
    if (!customerKey) return { status: 400, data: { error: 'customer_key required' } };
    return { data: getCustomerJourney(db, ctx.tenantId!, customerKey) };
  }

  if (path === '/api/call-center/omni/chat' && method === 'POST') {
    const input = body as {
      tenant_id?: string;
      content?: string;
      customer_name?: string;
      customer_phone?: string;
      customer_email?: string;
      conversation_id?: string;
    };
    if (!input.tenant_id?.trim()) {
      return { status: 400, data: { error: 'tenant_id required' } };
    }
    if (!input.content?.trim()) {
      return { status: 400, data: { error: 'content required' } };
    }
    const result = await receiveOmniInbound(
      { db, store },
      {
        tenant_id: input.tenant_id,
        channel: 'web_chat',
        content: input.content.trim(),
        customer_name: input.customer_name,
        customer_phone: input.customer_phone,
        customer_email: input.customer_email,
        external_id: input.conversation_id
      }
    );
    broadcastOmniMessage(input.tenant_id, {
      conversation_id: result.conversation.id,
      message: result.inbound as unknown as Record<string, unknown>
    });
    void emitTenantWebhookEvent(db, input.tenant_id, 'omni.message', {
      conversation_id: result.conversation.id,
      channel: 'web_chat',
      direction: 'inbound'
    }).catch(() => undefined);
    if (result.sentiment && result.sentiment.label === 'angry') {
      broadcastSentimentAlert(input.tenant_id, {
        conversation_id: result.conversation.id,
        channel: 'web_chat',
        label: result.sentiment.label,
        score: result.sentiment.score,
        snippet: input.content.slice(0, 80)
      });
    }
    return {
      data: {
        conversation_id: result.conversation.id,
        reply: result.outbound?.content || '',
        intent_score: result.bot_reply?.intent_score,
        should_escalate: result.bot_reply?.should_escalate
      }
    };
  }

  if (path === '/api/call-center/omni/webhooks/sms' && method === 'POST') {
    requireWebhookKey(headers);
    const input = body as {
      tenant_id?: string;
      From?: string;
      Body?: string;
      MessageSid?: string;
    };
    if (!input.tenant_id) return { status: 400, data: { error: 'tenant_id required' } };
    const result = await receiveOmniInbound(
      { db, store },
      {
        tenant_id: input.tenant_id,
        channel: 'sms',
        content: input.Body || '',
        customer_phone: input.From,
        external_id: input.MessageSid
      }
    );
    broadcastOmniMessage(input.tenant_id, {
      conversation_id: result.conversation.id,
      message: result.inbound as unknown as Record<string, unknown>
    });
    return { data: { ok: true, conversation_id: result.conversation.id } };
  }

  if (path === '/api/call-center/omni/webhooks/email' && method === 'POST') {
    requireWebhookKey(headers);
    const input = body as {
      tenant_id?: string;
      from?: string;
      subject?: string;
      body?: string;
      message_id?: string;
    };
    if (!input.tenant_id) return { status: 400, data: { error: 'tenant_id required' } };
    const content = [input.subject, input.body].filter(Boolean).join('\n');
    const result = await receiveOmniInbound(
      { db, store },
      {
        tenant_id: input.tenant_id,
        channel: 'email',
        content,
        customer_email: input.from,
        external_id: input.message_id
      }
    );
    return { data: { ok: true, conversation_id: result.conversation.id } };
  }

  if (path === '/api/call-center/omni/webhooks/wechat' && method === 'POST') {
    requireWebhookKey(headers);
    const input = body as { tenant_id?: string; from?: string; content?: string; msg_id?: string };
    if (!input.tenant_id) return { status: 400, data: { error: 'tenant_id required' } };
    const result = await receiveOmniInbound(
      { db, store },
      {
        tenant_id: input.tenant_id,
        channel: 'wechat',
        content: input.content || '',
        customer_id: input.from,
        external_id: input.msg_id
      }
    );
    return { data: { ok: true, conversation_id: result.conversation.id } };
  }

  if (path === '/api/call-center/omni/webhooks/whatsapp' && method === 'POST') {
    requireWebhookKey(headers);
    const input = body as { tenant_id?: string; from?: string; content?: string; message_id?: string };
    if (!input.tenant_id) return { status: 400, data: { error: 'tenant_id required' } };
    const result = await receiveOmniInbound(
      { db, store },
      {
        tenant_id: input.tenant_id,
        channel: 'whatsapp',
        content: input.content || '',
        customer_phone: input.from,
        external_id: input.message_id
      }
    );
    return { data: { ok: true, conversation_id: result.conversation.id } };
  }

  if (path === '/api/call-center/omni/notifications/schedule' && method === 'POST') {
    const ctx = requireAuth(headers);
    const input = body as {
      channel?: 'sms' | 'email';
      target?: string;
      template_key?: string;
      payload?: Record<string, unknown>;
      scheduled_at?: string;
    };
    if (!input.channel || !input.target || !input.template_key || !input.scheduled_at) {
      return { status: 400, data: { error: 'channel, target, template_key, scheduled_at required' } };
    }
    const notifyId = scheduleNotification(db, {
      tenant_id: ctx.tenantId!,
      channel: input.channel,
      target: input.target,
      template_key: input.template_key,
      payload: input.payload || {},
      scheduled_at: input.scheduled_at
    });
    return { status: 201, data: { id: notifyId } };
  }

  if (path === '/api/call-center/omni/notifications/process-due' && method === 'POST') {
    const sent = await processDueNotifications(db);
    return { data: { processed: sent } };
  }

  if (path === '/api/call-center/omni/adapters' && method === 'GET') {
    const { getOmniChannelRegistry } = await import('./omni-adapters.js');
    return { data: getOmniChannelRegistry().list() };
  }

  return undefined;
}
