import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readAuthStorage,
  removeAuthStorage,
  writeAuthStorage
} from '../frontend/src/auth-storage.js';

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

test('frontend auth storage migrates legacy keys and writes only Converact keys', () => {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage
  });
  storage.setItem('opc_token', 'legacy-token');

  assert.equal(readAuthStorage('token'), 'legacy-token');
  assert.equal(storage.getItem('converact_token'), 'legacy-token');

  writeAuthStorage('token', 'current-token');
  assert.equal(storage.getItem('converact_token'), 'current-token');
  assert.equal(storage.getItem('opc_token'), null);

  storage.setItem('opc_token', 'stale-token');
  removeAuthStorage('token');
  assert.equal(storage.getItem('converact_token'), null);
  assert.equal(storage.getItem('opc_token'), null);
});
