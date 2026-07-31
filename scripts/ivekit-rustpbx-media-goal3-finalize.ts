import {
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  RustPbxMediaGoal3AcceptanceEvidence
} from './ivekit-rustpbx-media-goal3-acceptance.js';

const MAX_JSON_BYTES = 4 * 1_048_576;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:/ -]{0,511}$/;
const REQUIRED_REGRESSIONS = [
  'goal0',
  'goal1',
  'goal2',
  'kamailio',
  'rustpbx',
  'cdr',
  'recording_isolation',
  'package_typecheck'
] as const;
const SUPPLY_CHAIN_ARTIFACTS = [
  'cyclonedx',
  'spdx',
  'trivy',
  'secret_scan',
  'provenance',
  'signature'
] as const;
const PRODUCTION_GATES = [
  'dual_zone',
  'production_mtls',
  'three_node_nats',
  'production_postgres',
  'production_object_storage',
  'complete_failure_matrix'
] as const;

type RegressionId = typeof REQUIRED_REGRESSIONS[number];
type SupplyChainArtifactId = typeof SUPPLY_CHAIN_ARTIFACTS[number];
type ProductionGateId = typeof PRODUCTION_GATES[number];
type DerivedStatus =
  'implemented' | 'functional_pass' | 'production_pass' | 'capacity_pass';
type EvidenceStatus = 'passed' | 'not_run';
type CapacityClaim = 'none' | 'single_node_measured' | 'cell_measured';

interface StatusEvidence {
  status: EvidenceStatus;
  evidence_sha256: string;
  reason?: string;
}

interface SupplyChainArtifact {
  status: EvidenceStatus;
  sha256: string;
  reason?: string;
}

interface ProductionGateEvidence extends StatusEvidence {
  opc_commit: string;
  runtime_config_sha256: string;
}

interface VulnerabilityException {
  owner: string;
  reason: string;
  expires_at: string;
  remediation_status: 'planned' | 'in_progress' | 'accepted';
}

interface CriticalVulnerability {
  vulnerability_id: string;
  exception: VulnerabilityException;
}

interface CapacityCampaignNotRun {
  status: 'not_run';
  evidence_sha256: string;
  reason: string;
}

interface CapacityCampaignPassed {
  status: 'passed';
  evidence_sha256: string;
  opc_commit: string;
  opc_image_digest: string;
  media_control_image_digest: string;
  rustpbx_image_digest: string;
  rtpengine_image_digest: string;
  runtime_config_sha256: string;
  claim: Exclude<CapacityClaim, 'none'>;
  measurements: {
    max_concurrent_calls: number;
    steady_cps: number;
    p99_setup_ms: number;
  };
}

export interface RustPbxMediaGoal3FinalizerInput {
  schema_version: '1.0.0';
  generated_at: string;
  source_identity: RustPbxMediaGoal3AcceptanceEvidence['source_identity'];
  acceptance_attempts: RustPbxMediaGoal3AcceptanceEvidence[];
  regressions: Record<RegressionId, StatusEvidence & { opc_commit: string }>;
  supply_chain: {
    generated_at: string;
    source_identity: {
      opc_commit: string;
      opc_image_digest: string;
      media_control_image_digest: string;
      rustpbx_image_digest: string;
      rtpengine_image_digest: string;
    };
    artifacts: Record<SupplyChainArtifactId, SupplyChainArtifact>;
    secret_finding_count: number;
    critical_vulnerabilities: CriticalVulnerability[];
  };
  production_gates: Record<ProductionGateId, ProductionGateEvidence>;
  capacity_campaign: CapacityCampaignNotRun | CapacityCampaignPassed;
}

type AttemptDisposition =
  'accepted_functional' |
  'retained_identity_mismatch' |
  'retained_failed_or_incomplete';

export interface RustPbxMediaGoal3FinalEvidence {
  schema_version: '1.0.0';
  evidence_type: 'rustpbx_media_goal3_final';
  generated_at: string;
  status: DerivedStatus;
  source_identity: RustPbxMediaGoal3FinalizerInput['source_identity'];
  acceptance: {
    accepted_attempts: number;
    attempts: Array<{
      attempt_id: string;
      evidence_sha256: string;
      disposition: AttemptDisposition;
      status: RustPbxMediaGoal3AcceptanceEvidence['status'];
      runtime_config_sha256: string;
    }>;
  };
  t1_takeover: {
    repetitions: number;
    p50_ms: number | null;
    p95_ms: number | null;
    p99_ms: number | null;
    target_ms: 5_000;
    status: EvidenceStatus;
  };
  regressions: RustPbxMediaGoal3FinalizerInput['regressions'];
  supply_chain: {
    status: EvidenceStatus;
    identity_status: 'passed' | 'failed';
    artifacts: RustPbxMediaGoal3FinalizerInput['supply_chain']['artifacts'];
    secret_finding_count: number;
    critical_vulnerability_count: number;
    active_exception_count: number;
  };
  production_gates: RustPbxMediaGoal3FinalizerInput['production_gates'];
  production_gate_identity_status: 'passed' | 'failed';
  capacity_campaign: {
    status: EvidenceStatus | 'retained_identity_mismatch';
    evidence_sha256: string;
    claim: CapacityClaim;
  };
  capacity_claim: CapacityClaim;
  blocking_reasons: string[];
}

export function buildRustPbxMediaGoal3FinalEvidence(
  rawInput: RustPbxMediaGoal3FinalizerInput
): RustPbxMediaGoal3FinalEvidence {
  const input = structuredClone(rawInput);
  validateInput(input);
  const generatedAt = input.generated_at;
  const attempts = input.acceptance_attempts.map((attempt) =>
    summarizeAttempt(attempt, input.source_identity, generatedAt)
  );
  const accepted = attempts.filter((attempt) =>
    attempt.disposition === 'accepted_functional'
  );
  const acceptedIds = new Set(accepted.map((attempt) => attempt.attempt_id));
  const takeoverSamples = input.acceptance_attempts
    .filter((attempt) => acceptedIds.has(attempt.attempt_id))
    .map((attempt) =>
      attempt.checks.t1_owner_takeover_under_5000ms
        .measurements.takeover_rto_ms
    )
    .filter((value): value is number =>
      typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 5_000
    );
  const t1 = {
    repetitions: takeoverSamples.length,
    p50_ms: percentile(takeoverSamples, 50),
    p95_ms: percentile(takeoverSamples, 95),
    p99_ms: percentile(takeoverSamples, 99),
    target_ms: 5_000 as const,
    status: takeoverSamples.length >= 3 ? 'passed' as const : 'not_run' as const
  };
  const regressionsPassed = REQUIRED_REGRESSIONS.every((id) =>
    input.regressions[id].status === 'passed' &&
    input.regressions[id].opc_commit === input.source_identity.opc_commit
  );
  const supplyChainIdentityMatches = supplyChainMatchesIdentity(
    input.supply_chain.source_identity,
    input.source_identity
  );
  const supplyChainPassed = supplyChainIdentityMatches &&
    supplyChainReleasable(
    input.supply_chain,
    generatedAt
  );
  const productionGateIdentityMatches = PRODUCTION_GATES.every((id) =>
    input.production_gates[id].opc_commit ===
      input.source_identity.opc_commit &&
    input.production_gates[id].runtime_config_sha256 ===
      input.source_identity.runtime_config_sha256
  );
  const productionGatesPassed = productionGateIdentityMatches &&
    PRODUCTION_GATES.every((id) =>
    input.production_gates[id].status === 'passed'
  );
  const functionalPassed = accepted.length > 0;
  const productionPassed = functionalPassed &&
    t1.status === 'passed' &&
    regressionsPassed &&
    supplyChainPassed &&
    productionGatesPassed;
  const capacity = capacityDisposition(
    input.capacity_campaign,
    input.source_identity,
    productionPassed
  );
  const capacityPassed =
    productionPassed && capacity.status === 'passed';
  const status: DerivedStatus = capacityPassed
    ? 'capacity_pass'
    : productionPassed
      ? 'production_pass'
      : functionalPassed
        ? 'functional_pass'
        : 'implemented';
  const blockers = [
    ...(!functionalPassed ? ['functional-acceptance-missing'] : []),
    ...(t1.status !== 'passed' ? ['t1-repeat-count-below-3'] : []),
    ...(!regressionsPassed ? ['regressions-incomplete'] : []),
    ...(!supplyChainIdentityMatches
      ? ['supply-chain-identity-mismatch']
      : []),
    ...(!supplyChainPassed ? ['supply-chain-incomplete'] : []),
    ...(!productionGateIdentityMatches
      ? ['production-gate-identity-mismatch']
      : []),
    ...(!productionGatesPassed ? ['production-gates-incomplete'] : []),
    ...(capacity.status !== 'passed' ? ['capacity-campaign-not-passed'] : [])
  ];

  const evidence: RustPbxMediaGoal3FinalEvidence = {
    schema_version: '1.0.0',
    evidence_type: 'rustpbx_media_goal3_final',
    generated_at: generatedAt,
    status,
    source_identity: input.source_identity,
    acceptance: {
      accepted_attempts: accepted.length,
      attempts
    },
    t1_takeover: t1,
    regressions: input.regressions,
    supply_chain: {
      status: supplyChainPassed ? 'passed' : 'not_run',
      identity_status: supplyChainIdentityMatches ? 'passed' : 'failed',
      artifacts: input.supply_chain.artifacts,
      secret_finding_count: input.supply_chain.secret_finding_count,
      critical_vulnerability_count:
        input.supply_chain.critical_vulnerabilities.length,
      active_exception_count:
        input.supply_chain.critical_vulnerabilities.length
    },
    production_gates: input.production_gates,
    production_gate_identity_status:
      productionGateIdentityMatches ? 'passed' : 'failed',
    capacity_campaign: capacity,
    capacity_claim: capacityPassed ? capacity.claim : 'none',
    blocking_reasons: [...new Set(blockers)].sort()
  };
  assertBounded(evidence, 'Goal 3 final evidence');
  return evidence;
}

function validateInput(input: RustPbxMediaGoal3FinalizerInput): void {
  assertBounded(input, 'Goal 3 finalizer input');
  if (input.schema_version !== '1.0.0') {
    throw new Error('unsupported Goal 3 finalizer schema');
  }
  canonicalTimestamp(input.generated_at, 'finalizer generated_at');
  validateIdentity(input.source_identity);
  if (!Array.isArray(input.acceptance_attempts) ||
      input.acceptance_attempts.length > 10_000) {
    throw new Error('Goal 3 acceptance attempts are invalid');
  }
  validateRegressions(input.regressions);
  validateSupplyChain(input.supply_chain, input.generated_at);
  validateProductionGates(input.production_gates);
  validateCapacityCampaign(input.capacity_campaign);
}

function summarizeAttempt(
  attempt: RustPbxMediaGoal3AcceptanceEvidence,
  expected: RustPbxMediaGoal3FinalizerInput['source_identity'],
  generatedAt: string
): RustPbxMediaGoal3FinalEvidence['acceptance']['attempts'][number] {
  if (!attempt || !IDENTIFIER.test(String(attempt.attempt_id || '')) ||
      !SHA256.test(String(attempt.raw_input_sha256 || ''))) {
    throw new Error('Goal 3 acceptance attempt is malformed');
  }
  canonicalTimestamp(attempt.generated_at, 'acceptance generated_at');
  if (Date.parse(attempt.generated_at) > Date.parse(generatedAt)) {
    throw new Error('Goal 3 acceptance occurs after finalization');
  }
  validateIdentity(attempt.source_identity);
  const identityMatches = sameIdentity(attempt.source_identity, expected);
  const accepted = identityMatches &&
    attempt.identity_status === 'passed' &&
    attempt.status === 'passed' &&
    attempt.capacity_claim === 'none' &&
    attempt.environment?.led_services_unchanged === true &&
    attempt.profiles?.ordinary === 'passed' &&
    attempt.profiles?.t1 === 'passed';
  const disposition: AttemptDisposition = !identityMatches ||
      attempt.identity_status !== 'passed'
    ? 'retained_identity_mismatch'
    : accepted
      ? 'accepted_functional'
      : 'retained_failed_or_incomplete';
  return {
    attempt_id: attempt.attempt_id,
    evidence_sha256: attempt.raw_input_sha256,
    disposition,
    status: attempt.status,
    runtime_config_sha256: attempt.source_identity.runtime_config_sha256
  };
}

function validateRegressions(
  input: RustPbxMediaGoal3FinalizerInput['regressions']
): void {
  if (!plainRecord(input) ||
      Object.keys(input).length !== REQUIRED_REGRESSIONS.length) {
    throw new Error('complete Goal 3 regressions are required');
  }
  for (const id of REQUIRED_REGRESSIONS) {
    const entry = input[id];
    validateStatusEvidence(entry, `regression ${id}`);
    if (!COMMIT.test(String(entry.opc_commit || ''))) {
      throw new Error(`Goal 3 regression ${id} commit is invalid`);
    }
  }
}

function validateSupplyChain(
  input: RustPbxMediaGoal3FinalizerInput['supply_chain'],
  generatedAt: string
): void {
  if (!input || !plainRecord(input.artifacts) ||
      Object.keys(input.artifacts).length !== SUPPLY_CHAIN_ARTIFACTS.length ||
      !Number.isSafeInteger(input.secret_finding_count) ||
      input.secret_finding_count < 0 ||
      !Array.isArray(input.critical_vulnerabilities) ||
      input.critical_vulnerabilities.length > 10_000) {
    throw new Error('Goal 3 supply-chain evidence is invalid');
  }
  canonicalTimestamp(input.generated_at, 'supply-chain generated_at');
  validateSupplyChainIdentity(input.source_identity);
  if (Date.parse(input.generated_at) > Date.parse(generatedAt)) {
    throw new Error('Goal 3 supply-chain evidence occurs after finalization');
  }
  for (const id of SUPPLY_CHAIN_ARTIFACTS) {
    const artifact = input.artifacts[id];
    if (!artifact || !['passed', 'not_run'].includes(artifact.status) ||
        !SHA256.test(String(artifact.sha256 || '')) ||
        (artifact.status === 'not_run' &&
          !SAFE_TEXT.test(String(artifact.reason || '')))) {
      throw new Error(`Goal 3 supply-chain artifact is invalid: ${id}`);
    }
  }
  for (const finding of input.critical_vulnerabilities) {
    const exception = finding?.exception;
    if (!/^CVE-[0-9]{4}-[0-9]{4,}$/.test(
      String(finding?.vulnerability_id || '')
    ) ||
        !SAFE_TEXT.test(String(exception?.owner || '')) ||
        !SAFE_TEXT.test(String(exception?.reason || '')) ||
        !['planned', 'in_progress', 'accepted'].includes(
          exception?.remediation_status
        ) ||
        Date.parse(canonicalTimestamp(
          exception?.expires_at,
          'vulnerability exception expiry'
        )) <= Date.parse(generatedAt)) {
      throw new Error('Goal 3 vulnerability exception is invalid or expired');
    }
  }
}

function validateProductionGates(
  input: RustPbxMediaGoal3FinalizerInput['production_gates']
): void {
  if (!plainRecord(input) ||
      Object.keys(input).length !== PRODUCTION_GATES.length) {
    throw new Error('complete Goal 3 production gates are required');
  }
  for (const id of PRODUCTION_GATES) {
    const evidence = input[id];
    validateStatusEvidence(evidence, `production gate ${id}`);
    if (!COMMIT.test(String(evidence.opc_commit || '')) ||
        !SHA256.test(String(evidence.runtime_config_sha256 || ''))) {
      throw new Error(`Goal 3 production gate identity is invalid: ${id}`);
    }
  }
}

function validateSupplyChainIdentity(
  identity: RustPbxMediaGoal3FinalizerInput['supply_chain']['source_identity']
): void {
  if (!identity ||
      !COMMIT.test(String(identity.opc_commit || '')) ||
      !IMAGE_DIGEST.test(String(identity.opc_image_digest || '')) ||
      !IMAGE_DIGEST.test(String(identity.media_control_image_digest || '')) ||
      !IMAGE_DIGEST.test(String(identity.rustpbx_image_digest || '')) ||
      !IMAGE_DIGEST.test(String(identity.rtpengine_image_digest || ''))) {
    throw new Error('Goal 3 supply-chain source identity is invalid');
  }
}

function validateCapacityCampaign(
  input: RustPbxMediaGoal3FinalizerInput['capacity_campaign']
): void {
  validateStatusEvidence(input, 'capacity campaign');
  if (input.status === 'not_run') return;
  if (!COMMIT.test(input.opc_commit) ||
      !IMAGE_DIGEST.test(input.opc_image_digest) ||
      !IMAGE_DIGEST.test(input.media_control_image_digest) ||
      !IMAGE_DIGEST.test(input.rustpbx_image_digest) ||
      !IMAGE_DIGEST.test(input.rtpengine_image_digest) ||
      !SHA256.test(input.runtime_config_sha256) ||
      !['single_node_measured', 'cell_measured'].includes(input.claim) ||
      !positiveInteger(input.measurements?.max_concurrent_calls) ||
      !positiveNumber(input.measurements?.steady_cps) ||
      !positiveNumber(input.measurements?.p99_setup_ms)) {
    throw new Error('Goal 3 capacity campaign is invalid');
  }
}

function validateStatusEvidence(
  input: StatusEvidence,
  label: string
): void {
  if (!input || !['passed', 'not_run'].includes(input.status) ||
      !SHA256.test(String(input.evidence_sha256 || ''))) {
    throw new Error(`Goal 3 ${label} evidence is invalid`);
  }
  const reason = String(input.reason || '');
  if (input.status === 'not_run' && !SAFE_TEXT.test(reason)) {
    throw new Error(`Goal 3 ${label} not_run reason is required`);
  }
  if (input.status === 'passed' && reason && !SAFE_TEXT.test(reason)) {
    throw new Error(`Goal 3 ${label} reason is invalid`);
  }
}

function supplyChainReleasable(
  input: RustPbxMediaGoal3FinalizerInput['supply_chain'],
  generatedAt: string
): boolean {
  return SUPPLY_CHAIN_ARTIFACTS.every((id) =>
    input.artifacts[id].status === 'passed'
  ) &&
    input.secret_finding_count === 0 &&
    input.critical_vulnerabilities.every((finding) =>
      Date.parse(finding.exception.expires_at) > Date.parse(generatedAt)
    );
}

function supplyChainMatchesIdentity(
  supply: RustPbxMediaGoal3FinalizerInput['supply_chain']['source_identity'],
  expected: RustPbxMediaGoal3FinalizerInput['source_identity']
): boolean {
  return supply.opc_commit === expected.opc_commit &&
    supply.opc_image_digest === expected.opc_image_digest &&
    supply.media_control_image_digest ===
      expected.media_control_image_digest &&
    supply.rustpbx_image_digest === expected.rustpbx_image_digest &&
    supply.rtpengine_image_digest === expected.rtpengine_image_digest;
}

function capacityDisposition(
  input: RustPbxMediaGoal3FinalizerInput['capacity_campaign'],
  identity: RustPbxMediaGoal3FinalizerInput['source_identity'],
  productionPassed: boolean
): RustPbxMediaGoal3FinalEvidence['capacity_campaign'] {
  if (input.status === 'not_run') {
    return {
      status: 'not_run',
      evidence_sha256: input.evidence_sha256,
      claim: 'none'
    };
  }
  const identityMatches =
    input.opc_commit === identity.opc_commit &&
    input.opc_image_digest === identity.opc_image_digest &&
    input.media_control_image_digest ===
      identity.media_control_image_digest &&
    input.rustpbx_image_digest === identity.rustpbx_image_digest &&
    input.rtpengine_image_digest === identity.rtpengine_image_digest &&
    input.runtime_config_sha256 === identity.runtime_config_sha256;
  if (!identityMatches || !productionPassed) {
    return {
      status: identityMatches ? 'not_run' : 'retained_identity_mismatch',
      evidence_sha256: input.evidence_sha256,
      claim: 'none'
    };
  }
  return {
    status: 'passed',
    evidence_sha256: input.evidence_sha256,
    claim: input.claim
  };
}

function validateIdentity(
  identity: RustPbxMediaGoal3FinalizerInput['source_identity']
): void {
  if (!identity || !COMMIT.test(identity.opc_commit)) {
    throw new Error('Goal 3 OPC source identity is invalid');
  }
  for (const id of [
    identity.rustpbx_commit,
    identity.rsipstack_commit,
    identity.rustrtc_commit,
    identity.rtpengine_commit
  ]) {
    if (!COMMIT.test(String(id || ''))) {
      throw new Error('Goal 3 upstream source identity is invalid');
    }
  }
  for (const digest of [
    identity.rustpbx_patch_set_sha256,
    identity.rtpengine_patch_set_sha256,
    identity.runtime_config_sha256
  ]) {
    if (!SHA256.test(String(digest || ''))) {
      throw new Error('Goal 3 source digest is invalid');
    }
  }
  if (!IMAGE_DIGEST.test(identity.opc_image_digest) ||
      !IMAGE_DIGEST.test(identity.media_control_image_digest) ||
      !IMAGE_DIGEST.test(identity.rustpbx_image_digest) ||
      !IMAGE_DIGEST.test(identity.rtpengine_image_digest) ||
      !Array.isArray(identity.rustpbx_patch_ids) ||
      identity.rustpbx_patch_ids.length < 1 ||
      identity.rustpbx_patch_ids.length > 128) {
    throw new Error('Goal 3 image or patch identity is invalid');
  }
}

function sameIdentity(
  left: RustPbxMediaGoal3FinalizerInput['source_identity'],
  right: RustPbxMediaGoal3FinalizerInput['source_identity']
): boolean {
  return left.opc_commit === right.opc_commit &&
    left.rustpbx_commit === right.rustpbx_commit &&
    left.rsipstack_commit === right.rsipstack_commit &&
    left.rustrtc_commit === right.rustrtc_commit &&
    left.rtpengine_commit === right.rtpengine_commit &&
    left.rustpbx_patch_set_sha256 === right.rustpbx_patch_set_sha256 &&
    left.rtpengine_patch_set_sha256 === right.rtpengine_patch_set_sha256 &&
    left.opc_image_digest === right.opc_image_digest &&
    left.media_control_image_digest === right.media_control_image_digest &&
    left.rustpbx_image_digest === right.rustpbx_image_digest &&
    left.rtpengine_image_digest === right.rtpengine_image_digest &&
    left.runtime_config_sha256 === right.runtime_config_sha256 &&
    left.host_kernel === right.host_kernel &&
    left.rustpbx_patch_ids.length === right.rustpbx_patch_ids.length &&
    left.rustpbx_patch_ids.every((id, index) =>
      id === right.rustpbx_patch_ids[index]
    );
}

function percentile(values: number[], value: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((value / 100) * sorted.length) - 1)
  );
  return sorted[index];
}

function canonicalTimestamp(value: string, label: string): string {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed) ||
      new Date(parsed).toISOString() !== value) {
    throw new Error(`Goal 3 ${label} timestamp is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function positiveNumber(value: unknown): boolean {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertBounded(value: unknown, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_JSON_BYTES) {
    throw new Error(`${label} exceeds 4 MiB`);
  }
}

function readJson(path: string): RustPbxMediaGoal3FinalizerInput {
  const resolved = realpathSync(resolve(path));
  const metadata = statSync(resolved);
  if (!metadata.isFile() || metadata.size < 2 ||
      metadata.size > MAX_JSON_BYTES) {
    throw new Error('Goal 3 finalizer input must be a bounded regular file');
  }
  return JSON.parse(readFileSync(resolved, 'utf8')) as
    RustPbxMediaGoal3FinalizerInput;
}

function runCli(argv: string[]): void {
  const [inputPath, outputPath] = argv;
  if (!inputPath || !outputPath) {
    throw new Error(
      'usage: ivekit-rustpbx-media-goal3-finalize <input.json> <output.json>'
    );
  }
  const inputReal = realpathSync(resolve(inputPath));
  const output = resolve(outputPath);
  if (output === inputReal) {
    throw new Error('Goal 3 finalizer output must not overwrite its input');
  }
  const evidence = buildRustPbxMediaGoal3FinalEvidence(readJson(inputPath));
  writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx'
  });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Goal 3 finalizer failed'}\n`
    );
    process.exitCode = 1;
  }
}
