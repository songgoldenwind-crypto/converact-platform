import {
  verifyConveractFabricWebhook,
  type ConveractFabricWebhookReplayClaim,
  type ConveractFabricWebhookReplayStore
} from '@converact/sdk';

export interface ConveractFabricWebhookReceiverDependencies {
  resolveSigningSecret(): Promise<string | Uint8Array>;
  inbox: ConveractFabricWebhookReplayStore;
  toleranceSeconds?: number;
  replayRetentionSeconds?: number;
}

/**
 * Framework-neutral LED backend example. The inbox claim must atomically persist
 * the verified envelope for a separate business worker before returning true.
 */
export async function receiveConveractFabricWebhook(
  request: Request,
  dependencies: ConveractFabricWebhookReceiverDependencies
): Promise<Response> {
  if (request.method !== 'POST') return response(405, { error: 'method_not_allowed' });
  if (!String(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    return response(415, { error: 'unsupported_media_type' });
  }

  const timestamp = request.headers.get('x-ivekit-timestamp') || '';
  const signature = request.headers.get('x-ivekit-signature') || '';
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return response(400, { error: 'invalid_body' });
  }

  let storageFailure: unknown = null;
  const inbox: ConveractFabricWebhookReplayStore = {
    async claim(claim: ConveractFabricWebhookReplayClaim): Promise<boolean> {
      try {
        return await dependencies.inbox.claim(claim);
      } catch (error) {
        storageFailure = error;
        throw error;
      }
    }
  };

  let secret: string | Uint8Array;
  try {
    secret = await dependencies.resolveSigningSecret();
  } catch {
    return response(503, { error: 'secret_unavailable' });
  }

  try {
    const result = await verifyConveractFabricWebhook({
      rawBody,
      timestamp,
      signature,
      secret,
      replayStore: inbox,
      toleranceSeconds: dependencies.toleranceSeconds,
      replayRetentionSeconds: dependencies.replayRetentionSeconds
    });
    return response(200, {
      accepted: !result.duplicate,
      duplicate: result.duplicate,
      delivery_id: result.envelope.id,
      event_id: result.envelope.data.event_id
    });
  } catch {
    if (storageFailure) return response(503, { error: 'inbox_unavailable' });
    return response(401, { error: 'webhook_verification_failed' });
  }
}

function response(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}
