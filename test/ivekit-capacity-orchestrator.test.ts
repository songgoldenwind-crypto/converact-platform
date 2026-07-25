import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalSha256 } from '../scripts/capacity/canonical-json.js';
import {
  DurableLoadRunOrchestrator,
  FencedCapacityCommandHandler,
  LoadRunControlError,
  validateStartShardCommand,
  type CapacityCommandBus,
  type CapacityCommandEnvelope,
  type CapacityCommandOutboxRecord,
  type CapacityControllerLease,
  type CapacityEvidenceRecord,
  type CapacityLoadRunRepository,
  type CapacityShardAssignment,
  type CapacityWorkerHeartbeat
} from '../scripts/capacity/orchestrator/index.js';

test('orchestrator persists run creation and controller fencing before scheduling work', async () => {
  const repository = new FakeRepository();
  const orchestrator = new DurableLoadRunOrchestrator({
    repository,
    command_bus: new FakeCommandBus()
  });

  const runManifest = manifest();
  await orchestrator.createRun({
    manifest: runManifest,
    manifest_sha256: canonicalSha256(runManifest),
    created_at: '2026-07-16T08:00:00.000Z'
  });
  const lease = await orchestrator.claimController({
    run_id: 'run-capacity-001',
    controller_id: 'controller-a',
    lease_ttl_ms: 15_000,
    now: '2026-07-16T08:00:01.000Z'
  });

  assert.equal(repository.created.length, 1);
  assert.equal(lease.lease_epoch, '1');
  assert.equal(repository.controllerClaims[0]?.lease_ttl_ms, 15_000);

  await assert.rejects(
    () => orchestrator.startPhase({
      run_id: 'run-capacity-001',
      phase_id: 'steady',
      controller_id: 'controller-a',
      controller_lease_epoch: '0',
      now: '2026-07-16T08:00:02.000Z'
    }),
    (error: unknown) => error instanceof LoadRunControlError && error.code === 'stale_controller_lease'
  );
});

test('worker assignment is fenced and durable command dispatch retries publish failures', async () => {
  const repository = new FakeRepository();
  const bus = new FakeCommandBus();
  const orchestrator = new DurableLoadRunOrchestrator({ repository, command_bus: bus });
  const heartbeat: CapacityWorkerHeartbeat = {
    run_id: 'run-capacity-001',
    worker_id: 'tinode-worker-a',
    fleet_id: 'tinode',
    release_id: 'loadgen@abc123',
    state: 'online',
    safe_capacity: 2_000,
    reported_load: 0,
    observed_at: '2026-07-16T08:00:03.000Z',
    metadata: {}
  };

  await orchestrator.heartbeatWorker(heartbeat);
  const assignment = await orchestrator.assignNextShard({
    run_id: heartbeat.run_id,
    phase_id: 'steady',
    worker_id: heartbeat.worker_id,
    fleet_id: heartbeat.fleet_id,
    lease_ttl_ms: 10_000,
    now: '2026-07-16T08:00:04.000Z'
  });
  assert.equal(assignment?.lease_epoch, '7');
  assert.equal(repository.assignments.length, 1);

  bus.failNext = true;
  const failed = await orchestrator.dispatchCommands({
    dispatcher_id: 'dispatcher-a',
    lease_ttl_ms: 5_000,
    limit: 10,
    now: '2026-07-16T08:00:05.000Z'
  });
  assert.deepEqual(failed, {
    claimed: 1,
    published: 0,
    released: 1,
    unconfirmed: 0
  });
  assert.deepEqual(repository.releasedCommands, ['command-a']);

  const retried = await orchestrator.dispatchCommands({
    dispatcher_id: 'dispatcher-b',
    lease_ttl_ms: 5_000,
    limit: 10,
    now: '2026-07-16T08:00:11.000Z'
  });
  assert.deepEqual(retried, {
    claimed: 1,
    published: 1,
    released: 0,
    unconfirmed: 0
  });
  assert.deepEqual(repository.publishedCommands, ['command-a']);
  assert.equal(bus.published[0]?.subject, 'ivekit.capacity.command.tinode.tinode-worker-a');
  assert.equal(bus.published[0]?.payload.lease_epoch, '7');
});

test('published commands with an unconfirmed database mark are not released early', async () => {
  const repository = new FakeRepository();
  repository.failPublishedMark = true;
  const orchestrator = new DurableLoadRunOrchestrator({
    repository,
    command_bus: new FakeCommandBus()
  });
  const result = await orchestrator.dispatchCommands({
    dispatcher_id: 'dispatcher-a',
    lease_ttl_ms: 5_000,
    limit: 10,
    now: '2026-07-16T08:00:05.000Z'
  });
  assert.deepEqual(result, {
    claimed: 1,
    published: 0,
    released: 0,
    unconfirmed: 1
  });
  assert.deepEqual(repository.releasedCommands, []);
});

test('stale shard completions cannot overwrite a takeover owner', async () => {
  const repository = new FakeRepository();
  const orchestrator = new DurableLoadRunOrchestrator({
    repository,
    command_bus: new FakeCommandBus()
  });

  await assert.rejects(
    () => orchestrator.completeShard({
      run_id: 'run-capacity-001',
      phase_id: 'steady',
      shard_id: 'interaction/tinode-im/0-1000',
      worker_id: 'tinode-worker-old',
      lease_epoch: '6',
      outcome: 'completed',
      evidence_id: 'evidence-a',
      error_code: '',
      now: '2026-07-16T08:00:20.000Z'
    }),
    (error: unknown) => error instanceof LoadRunControlError && error.code === 'stale_shard_lease'
  );
});

test('evidence validation rejects forged checksums before repository mutation', async () => {
  const repository = new FakeRepository();
  const orchestrator = new DurableLoadRunOrchestrator({
    repository,
    command_bus: new FakeCommandBus()
  });

  await assert.rejects(
    () => orchestrator.completeEvidenceUpload({
      evidence_id: 'evidence-a',
      object_uri: 's3://capacity/run-a/evidence-a.json',
      sha256: 'not-a-sha256',
      byte_size: 100,
      captured_at: '2026-07-16T08:00:20.000Z',
      now: '2026-07-16T08:00:21.000Z'
    }),
    (error: unknown) => error instanceof LoadRunControlError &&
      error.code === 'evidence_sha256_invalid'
  );
  assert.equal(repository.evidenceUploads, 0);
});

test('orchestrator rejects ambiguous shard, evidence and final run truth inputs', async () => {
  const repository = new FakeRepository();
  const orchestrator = new DurableLoadRunOrchestrator({
    repository,
    command_bus: new FakeCommandBus()
  });

  await assert.rejects(
    () => orchestrator.registerEvidence({
      evidence_id: 'evidence-a',
      run_id: 'run-capacity-001',
      phase_id: '',
      shard_id: 'interaction/tinode-im/0-1000',
      kind: 'shard_summary',
      metadata: {},
      now: '2026-07-16T08:00:20.000Z'
    }),
    (error: unknown) => error instanceof LoadRunControlError &&
      error.code === 'shard_evidence_phase_required'
  );
  await assert.rejects(
    () => orchestrator.completeShard({
      run_id: 'run-capacity-001',
      phase_id: 'steady',
      shard_id: 'interaction/tinode-im/0-1000',
      worker_id: 'tinode-worker-a',
      lease_epoch: '7',
      outcome: 'completed',
      evidence_id: '',
      error_code: '',
      now: '2026-07-16T08:00:20.000Z'
    }),
    (error: unknown) => error instanceof LoadRunControlError &&
      error.code === 'completed_shard_evidence_required'
  );
  await assert.rejects(
    () => orchestrator.verifyEvidence({
      evidence_id: 'evidence-a',
      outcome: 'rejected',
      error_code: '',
      now: '2026-07-16T08:00:20.000Z'
    }),
    (error: unknown) => error instanceof LoadRunControlError &&
      error.code === 'evidence_error_code_required'
  );
  await assert.rejects(
    () => orchestrator.finalizeRun({
      run_id: 'run-capacity-001',
      controller_id: 'controller-a',
      controller_lease_epoch: '1',
      outcome: 'failed',
      evidence_manifest_sha256: 'a'.repeat(64),
      failure_code: '',
      now: '2026-07-16T08:00:20.000Z'
    }),
    (error: unknown) => error instanceof LoadRunControlError &&
      error.code === 'run_failure_code_required'
  );
  await assert.doesNotReject(
    () => orchestrator.finalizeRun({
      run_id: 'run-capacity-001',
      controller_id: 'controller-a',
      controller_lease_epoch: '1',
      outcome: 'failed',
      evidence_manifest_sha256: '',
      failure_code: 'capacity_phase_failed',
      now: '2026-07-16T08:00:20.000Z'
    })
  );
});

test('evidence object URI accepts production stores and rejects local or credentialed URLs', async () => {
  const repository = new FakeRepository();
  const orchestrator = new DurableLoadRunOrchestrator({
    repository,
    command_bus: new FakeCommandBus()
  });
  const common = {
    evidence_id: 'evidence-a',
    sha256: 'a'.repeat(64),
    byte_size: 100,
    captured_at: '2026-07-16T08:00:20.000Z',
    now: '2026-07-16T08:00:21.000Z'
  };
  await orchestrator.completeEvidenceUpload({
    ...common,
    object_uri: 's3://capacity/run-a/evidence-a.json'
  });
  await assert.rejects(
    () => orchestrator.completeEvidenceUpload({
      ...common,
      object_uri: 'file:///tmp/evidence-a.json'
    }),
    (error: unknown) => error instanceof LoadRunControlError &&
      error.code === 'object_uri_invalid'
  );
  await assert.rejects(
    () => orchestrator.completeEvidenceUpload({
      ...common,
      object_uri: 'https://user:secret@objects.example.com/evidence-a.json'
    }),
    (error: unknown) => error instanceof LoadRunControlError &&
      error.code === 'object_uri_invalid'
  );
});

test('command handler renews the authoritative shard lease before generator side effects', async () => {
  const order: string[] = [];
  const handler = new FencedCapacityCommandHandler({
    worker_id: 'tinode-worker-a',
    fleet_id: 'tinode',
    lease_ttl_ms: 10_000,
    now: () => '2026-07-16T08:00:05.000Z',
    coordinator: {
      async renew(input) {
        order.push(`renew:${input.lease_epoch}`);
        return { execution_claimed: true };
      }
    },
    executor: {
      async start(command, _options) {
        order.push(`start:${command.shard_id}`);
      }
    }
  });

  await handler.handle(commandPayload());
  assert.deepEqual(order, [
    'renew:7',
    'start:interaction/tinode-im/0-1000'
  ]);

  await assert.rejects(
    () => handler.handle({
      ...commandPayload(),
      worker_id: 'tinode-worker-old'
    }),
    (error: unknown) => error instanceof LoadRunControlError &&
      error.code === 'command_target_mismatch'
  );
  assert.equal(order.length, 2);
});

test('command handler does not execute a redelivered command after execution was claimed', async () => {
  let starts = 0;
  let resumes = 0;
  const handler = new FencedCapacityCommandHandler({
    worker_id: 'tinode-worker-a',
    fleet_id: 'tinode',
    lease_ttl_ms: 10_000,
    now: () => '2026-07-16T08:00:05.000Z',
    coordinator: {
      async renew() {
        return { execution_claimed: false };
      }
    },
    executor: {
      async start() {
        starts += 1;
      },
      async resume() {
        resumes += 1;
      }
    }
  });
  await handler.handle(commandPayload());
  assert.equal(starts, 0);
  assert.equal(resumes, 0);
});

test('command handler resumes durable result finalization without restarting the generator', async () => {
  let starts = 0;
  const resumed: unknown[] = [];
  const result = {
    schema_version: '1.0.0' as const,
    outcome: 'completed' as const,
    error_code: '',
    evidence_kind: 'tinode_shard_result',
    evidence: {
      status: 'controlled_pass',
      attempted_count: 1000,
      accepted_count: 1000
    }
  };
  const handler = new FencedCapacityCommandHandler({
    worker_id: 'tinode-worker-a',
    fleet_id: 'tinode',
    lease_ttl_ms: 10_000,
    now: () => '2026-07-16T08:00:05.000Z',
    coordinator: {
      async renew() {
        return {
          execution_claimed: false,
          execution_checkpoint: {
            state: 'result_ready' as const,
            result,
            result_sha256: canonicalSha256(result)
          }
        };
      }
    },
    executor: {
      async start() {
        starts += 1;
      },
      async resume(_command, checkpoint) {
        resumed.push(checkpoint);
      }
    }
  });

  await handler.handle(commandPayload());

  assert.equal(starts, 0);
  assert.equal(resumed.length, 1);
  assert.deepEqual(resumed[0], {
    state: 'result_ready',
    result,
    result_sha256: canonicalSha256(result)
  });
});

test('start shard command validation bounds payload, protocols and validity window', () => {
  const composite = commandPayload();
  composite.assignment.covered_workloads = [{
    workload_domain: 'interaction',
    workload_id: 'tinode_im',
    workload_kind: 'tinode_im',
    ordinal_start: 0,
    ordinal_end_exclusive: 600,
    expected_count: 600
  }];
  assert.deepEqual(
    validateStartShardCommand(composite).assignment.covered_workloads,
    composite.assignment.covered_workloads
  );
  assert.deepEqual(
    validateStartShardCommand({
      ...commandPayload(),
      assignment: {
        ...commandPayload().assignment,
        covered_workloads: []
      }
    }).assignment.covered_workloads,
    []
  );

  assert.throws(
    () => validateStartShardCommand({
      ...commandPayload(),
      issued_at: '2026-07-16T08:00:15.000Z',
      lease_expires_at: '2026-07-16T08:00:14.000Z'
    }),
    (error: unknown) => error instanceof LoadRunControlError &&
      error.code === 'command_payload_invalid'
  );
  assert.throws(
    () => validateStartShardCommand({
      ...composite,
      assignment: {
        ...composite.assignment,
        covered_workloads: [{
          ...composite.assignment.covered_workloads[0],
          expected_count: 599
        }]
      }
    }),
    (error: unknown) => error instanceof LoadRunControlError &&
      error.code === 'command_assignment_invalid'
  );
  assert.throws(
    () => validateStartShardCommand({
      ...commandPayload(),
      assignment: {
        ...commandPayload().assignment,
        required_protocols: ['tinode_websocket', 'tinode_websocket']
      }
    }),
    (error: unknown) => error instanceof LoadRunControlError &&
      error.code === 'command_assignment_invalid'
  );
  assert.throws(
    () => validateStartShardCommand({
      ...commandPayload(),
      assignment: {
        ...commandPayload().assignment,
        seed: `seed-${'x'.repeat(70_000)}`
      }
    }),
    (error: unknown) => error instanceof LoadRunControlError &&
      error.code === 'command_payload_invalid'
  );
});

test('command handler renews throughout execution and aborts when lease renewal fails', async () => {
  let renewals = 0;
  let aborted = false;
  const handler = new FencedCapacityCommandHandler({
    worker_id: 'tinode-worker-a',
    fleet_id: 'tinode',
    lease_ttl_ms: 1_000,
    renewal_interval_ms: 100,
    now: () => new Date().toISOString(),
    coordinator: {
      async renew() {
        renewals += 1;
        if (renewals === 3) {
          throw new LoadRunControlError('stale_shard_lease', 409);
        }
        return { execution_claimed: renewals === 1 };
      }
    },
    executor: {
      async start(_command, { signal }) {
        await new Promise<void>((resolve) => {
          const stop = () => {
            aborted = true;
            resolve();
          };
          signal.addEventListener('abort', stop, { once: true });
          if (signal.aborted) stop();
        });
      }
    }
  });

  await assert.rejects(
    () => handler.handle({
      ...commandPayload(),
      lease_expires_at: new Date(Date.now() + 10_000).toISOString()
    }),
    (error: unknown) => error instanceof LoadRunControlError &&
      error.code === 'stale_shard_lease'
  );
  assert.equal(renewals, 3);
  assert.equal(aborted, true);
});

class FakeRepository implements CapacityLoadRunRepository {
  created: Array<Record<string, unknown>> = [];
  controllerClaims: Array<Record<string, unknown>> = [];
  assignments: Array<Record<string, unknown>> = [];
  publishedCommands: string[] = [];
  releasedCommands: string[] = [];
  evidenceUploads = 0;
  failPublishedMark = false;
  private commandAvailable = true;

  async createRun(input: any): Promise<void> {
    this.created.push(input);
  }

  async claimController(input: any): Promise<CapacityControllerLease> {
    this.controllerClaims.push(input);
    return {
      run_id: input.run_id,
      controller_id: input.controller_id,
      lease_epoch: '1',
      lease_expires_at: '2026-07-16T08:00:16.000Z'
    };
  }

  async startPhase(input: any): Promise<void> {
    if (input.controller_lease_epoch !== '1') {
      throw new LoadRunControlError('stale_controller_lease', 409);
    }
  }

  async heartbeatWorker(_input: CapacityWorkerHeartbeat): Promise<void> {}

  async assignNextShard(input: any): Promise<CapacityShardAssignment | null> {
    this.assignments.push(input);
    return {
      run_id: input.run_id,
      phase_id: input.phase_id,
      shard_id: 'interaction/tinode-im/0-1000',
      worker_id: input.worker_id,
      fleet_id: input.fleet_id,
      lease_epoch: '7',
      lease_expires_at: '2026-07-16T08:00:14.000Z',
      workload_domain: 'interaction',
      workload_id: 'tinode-im',
      workload_kind: 'tinode_im',
      ordinal_start: 0,
      ordinal_end_exclusive: 1000,
      expected_count: 1000,
      required_protocols: ['tinode_websocket'],
      seed: 'seed-a'
    };
  }

  async renewShardLease(): Promise<any> {
    throw new Error('not used');
  }

  async completeShard(): Promise<void> {
    throw new LoadRunControlError('stale_shard_lease', 409);
  }

  async completePhase(): Promise<void> {}

  async finalizeRun(): Promise<void> {}

  async registerEvidence(input: any): Promise<CapacityEvidenceRecord> {
    return evidence({ ...input, state: 'pending' });
  }

  async startEvidenceUpload(input: any): Promise<CapacityEvidenceRecord> {
    return evidence({ ...input, state: 'uploading' });
  }

  async completeEvidenceUpload(input: any): Promise<CapacityEvidenceRecord> {
    this.evidenceUploads += 1;
    return evidence({ ...input, state: 'uploaded' });
  }

  async verifyEvidence(input: any): Promise<CapacityEvidenceRecord> {
    return evidence({ ...input, state: input.outcome });
  }

  async claimCommands(input: any): Promise<CapacityCommandOutboxRecord[]> {
    if (!this.commandAvailable && input.now < '2026-07-16T08:00:10.000Z') return [];
    this.commandAvailable = false;
    return [{
      command_id: 'command-a',
      subject: 'ivekit.capacity.command.tinode.tinode-worker-a',
      payload: {
        schema_version: '1.0.0',
        command_id: 'command-a',
        command_type: 'start_shard',
        run_id: 'run-capacity-001',
        phase_id: 'steady',
        shard_id: 'interaction/tinode-im/0-1000',
        worker_id: 'tinode-worker-a',
        fleet_id: 'tinode',
        lease_epoch: '7',
        lease_expires_at: '2026-07-16T08:00:14.000Z',
        issued_at: '2026-07-16T08:00:04.000Z',
        assignment: {
          workload_domain: 'interaction',
          workload_id: 'tinode-im',
          workload_kind: 'tinode_im',
          ordinal_start: 0,
          ordinal_end_exclusive: 1000,
          expected_count: 1000,
          required_protocols: ['tinode_websocket'],
          seed: 'seed-a'
        }
      },
      dispatcher_id: input.dispatcher_id,
      dispatch_epoch: '1'
    }];
  }

  async markCommandPublished(input: any): Promise<void> {
    if (this.failPublishedMark) {
      throw new LoadRunControlError('stale_dispatch_lease', 409);
    }
    this.publishedCommands.push(input.command_id);
  }

  async releaseCommand(input: any): Promise<void> {
    this.releasedCommands.push(input.command_id);
    this.commandAvailable = true;
  }
}

class FakeCommandBus implements CapacityCommandBus {
  failNext = false;
  published: CapacityCommandEnvelope[] = [];

  async publish(command: CapacityCommandEnvelope): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('nats unavailable');
    }
    this.published.push(command);
  }
}

function manifest(): any {
  return {
    schema_version: '1.0.0',
    run_id: 'run-capacity-001',
    profile_id: 'mix-100k-v1',
    profile_sha256: 'b'.repeat(64),
    fork_manifest_id: 'fork-001',
    fork_manifest_sha256: 'c'.repeat(64),
    sut_release_id: 'ivekit@abc123',
    generator_release_id: 'loadgen@abc123',
    seed: 'seed-a',
    run_epoch: '2026-07-16T08:00:00.000Z',
    topology: {
      fleets: [{ fleet_id: 'tinode', worker_count: 1, protocols: ['tinode_websocket'] }]
    },
    shards: [{
      shard_id: 'interaction/tinode-im/0-1000',
      workload_domain: 'interaction',
      workload_id: 'tinode-im',
      workload_kind: 'tinode_im',
      ordinal_start: 0,
      ordinal_end_exclusive: 1000,
      expected_count: 1000,
      required_protocols: ['tinode_websocket'],
      assigned_fleet: 'tinode',
      initial_lease_epoch: 0,
      seed: 'seed-a'
    }],
    phases: [
      { id: 'ramp', duration_seconds: 60 },
      { id: 'steady', duration_seconds: 300 }
    ],
    faults: [],
    expected_totals: {
      interactions: 1000,
      connections: 0,
      by_workload: { 'tinode-im': 1000 }
    },
    external_dependencies: [],
    start_not_before: '2026-07-16T08:00:00.000Z',
    evidence_prefix: 'capacity/run-capacity-001'
  };
}

function evidence(overrides: Record<string, unknown>): CapacityEvidenceRecord {
  return {
    evidence_id: String(overrides.evidence_id || 'evidence-a'),
    run_id: String(overrides.run_id || 'run-capacity-001'),
    phase_id: String(overrides.phase_id || ''),
    shard_id: String(overrides.shard_id || ''),
    kind: String(overrides.kind || 'shard_summary'),
    state: (overrides.state || 'pending') as CapacityEvidenceRecord['state'],
    object_uri: String(overrides.object_uri || ''),
    sha256: String(overrides.sha256 || ''),
    byte_size: Number(overrides.byte_size || 0),
    metadata: {},
    error_code: String(overrides.error_code || ''),
    captured_at: String(overrides.captured_at || ''),
    verified_at: String(overrides.verified_at || '')
  };
}

function commandPayload(): CapacityCommandEnvelope['payload'] {
  return {
    schema_version: '1.0.0',
    command_id: 'command-a',
    command_type: 'start_shard',
    run_id: 'run-capacity-001',
    phase_id: 'steady',
    shard_id: 'interaction/tinode-im/0-1000',
    worker_id: 'tinode-worker-a',
    fleet_id: 'tinode',
    lease_epoch: '7',
    lease_expires_at: '2026-07-16T08:00:14.000Z',
    issued_at: '2026-07-16T08:00:04.000Z',
    assignment: {
      workload_domain: 'interaction',
      workload_id: 'tinode-im',
      workload_kind: 'tinode_im',
      ordinal_start: 0,
      ordinal_end_exclusive: 1000,
      expected_count: 1000,
      required_protocols: ['tinode_websocket'],
      seed: 'seed-a'
    }
  };
}
