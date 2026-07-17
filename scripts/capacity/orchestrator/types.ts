import type { LoadRunManifest, LoadShard } from '../profile-compiler.js';

export type CapacityRunState =
  | 'planned'
  | 'ready'
  | 'running'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'not_run';

export type CapacityWorkerState = 'online' | 'draining' | 'offline';
export type CapacityShardOutcome = 'completed' | 'failed' | 'cancelled' | 'not_run';
export type CapacityRunOutcome =
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'not_run'
  | 'invalid_generator_capacity';
export type CapacityEvidenceState =
  | 'pending'
  | 'uploading'
  | 'uploaded'
  | 'verified'
  | 'rejected'
  | 'not_run';
export type CapacityShardExecutionState = 'running' | 'result_ready';

export interface CapacityShardExecutionResult {
  schema_version: '1.0.0';
  outcome: CapacityShardOutcome;
  error_code: string;
  evidence_kind: string;
  evidence: Record<string, unknown>;
}

export interface CapacityShardExecutionCheckpoint {
  state: CapacityShardExecutionState;
  result: CapacityShardExecutionResult | null;
  result_sha256: string;
}

export interface CapacityControllerLease {
  run_id: string;
  controller_id: string;
  lease_epoch: string;
  lease_expires_at: string;
}

export interface CapacityWorkerHeartbeat {
  run_id: string;
  worker_id: string;
  fleet_id: string;
  release_id: string;
  state: CapacityWorkerState;
  safe_capacity: number;
  reported_load: number;
  observed_at: string;
  metadata: Record<string, unknown>;
}

export interface CapacityShardAssignment extends Omit<LoadShard,
  'assigned_fleet' | 'initial_lease_epoch'> {
  run_id: string;
  phase_id: string;
  worker_id: string;
  fleet_id: string;
  lease_epoch: string;
  lease_expires_at: string;
}

export interface CapacityShardLeaseRenewal extends CapacityShardAssignment {
  execution_claimed: boolean;
  execution_checkpoint?: CapacityShardExecutionCheckpoint;
}

export interface CapacityStartShardCommand {
  schema_version: '1.0.0';
  command_id: string;
  command_type: 'start_shard';
  run_id: string;
  phase_id: string;
  shard_id: string;
  worker_id: string;
  fleet_id: string;
  lease_epoch: string;
  lease_expires_at: string;
  issued_at: string;
  assignment: Pick<CapacityShardAssignment,
    | 'workload_domain'
    | 'workload_id'
    | 'workload_kind'
    | 'ordinal_start'
    | 'ordinal_end_exclusive'
    | 'expected_count'
    | 'required_protocols'
    | 'seed'>;
}

export interface CapacityCommandEnvelope {
  subject: string;
  payload: CapacityStartShardCommand;
}

export interface CapacityCommandOutboxRecord extends CapacityCommandEnvelope {
  command_id: string;
  dispatcher_id: string;
  dispatch_epoch: string;
}

export interface CapacityCommandBus {
  publish(command: CapacityCommandEnvelope): Promise<void>;
}

export interface CapacityEvidenceRecord {
  evidence_id: string;
  run_id: string;
  phase_id: string;
  shard_id: string;
  kind: string;
  state: CapacityEvidenceState;
  object_uri: string;
  sha256: string;
  byte_size: number;
  metadata: Record<string, unknown>;
  error_code: string;
  captured_at: string;
  verified_at: string;
}

export interface CapacityLoadRunRepository {
  createRun(input: {
    manifest: LoadRunManifest;
    manifest_sha256: string;
    created_at: string;
  }): Promise<void>;
  claimController(input: {
    run_id: string;
    controller_id: string;
    lease_ttl_ms: number;
    now: string;
  }): Promise<CapacityControllerLease>;
  startPhase(input: {
    run_id: string;
    phase_id: string;
    controller_id: string;
    controller_lease_epoch: string;
    now: string;
  }): Promise<void>;
  heartbeatWorker(input: CapacityWorkerHeartbeat): Promise<void>;
  assignNextShard(input: {
    run_id: string;
    phase_id: string;
    worker_id: string;
    fleet_id: string;
    lease_ttl_ms: number;
    now: string;
  }): Promise<CapacityShardAssignment | null>;
  renewShardLease(input: {
    run_id: string;
    phase_id: string;
    shard_id: string;
    worker_id: string;
    lease_epoch: string;
    lease_ttl_ms: number;
    now: string;
  }): Promise<CapacityShardLeaseRenewal>;
  completeShard(input: {
    run_id: string;
    phase_id: string;
    shard_id: string;
    worker_id: string;
    lease_epoch: string;
    outcome: CapacityShardOutcome;
    evidence_id: string;
    error_code: string;
    now: string;
  }): Promise<void>;
  completePhase(input: {
    run_id: string;
    phase_id: string;
    controller_id: string;
    controller_lease_epoch: string;
    outcome: 'completed' | 'failed';
    now: string;
  }): Promise<void>;
  finalizeRun(input: {
    run_id: string;
    controller_id: string;
    controller_lease_epoch: string;
    outcome: CapacityRunOutcome;
    evidence_manifest_sha256: string;
    failure_code: string;
    now: string;
  }): Promise<void>;
  registerEvidence(input: {
    evidence_id: string;
    run_id: string;
    phase_id: string;
    shard_id: string;
    kind: string;
    metadata: Record<string, unknown>;
    now: string;
  }): Promise<CapacityEvidenceRecord>;
  startEvidenceUpload(input: {
    evidence_id: string;
    now: string;
  }): Promise<CapacityEvidenceRecord>;
  completeEvidenceUpload(input: {
    evidence_id: string;
    object_uri: string;
    sha256: string;
    byte_size: number;
    captured_at: string;
    now: string;
  }): Promise<CapacityEvidenceRecord>;
  verifyEvidence(input: {
    evidence_id: string;
    outcome: 'verified' | 'rejected' | 'not_run';
    error_code: string;
    now: string;
  }): Promise<CapacityEvidenceRecord>;
  claimCommands(input: {
    dispatcher_id: string;
    lease_ttl_ms: number;
    limit: number;
    now: string;
  }): Promise<CapacityCommandOutboxRecord[]>;
  markCommandPublished(input: {
    command_id: string;
    dispatcher_id: string;
    dispatch_epoch: string;
    now: string;
  }): Promise<void>;
  releaseCommand(input: {
    command_id: string;
    dispatcher_id: string;
    dispatch_epoch: string;
    error_code: string;
    now: string;
  }): Promise<void>;
}

export interface CapacityShardExecutionCheckpointRepository {
  saveShardExecutionResult(input: {
    run_id: string;
    phase_id: string;
    shard_id: string;
    worker_id: string;
    lease_epoch: string;
    result: CapacityShardExecutionResult;
    result_sha256: string;
    now: string;
  }): Promise<CapacityShardExecutionCheckpoint>;
}

export class LoadRunControlError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: string, status: number, retryable = false) {
    super(code);
    this.name = 'LoadRunControlError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
