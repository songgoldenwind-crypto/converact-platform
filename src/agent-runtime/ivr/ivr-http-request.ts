/**
 * HTTP node execution — HT-1 fetch + HT-2 retry with exponential backoff.
 */
import { sendWithIoRetries } from './ivr-io-retry.js';
import type { HttpExecResult } from './ivr-side-effects.js';

function substituteVars(text: string, variables: Record<string, string>): string {
  if (!text) return text;
  return text.replace(/\{\{([^}]+)\}\}/g, (_, key: string) => variables[key.trim()] ?? `{{${key.trim()}}}`);
}

export async function executeHttpRequest(
  nodeData: Record<string, unknown>,
  variables: Record<string, string>
): Promise<HttpExecResult> {
  const method = (nodeData.method as string) || 'GET';
  const url = substituteVars(nodeData.url as string, variables);
  const timeoutSec = (nodeData.timeoutSec as number) ?? 10;
  const retryCount = Math.max(0, Math.min((nodeData.retryCount as number) ?? 0, 5));
  const headers: Record<string, string> = {};
  for (const h of (nodeData.headers as Array<{ key: string; value: string }>) || []) {
    headers[h.key] = substituteVars(h.value, variables);
  }

  let body: string | undefined;
  const params = (nodeData.requestParams as Array<{ key: string; source: string; path?: string }>) || [];
  if (method !== 'GET' && params.length > 0) {
    const payload: Record<string, unknown> = {};
    for (const p of params) {
      const val = substituteVars(p.source, variables);
      if (p.path && p.path.includes('/')) {
        const parts = p.path.split('/');
        let obj = payload;
        for (let i = 0; i < parts.length - 1; i++) {
          obj[parts[i]] = obj[parts[i]] || {};
          obj = obj[parts[i]] as Record<string, unknown>;
        }
        obj[parts[parts.length - 1]] = val;
      } else {
        payload[p.key] = val;
      }
    }
    body = JSON.stringify(payload);
  }

  const send = async (): Promise<HttpExecResult> => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let responseBody: Record<string, unknown> | undefined;
      try {
        responseBody = JSON.parse(text);
      } catch {
        /* non-JSON response */
      }

      const mappedVariables: Record<string, string> = {};
      for (const m of (nodeData.responseMappings as Array<{ responsePath: string; targetVariable: string }>) || []) {
        if (responseBody) {
          const parts = m.responsePath.split('.');
          let val: unknown = responseBody;
          for (const part of parts) {
            val = (val as Record<string, unknown>)?.[part];
          }
          mappedVariables[m.targetVariable] = val != null ? String(val) : '';
        }
      }

      return { success: res.ok, statusCode: res.status, responseBody, mappedVariables };
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'AbortError';
      return {
        success: false,
        statusCode: 0,
        error: isTimeout ? 'timeout' : err instanceof Error ? err.message : String(err),
      };
    }
  };

  return sendWithIoRetries(send, retryCount);
}
