import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalSha256 } from '../scripts/capacity/canonical-json.js';
import { ExternalJsonCapacityShardDriver } from '../scripts/capacity/generators/external-worker.js';
import {
  CheckpointedCapacityShardExecutor,
  DurableCapacityShardResultFinalizer,
  capacityShardEvidenceDocument,
  type CapacityEvidenceObjectStore,
  type CapacityShardDriver,
  type CapacityShardResultControl
} from '../scripts/capacity/orchestrator/worker-runtime.js';
import type {
  CapacityEvidenceRecord,
  CapacityShardExecutionCheckpoint,
  CapacityShardExecutionResult,
  CapacityStartShardCommand
} from '../scripts/capacity/orchestrator/types.js';
import {
  assertCapacityWorkerSchema,
  capacityWorkerConfig
} from '../scripts/ivekit-capacity-worker.js';

test('checkpointed executor persists the generator result before evidence side effects', async () => {
  const order: string[] = [];
  const result = shardResult();
  const driver: CapacityShardDriver = {
    async execute() {
      order.push('driver');
      return result;
    }
  };
  const executor = new CheckpointedCapacityShardExecutor({
    driver,
    checkpoint_repository: {
      async saveShardExecutionResult(input) {
        order.push('checkpoint');
        assert.equal(input.result_sha256, canonicalSha256(result));
        return {
          state: 'result_ready',
          result: input.result,
          result_sha256: input.result_sha256
        };
      }
    },
    finalizer: {
      async finalize(_command, finalized) {
        order.push('finalize');
        assert.deepEqual(finalized, result);
      }
    },
    now: () => '2026-07-16T12:00:00.000Z'
  });

  await executor.start(command(), { signal: new AbortController().signal });

  assert.deepEqual(order, ['driver', 'checkpoint', 'finalize']);
});

test('checkpointed executor resumes finalization without rerunning the generator', async () => {
  let driverStarts = 0;
  let finalized = 0;
  const result = shardResult();
  const checkpoint: CapacityShardExecutionCheckpoint = {
    state: 'result_ready',
    result,
    result_sha256: canonicalSha256(result)
  };
  const executor = new CheckpointedCapacityShardExecutor({
    driver: {
      async execute() {
        driverStarts += 1;
        return result;
      }
    },
    checkpoint_repository: {
      async saveShardExecutionResult() {
        throw new Error('checkpoint must not be rewritten during resume');
      }
    },
    finalizer: {
      async finalize(_command, resumed) {
        finalized += 1;
        assert.deepEqual(resumed, result);
      }
    }
  });

  await executor.resume(command(), checkpoint, {
    signal: new AbortController().signal
  });

  assert.equal(driverStarts, 0);
  assert.equal(finalized, 1);
});

test('durable finalizer reuses verified evidence after a completion retry', async () => {
  const control = new FakeResultControl();
  const objectStore = new FakeObjectStore();
  const finalizer = new DurableCapacityShardResultFinalizer({
    control,
    object_store: objectStore,
    evidence_prefix: 'capacity/cell-10k',
    now: () => '2026-07-16T12:00:00.000Z'
  });

  control.failCompletionOnce = true;
  await assert.rejects(
    () => finalizer.finalize(command(), shardResult(), {
      signal: new AbortController().signal
    }),
    /completion unavailable/
  );
  await finalizer.finalize(command(), shardResult(), {
    signal: new AbortController().signal
  });

  assert.equal(objectStore.puts, 1);
  assert.equal(control.completed, 1);
  assert.equal(control.record.state, 'verified');
  assert.equal(
    control.record.sha256,
    canonicalSha256(capacityShardEvidenceDocument(command(), shardResult()))
  );
});

test('external worker driver binds immutable binary identity and the fenced command', async () => {
  const plans: any[] = [];
  const driver = new ExternalJsonCapacityShardDriver({
    spec: {
      schema_version: '1.0.0',
      executable: '/opt/ivekit/bin/tinode-capacity-worker',
      binary_version: 'tinode-loadgen@abc123',
      binary_sha256: 'a'.repeat(64),
      result_directory: '/var/lib/ivekit-capacity/results',
      timeout_ms: 60_000,
      args: ['--profile', 'cell-10k-v1'],
      static_input: {
        endpoint: 'wss://tinode.example.com/v0/channels',
        credential_bundle_path: '/run/secrets/tinode-loadgen.json'
      }
    },
    executor: async (plan) => {
      plans.push(plan);
      return {
        code: 0,
        timed_out: false,
        aborted: false,
        stdout: '',
        stderr: '',
        raw: { ...shardResult() } as Record<string, unknown>
      };
    }
  });

  const result = await driver.execute(command(), {
    signal: new AbortController().signal
  });

  assert.deepEqual(result, shardResult());
  assert.equal(plans[0].binary_sha256, 'a'.repeat(64));
  assert.equal(plans[0].input.command.lease_epoch, '7');
  assert.match(plans[0].result_path, /^[\/]var\/lib\/ivekit-capacity\/results\/[a-f0-9]{64}\.json$/);
  assert.deepEqual(plans[0].args.slice(-5), [
    'run', '--input-json', '-', '--result', plans[0].result_path
  ]);
});

test('capacity worker config is explicit, bounded and restart-stable', () => {
  const config = capacityWorkerConfig({
    CONVERACT_DATABASE_URL: 'postgresql://opc@postgres/ivekit',
    NATS_URL: 'tls://nats-a:4222,tls://nats-b:4222',
    NATS_USER: 'capacity-worker',
    NATS_PASSWORD: 'test-secret',
    NATS_TLS_MODE: 'required',
    NATS_TLS_CA_FILE: '/etc/nats/tls/ca.crt',
    NATS_TLS_CERT_FILE: '/etc/nats/tls/tls.crt',
    NATS_TLS_KEY_FILE: '/etc/nats/tls/tls.key',
    CONVERACT_FABRIC_CAPACITY_RUN_ID: 'run-capacity-001',
    CONVERACT_FABRIC_CAPACITY_PHASE_ID: 'steady',
    CONVERACT_FABRIC_CAPACITY_FLEET_ID: 'tinode',
    CONVERACT_FABRIC_CAPACITY_WORKER_ID: 'tinode-worker-a',
    CONVERACT_FABRIC_CAPACITY_RELEASE_ID: 'loadgen@abc123',
    CONVERACT_FABRIC_CAPACITY_SAFE_CAPACITY: '2000',
    CONVERACT_FABRIC_CAPACITY_HEARTBEAT_INTERVAL_MS: '5000',
    CONVERACT_FABRIC_CAPACITY_ASSIGNMENT_INTERVAL_MS: '250',
    CONVERACT_FABRIC_CAPACITY_SHARD_LEASE_MS: '30000',
    CONVERACT_FABRIC_CAPACITY_ACK_WAIT_MS: '60000',
    CONVERACT_FABRIC_CAPACITY_RETRY_DELAY_MS: '1000',
    CONVERACT_FABRIC_CAPACITY_DRIVER_SPEC_PATH: '/run/ivekit-capacity/driver-spec.json',
    CONVERACT_FABRIC_CAPACITY_EVIDENCE_PREFIX: 'capacity/cell-10k',
    CONVERACT_FABRIC_CAPACITY_EVIDENCE_S3_BUCKET: 'ivekit-capacity-evidence',
    CONVERACT_FABRIC_CAPACITY_EVIDENCE_S3_REGION: 'ap-southeast-1',
    CONVERACT_FABRIC_CAPACITY_WORKER_METADATA_JSON: '{"zone":"zone-a"}'
  });

  assert.equal(config.fleet_id, 'tinode');
  assert.equal(config.safe_capacity, 2000);
  assert.deepEqual(config.nats.servers, [
    'tls://nats-a:4222',
    'tls://nats-b:4222'
  ]);
  assert.equal(config.nats.name, 'tinode-worker-a');
  assert.equal(config.nats.user, 'capacity-worker');
  assert.equal(config.nats.pass, 'test-secret');
  assert.equal(config.nats.tls && config.nats.tls.rejectUnauthorized, true);
  assert.deepEqual(config.metadata, { zone: 'zone-a' });
  assert.equal(capacityWorkerConfig({
    CONVERACT_DATABASE_URL: 'postgresql://opc@postgres/ivekit',
    NATS_URL: 'nats://nats-a:4222',
    CONVERACT_FABRIC_CAPACITY_RUN_ID: 'run-capacity-001',
    CONVERACT_FABRIC_CAPACITY_FLEET_ID: 'tinode',
    CONVERACT_FABRIC_CAPACITY_WORKER_ID: 'tinode-worker-a',
    CONVERACT_FABRIC_CAPACITY_RELEASE_ID: 'loadgen@abc123',
    CONVERACT_FABRIC_CAPACITY_SAFE_CAPACITY: '2000',
    CONVERACT_FABRIC_CAPACITY_DRIVER_SPEC_PATH: '/run/ivekit-capacity/driver-spec.json',
    CONVERACT_FABRIC_CAPACITY_EVIDENCE_PREFIX: 'capacity/cell-10k',
    CONVERACT_FABRIC_CAPACITY_EVIDENCE_S3_BUCKET: 'ivekit-capacity-evidence',
    CONVERACT_FABRIC_CAPACITY_EVIDENCE_S3_REGION: 'ap-southeast-1'
  }).phase_id, '');
  assert.throws(
    () => capacityWorkerConfig({
      ...process.env,
      CONVERACT_DATABASE_URL: 'postgresql://opc@postgres/ivekit',
      NATS_URL: 'nats://nats:4222',
      CONVERACT_FABRIC_CAPACITY_RUN_ID: 'run-capacity-001',
      CONVERACT_FABRIC_CAPACITY_PHASE_ID: 'steady',
      CONVERACT_FABRIC_CAPACITY_FLEET_ID: 'unknown',
      CONVERACT_FABRIC_CAPACITY_WORKER_ID: 'worker-a',
      CONVERACT_FABRIC_CAPACITY_RELEASE_ID: 'loadgen@abc123',
      CONVERACT_FABRIC_CAPACITY_SAFE_CAPACITY: '1',
      CONVERACT_FABRIC_CAPACITY_DRIVER_SPEC_PATH: '/run/driver.json',
      CONVERACT_FABRIC_CAPACITY_EVIDENCE_PREFIX: 'capacity/test',
      CONVERACT_FABRIC_CAPACITY_EVIDENCE_S3_BUCKET: 'capacity-evidence',
      CONVERACT_FABRIC_CAPACITY_EVIDENCE_S3_REGION: 'us-east-1'
    }),
    /fleet/i
  );
});

test('capacity worker refuses to start without execution checkpoint schema', async () => {
  await assert.rejects(
    () => assertCapacityWorkerSchema({
      async query() {
        return { rows: [{ shards: 'ivekit_capacity_load_shards', execution_state: null }] };
      }
    }),
    /migration 082/i
  );
  await assert.doesNotReject(
    () => assertCapacityWorkerSchema({
      async query() {
        return {
          rows: [{
            shards: 'ivekit_capacity_load_shards',
            execution_state: 'execution_state'
          }]
        };
      }
    })
  );
});

class FakeObjectStore implements CapacityEvidenceObjectStore {
  puts = 0;

  async put(input: {
    key: string;
    body: Uint8Array;
    sha256: string;
  }): Promise<{ object_uri: string }> {
    this.puts += 1;
    assert.match(input.key, /^capacity\/cell-10k\/run-capacity-001\/steady\//);
    assert.equal(
      input.sha256,
      canonicalSha256(capacityShardEvidenceDocument(command(), shardResult()))
    );
    assert.ok(input.body.byteLength > 0);
    return { object_uri: `s3://capacity-evidence/${input.key}` };
  }
}

class FakeResultControl implements CapacityShardResultControl {
  record = evidence('pending');
  failCompletionOnce = false;
  completed = 0;

  async registerEvidence(): Promise<CapacityEvidenceRecord> {
    if (this.record.state === 'pending' && Object.keys(this.record.metadata).length === 0) {
      this.record.metadata = {
        command_id: 'command-capacity-001',
        fleet_id: 'tinode',
        worker_id: 'tinode-worker-a',
        lease_epoch: '7',
        result_sha256: canonicalSha256(shardResult()),
        evidence_sha256: canonicalSha256(
          capacityShardEvidenceDocument(command(), shardResult())
        )
      };
    }
    return structuredClone(this.record);
  }

  async startEvidenceUpload(): Promise<CapacityEvidenceRecord> {
    if (this.record.state === 'pending') this.record.state = 'uploading';
    return structuredClone(this.record);
  }

  async completeEvidenceUpload(input: {
    object_uri: string;
    sha256: string;
    byte_size: number;
    captured_at: string;
  }): Promise<CapacityEvidenceRecord> {
    if (this.record.state === 'uploading') {
      Object.assign(this.record, {
        state: 'uploaded',
        object_uri: input.object_uri,
        sha256: input.sha256,
        byte_size: input.byte_size,
        captured_at: input.captured_at
      });
    }
    return structuredClone(this.record);
  }

  async verifyEvidence(): Promise<CapacityEvidenceRecord> {
    if (this.record.state === 'uploaded') this.record.state = 'verified';
    return structuredClone(this.record);
  }

  async completeShard(): Promise<void> {
    if (this.failCompletionOnce) {
      this.failCompletionOnce = false;
      throw new Error('completion unavailable');
    }
    this.completed += 1;
  }
}

function command(): CapacityStartShardCommand {
  return {
    schema_version: '1.0.0',
    command_id: 'command-capacity-001',
    command_type: 'start_shard',
    run_id: 'run-capacity-001',
    phase_id: 'steady',
    shard_id: 'interaction/tinode_im/0-1000',
    worker_id: 'tinode-worker-a',
    fleet_id: 'tinode',
    lease_epoch: '7',
    lease_expires_at: '2026-07-16T12:01:00.000Z',
    issued_at: '2026-07-16T11:59:59.000Z',
    assignment: {
      workload_domain: 'interaction',
      workload_id: 'tinode_im',
      workload_kind: 'tinode_im',
      ordinal_start: 0,
      ordinal_end_exclusive: 1000,
      expected_count: 1000,
      required_protocols: ['tinode_websocket'],
      seed: 'seed-capacity-001'
    }
  };
}

function shardResult(): CapacityShardExecutionResult {
  return {
    schema_version: '1.0.0',
    outcome: 'completed',
    error_code: '',
    evidence_kind: 'tinode_shard_result',
    evidence: {
      status: 'controlled_pass',
      attempted_count: 1000,
      accepted_count: 1000
    }
  };
}

function evidence(state: CapacityEvidenceRecord['state']): CapacityEvidenceRecord {
  return {
    evidence_id: 'capacity-evidence-a',
    run_id: 'run-capacity-001',
    phase_id: 'steady',
    shard_id: 'interaction/tinode_im/0-1000',
    kind: 'tinode_shard_result',
    state,
    object_uri: '',
    sha256: '',
    byte_size: 0,
    metadata: {},
    error_code: '',
    captured_at: '',
    verified_at: ''
  };
}
