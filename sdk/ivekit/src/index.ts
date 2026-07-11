import {
  createIveKitHttpSdk,
  type IveKitChatHttpClient,
  type IveKitHttpSdkInput,
  type IveKitMediaHttpClient
} from './http-sdk.js';
import {
  createIveKitRustDeskHttpClient,
  type IveKitRustDeskHttpClient
} from './rustdesk-http-client.js';
import {
  createIveKitRustDeskLedSdk,
  type IveKitRustDeskLedSdk
} from './rustdesk-led-sdk.js';

export type IveKitRustDeskClient = IveKitRustDeskHttpClient & IveKitRustDeskLedSdk;

export interface IveKitClient {
  media: IveKitMediaHttpClient;
  chat: IveKitChatHttpClient;
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
export * from './upload-transport.js';
export * from './rustdesk-http-client.js';
export * from './rustdesk-led-sdk.js';
export type * from './types.js';
