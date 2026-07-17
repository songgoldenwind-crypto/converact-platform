import { canonicalJson, canonicalSha256 } from '../canonical-json.js';
import {
  validateCapacityRunEvidence,
  type CapacityEvidenceResult,
  type ShardRunEvidence
} from '../evidence-validator.js';
import type { GeneratorFleetQualification } from '../generator-qualification.js';
import type { LoadRunManifest } from '../profile-compiler.js';
import type { CapacityRunControlState } from './controller.js';
import {
  LoadRunControlError,
  type CapacityControllerLease,
  type CapacityEvidenceRecord,
  type CapacityRunOutcome
} from './types.js';
import type { CapacityEvidenceObjectStore } from './worker-runtime.js';

export interface CapacityRunEvidenceSubmission {
  schema_version: '1.0.0';
  run_id: string;
  manifest_sha256: string;
  mode: 'controlled' | 'production';
  fleet_qualifications: GeneratorFleetQualification[];
  shard_evidence: ShardRunEvidence[];
}

export interface CapacityRunEvidenceDocument {
  schema_version: '1.0.0';
  run_id: string;
  manifest: LoadRunManifest;
  manifest_sha256: string;
  profile_id: string;
  fork_manifest_id: string;
  sut_release_id: string;
  generator_release_id: string;
  mode: 'controlled' | 'production';
  fleet_qualifications: GeneratorFleetQualification[];
  shard_evidence: ShardRunEvidence[];
  external_dependencies: LoadRunManifest['external_dependencies'];
  validation: CapacityEvidenceResult;
}

export interface CapacityRunEvidenceControl {
  readRunControlState(input: {
    run_id: string;
  }): Promise<CapacityRunControlState>;
  claimController(input: {
    run_id: string;
    controller_id: string;
    lease_ttl_ms: number;
    now: string;
  }): Promise<CapacityControllerLease>;
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
    outcome: 'verified';
    error_code: '';
    now: string;
  }): Promise<CapacityEvidenceRecord>;
  finalizeRun(input: {
    run_id: string;
    controller_id: string;
    controller_lease_epoch: string;
    outcome: CapacityRunOutcome;
    evidence_manifest_sha256: string;
    failure_code: string;
    now: string;
  }): Promise<void>;
}

export class CapacityRunEvidenceFinalizer {
  readonly #control: CapacityRunEvidenceControl;
  readonly #objectStore: CapacityEvidenceObjectStore;
  readonly #controllerId: string;
  readonly #leaseTtlMs: number;
  readonly #evidencePrefix: string;
  readonly #now: () => string;
  readonly #delay: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(input: {
    control: CapacityRunEvidenceControl;
    object_store: CapacityEvidenceObjectStore;
    controller_id: string;
    lease_ttl_ms: number;
    evidence_prefix: string;
    now?: () => string;
    delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  }) {
    this.#control = input.control;
    this.#objectStore = input.object_store;
    this.#controllerId = safeId(input.controller_id, 'controller_id');
    this.#leaseTtlMs = boundedInteger(
      input.lease_ttl_ms,
      1_000,
      300_000,
      'lease_ttl_ms'
    );
    this.#evidencePrefix = evidencePrefix(input.evidence_prefix);
    this.#now = input.now || (() => new Date().toISOString());
    this.#delay = input.delay || abortableDelay;
  }

  async finalize(input: {
    manifest: LoadRunManifest;
    submission: CapacityRunEvidenceSubmission;
  }, signal?: AbortSignal): Promise<CapacityEvidenceResult> {
    const manifestSha256 = canonicalSha256(input.manifest);
    validateSubmission(input.submission, input.manifest, manifestSha256);
    const validation = validateCapacityRunEvidence({
      mode: input.submission.mode,
      expected_manifest_sha256: manifestSha256,
      evidence_manifest_sha256: input.submission.manifest_sha256,
      expected_shards: input.manifest.phases.flatMap((phase) =>
        input.manifest.shards.map((shard) => ({
          phase_id: phase.id,
          shard_id: shard.shard_id,
          workload_domain: shard.workload_domain,
          workload_id: shard.workload_id,
          expected_count: shard.expected_count
        }))),
      required_fleet_ids: input.manifest.topology.fleets.map(
        (fleet) => fleet.fleet_id
      ),
      fleet_qualifications: input.submission.fleet_qualifications,
      shard_evidence: input.submission.shard_evidence,
      external_dependencies: input.manifest.external_dependencies
    });
    const document = capacityRunEvidenceDocument(
      input.manifest,
      input.submission,
      validation
    );
    const body = Buffer.from(canonicalJson(document));
    if (body.byteLength > 16 * 1024 * 1024) {
      throw new LoadRunControlError('run_evidence_manifest_too_large', 413);
    }
    const documentSha256 = canonicalSha256(document);
    const state = await this.#control.readRunControlState({
      run_id: input.manifest.run_id
    });
    if (state.manifest_sha256 !== manifestSha256) {
      throw new LoadRunControlError('existing_run_manifest_mismatch', 409);
    }
    if (state.state !== 'finalizing') {
      if (terminalStateMatches(state.state, validation.outcome) &&
          state.evidence_manifest_sha256 === documentSha256) return validation;
      throw new LoadRunControlError('run_not_ready_for_finalization', 409);
    }
    abortIfNeeded(signal);
    const lease = await this.#claimController(input.manifest.run_id, signal);
    const now = validTimestamp(this.#now());
    const evidenceId = `capacity-run-${canonicalSha256({
      run_id: input.manifest.run_id,
      manifest_sha256: manifestSha256
    })}`;
    const metadata = {
      manifest_sha256: manifestSha256,
      document_sha256: documentSha256,
      validation_outcome: validation.outcome,
      mode: input.submission.mode
    };
    let record = await this.#control.registerEvidence({
      evidence_id: evidenceId,
      run_id: input.manifest.run_id,
      phase_id: '',
      shard_id: '',
      kind: 'run_evidence_manifest',
      metadata,
      now
    });
    assertRunEvidenceRecord(
      record,
      input.manifest.run_id,
      metadata,
      documentSha256,
      body.byteLength
    );
    if (record.state === 'pending' || record.state === 'uploading') {
      record = await this.#control.startEvidenceUpload({
        evidence_id: evidenceId,
        now
      });
      assertRunEvidenceRecord(
        record,
        input.manifest.run_id,
        metadata,
        documentSha256,
        body.byteLength
      );
    }
    if (record.state === 'uploading') {
      abortIfNeeded(signal);
      const key = [
        this.#evidencePrefix,
        input.manifest.run_id,
        `run-evidence-${documentSha256}.json`
      ].join('/');
      const uploaded = await this.#objectStore.put({
        key,
        body,
        sha256: documentSha256,
        content_type: 'application/json',
        signal: signal || new AbortController().signal
      });
      record = await this.#control.completeEvidenceUpload({
        evidence_id: evidenceId,
        object_uri: uploaded.object_uri,
        sha256: documentSha256,
        byte_size: body.byteLength,
        captured_at: now,
        now
      });
      assertRunEvidenceRecord(
        record,
        input.manifest.run_id,
        metadata,
        documentSha256,
        body.byteLength
      );
    }
    if (record.state === 'uploaded') {
      record = await this.#control.verifyEvidence({
        evidence_id: evidenceId,
        outcome: 'verified',
        error_code: '',
        now
      });
      assertRunEvidenceRecord(
        record,
        input.manifest.run_id,
        metadata,
        documentSha256,
        body.byteLength
      );
    }
    if (record.state !== 'verified') {
      throw new LoadRunControlError('run_evidence_not_verified', 409, true);
    }
    await this.#control.finalizeRun({
      run_id: input.manifest.run_id,
      controller_id: this.#controllerId,
      controller_lease_epoch: lease.lease_epoch,
      outcome: validation.outcome,
      evidence_manifest_sha256: documentSha256,
      failure_code: failureCode(validation.outcome),
      now: validTimestamp(this.#now())
    });
    return validation;
  }

  async #claimController(
    runId: string,
    signal?: AbortSignal
  ): Promise<CapacityControllerLease> {
    while (!signal?.aborted) {
      try {
        return await this.#control.claimController({
          run_id: runId,
          controller_id: this.#controllerId,
          lease_ttl_ms: this.#leaseTtlMs,
          now: validTimestamp(this.#now())
        });
      } catch (error) {
        if (!(error instanceof LoadRunControlError) ||
            error.code !== 'controller_lease_unavailable') throw error;
      }
      await this.#delay(Math.max(100, Math.floor(this.#leaseTtlMs / 5)), signal);
    }
    throw new LoadRunControlError('capacity_finalizer_aborted', 409, true);
  }
}

export function capacityRunEvidenceDocument(
  manifest: LoadRunManifest,
  submission: CapacityRunEvidenceSubmission,
  validation: CapacityEvidenceResult
): CapacityRunEvidenceDocument {
  return {
    schema_version: '1.0.0',
    run_id: manifest.run_id,
    manifest: structuredClone(manifest),
    manifest_sha256: canonicalSha256(manifest),
    profile_id: manifest.profile_id,
    fork_manifest_id: manifest.fork_manifest_id,
    sut_release_id: manifest.sut_release_id,
    generator_release_id: manifest.generator_release_id,
    mode: submission.mode,
    fleet_qualifications: structuredClone(submission.fleet_qualifications),
    shard_evidence: structuredClone(submission.shard_evidence),
    external_dependencies: structuredClone(manifest.external_dependencies),
    validation: structuredClone(validation)
  };
}

function validateSubmission(
  submission: CapacityRunEvidenceSubmission,
  manifest: LoadRunManifest,
  manifestSha256: string
): void {
  if (!submission || typeof submission !== 'object' ||
      submission.schema_version !== '1.0.0' ||
      submission.run_id !== manifest.run_id ||
      submission.manifest_sha256 !== manifestSha256 ||
      !['controlled', 'production'].includes(submission.mode) ||
      !Array.isArray(submission.fleet_qualifications) ||
      !Array.isArray(submission.shard_evidence)) {
    throw new LoadRunControlError('run_evidence_submission_invalid', 400);
  }
}

function assertRunEvidenceRecord(
  record: CapacityEvidenceRecord,
  runId: string,
  metadata: Record<string, unknown>,
  sha256: string,
  byteSize: number
): void {
  if (record.run_id !== runId || record.phase_id || record.shard_id ||
      record.kind !== 'run_evidence_manifest' ||
      canonicalSha256(record.metadata) !== canonicalSha256(metadata)) {
    throw new LoadRunControlError('run_evidence_identity_mismatch', 409);
  }
  if (record.state === 'uploaded' || record.state === 'verified') {
    if (!record.object_uri || record.sha256 !== sha256 ||
        record.byte_size !== byteSize) {
      throw new LoadRunControlError('run_evidence_object_mismatch', 409);
    }
  }
}

function failureCode(outcome: CapacityEvidenceResult['outcome']): string {
  if (outcome === 'passed') return '';
  if (outcome === 'not_run') return 'capacity_external_not_run';
  if (outcome === 'invalid_generator_capacity') {
    return 'invalid_generator_capacity';
  }
  return 'capacity_evidence_failed';
}

function terminalStateMatches(
  state: string,
  outcome: CapacityEvidenceResult['outcome']
): boolean {
  if (outcome === 'passed') return state === 'completed';
  if (outcome === 'not_run') return state === 'not_run';
  return state === 'failed';
}

function evidencePrefix(value: string): string {
  const normalized = value.replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.length > 512 ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalized) ||
      normalized.split('/').some((part) => part === '' || part === '..')) {
    throw new LoadRunControlError('evidence_prefix_invalid', 400);
  }
  return normalized;
}

function safeId(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/.test(value)) {
    throw new LoadRunControlError(`${field}_invalid`, 400);
  }
  return value;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new LoadRunControlError(`${field}_invalid`, 400);
  }
  return value;
}

function validTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw new LoadRunControlError('timestamp_invalid', 500);
  }
  return new Date(value).toISOString();
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new LoadRunControlError('capacity_finalizer_aborted', 409, true);
  }
}

function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}
