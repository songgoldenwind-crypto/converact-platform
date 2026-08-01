import {
  createConveractFabricHttpSdk,
  type ConveractFabricChatHttpClient,
  type ConveractFabricContactCenterHttpClient,
  type ConveractFabricContextHttpClient,
  type ConveractFabricEventHttpClient,
  type ConveractFabricHttpSdkInput,
  type ConveractFabricIntelligenceHttpClient,
  type ConveractFabricIvrHttpClient,
  type ConveractFabricMediaHttpClient,
  type ConveractFabricNotificationHttpClient,
  type ConveractFabricAuditHttpClient,
  type ConveractFabricRetentionHttpClient,
  type ConveractFabricVoiceHttpClient
} from './http-sdk.js';
import {
  createConveractFabricRustDeskHttpClient,
  type ConveractFabricRustDeskControlHttpClient
} from './rustdesk-http-client.js';
import {
  createConveractFabricRustDeskLedSdk,
  type ConveractFabricRustDeskLedSdk
} from './rustdesk-led-sdk.js';

export type ConveractFabricRustDeskClient = ConveractFabricRustDeskControlHttpClient & ConveractFabricRustDeskLedSdk;

export interface ConveractFabricClient {
  media: ConveractFabricMediaHttpClient;
  chat: ConveractFabricChatHttpClient;
  contactCenter: ConveractFabricContactCenterHttpClient;
  context: ConveractFabricContextHttpClient;
  events: ConveractFabricEventHttpClient;
  intelligence: ConveractFabricIntelligenceHttpClient;
  ivr: ConveractFabricIvrHttpClient;
  voice: ConveractFabricVoiceHttpClient;
  notifications: ConveractFabricNotificationHttpClient;
  audit: ConveractFabricAuditHttpClient;
  retention: ConveractFabricRetentionHttpClient;
  rustdesk: ConveractFabricRustDeskClient;
}

export type ConveractFabricClientInput = ConveractFabricHttpSdkInput;

export function createConveractFabricClient(input: ConveractFabricClientInput): ConveractFabricClient {
  const http = createConveractFabricHttpSdk(input);
  const rustdeskHttp = createConveractFabricRustDeskHttpClient({
    baseUrl: input.baseUrl,
    tenantId: input.tenantId,
    apiKey: input.apiKey,
    accessToken: input.accessToken,
    userId: input.userId,
    timeoutMs: input.timeoutMs,
    fetch: input.fetch
  });
  const rustdeskWorkflow = createConveractFabricRustDeskLedSdk({
    tenantId: input.tenantId,
    client: rustdeskHttp
  });
  return {
    ...http,
    rustdesk: {
      ...rustdeskHttp,
      ...rustdeskWorkflow
    }
  };
}

export * from './http-sdk.js';
export type * from './chat-types.js';
export type * from './media-types.js';
export type * from './context-types.js';
export type * from './contact-center-types.js';
export type * from './event-types.js';
export type * from './intelligence-types.js';
export type * from './ivr-types.js';
export type * from './voice-types.js';
export type * from './notification-types.js';
export type * from './audit-types.js';
export type * from './retention-types.js';
export * from './voice-controller.js';
export * from './upload-transport.js';
export * from './webhook.js';
export * from './rustdesk-http-client.js';
export * from './rustdesk-led-sdk.js';
export type * from './types.js';
export * from './legacy-fabric-v1-aliases.js';
