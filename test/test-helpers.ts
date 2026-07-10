import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server as NetServer } from 'node:net';
import type { JsonRecord } from '../src/agent-runtime/integrations/provider-runtime-types.js';
import type {
  ToolBlockedResult,
  ToolExecutionResult,
  ToolSuccessResult
} from '../src/agent-runtime/runtime-domain-types.js';

export function expectSuccess<T = JsonRecord>(result: ToolExecutionResult): ToolSuccessResult & { output: T } {
  assert.equal(result.status, 'success');
  return result as ToolSuccessResult & { output: T };
}

export function expectBlocked(result: ToolExecutionResult): ToolBlockedResult {
  assert.equal(result.status, 'blocked_pending_approval');
  return result as ToolBlockedResult;
}

export function expectRecord<T = JsonRecord>(value: unknown): T {
  return value as T;
}

export function expectList<T = JsonRecord>(value: unknown): T[] {
  return value as T[];
}

export async function listenOnRandomPort(server: NetServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('error', onError);
      reject(error);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return (address as AddressInfo).port;
}
