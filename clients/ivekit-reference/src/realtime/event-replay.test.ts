import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  IveKitEvent,
  IveKitEventHttpClient,
  IveKitEventPage,
  IveKitEventReplayResult
} from '@opc/ivekit-sdk';
import { EventReplayController, eventWorkspace } from './event-replay.js';

const event = (id: string, type: string): IveKitEvent => ({
  event_id: id,
  cursor: `cursor-${id}`,
  tenant_id: 'tenant-replay',
  type,
  data: {},
  timestamp: '2026-07-12T00:00:00.000Z',
  expires_at: '2026-07-13T00:00:00.000Z',
  visibility_scope: 'tenant',
  visibility_ref_id: '',
  audience_user_ids: []
});

test('event replay starts at head, resumes gaps once, and deduplicates event IDs', async () => {
  const delivered: string[] = [];
  const statuses: string[] = [];
  const replays: IveKitEventReplayResult[] = [
    {
      items: [event('1', 'collaboration.message.created'), event('1', 'collaboration.message.created')],
      next_cursor: 'cursor-1', has_more: false, snapshot_required: false, pages: 1
    }
  ];
  const controller = new EventReplayController({
    events: {
      getHeadCursor: async () => 'head-0',
      listPage: async () => page(),
      replay: async () => replays.shift()!
    } as IveKitEventHttpClient,
    onEvent: (item) => { delivered.push(item.event_id); },
    snapshots: { chat: async () => {}, media: async () => {}, remote: async () => {} },
    onStatus: (status) => { statuses.push(status); }
  });

  await controller.start();
  assert.equal(controller.getCursor(), 'head-0');
  await Promise.all([controller.resume(), controller.resume()]);
  assert.equal(controller.getCursor(), 'cursor-1');
  assert.deepEqual(delivered, ['1']);
  assert.deepEqual(statuses, ['syncing', 'live', 'syncing', 'live']);
});

test('event replay refreshes all workspaces on snapshot fallback before moving to a new head', async () => {
  const snapshots: string[] = [];
  let head = 0;
  const controller = new EventReplayController({
    initialCursor: 'expired',
    events: {
      getHeadCursor: async () => `head-${++head}`,
      listPage: async () => page(),
      replay: async () => ({
        items: [], next_cursor: '', has_more: false, snapshot_required: true,
        reason: 'cursor_expired', pages: 1
      })
    } as IveKitEventHttpClient,
    onEvent: async () => {},
    snapshots: {
      chat: async () => { snapshots.push('chat'); },
      media: async () => { snapshots.push('media'); },
      remote: async () => { snapshots.push('remote'); },
      voice: async () => { snapshots.push('voice'); }
    }
  });

  await controller.start();
  assert.deepEqual(snapshots.sort(), ['chat', 'media', 'remote', 'voice']);
  assert.equal(controller.getCursor(), 'head-1');
  controller.stop();
  await controller.resume();
  assert.equal(head, 1);
});

test('event replay does not deduplicate an event whose projection failed', async () => {
  let attempts = 0;
  const replay: IveKitEventReplayResult = {
    items: [event('retry-1', 'collaboration.message.created')],
    next_cursor: 'cursor-retry-1', has_more: false, snapshot_required: false, pages: 1
  };
  const controller = new EventReplayController({
    initialCursor: 'head-retry',
    events: {
      getHeadCursor: async () => 'head-retry',
      listPage: async () => page(),
      replay: async () => replay
    } as IveKitEventHttpClient,
    onEvent: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('projection failed');
    },
    snapshots: { chat: async () => {}, media: async () => {}, remote: async () => {} }
  });

  await assert.rejects(() => controller.resume(), /projection failed/);
  assert.equal(controller.getCursor(), 'head-retry');
  await controller.resume();
  assert.equal(attempts, 2);
  assert.equal(controller.getCursor(), 'cursor-retry-1');
});

test('durable event types route to the matching workspace', () => {
  assert.equal(eventWorkspace('collaboration.message.created'), 'chat');
  assert.equal(eventWorkspace('media.call.updated'), 'media');
  assert.equal(eventWorkspace('remote.rustdesk.session.ended'), 'remote');
  assert.equal(eventWorkspace('voice.call.state_changed'), 'voice');
  assert.equal(eventWorkspace('ivr.session.completed'), 'voice');
  assert.equal(eventWorkspace('tenant.settings.updated'), 'context');
});

function page(): IveKitEventPage {
  return { items: [], next_cursor: 'cursor', has_more: false, snapshot_required: false };
}
