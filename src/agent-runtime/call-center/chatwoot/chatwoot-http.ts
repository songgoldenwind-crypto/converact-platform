/**
 * ⚠️ DEPRECATED (2026-06-22 audit): routeChatwootApi is dead code —
 * it is never imported or called by any router (call-center-http.ts
 * does not reference it). The /api/chatwoot/* endpoints never activate.
 * Additionally, it hardcodes tenantId: 'default' (multi-tenant broken)
 * and uses a non-standard x-chatwoot-signature header with plain-string
 * comparison (not timing-safe).
 *
 * ChatwootClient and chatwoot-webhook-handler are retained for future
 * re-integration but need: (1) proper router mounting, (2) tenant
 * resolution from Chatwoot account.id, (3) standard auth or IP allowlist.
 */
import { ChatwootClient } from './chatwoot-client.js';
import { handleChatwootWebhook } from './chatwoot-webhook-handler.js';
import type { ChatwootWebhookPayload } from './chatwoot-webhook-handler.js';

function getChatwootClient(): ChatwootClient | null {
  const baseUrl = process.env.CHATWOOT_URL;
  const apiAccessToken = process.env.CHATWOOT_API_TOKEN;
  const accountId = Number(process.env.CHATWOOT_ACCOUNT_ID || '1');

  if (!baseUrl || !apiAccessToken) return null;
  return new ChatwootClient({ baseUrl, apiAccessToken, accountId });
}

export async function routeChatwootApi(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  if (path === '/api/chatwoot/status' && method === 'GET') {
    const client = getChatwootClient();
    return {
      configured: client !== null,
      chatwoot_url: process.env.CHATWOOT_URL ?? null,
      account_id: Number(process.env.CHATWOOT_ACCOUNT_ID || '1')
    };
  }

  if (path === '/api/webhooks/chatwoot' && method === 'POST') {
    const secret = process.env.CHATWOOT_WEBHOOK_SECRET;
    if (secret) {
      const provided = headers['x-chatwoot-signature'] ?? headers['X-Chatwoot-Signature'];
      const token = Array.isArray(provided) ? provided[0] : provided;
      if (token !== secret) {
        return { status: 401, data: { error: 'invalid webhook signature' } };
      }
    }

    const client = getChatwootClient();
    if (!client) {
      return { status: 503, data: { error: 'Chatwoot integration not configured' } };
    }

    const payload = body as ChatwootWebhookPayload;
    const result = await handleChatwootWebhook(payload, {
      chatwootClient: client,
      tenantId: 'default'
    });

    return result;
  }

  return undefined;
}
