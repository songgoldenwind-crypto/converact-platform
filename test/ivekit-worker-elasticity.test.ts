import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const migrationPath = 'src/migrations/096_ivekit_worker_backlog_metrics.sql';

test('worker backlog metrics are aggregate-only and callable by the runtime role', () => {
  assert.equal(existsSync(migrationPath), true);
  const sql = readFileSync(migrationPath, 'utf8');

  assert.match(sql, /CREATE OR REPLACE FUNCTION opc_ivekit_worker_backlog_metrics\(/i);
  assert.match(
    sql,
    /RETURNS TABLE\(pool TEXT, depth BIGINT, oldest_age_seconds DOUBLE PRECISION\)/i
  );
  assert.match(sql, /SECURITY DEFINER/i);
  assert.match(sql, /SET search_path = pg_catalog, public/i);
  for (const pool of [
    'notification', 'event-webhook', 'attachment', 'quality', 'translation', 'file-security'
  ]) {
    assert.match(sql, new RegExp(`'${pool}'::TEXT`));
  }
  assert.doesNotMatch(sql, /SELECT\s+tenant_id/i);
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION opc_ivekit_worker_backlog_metrics\(TIMESTAMPTZ\) FROM PUBLIC/i
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION opc_ivekit_worker_backlog_metrics\(TIMESTAMPTZ\) TO opc_runtime/i
  );
});

test('backlog observer publishes bounded low-cardinality Prometheus metrics', () => {
  const observer = readFileSync(
    'src/agent-runtime/converact/operations/worker-backlog-metrics.ts',
    'utf8'
  );

  assert.match(observer, /opc_ivekit_worker_backlog_depth/);
  assert.match(observer, /opc_ivekit_worker_backlog_oldest_age_seconds/);
  assert.match(observer, /opc_ivekit_worker_backlog_observer_up/);
  assert.match(observer, /OPC_IVEKIT_WORKER_BACKLOG_METRICS_ENABLED/);
  assert.match(observer, /OPC_IVEKIT_WORKER_BACKLOG_METRICS_INTERVAL_MS/);
  assert.doesNotMatch(observer, /tenant_id|session_id|message_id/);
});

test('Helm provides fixed worker pools and backlog-driven KEDA without arbitrary worker env', () => {
  const values = readFileSync('services/converact-service/helm/converact/values.yaml', 'utf8');
  const template = readFileSync(
    'services/converact-service/helm/converact/templates/async-worker-pools.yaml',
    'utf8'
  );
  const helpers = readFileSync(
    'services/converact-service/helm/converact/templates/_helpers.tpl',
    'utf8'
  );

  for (const pool of ['eventWebhook', 'attachment', 'quality', 'translation', 'fileSecurity']) {
    assert.match(values, new RegExp(`\\n    ${pool}:\\n`));
  }
  assert.match(values, /prometheusAddress:/);
  assert.doesNotMatch(values, /workerPools:[\s\S]*?extraEnv:/);
  assert.match(template, /kind: Deployment/i);
  assert.match(template, /kind: PodDisruptionBudget/i);
  assert.match(template, /kind: ScaledObject/i);
  assert.match(template, /opc_ivekit_worker_backlog_depth/);
  assert.match(template, /opc_ivekit_worker_backlog_oldest_age_seconds/);
  assert.match(template, /fallback:[\s\S]*failureThreshold:[\s\S]*replicas:/i);
  assert.match(template, /scaleDown:[\s\S]*stabilizationWindowSeconds:/i);
  assert.match(template, /OPC_IVEKIT_EVENT_WEBHOOK_WORKER_ENABLED/);
  assert.match(template, /OPC_ATTACHMENT_PROCESSING_WORKER_ENABLED/);
  assert.match(template, /OPC_QUALITY_REVIEW_WORKER_ENABLED/);
  assert.match(template, /OPC_TRANSLATION_WORKER_ENABLED/);
  assert.match(template, /OPC_FILE_SECURITY_SCAN_WORKER_ENABLED/);
  assert.match(helpers, /workerPools\.autoscaling\.prometheusAddress is required/i);
  assert.match(helpers, /worker pool minReplicas must not exceed maxReplicas/i);
});

test('observability profile enables one API backlog observer and keeps workers off API pods', () => {
  const profile = readFileSync(
    'services/converact-service/helm/converact/profiles/observability.values.yaml',
    'utf8'
  );
  const aiProfile = readFileSync(
    'services/converact-service/helm/converact/profiles/ai.values.yaml',
    'utf8'
  );

  assert.match(profile, /OPC_IVEKIT_WORKER_BACKLOG_METRICS_ENABLED: "1"/);
  assert.match(aiProfile, /workerPools:[\s\S]*attachment:[\s\S]*enabled: true/);
  assert.match(aiProfile, /workerPools:[\s\S]*quality:[\s\S]*enabled: true/);
  assert.match(aiProfile, /workerPools:[\s\S]*translation:[\s\S]*enabled: true/);
  assert.doesNotMatch(aiProfile, /config:[\s\S]*OPC_ATTACHMENT_PROCESSING_WORKER_ENABLED: "1"/);
  assert.doesNotMatch(aiProfile, /observability: false/);
  assert.doesNotMatch(profile, /ai: false/);
});
