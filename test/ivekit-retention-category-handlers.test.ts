import assert from 'node:assert/strict';
import test from 'node:test';

import type { PgQueryable } from '../src/db-pg.js';
import {
  createPostgresIveKitRetentionCategoryHandlers,
  type IveKitRetentionClaim
} from '../src/agent-runtime/ivekit/operations/retention/index.js';
import type { ObjectStorage } from '../src/storage/object-storage.js';

class RecordingPg implements PgQueryable {
  readonly calls: string[] = [];
  readonly params: unknown[][] = [];

  constructor(private readonly respond: (text: string) => unknown[] = () => [{ id: 'updated' }]) {}

  async query<R>(text: string, params: unknown[] = []): Promise<any> {
    this.calls.push(text);
    this.params.push(params);
    const rows = this.respond(text) as R[];
    return { rows, rowCount: rows.length, command: '', oid: 0, fields: [] };
  }
}

test('secure-file retention skips legal holds and deletes every object before expiring state', async () => {
  const order: string[] = [];
  const pg = new RecordingPg((sql) => {
    if (/SELECT file\.id, file\.object_key/i.test(sql)) return [
      {
        id: 'file-a', object_key: 'source-a', part_keys: ['part-a'],
        derivative_keys: ['thumb-a'], held: false
      },
      {
        id: 'file-held', object_key: 'source-held', part_keys: [],
        derivative_keys: [], held: true
      }
    ];
    if (/SET status = 'expired'/i.test(sql)) order.push('state:expired');
    return [{ id: 'updated' }];
  });
  const storage = objectStorage(async (key) => {
    order.push(`object:${key}`);
    return 'deleted';
  });
  const handlers = createPostgresIveKitRetentionCategoryHandlers({ pg, storage });

  const summary = await handlers.secure_files.deleteExpired(claim('secure_files'));

  assert.deepEqual(summary, { scanned_count: 2, deleted_count: 1, held_count: 1 });
  assert.deepEqual(order, [
    'object:source-a', 'object:part-a', 'object:thumb-a', 'state:expired', 'state:expired'
  ]);
  assert.equal(order.some((item) => item.includes('held')), false);
  const fence = pg.calls.findIndex((sql) => /cleanup_lease_token_hash = \$4[\s\S]*FOR UPDATE/i.test(sql));
  const expire = pg.calls.findIndex((sql) => /UPDATE collaboration_secure_file_derivatives/i.test(sql));
  assert.ok(fence >= 0 && fence < expire);
  const candidateQuery = pg.calls.find((sql) => /SELECT file\.id, file\.object_key/i.test(sql))!;
  assert.match(candidateQuery, /LEAST\(/i);
  assert.match(candidateQuery, /file\.retention_until IS NULL AND file\.expires_at IS NULL/i);
  assert.match(candidateQuery, /ORDER BY held ASC/i);
  assert.equal(pg.params[pg.calls.indexOf(candidateQuery)]?.[2], '2026-07-15T00:00:00.000Z');
});

test('media-recording retention deletes the object before terminal state and skips holds', async () => {
  const order: string[] = [];
  const pg = new RecordingPg((sql) => {
    if (/SELECT recording\.id, recording\.storage_url/i.test(sql)) return [
      {
        id: 'recording-a', storage_url: 's3://recordings/a.mp4',
        media_call_id: 'media-call-a', call_session_id: '', held: false
      },
      { id: 'recording-held', storage_url: 's3://recordings/held.mp4', held: true }
    ];
    if (/UPDATE call_recordings/i.test(sql)) order.push('state:deleted');
    return [{ id: 'updated' }];
  });
  const handlers = createPostgresIveKitRetentionCategoryHandlers({
    pg,
    storage: objectStorage(async () => 'not_found'),
    deleteRecording: async (recording) => {
      order.push(`object:${recording.storage_url}`);
      return { status: 'deleted', source: 's3' };
    }
  });

  const summary = await handlers.media_recordings.deleteExpired(claim('media_recordings'));

  assert.deepEqual(summary, { scanned_count: 2, deleted_count: 1, held_count: 1 });
  assert.deepEqual(order, ['object:s3://recordings/a.mp4', 'state:deleted']);
  const candidateQuery = pg.calls.find((sql) => /SELECT recording\.id, recording\.storage_url/i.test(sql))!;
  assert.match(candidateQuery, /recording\.retention_until <= \$3/i);
  assert.match(candidateQuery,
    /recording\.retention_until IS NULL[\s\S]*recording\.created_at <= \$2/i);
  assert.match(candidateQuery, /ORDER BY held ASC/i);
  const transcriptDelete = pg.calls.find((sql) => /DELETE FROM ivekit_realtime_speech_segments/i.test(sql))!;
  assert.match(transcriptDelete, /tenant_id = \$1 AND interaction_id = \$2/i);
  assert.deepEqual(pg.params[pg.calls.indexOf(transcriptDelete)], ['tenant-a', 'media-call-a']);
});

function objectStorage(
  remove: ObjectStorage['delete']
): ObjectStorage {
  return {
    async upload() { throw new Error('not used'); },
    async download() { throw new Error('not used'); },
    async head() { throw new Error('not used'); },
    delete: remove,
    async initiateMultipart() { throw new Error('not used'); },
    async uploadPart() { throw new Error('not used'); },
    async completeMultipart() { throw new Error('not used'); },
    async abortMultipart() { throw new Error('not used'); }
  };
}

function claim(category: IveKitRetentionClaim['policy']['category']): IveKitRetentionClaim {
  return {
    run_id: `run-${category}`,
    worker_id: 'retention-worker-a',
    cutoff_at: '2026-06-15T00:00:00.000Z',
    started_at: '2026-07-15T00:00:00.000Z',
    policy: {
      tenant_id: 'tenant-a', category, enabled: true, retention_days: 30,
      batch_size: 10, interval_seconds: 3600,
      next_run_at: '2026-07-15T00:00:00.000Z', lease_owner: 'retention-worker-a',
      lease_expires_at: '2026-07-15T00:02:00.000Z', revision: 1,
      created_by: 'admin-a', updated_by: 'admin-a',
      created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-07-01T00:00:00.000Z'
    }
  };
}
