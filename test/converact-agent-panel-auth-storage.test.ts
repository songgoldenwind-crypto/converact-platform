import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readAgentAuthStorage,
  writeAgentAuthStorage
} from '../services/agent-panel/src/lib/auth-storage.js';

class MemoryStorage {
  readonly #values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }
}

test('agent panel migrates legacy auth storage and writes only Converact keys', () => {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage
  });
  storage.setItem('opc_token', 'legacy-token');

  assert.equal(readAgentAuthStorage('token'), 'legacy-token');
  assert.equal(storage.getItem('converact_token'), 'legacy-token');

  writeAgentAuthStorage('token', 'current-token');
  assert.equal(storage.getItem('converact_token'), 'current-token');
  assert.equal(storage.getItem('opc_token'), null);
});
