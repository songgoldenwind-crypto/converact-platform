import { resolveConveractEnv } from '../src/config/converact-env.js';
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  RTPENGINE_ACCEPTANCE_REQUIRED_CHECKS,
  type RtpengineAcceptanceCheck
} from './converact-rtpengine-acceptance.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const REQUIRED_STAGES = [
  'patch_apply',
  'compile',
  'unit',
  'integration'
] as const;

type VerificationStatus = 'passed' | 'not_run';
type RuntimeMode = 'userspace' | 'kernel';
type CapacityClaim = 'none' | 'userspace_measured' | 'kernel_measured';

interface Goal2Contract {
  contract_id: 'voice-media-goal2-v1';
  source: {
    commit: string;
    archive_sha256: string;
  };
  failure_matrix: Array<{
    failure_id: string;
    required_evidence: string[];
  }>;
}

interface Goal2SupplyChainEvidence {
  status: 'passed';
  generated_at: string;
  identity: {
    source_commit: string;
    image_reference: string;
    image_digest: string;
    rtpengine_source_commit: string;
    archive_sha256: string;
    patch_set_sha256: string;
    toolchain_image_digest: string;
    builder_image_digest: string;
    architecture: 'amd64' | 'arm64';
  };
  signature: { status: 'passed' | 'not_run' };
  policy: {
    critical_vulnerability_count: number;
    excepted_critical_vulnerability_count: number;
    secret_finding_count: number;
    exceptions?: Array<{
      vulnerability_id: string;
      expires_at: string;
    }>;
  };
}

interface Goal2StageEvidence {
  stage: typeof REQUIRED_STAGES[number];
  status: 'passed';
  generated_at: string;
  source_commit: string;
  evidence_sha256: string;
  patch_set_sha256?: string;
  image_digest?: string;
}

interface Goal2AcceptanceDocument {
  schema_version: 1;
  status: 'passed' | 'failed';
  capacity_claim: 'none';
  source_commit: string;
  rtpengine_image_digest: string;
  config_hash: string;
  runtime_mode: RuntimeMode;
  generated_at: string;
  checks: Record<RtpengineAcceptanceCheck, boolean>;
}

interface Goal2AcceptanceAttempt {
  attempt_id: string;
  evidence_sha256: string;
  host_kernel: string;
  kernel_module_sha256?: string;
  generator: {
    status: 'functional' | 'valid_capacity' | 'overloaded';
    evidence_ref: string;
  };
  reconciliation: {
    expected_sessions: number;
    observed_sessions: number;
  };
  document: Goal2AcceptanceDocument;
}

type Goal2FailureEvidence =
  | {
      failure_id: string;
      status: 'passed';
      evidence: string[];
    }
  | {
      failure_id: string;
      status: 'not_run';
      reason: string;
    };

export interface VoiceMediaGoal2FinalizerInput {
  generated_at: string;
  contract: Goal2Contract;
  supply_chain: Goal2SupplyChainEvidence;
  stages: Goal2StageEvidence[];
  acceptance_attempts: Goal2AcceptanceAttempt[];
  failure_evidence: Goal2FailureEvidence[];
  requested_capacity_claim: CapacityClaim;
}

type AttemptDisposition =
  | 'accepted_functional'
  | 'accepted_capacity'
  | 'retained_identity_mismatch'
  | 'retained_generator_overload'
  | 'retained_reconciliation_delta'
  | 'retained_failed_checks';

export interface VoiceMediaGoal2FinalEvidence {
  schema_version: 1;
  goal: 'voice-media-control-goal2';
  status: 'implemented';
  generated_at: string;
  identity: Goal2SupplyChainEvidence['identity'];
  verification: {
    source_identity: 'passed';
    patch_apply: 'passed';
    compile: 'passed';
    unit: 'passed';
    integration: 'passed';
    real_environment: 'passed';
    benchmark: VerificationStatus;
  };
  runtime_modes: {
    userspace: VerificationStatus;
    kernel: VerificationStatus;
    recording: 'not_run';
    transcoding: 'not_run';
  };
  stages: Goal2StageEvidence[];
  acceptance_attempts: Array<{
    attempt_id: string;
    evidence_sha256: string;
    runtime_mode: RuntimeMode;
    image_digest: string;
    config_hash: string;
    host_kernel: string;
    generator_status: Goal2AcceptanceAttempt['generator']['status'];
    expected_sessions: number;
    observed_sessions: number;
    disposition: AttemptDisposition;
  }>;
  failure_evidence: Goal2FailureEvidence[];
  supply_chain: {
    status: 'passed';
    signature: 'passed' | 'not_run';
    critical_vulnerability_count: number;
    excepted_critical_vulnerability_count: number;
    secret_finding_count: 0;
  };
  claim: {
    benchmark: VerificationStatus;
    capacity_claim: CapacityClaim;
    production_eligible: false;
    blocking_reasons: string[];
  };
}

interface Goal2AttemptManifestEntry
  extends Omit<Goal2AcceptanceAttempt, 'document'> {
  evidence_path: string;
}

export function buildVoiceMediaGoal2FinalEvidence(
  input: VoiceMediaGoal2FinalizerInput
): VoiceMediaGoal2FinalEvidence {
  const generatedAt = timestamp(input.generated_at, 'finalizer generated_at');
  const identity = validateSupplyChain(
    input.supply_chain,
    input.contract,
    generatedAt
  );
  const stages = validateStages(input.stages, identity, generatedAt);
  const failureEvidence = validateFailureEvidence(
    input.failure_evidence,
    input.contract.failure_matrix
  );
  const attempts = validateAttempts(
    input.acceptance_attempts,
    identity,
    generatedAt
  );
  const accepted = attempts.filter((attempt) =>
    attempt.disposition === 'accepted_functional' ||
    attempt.disposition === 'accepted_capacity'
  );
  if (accepted.length === 0) {
    throw new Error('no exact functional acceptance attempt');
  }
  const claim = capacityClaim(input.requested_capacity_claim, attempts);
  const userspace = accepted.some((attempt) =>
    attempt.runtime_mode === 'userspace') ? 'passed' : 'not_run';
  const kernel = accepted.some((attempt) =>
    attempt.runtime_mode === 'kernel') ? 'passed' : 'not_run';
  const failureIncomplete = failureEvidence.some((entry) =>
    entry.status === 'not_run');
  const blockers = [
    ...(claim.benchmark === 'not_run' ? ['benchmark-not-run'] : []),
    ...(kernel === 'not_run' ? ['kernel-mode-not-run'] : []),
    'recording-mode-not-run',
    'transcoding-mode-not-run',
    ...(failureIncomplete ? ['failure-matrix-incomplete'] : []),
    ...(input.supply_chain.signature.status === 'not_run'
      ? ['image-signature-not-run']
      : []),
    ...(input.supply_chain.policy.critical_vulnerability_count > 0
      ? ['critical-vulnerability-exception-active']
      : [])
  ];

  return {
    schema_version: 1,
    goal: 'voice-media-control-goal2',
    status: 'implemented',
    generated_at: generatedAt,
    identity,
    verification: {
      source_identity: 'passed',
      patch_apply: 'passed',
      compile: 'passed',
      unit: 'passed',
      integration: 'passed',
      real_environment: 'passed',
      benchmark: claim.benchmark
    },
    runtime_modes: {
      userspace,
      kernel,
      recording: 'not_run',
      transcoding: 'not_run'
    },
    stages,
    acceptance_attempts: attempts,
    failure_evidence: failureEvidence,
    supply_chain: {
      status: 'passed',
      signature: input.supply_chain.signature.status,
      critical_vulnerability_count:
        input.supply_chain.policy.critical_vulnerability_count,
      excepted_critical_vulnerability_count:
        input.supply_chain.policy.excepted_critical_vulnerability_count,
      secret_finding_count: 0
    },
    claim: {
      benchmark: claim.benchmark,
      capacity_claim: claim.capacity_claim,
      production_eligible: false,
      blocking_reasons: [...new Set(blockers)].sort()
    }
  };
}

export async function collectVoiceMediaGoal2FinalEvidence(
  env: Record<string, string | undefined>
): Promise<VoiceMediaGoal2FinalEvidence> {
  const [
    contract,
    supplyChain,
    stages,
    attemptManifest,
    failureEvidence
  ] = await Promise.all([
    jsonFile<Goal2Contract>(requiredPath(env, 'CONVERACT_FABRIC_RTPENGINE_GOAL2_CONTRACT')),
    jsonFile<Goal2SupplyChainEvidence>(
      requiredPath(env, 'CONVERACT_FABRIC_RTPENGINE_GOAL2_SUPPLY_CHAIN')
    ),
    jsonFile<Goal2StageEvidence[]>(
      requiredPath(env, 'CONVERACT_FABRIC_RTPENGINE_GOAL2_STAGES')
    ),
    jsonFile<Goal2AttemptManifestEntry[]>(
      requiredPath(env, 'CONVERACT_FABRIC_RTPENGINE_GOAL2_ATTEMPTS')
    ),
    jsonFile<Goal2FailureEvidence[]>(
      requiredPath(env, 'CONVERACT_FABRIC_RTPENGINE_GOAL2_FAILURE_EVIDENCE')
    )
  ]);
  if (!Array.isArray(attemptManifest) || attemptManifest.length > 10_000) {
    throw new Error('acceptance attempt manifest is invalid');
  }
  const acceptanceAttempts = await Promise.all(attemptManifest.map(
    async (entry): Promise<Goal2AcceptanceAttempt> => {
      const path = checkedPath(entry.evidence_path, 'attempt evidence path');
      const bytes = await boundedFile(path);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== entry.evidence_sha256) {
        throw new Error(`acceptance evidence SHA-256 mismatch: ${entry.attempt_id}`);
      }
      return {
        attempt_id: entry.attempt_id,
        evidence_sha256: digest,
        host_kernel: entry.host_kernel,
        ...(entry.kernel_module_sha256
          ? { kernel_module_sha256: entry.kernel_module_sha256 }
          : {}),
        generator: structuredClone(entry.generator),
        reconciliation: structuredClone(entry.reconciliation),
        document: parseJson<Goal2AcceptanceDocument>(bytes, path)
      };
    }
  ));
  const result = buildVoiceMediaGoal2FinalEvidence({
    generated_at: required(env, 'CONVERACT_FABRIC_RTPENGINE_GOAL2_GENERATED_AT'),
    contract,
    supply_chain: supplyChain,
    stages,
    acceptance_attempts: acceptanceAttempts,
    failure_evidence: failureEvidence,
    requested_capacity_claim: requestedCapacityClaim(
      required(env, 'CONVERACT_FABRIC_RTPENGINE_GOAL2_CAPACITY_CLAIM')
    )
  });
  await writeNewJson(
    requiredPath(env, 'CONVERACT_FABRIC_RTPENGINE_GOAL2_OUTPUT'),
    result
  );
  return result;
}

function validateSupplyChain(
  supplyChain: Goal2SupplyChainEvidence,
  contract: Goal2Contract,
  generatedAt: string
): Goal2SupplyChainEvidence['identity'] {
  if (!contract || contract.contract_id !== 'voice-media-goal2-v1') {
    throw new Error('Goal 2 contract is invalid');
  }
  if (!supplyChain || supplyChain.status !== 'passed') {
    throw new Error('passed supply-chain evidence is required');
  }
  assertNotAfter(supplyChain.generated_at, generatedAt);
  const identity = supplyChain.identity;
  if (!identity || !COMMIT.test(identity.source_commit)) {
    throw new Error('full Converact source commit is required');
  }
  if (!SHA256_DIGEST.test(identity.image_digest)) {
    throw new Error('runtime image digest is required');
  }
  if (!COMMIT.test(identity.rtpengine_source_commit) ||
      identity.rtpengine_source_commit !== contract.source.commit) {
    throw new Error('RTPengine source commit does not match the contract');
  }
  if (!SHA256.test(identity.archive_sha256) ||
      identity.archive_sha256 !== contract.source.archive_sha256) {
    throw new Error('RTPengine archive identity does not match the contract');
  }
  if (!SHA256.test(identity.patch_set_sha256)) {
    throw new Error('RTPengine patch-set identity is required');
  }
  if (!SHA256_DIGEST.test(identity.toolchain_image_digest) ||
      !SHA256_DIGEST.test(identity.builder_image_digest)) {
    throw new Error('immutable builder identity is required');
  }
  if (!safeLine(identity.image_reference, 256) ||
      !['amd64', 'arm64'].includes(identity.architecture)) {
    throw new Error('runtime image identity is invalid');
  }
  const policy = supplyChain.policy;
  if (!policy ||
      !nonNegativeInteger(policy.critical_vulnerability_count) ||
      !nonNegativeInteger(policy.excepted_critical_vulnerability_count) ||
      policy.excepted_critical_vulnerability_count !==
        policy.critical_vulnerability_count ||
      policy.secret_finding_count !== 0) {
    throw new Error('supply-chain policy is not releasable');
  }
  if (policy.critical_vulnerability_count > 0) {
    if (!Array.isArray(policy.exceptions) ||
        policy.exceptions.length !== policy.critical_vulnerability_count) {
      throw new Error('critical vulnerability exception details are required');
    }
    for (const exception of policy.exceptions) {
      if (!/^CVE-[0-9]{4}-[0-9]{4,}$/.test(exception.vulnerability_id) ||
          Date.parse(timestamp(exception.expires_at, 'exception expiry')) <=
            Date.parse(generatedAt)) {
        throw new Error('critical vulnerability exception is expired');
      }
    }
  }
  if (supplyChain.signature?.status !== 'passed' &&
      supplyChain.signature?.status !== 'not_run') {
    throw new Error('supply-chain signature status is invalid');
  }
  return structuredClone(identity);
}

function validateStages(
  input: Goal2StageEvidence[],
  identity: Goal2SupplyChainEvidence['identity'],
  generatedAt: string
): Goal2StageEvidence[] {
  if (!Array.isArray(input) || input.length !== REQUIRED_STAGES.length) {
    throw new Error('all Goal 2 lifecycle stages are required');
  }
  const byStage = new Map(input.map((entry) => [entry.stage, entry]));
  if (byStage.size !== REQUIRED_STAGES.length) {
    throw new Error('Goal 2 lifecycle stages must be unique');
  }
  return REQUIRED_STAGES.map((stage) => {
    const entry = byStage.get(stage);
    if (!entry || entry.status !== 'passed' ||
        entry.source_commit !== identity.source_commit ||
        !SHA256.test(entry.evidence_sha256)) {
      throw new Error(`Goal 2 lifecycle stage is invalid: ${stage}`);
    }
    assertNotAfter(entry.generated_at, generatedAt);
    if (stage === 'patch_apply') {
      if (entry.patch_set_sha256 !== identity.patch_set_sha256) {
        throw new Error('patch_apply identity does not match the runtime image');
      }
    } else if (entry.image_digest !== identity.image_digest) {
      throw new Error(`${stage} identity does not match the runtime image`);
    }
    return structuredClone(entry);
  });
}

function validateAttempts(
  input: Goal2AcceptanceAttempt[],
  identity: Goal2SupplyChainEvidence['identity'],
  generatedAt: string
): VoiceMediaGoal2FinalEvidence['acceptance_attempts'] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 10_000) {
    throw new Error('acceptance attempts are required');
  }
  const seen = new Set<string>();
  return input.map((attempt) => {
    if (!attempt || !safeId(attempt.attempt_id) ||
        seen.has(attempt.attempt_id) ||
        !SHA256.test(attempt.evidence_sha256) ||
        !safeLine(attempt.host_kernel, 256) ||
        !safeLine(attempt.generator?.evidence_ref, 512) ||
        !['functional', 'valid_capacity', 'overloaded'].includes(
          attempt.generator?.status
        ) ||
        !nonNegativeInteger(attempt.reconciliation?.expected_sessions) ||
        !nonNegativeInteger(attempt.reconciliation?.observed_sessions) ||
        attempt.reconciliation.expected_sessions < 1) {
      throw new Error('acceptance attempt metadata is invalid');
    }
    seen.add(attempt.attempt_id);
    const document = attempt.document;
    if (!document || document.schema_version !== 1 ||
        document.capacity_claim !== 'none' ||
        !['userspace', 'kernel'].includes(document.runtime_mode) ||
        !SHA256_DIGEST.test(document.config_hash)) {
      throw new Error('acceptance attempt document is invalid');
    }
    assertNotAfter(document.generated_at, generatedAt);
    const identityMatches =
      document.source_commit === identity.source_commit &&
      document.rtpengine_image_digest === identity.image_digest &&
      (document.runtime_mode !== 'kernel' ||
        SHA256.test(attempt.kernel_module_sha256 || ''));
    const completeChecks =
      document.status === 'passed' &&
      RTPENGINE_ACCEPTANCE_REQUIRED_CHECKS.every((check) =>
        document.checks?.[check] === true);
    let disposition: AttemptDisposition;
    if (!identityMatches) {
      disposition = 'retained_identity_mismatch';
    } else if (attempt.generator.status === 'overloaded') {
      disposition = 'retained_generator_overload';
    } else if (attempt.reconciliation.expected_sessions !==
        attempt.reconciliation.observed_sessions) {
      disposition = 'retained_reconciliation_delta';
    } else if (!completeChecks) {
      disposition = 'retained_failed_checks';
    } else if (attempt.generator.status === 'valid_capacity') {
      disposition = 'accepted_capacity';
    } else {
      disposition = 'accepted_functional';
    }
    return {
      attempt_id: attempt.attempt_id,
      evidence_sha256: attempt.evidence_sha256,
      runtime_mode: document.runtime_mode,
      image_digest: document.rtpengine_image_digest,
      config_hash: document.config_hash,
      host_kernel: attempt.host_kernel,
      generator_status: attempt.generator.status,
      expected_sessions: attempt.reconciliation.expected_sessions,
      observed_sessions: attempt.reconciliation.observed_sessions,
      disposition
    };
  });
}

function validateFailureEvidence(
  input: Goal2FailureEvidence[],
  matrix: Goal2Contract['failure_matrix']
): Goal2FailureEvidence[] {
  if (!Array.isArray(matrix) || matrix.length < 1 ||
      !Array.isArray(input) || input.length !== matrix.length) {
    throw new Error('complete failure matrix evidence is required');
  }
  const byId = new Map(input.map((entry) => [entry.failure_id, entry]));
  if (byId.size !== matrix.length) {
    throw new Error('failure matrix evidence must be unique');
  }
  return matrix.map((contractEntry) => {
    if (!safeId(contractEntry.failure_id) ||
        !Array.isArray(contractEntry.required_evidence) ||
        contractEntry.required_evidence.length < 1) {
      throw new Error('failure matrix contract is invalid');
    }
    const entry = byId.get(contractEntry.failure_id);
    if (!entry) {
      throw new Error(`failure evidence is missing: ${contractEntry.failure_id}`);
    }
    if (entry.status === 'not_run') {
      if (!safeLine(entry.reason, 1_024)) {
        throw new Error(`failure not-run reason is required: ${entry.failure_id}`);
      }
      return structuredClone(entry);
    }
    if (!Array.isArray(entry.evidence) ||
        !contractEntry.required_evidence.every((item) =>
          entry.evidence.includes(item))) {
      throw new Error(`failure evidence is incomplete: ${entry.failure_id}`);
    }
    return {
      failure_id: entry.failure_id,
      status: 'passed' as const,
      evidence: [...new Set(entry.evidence)].sort()
    };
  });
}

function capacityClaim(
  requested: CapacityClaim,
  attempts: VoiceMediaGoal2FinalEvidence['acceptance_attempts']
): { benchmark: VerificationStatus; capacity_claim: CapacityClaim } {
  if (requested === 'none') {
    return { benchmark: 'not_run', capacity_claim: 'none' };
  }
  const capacityAttempts = attempts.filter((attempt) =>
    attempt.disposition === 'accepted_capacity');
  const modes = new Set(capacityAttempts.map((attempt) =>
    attempt.runtime_mode));
  if (modes.size > 1) throw new Error('capacity repetitions mix runtime modes');
  const requiredMode = requested === 'userspace_measured'
    ? 'userspace'
    : 'kernel';
  const repetitions = capacityAttempts.filter((attempt) =>
    attempt.runtime_mode === requiredMode);
  if (repetitions.length < 3) {
    throw new Error(`three valid ${requiredMode} repetitions are required`);
  }
  const configs = new Set(repetitions.map((attempt) => attempt.config_hash));
  if (configs.size !== 1) {
    throw new Error('capacity repetitions use different runtime configurations');
  }
  return { benchmark: 'passed', capacity_claim: requested };
}

function assertNotAfter(value: string, maximum: string): void {
  const checked = timestamp(value, 'evidence generated_at');
  if (Date.parse(checked) > Date.parse(maximum)) {
    throw new Error('evidence timestamp exceeds finalizer time');
  }
}

function timestamp(value: string, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is invalid`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{2,255}$/.test(value);
}

function safeLine(value: unknown, maximum: number): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\0\r\n]/.test(value);
}

async function jsonFile<T>(path: string): Promise<T> {
  return parseJson<T>(await boundedFile(path), path);
}

async function boundedFile(path: string): Promise<Buffer> {
  const bytes = await readFile(path);
  if (bytes.length < 2 || bytes.length > 16 * 1024 * 1024) {
    throw new Error(`Goal 2 evidence file size is invalid: ${path}`);
  }
  return bytes;
}

function parseJson<T>(bytes: Buffer, path: string): T {
  try {
    return JSON.parse(bytes.toString('utf8')) as T;
  } catch {
    throw new Error(`Goal 2 evidence JSON is invalid: ${path}`);
  }
}

async function writeNewJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function requiredPath(
  env: Record<string, string | undefined>,
  name: string
): string {
  return checkedPath(required(env, name), name);
}

function checkedPath(value: string, label: string): string {
  if (!isAbsolute(value) || dirname(value) === value ||
      value.includes('\0') || value.length > 4_096) {
    throw new Error(`${label} must be an absolute file path`);
  }
  return value;
}

function required(
  env: Record<string, string | undefined>,
  name: string
): string {
  const value = resolveConveractEnv(env, name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requestedCapacityClaim(value: string): CapacityClaim {
  if (value !== 'none' &&
      value !== 'userspace_measured' &&
      value !== 'kernel_measured') {
    throw new Error('CONVERACT_FABRIC_RTPENGINE_GOAL2_CAPACITY_CLAIM is invalid');
  }
  return value;
}

if (process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href) {
  collectVoiceMediaGoal2FinalEvidence(process.env)
    .then((result) => {
      process.stdout.write(`${JSON.stringify({
        status: result.status,
        runtime_modes: result.runtime_modes,
        capacity_claim: result.claim.capacity_claim,
        benchmark: result.claim.benchmark
      })}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error
        ? error.message
        : String(error)}\n`);
      process.exitCode = 1;
    });
}
