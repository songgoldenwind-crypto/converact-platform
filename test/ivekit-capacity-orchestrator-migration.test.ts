import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('capacity orchestrator migration persists leases, workers, evidence and transactional outbox', () => {
  const sql = readFileSync('src/migrations/077_ivekit_capacity_orchestrator.sql', 'utf8');

  for (const table of [
    'ivekit_capacity_load_runs',
    'ivekit_capacity_load_phases',
    'ivekit_capacity_load_shards',
    'ivekit_capacity_load_workers',
    'ivekit_capacity_evidence',
    'ivekit_capacity_command_outbox'
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, 'i'));
  }
  assert.match(sql, /controller_lease_epoch BIGINT NOT NULL DEFAULT 0/i);
  assert.match(sql, /lease_epoch BIGINT NOT NULL DEFAULT 0/i);
  assert.match(sql, /reported_load INTEGER NOT NULL/i);
  assert.match(sql, /execution_state TEXT NOT NULL DEFAULT 'pending'/i);
  assert.match(sql, /execution_result JSONB NOT NULL DEFAULT '\{\}'::JSONB/i);
  assert.match(sql, /execution_result_sha256 TEXT NOT NULL DEFAULT ''/i);
  assert.match(sql, /dispatch_epoch BIGINT NOT NULL DEFAULT 0/i);
  assert.match(sql, /CHECK \(state IN \('planned', 'ready', 'running', 'finalizing', 'completed', 'failed', 'cancelled', 'not_run'\)\)/i);
  assert.match(sql, /UNIQUE \(run_id, phase_id, shard_id\)/i);
  assert.match(sql, /UNIQUE \(run_id, command_key\)/i);
  assert.match(sql, /CHECK \(sha256 = '' OR sha256 ~ '\^\[a-f0-9\]\{64\}\$'\)/i);
  assert.match(sql, /CHECK \(shard_id IS NULL OR phase_id IS NOT NULL\)/i);
  assert.match(
    sql,
    /FOREIGN KEY \(run_id, phase_id, shard_id\)[\s\S]*REFERENCES ivekit_capacity_load_shards/i
  );
});

test('capacity worker checkpoint upgrade is safe for databases that already ran migration 077', () => {
  const sql = readFileSync(
    'src/migrations/082_ivekit_capacity_worker_checkpoints.sql',
    'utf8'
  );

  assert.match(sql, /ALTER TABLE ivekit_capacity_load_shards/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS execution_state/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS execution_result JSONB/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS execution_result_sha256/i);
  assert.match(sql, /SET execution_state = 'running'[\s\S]*state = 'running'/i);
  assert.match(sql, /idx_ivekit_capacity_load_shards_worker_outstanding/i);
});

test('capacity composite workload upgrade persists co-executed workload coverage', () => {
  const sql = readFileSync(
    'src/migrations/100_ivekit_capacity_composite_workloads.sql',
    'utf8'
  );

  assert.match(sql, /ALTER TABLE ivekit_capacity_load_shards/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS covered_workloads JSONB/i);
  assert.match(sql, /jsonb_typeof\(covered_workloads\) = 'array'/i);
});
