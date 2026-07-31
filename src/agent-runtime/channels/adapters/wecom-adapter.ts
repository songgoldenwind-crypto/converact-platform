import crypto from 'node:crypto';
import type { JsonRecord } from '../../integrations/provider-runtime-types.js';
import type { ChannelAdapter, InboundMessage } from '../channel-adapter-registry.js';

export interface WeComAdapterOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

interface TokenCacheEntry {
  accessToken: string;
  expiresAt: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();

export function createWeComAdapter(options: WeComAdapterOptions = {}): ChannelAdapter {
  const doFetch = options.fetch || globalThis.fetch;
  const now = options.now || (() => Date.now());

  return {
    normalizeInbound(raw) {
      return normalizeWeComInbound(raw);
    },
    deliverOutbound(message) {
      return deliverWeComAppMessage(message, doFetch, now);
    }
  };
}

async function deliverWeComAppMessage(
  message: JsonRecord,
  doFetch: typeof fetch,
  now: () => number
): Promise<JsonRecord> {
  const toUser = String(message.to || message.touser || message.lead_contact || '').trim();
  const text = String(message.text || message.message || '').trim();
  const runtimeConfig = record(message.runtime_config || message.config || {});
  const corpId = String(runtimeConfig.corp_id || '').trim();
  const agentId = String(runtimeConfig.agent_id || runtimeConfig.agentid || '').trim();
  const secret = String(runtimeConfig.secret || '').trim();

  if (!toUser) return { status: 'failed', failure_reason: 'wecom adapter: missing recipient (touser)' };
  if (!text) return { status: 'failed', failure_reason: 'wecom adapter: missing message text' };
  if (!corpId || !agentId || !secret) {
    return {
      status: 'manual_fallback_required',
      failure_reason: 'wecom adapter: missing corp_id, agent_id or secret',
      channel: 'wechat',
      to: toUser
    };
  }

  try {
    const accessToken = await getAccessToken(corpId, agentId, secret, doFetch, now);
    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${encodeURIComponent(accessToken)}`;
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: toUser,
        msgtype: 'text',
        agentid: Number(agentId),
        text: { content: text }
      })
    });

    const bodyText = await response.text();
    let result: JsonRecord = {};
    try {
      result = JSON.parse(bodyText);
    } catch {
      result = { raw: bodyText };
    }

    const errcode = Number(result.errcode ?? 0);
    if (!response.ok || errcode !== 0) {
      return {
        status: errcode === 60011 || errcode === 60012 ? 'manual_fallback_required' : 'failed',
        failure_reason: `wecom send failed: ${errcode} ${result.errmsg || response.statusText}`,
        channel: 'wechat',
        to: toUser,
        raw_receipt_summary: bodyText
      };
    }

    return {
      status: 'sent',
      channel: 'wechat',
      external_message_id: String(result.msgid || `wecom:${now()}`),
      raw_receipt_summary: bodyText,
      sent_at: new Date().toISOString(),
      to: toUser
    };
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      status: 'failed',
      failure_reason: `wecom adapter error: ${err.message}`,
      channel: 'wechat',
      to: toUser
    };
  }
}

async function getAccessToken(
  corpId: string,
  agentId: string,
  secret: string,
  doFetch: typeof fetch,
  now: () => number
): Promise<string> {
  const cacheKey = `${corpId}:${agentId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now() + 60_000) {
    return cached.accessToken;
  }

  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${encodeURIComponent(corpId)}&corpsecret=${encodeURIComponent(secret)}`;
  const response = await doFetch(url);
  const bodyText = await response.text();
  let result: JsonRecord = {};
  try {
    result = JSON.parse(bodyText);
  } catch {
    throw new Error(`wecom token response not json: ${bodyText}`);
  }

  const accessToken = String(result.access_token || '');
  if (!accessToken) {
    throw new Error(`wecom token error: ${result.errcode} ${result.errmsg}`);
  }

  const expiresIn = Number(result.expires_in || 7200) * 1000;
  tokenCache.set(cacheKey, { accessToken, expiresAt: now() + expiresIn });
  return accessToken;
}

export function normalizeWeComInbound(raw: JsonRecord = {}): InboundMessage {
  const xml = record(raw.xml || raw);
  const msgType = String(xml.MsgType || xml.msg_type || '').toLowerCase();
  const text = msgType === 'text' ? String(xml.Content || xml.content || '') : '';

  return {
    messageId: String(xml.MsgId || xml.msg_id || `wecom:${Date.now()}`),
    tenantId: String(raw.tenant_id || xml.tenant_id || ''),
    workspaceId: String(raw.workspace_id || xml.workspace_id || 'default'),
    channel: 'wechat',
    channelAccountId: String(xml.ToUserName || xml.to_user_name || xml.agentid || ''),
    externalUserId: String(xml.FromUserName || xml.from_user_name || ''),
    internalUserId: '',
    threadId: String(xml.MsgId || xml.msg_id || ''),
    businessObjectType: '',
    businessObjectId: '',
    text,
    attachments: [],
    receivedAt: String(xml.CreateTime ? new Date(Number(xml.CreateTime) * 1000).toISOString() : new Date().toISOString()),
    signatureVerified: Boolean(raw.signature_verified)
  };
}

export function verifyWeComWebhookSignature(
  token: string,
  signature: string,
  timestamp: string,
  nonce: string,
  echoStr?: string
): boolean {
  const payload = echoStr ? [token, timestamp, nonce, echoStr] : [token, timestamp, nonce];
  const expected = crypto.createHash('sha1').update(payload.sort().join('')).digest('hex');
  return expected === signature;
}

export function parseWeComXmlBody(xml: string): JsonRecord {
  const result: JsonRecord = {};
  if (!xml || typeof xml !== 'string') return result;

  const cdataPattern = /<([^\/>\s]+)><!\[CDATA\[(.*?)\]\]><\/\1>/gs;
  let match: RegExpExecArray | null;
  while ((match = cdataPattern.exec(xml)) !== null) {
    result[match[1]] = match[2];
  }

  const textPattern = /<([^\/>\s]+)>([^<]*)<\/\1>/g;
  while ((match = textPattern.exec(xml)) !== null) {
    if (!(match[1] in result)) result[match[1]] = match[2];
  }

  return result;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}
