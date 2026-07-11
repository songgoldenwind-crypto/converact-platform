import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { IveKitChatMessage } from '@opc/ivekit-sdk';
import { ChatConvergence } from './convergence.js';

test('convergence deduplicates, orders, coalesces invalidations, and advances after cursor', async () => {
  const pages = [
    deferred<{ items: IveKitChatMessage[]; next_cursor: string | null; has_more: boolean }>(),
    deferred<{ items: IveKitChatMessage[]; next_cursor: string | null; has_more: boolean }>()
  ];
  const cursors: Array<string | null> = [];
  const projections: string[][] = [];
  let index = 0;
  const convergence = new ChatConvergence({
    fetchAfter: async (cursor) => { cursors.push(cursor); return pages[index++].promise; },
    onProjection: (projection) => projections.push(projection.messages.map((message) => message.id))
  });
  const first = convergence.invalidate('initial');
  const coalesced = convergence.invalidate('tinode_data');
  pages[0].resolve({ items: [message('b', 2), message('a', 1), message('b', 2)], next_cursor: 'cursor-2', has_more: false });
  await Promise.resolve();
  await Promise.resolve();
  pages[1].resolve({ items: [message('c', 3)], next_cursor: 'cursor-3', has_more: false });
  await Promise.all([first, coalesced]);
  assert.deepEqual(cursors, [null, 'cursor-2']);
  assert.deepEqual(projections.at(-1), ['a', 'b', 'c']);
});

test('convergence suppresses stale generations and closes on authorization failure', async () => {
  const pending = deferred<{ items: IveKitChatMessage[]; next_cursor: string | null; has_more: boolean }>();
  const projections: string[][] = [];
  const fatal: number[] = [];
  let request = 0;
  const convergence = new ChatConvergence({
    fetchAfter: async () => {
      if (request++ === 0) return pending.promise;
      throw Object.assign(new Error('revoked'), { status: 403 });
    },
    onProjection: (projection) => projections.push(projection.messages.map((item) => item.id)),
    onFatalAuth: (status) => fatal.push(status)
  });
  const stale = convergence.invalidate('initial');
  convergence.reset([message('new', 5)], 'cursor-new');
  pending.resolve({ items: [message('old', 1)], next_cursor: 'cursor-old', has_more: false });
  await stale;
  assert.deepEqual(projections.at(-1), ['new']);
  await assert.rejects(convergence.invalidate('visibility'), /revoked/);
  assert.deepEqual(fatal, [403]);
  await assert.rejects(convergence.invalidate('tinode_data'), /closed/);
});

test('convergence rejects a non-advancing has-more cursor', async () => {
  const convergence = new ChatConvergence({
    fetchAfter: async () => ({ items: [], next_cursor: null, has_more: true })
  });
  await assert.rejects(convergence.invalidate('initial'), /cursor did not advance/);
});

function message(id: string, order: number): IveKitChatMessage {
  return { id, created_at: new Date(order * 1000).toISOString() } as IveKitChatMessage;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
