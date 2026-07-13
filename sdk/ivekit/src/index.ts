import {
  createIveKitHttpSdk,
  type IveKitChatHttpClient,
  type IveKitContextHttpClient,
  type IveKitEventHttpClient,
  type IveKitHttpSdkInput,
  type IveKitIntelligenceHttpClient,
  type IveKitIvrHttpClient,
  type IveKitMediaHttpClient,
  type IveKitVoiceHttpClient
} from './http-sdk.js';
import {
  createIveKitRustDeskHttpClient,
  type IveKitRustDeskControlHttpClient
} from './rustdesk-http-client.js';
import {
  createIveKitRustDeskLedSdk,
  type IveKitRustDeskLedSdk
} from './rustdesk-led-sdk.js';

export type IveKitRustDeskClient = IveKitRustDeskControlHttpClient & IveKitRustDeskLedSdk;

export interface IveKitClient {
  media: IveKitMediaHttpClient;
  chat: IveKitChatHttpClient;
  context: IveKitContextHttpClient;
  events: IveKitEventHttpClient;
  intelligence: IveKitIntelligenceHttpClient;
  ivr: IveKitIvrHttpClient;
  voice: IveKitVoiceHttpClient;
  rustdesk: IveKitRustDeskClient;
}

export type IveKitClientInput = IveKitHttpSdkInput;

export function createIveKitClient(input: IveKitClientInput): IveKitClient {
  const http = createIveKitHttpSdk(input);
  const rustdeskHttp = createIveKitRustDeskHttpClient({
    baseUrl: input.baseUrl,
    tenantId: input.tenantId,
    apiKey: input.apiKey,
    accessToken: input.accessToken,
    userId: input.userId,
    timeoutMs: input.timeoutMs,
    fetch: input.fetch
  });
  const rustdeskWorkflow = createIveKitRustDeskLedSdk({
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
export type * from './event-types.js';
export type * from './intelligence-types.js';
export type * from './ivr-types.js';
export type * from './voice-types.js';
export * from './upload-transport.js';
export * from './rustdesk-http-client.js';
export * from './rustdesk-led-sdk.js';
export type * from './types.js';
