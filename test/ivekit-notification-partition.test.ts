import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const migrationPath =
  'src/migrations/081_ivekit_notification_worker_partition.sql';

test('notification delivery work has stable indexed logical shards', () => {
  assert.equal(existsSync(migrationPath), true);
  const sql = readFileSync(migrationPath, 'utf8');

  assert.match(sql, /ADD COLUMN IF NOT EXISTS worker_shard SMALLINT/);
  assert.match(sql, /substr\(md5\(id\), 1, 8\)/i);
  assert.match(sql, /CHECK \(worker_shard BETWEEN 0 AND 1023\)/i);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_ivekit_notification_delivery_worker_shard_due/i);
  assert.match(sql, /worker_shard = ANY \(p_shard_ids\)/i);
  assert.match(
    sql,
    /opc_notification_worker_tenant_ids\(\s*p_now TIMESTAMPTZ,\s*p_limit INTEGER,\s*p_shard_ids SMALLINT\[\]/i
  );
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION opc_notification_worker_tenant_ids\(\s*TIMESTAMPTZ,\s*INTEGER,\s*SMALLINT\[\]\s*\)/i
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION opc_notification_worker_tenant_ids\(\s*TIMESTAMPTZ,\s*INTEGER,\s*SMALLINT\[\]\s*\)/i
  );
});

test('Helm deploys notification workers as dynamically scalable competing consumers', () => {
  const template = readFileSync(
    'services/converact-service/helm/converact/templates/notification-worker.yaml',
    'utf8'
  );
  const values = readFileSync(
    'services/converact-service/helm/converact/values.yaml',
    'utf8'
  );
  const worker = readFileSync('src/converact-worker.ts', 'utf8');

  assert.match(template, /kind: Deployment/i);
  assert.doesNotMatch(template, /partition_index="\$\{HOSTNAME##\*-\}"/);
  assert.match(template, /OPC_IVEKIT_NOTIFICATION_PARTITION_COUNT[\s\S]*value: "1"/i);
  assert.match(template, /OPC_IVEKIT_NOTIFICATION_PARTITION_INDEX[\s\S]*value: "0"/i);
  assert.match(template, /exec node dist\/ivekit-worker\.js/i);
  assert.match(template, /OPC_TINODE_DELIVERY_WORKER_ENABLED[\s\S]*value: "0"/i);
  assert.match(values, /notificationWorker:[\s\S]*replicaCount: 2/i);
  assert.match(values, /notificationWorker:[\s\S]*autoscaling:[\s\S]*enabled: false/i);
  assert.match(template, /kind: ScaledObject/i);
  assert.match(template, /opc_ivekit_worker_backlog_depth/);
  assert.match(template, /opc_ivekit_worker_backlog_oldest_age_seconds/);
  assert.match(template, /fallback:[\s\S]*failureThreshold:[\s\S]*replicas:/i);
  assert.doesNotMatch(worker, /createIveKitHttpServer|initWebSocket|server\.listen/);
  assert.match(worker, /startIveKitApplication/);
});
