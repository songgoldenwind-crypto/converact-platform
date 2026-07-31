import { fileURLToPath } from 'node:url';

import { TinodeChatGateway, type TinodeGatewayConfig } from '../src/agent-runtime/collaboration/chat-gateway.js';
import { tinodeServerApiKey } from '../src/agent-runtime/collaboration/tinode-env.js';

export interface TinodeChatSmokeConfig {
  baseUrl: string;
  wsUrl?: string;
  apiKey: string;
  authToken?: string;
  basicUser?: string;
  basicPassword?: string;
  userPasswordSecret?: string;
  tenantId: string;
  sessionId: string;
  title: string;
  senderIdentity: string;
  participantIdentity?: string;
  participantProviderUserId?: string;
  body: string;
  timeoutMs?: number;
}

export interface TinodeChatSmokeResult {
  provider: 'tinode';
  topicId: string;
  messageId: string;
  published: boolean;
  participantGranted: boolean;
  participantUserId?: string;
  participantAuthToken?: string;
}

export function createTinodeChatSmokeConfigFromEnv(env: NodeJS.ProcessEnv): TinodeChatSmokeConfig {
  const baseUrl = String(env.TINODE_BASE_URL || '').trim();
  const wsUrl = String(env.TINODE_WS_URL || '').trim();
  const apiKey = tinodeServerApiKey(env);
  const authToken = String(env.TINODE_AUTH_TOKEN || '').trim();
  const basicUser = String(env.TINODE_BASIC_USER || '').trim();
  const participantIdentity = String(env.TINODE_CHAT_SMOKE_PARTICIPANT_IDENTITY || '').trim();
  const participantProviderUserId = String(env.TINODE_CHAT_SMOKE_PARTICIPANT_USER_ID || '').trim();
  const userPasswordSecret = String(env.TINODE_USER_PASSWORD_SECRET || '').trim();

  if (!baseUrl && !wsUrl) throw new Error('TINODE_BASE_URL or TINODE_WS_URL is required');
  if (!apiKey) throw new Error('TINODE_ROOT_API_KEY is required');
  if (!authToken && !basicUser) throw new Error('TINODE_AUTH_TOKEN or TINODE_BASIC_USER is required');
  if (participantIdentity && !participantProviderUserId && !userPasswordSecret) {
    throw new Error('TINODE_USER_PASSWORD_SECRET is required when creating Tinode smoke participant accounts');
  }

  return {
    baseUrl,
    wsUrl: wsUrl || undefined,
    apiKey,
    authToken: authToken || undefined,
    basicUser: basicUser || undefined,
    basicPassword: env.TINODE_BASIC_PASSWORD || undefined,
    userPasswordSecret: userPasswordSecret || undefined,
    tenantId: env.TINODE_CHAT_SMOKE_TENANT_ID || 'tenant_tinode_smoke',
    sessionId: env.TINODE_CHAT_SMOKE_SESSION_ID || `tinode-smoke-${Date.now()}`,
    title: env.TINODE_CHAT_SMOKE_TITLE || 'Tinode smoke',
    senderIdentity: env.TINODE_CHAT_SMOKE_SENDER_IDENTITY || 'agent_tinode_smoke',
    participantIdentity: participantIdentity || undefined,
    participantProviderUserId: participantProviderUserId || undefined,
    body: env.TINODE_CHAT_SMOKE_BODY || 'hello from OPC Tinode smoke',
    timeoutMs: parsePositiveInteger(env.TINODE_CHAT_SMOKE_TIMEOUT_MS, 5_000)
  };
}

export async function runTinodeChatSmoke(config: TinodeChatSmokeConfig): Promise<TinodeChatSmokeResult> {
  const gateway = new TinodeChatGateway(toGatewayConfig(config));
  const binding = await gateway.ensureTopic({
    tenant_id: config.tenantId,
    session_id: config.sessionId,
    title: config.title,
    metadata: { source: 'tinode-chat-smoke' }
  });
  if (binding.provider_status !== 'bound') {
    throw new Error(`Tinode topic was not bound: ${binding.provider_status}`);
  }
  let participantGranted = false;
  let participantUserId: string | undefined;
  let participantAuthToken: string | undefined;
  if (config.participantIdentity || config.participantProviderUserId) {
    const user = await gateway.ensureUser({
      tenant_id: config.tenantId,
      identity: config.participantIdentity || config.participantProviderUserId || 'tinode_smoke_participant',
      provider_user_id: config.participantProviderUserId
    });
    await gateway.addParticipant({
      tenant_id: config.tenantId,
      session_id: config.sessionId,
      provider_topic_id: binding.provider_topic_id,
      identity: config.participantIdentity || user.provider_user_id,
      provider_user_id: user.provider_user_id
    });
    participantGranted = true;
    participantUserId = user.provider_user_id;
    participantAuthToken = user.provider_auth_token;
  }

  const publish = await gateway.publishMessage({
    tenant_id: config.tenantId,
    session_id: config.sessionId,
    provider_topic_id: binding.provider_topic_id,
    sender_identity: config.senderIdentity,
    body: config.body,
    metadata: { source: 'tinode-chat-smoke' }
  });
  if (publish.provider_sync_status !== 'published') {
    throw new Error(`Tinode message was not published: ${publish.provider_sync_status}`);
  }

  return {
    provider: 'tinode',
    topicId: binding.provider_topic_id,
    messageId: publish.provider_message_id,
    published: true,
    participantGranted,
    participantUserId,
    participantAuthToken
  };
}

function toGatewayConfig(config: TinodeChatSmokeConfig): TinodeGatewayConfig {
  return {
    base_url: config.baseUrl,
    ws_url: config.wsUrl,
    api_key: config.apiKey,
    auth_token: config.authToken,
    basic_user: config.basicUser,
    basic_password: config.basicPassword,
    user_password_secret: config.userPasswordSecret,
    timeout_ms: config.timeoutMs
  };
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value || '');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function main(): Promise<void> {
  const result = await runTinodeChatSmoke(createTinodeChatSmokeConfigFromEnv(process.env));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
