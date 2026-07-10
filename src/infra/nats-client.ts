export interface NatsPublishInput {
  subject: string;
  payload: Record<string, unknown>;
}

let natsConnection: { publish: (subject: string, data: Uint8Array) => void; close?: () => Promise<void> } | null =
  null;
let connectPromise: Promise<boolean> | null = null;

export async function connectNats(): Promise<boolean> {
  const url = process.env.NATS_URL;
  if (!url) return false;
  if (natsConnection) return true;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      const { connect } = await import('nats');
      const nc = await connect({ servers: url, maxReconnectAttempts: 3, timeout: 5_000 });
      natsConnection = nc;
      console.log('[nats] connected:', url);
      return true;
    } catch (error) {
      console.warn('[nats] connect failed:', error instanceof Error ? error.message : error);
      return false;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

export async function publishNatsMessage(input: NatsPublishInput): Promise<boolean> {
  const connected = await connectNats();
  if (!connected || !natsConnection) return false;
  try {
    natsConnection.publish(input.subject, new TextEncoder().encode(JSON.stringify(input.payload)));
    return true;
  } catch (error) {
    console.warn('[nats] publish failed:', error instanceof Error ? error.message : error);
    return false;
  }
}

export async function closeNats(): Promise<void> {
  if (natsConnection?.close) {
    await natsConnection.close();
  }
  natsConnection = null;
}

export function isNatsConnected(): boolean {
  return Boolean(natsConnection);
}
