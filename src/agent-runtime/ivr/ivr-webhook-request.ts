/**
 * Webhook HTTP execution — WH-1 body + WH-2 HMAC signature + async fire-and-forget.
 */
import { createHmac } from 'node:crypto';
import { buildWebhookRequestBody } from './ivr-webhook-payload.js';
import { sendWithIoRetries, shouldRetryIoStatus } from './ivr-io-retry.js';
import type { WebhookExecResult } from './ivr-side-effects.js';

function substituteVars(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => {
    const trimmed = key.trim();
    return variables[trimmed] ?? `{{${trimmed}}}`;
  });
}

export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function resolveWebhookHmacSecret(
  nodeData: Record<string, unknown>,
  resolveSecretRef?: (secretRefId: string) => string | undefined
): string | undefined {
  const direct = nodeData.hmacSecret as string | undefined;
  if (direct) return direct;
  const refId = nodeData.hmacSecretRef as string | undefined;
  if (refId && resolveSecretRef) return resolveSecretRef(refId);
  return undefined;
}

export async function executeWebhookRequest(
  nodeData: Record<string, unknown>,
  variables: Record<string, string>,
  opts?: {
    resolveSecretRef?: (secretRefId: string) => string | undefined;
    onAsyncError?: (message: string) => void;
  }
): Promise<WebhookExecResult> {
  const url = substituteVars(nodeData.url as string, variables);
  const method = (nodeData.method as string) || 'POST';
  const timeoutSec = (nodeData.timeoutSec as number) ?? 10;
  const bodyObj = buildWebhookRequestBody(nodeData, variables);
  const body = method !== 'GET' ? JSON.stringify(bodyObj) : '';

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const secret = resolveWebhookHmacSecret(nodeData, opts?.resolveSecretRef);
  if (secret && body) {
    headers['X-OPC-Signature'] = signWebhookBody(body, secret);
  }

  const send = async (): Promise<WebhookExecResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: method !== 'GET' ? body : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      return { success: res.ok, statusCode: res.status };
    } catch (err) {
      clearTimeout(timer);
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      return {
        success: false,
        statusCode: 0,
        error: isTimeout ? 'timeout' : err instanceof Error ? err.message : String(err),
      };
    }
  };

  if (nodeData.async === true) {
    const retryCount = Math.max(0, Math.min((nodeData.retryCount as number) ?? 0, 5));
    void (async () => {
      const result = await sendWithIoRetries(send, retryCount, (r) => !r.success && shouldRetryIoStatus(r.statusCode));
      if (!result.success) {
        const msg = `async webhook failed: ${url} status=${result.statusCode} ${result.error ?? ''}`;
        if (opts?.onAsyncError) opts.onAsyncError(msg);
        else console.warn(msg);
      }
    })();
    return { success: true, statusCode: 202 };
  }

  const retryCount = Math.max(0, Math.min((nodeData.retryCount as number) ?? 0, 5));
  return sendWithIoRetries(send, retryCount, (r) => !r.success && shouldRetryIoStatus(r.statusCode));
}
