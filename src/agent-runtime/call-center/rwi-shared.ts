import type { RWIClientLike } from './rwi-client.js';
import { RWIClient, readRWIConfig } from './rwi-client.js';
import { getOutboundDialerForTests } from './call-center-runtime.js';

let sharedClient: RWIClientLike | null = null;
let connectPromise: Promise<RWIClientLike | null> | null = null;

export function getDialerRwiClient(): RWIClientLike | null {
  const dialer = getOutboundDialerForTests() as { getRwiClient?: () => RWIClientLike | null } | null;
  return dialer?.getRwiClient?.() ?? null;
}

export async function getSharedRwiClient(): Promise<RWIClientLike | null> {
  const fromDialer = getDialerRwiClient();
  if (fromDialer?.isConnected()) return fromDialer;

  const config = readRWIConfig();
  if (!config.url) return fromDialer;

  if (sharedClient?.isConnected()) return sharedClient;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    if (!sharedClient) {
      sharedClient = new RWIClient({ url: config.url!, authToken: config.authToken });
    }
    try {
      await sharedClient.connect();
      return sharedClient;
    } catch (error) {
      console.warn('[rwi-shared] connect failed:', error);
      return fromDialer;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

export function resetSharedRwiClientForTests(): void {
  sharedClient?.disconnect();
  sharedClient = null;
  connectPromise = null;
}
