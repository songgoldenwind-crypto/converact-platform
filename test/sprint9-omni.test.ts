import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase } from '../src/db.js';
import { createTenant } from '../src/platform/tenant-core.js';
import { useMemoryRedisForTests } from '../src/agent-runtime/call-center/call-center-runtime.js';
import { AgentSeatStore } from '../src/agent-runtime/call-center/seat-store.js';
import { OmniStore } from '../src/agent-runtime/call-center/omnichannel/omni-store.js';
import {
  buildCustomerKey,
  detectSentiment,
  processInboundOmniMessage,
  scheduleNotification,
  processDueNotifications,
  getCustomerJourney
} from '../src/agent-runtime/call-center/omnichannel/omni-service.js';
import { receiveOmniInbound, getOmniChannelRegistry } from '../src/agent-runtime/call-center/omnichannel/omni-adapters.js';
import { routeOmniApi } from '../src/agent-runtime/call-center/omnichannel/omni-http.js';
import { verifyMediaInvite } from '../src/agent-runtime/livekit/invite-token.js';

const OMNI_API_KEY = 'test-sprint9-key';

function omniAuth(tenantId: string): Record<string, string> {
  return { 'X-API-Key': OMNI_API_KEY, 'X-Tenant-Id': tenantId };
}

describe('Sprint 9 omnichannel', () => {
  let db: ReturnType<typeof createDatabase>;
  let tenantId: string;

  before(() => {
    useMemoryRedisForTests();
    process.env.OPC_API_KEY = OMNI_API_KEY;
    process.env.OPC_WEBHOOK_KEY = OMNI_API_KEY;
    db = createDatabase(':memory:');
    tenantId = createTenant(db, { name: 'Omni Test' }).id;
  });

  it('creates conversation and bot reply on web chat inbound', async () => {
    const store = new OmniStore(db);
    const result = await processInboundOmniMessage(db, store, {
      tenant_id: tenantId,
      channel: 'web_chat',
      content: '你好，我想了解价格',
      customer_name: '测试用户'
    });
    assert.ok(result.conversation.id);
    assert.equal(result.inbound.sender_type, 'customer');
    assert.ok(result.outbound);
    assert.ok(result.bot_reply);
    const messages = store.listMessages(result.conversation.id);
    assert.equal(messages.length, 2);
  });

  it('detects angry sentiment', () => {
    const s = detectSentiment('太差了！我要投诉！骗子！');
    assert.equal(s.label, 'angry');
    assert.ok(s.score >= 0.8);
  });

  it('records customer journey events', async () => {
    const store = new OmniStore(db);
    await receiveOmniInbound(
      { db, store },
      {
        tenant_id: tenantId,
        channel: 'sms',
        content: '预约咨询',
        customer_phone: '+819012345678'
      }
    );
    const key = buildCustomerKey({ customer_phone: '+819012345678' });
    const events = getCustomerJourney(db, tenantId, key);
    assert.ok(events.length >= 1);
    assert.equal(events[0].event_type, 'message_inbound');
  });

  it('processes due scheduled notifications', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    scheduleNotification(db, {
      tenant_id: tenantId,
      channel: 'sms',
      target: '+819011111111',
      template_key: 'verification_code',
      payload: { code: '123456' },
      scheduled_at: past
    });
    const sent = await processDueNotifications(db);
    assert.equal(sent, 1);
  });

  it('assigns conversation to seat', () => {
    const store = new OmniStore(db);
    const seatStore = new AgentSeatStore(db);
    const seat = seatStore.upsertSeat({
      tenant_id: tenantId,
      user_id: 'user-1',
      display_name: 'Agent 1'
    });
    const conv = store.findOrCreateConversation({
      tenant_id: tenantId,
      channel: 'email',
      customer_email: 'a@example.com'
    });
    const updated = store.assignConversation(conv.id, tenantId, seat.id);
    assert.equal(updated?.assigned_seat_id, seat.id);
    assert.equal(updated?.status, 'assigned');
  });

  it('lists registered omni channel adapters', () => {
    const adapters = getOmniChannelRegistry().list();
    const channels = adapters.map((a) => a.channel);
    assert.ok(channels.includes('web_chat'));
    assert.ok(channels.includes('sms'));
    assert.ok(channels.includes('email'));
  });

  it('omni HTTP: public chat, inbox, reply, escalate-voice', async () => {
    const chat = (await routeOmniApi(
      db,
      'POST',
      '/api/call-center/omni/chat',
      new URL('http://localhost/api/call-center/omni/chat'),
      {
        tenant_id: tenantId,
        content: '我想预约 demo',
        customer_name: '访客',
        customer_phone: '+8613812345678'
      },
      {}
    )) as { data: { conversation_id: string; reply: string } };
    assert.ok(chat.data.conversation_id);
    assert.ok(chat.data.reply);

    const inbox = (await routeOmniApi(
      db,
      'GET',
      '/api/call-center/omni/inbox',
      new URL('http://localhost/api/call-center/omni/inbox'),
      null,
      omniAuth(tenantId)
    )) as { data: Array<{ id: string }> };
    assert.ok(inbox.data.length >= 1);

    const convId = chat.data.conversation_id;
    const detail = (await routeOmniApi(
      db,
      'GET',
      `/api/call-center/omni/conversations/${convId}`,
      new URL(`http://localhost/api/call-center/omni/conversations/${convId}`),
      null,
      omniAuth(tenantId)
    )) as { data: { messages: unknown[]; journey: unknown[] } };
    assert.ok(detail.data.messages.length >= 2);
    assert.ok(detail.data.journey.length >= 1);

    const seatStore = new AgentSeatStore(db);
    const seat = seatStore.upsertSeat({
      tenant_id: tenantId,
      user_id: 'omni-agent',
      display_name: 'Omni Agent'
    });

    const replied = (await routeOmniApi(
      db,
      'POST',
      `/api/call-center/omni/conversations/${convId}/reply`,
      new URL(`http://localhost/api/call-center/omni/conversations/${convId}/reply`),
      { content: '人工回复：已收到', seat_id: seat.id },
      omniAuth(tenantId)
    )) as { data: { message: { content: string } } };
    assert.equal(replied.data.message.content, '人工回复：已收到');

    const escalated = (await routeOmniApi(
      db,
      'POST',
      `/api/call-center/omni/conversations/${convId}/escalate-voice`,
      new URL(`http://localhost/api/call-center/omni/conversations/${convId}/escalate-voice`),
      { seat_id: seat.id },
      omniAuth(tenantId)
    )) as { data: { task: { id: string }; conversation_id: string } };
    assert.ok(escalated.data.task.id);
    assert.equal(escalated.data.conversation_id, convId);
  });

  it('omni HTTP: video escalation returns signed tenant-aware customer join url', async () => {
    const previousInviteSecret = process.env.OPC_MEDIA_INVITE_SECRET;
    const previousPublicBaseUrl = process.env.OPC_PUBLIC_BASE_URL;
    process.env.OPC_MEDIA_INVITE_SECRET = 'omni-video-invite-secret';
    process.env.OPC_PUBLIC_BASE_URL = 'https://app.example.test';

    try {
      const chat = (await routeOmniApi(
        db,
        'POST',
        '/api/call-center/omni/chat',
        new URL('http://localhost/api/call-center/omni/chat'),
        {
          tenant_id: tenantId,
          content: '需要视频协助',
          customer_name: '视频客户',
          customer_phone: '+8613800000099'
        },
        {}
      )) as { data: { conversation_id: string } };

      const escalated = (await routeOmniApi(
        db,
        'POST',
        `/api/call-center/omni/conversations/${chat.data.conversation_id}/escalate-video`,
        new URL(
          `http://localhost/api/call-center/omni/conversations/${chat.data.conversation_id}/escalate-video`
        ),
        {},
        omniAuth(tenantId)
      )) as { data: { room: { room_name: string }; join_url: string } };

      const joinUrl = new URL(escalated.data.join_url);
      assert.equal(joinUrl.origin, 'https://app.example.test');
      assert.equal(joinUrl.pathname, '/video');
      assert.equal(joinUrl.searchParams.get('room'), escalated.data.room.room_name);
      assert.equal(joinUrl.searchParams.get('tenant_id'), tenantId);
      assert.ok(joinUrl.searchParams.get('expires_at'));
      assert.ok(joinUrl.searchParams.get('invite'));
      assert.equal(
        verifyMediaInvite({
          tenantId,
          roomName: escalated.data.room.room_name,
          role: 'customer',
          media: 'video',
          expiresAt: joinUrl.searchParams.get('expires_at'),
          invite: joinUrl.searchParams.get('invite')
        }),
        true
      );
    } finally {
      if (previousInviteSecret == null) delete process.env.OPC_MEDIA_INVITE_SECRET;
      else process.env.OPC_MEDIA_INVITE_SECRET = previousInviteSecret;
      if (previousPublicBaseUrl == null) delete process.env.OPC_PUBLIC_BASE_URL;
      else process.env.OPC_PUBLIC_BASE_URL = previousPublicBaseUrl;
    }
  });

  it('omni HTTP: schedule notification', async () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const created = (await routeOmniApi(
      db,
      'POST',
      '/api/call-center/omni/notifications/schedule',
      new URL('http://localhost/api/call-center/omni/notifications/schedule'),
      {
        channel: 'sms',
        target: '+8613900000099',
        template_key: 'appointment_reminder',
        payload: { time: '咨询服务', when: '明天 10:00' },
        scheduled_at: future
      },
      omniAuth(tenantId)
    )) as { status: number; data: { id: string } };
    assert.equal(created.status, 201);
    assert.ok(created.data.id);
  });

  it('sms webhook ingests inbound message', async () => {
    const result = (await routeOmniApi(
      db,
      'POST',
      '/api/call-center/omni/webhooks/sms',
      new URL('http://localhost/api/call-center/omni/webhooks/sms'),
      {
        tenant_id: tenantId,
        From: '+8613999999999',
        Body: '短信咨询',
        MessageSid: 'SM123'
      },
      { 'X-Webhook-Key': OMNI_API_KEY }
    )) as { data: { ok: boolean; conversation_id: string } };
    assert.equal(result.data.ok, true);
    assert.ok(result.data.conversation_id);
  });
});
