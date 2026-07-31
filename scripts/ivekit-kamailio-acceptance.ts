import { resolveFabricEnv } from '../src/config/converact-env.js';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface KamailioAcceptanceScenario {
  id: string;
  driver: 'sipp' | 'webphone';
  sipp_scenario?: string;
  webphone_mode?: 'register-refresh' | 'cross-edge-delivery';
  fault: 'none' | 'transport' | 'response_503' | 'response_486' | 'drain' | 'restart' | 'stale_snapshot';
  assertions: string[];
}

export const KAMAILIO_ACCEPTANCE_SCENARIOS: readonly KamailioAcceptanceScenario[] = [
  {
    id: 'weighted-distribution',
    driver: 'sipp',
    sipp_scenario: 'invite-bye-affinity-uac.xml',
    fault: 'none',
    assertions: ['snapshot_fresh', 'both_nodes_selected', 'distribution_matches_snapshot_weight']
  },
  {
    id: 'dialog-affinity',
    driver: 'sipp',
    sipp_scenario: 'invite-bye-affinity-uac.xml',
    fault: 'none',
    assertions: ['initial_owner_observed', 'reinvite_same_owner', 'bye_same_owner']
  },
  {
    id: 'retry-transport',
    driver: 'sipp',
    sipp_scenario: 'invite-bye-affinity-uac.xml',
    fault: 'transport',
    assertions: ['first_candidate_transport_failed', 'second_candidate_answered', 'single_dialog_confirmed']
  },
  {
    id: 'retry-503',
    driver: 'sipp',
    sipp_scenario: 'invite-bye-affinity-uac.xml',
    fault: 'response_503',
    assertions: [
      'first_candidate_returned_503',
      'second_candidate_answered',
      'single_dialog_confirmed',
      'failover_counter_incremented'
    ]
  },
  {
    id: 'no-retry-486',
    driver: 'sipp',
    sipp_scenario: 'expect-486-uac.xml',
    fault: 'response_486',
    assertions: ['business_486_returned', 'next_candidate_not_attempted']
  },
  {
    id: 'drain-removes-new-call',
    driver: 'sipp',
    sipp_scenario: 'invite-bye-affinity-uac.xml',
    fault: 'drain',
    assertions: ['draining_node_left_new_call_pool', 'existing_dialog_pin_retained', 'new_call_used_accepting_node']
  },
  {
    id: 'node-down-up',
    driver: 'sipp',
    sipp_scenario: 'invite-bye-affinity-uac.xml',
    fault: 'restart',
    assertions: ['options_marked_node_down', 'new_call_avoided_down_node', 'lease_and_options_required_for_recovery']
  },
  {
    id: 'stale-snapshot-fail-closed',
    driver: 'sipp',
    sipp_scenario: 'expect-503-uac.xml',
    fault: 'stale_snapshot',
    assertions: ['snapshot_expired', 'new_invite_returned_503', 'existing_pin_set_retained']
  },
  {
    id: 'forged-header-sanitized',
    driver: 'sipp',
    sipp_scenario: 'forged-headers-uac.xml',
    fault: 'none',
    assertions: ['external_owner_headers_removed', 'edge_owner_headers_rebuilt', 'rustpbx_observed_authoritative_owner']
  },
  {
    id: 'dmq-public-rejected',
    driver: 'sipp',
    sipp_scenario: 'kdmq-expect-403-uac.xml',
    fault: 'none',
    assertions: ['public_sip_port_rejected_kdmq', 'dmq_reject_counter_incremented']
  },
  {
    id: 'webphone-register-refresh',
    driver: 'webphone',
    webphone_mode: 'register-refresh',
    fault: 'none',
    assertions: [
      'origin_and_browser_jwt_accepted',
      'rustpbx_authenticated_register',
      'refresh_after_browser_token_expiry_succeeded',
      'unregister_succeeded'
    ]
  },
  {
    id: 'webphone-cross-edge-delivery',
    driver: 'webphone',
    webphone_mode: 'cross-edge-delivery',
    fault: 'restart',
    assertions: [
      'register_saved_on_edge_a',
      'dmq_location_visible_on_edge_b',
      'rustpbx_invite_reached_registered_wss',
      'edge_internal_headers_removed'
    ]
  }
] as const;

export interface KamailioAcceptanceArtifact {
  path: string;
  bytes: number;
  sha256: string;
}

export interface KamailioAcceptanceObservation {
  scenario_id: string;
  status: 'passed' | 'failed';
  started_at: string;
  completed_at: string;
  assertions: Record<string, boolean>;
  artifacts: KamailioAcceptanceArtifact[];
}

export interface KamailioAcceptanceReport {
  schema_version: 1;
  suite: 'iveKit Kamailio SIP Edge controlled acceptance';
  status: 'ready_for_review' | 'failed' | 'not_run';
  generated_at: string;
  source_commit: string;
  environment_id: string;
  images: { kamailio: string; rustpbx: string };
  scenario_contract_sha256: string;
  physical_capacity_status: 'not_run';
  scenarios: Array<{
    id: string;
    status: 'passed' | 'failed' | 'not_run';
    assertions: string[];
    artifacts: KamailioAcceptanceArtifact[];
  }>;
}

export function scenarioContractSha256(): string {
  return createHash('sha256')
    .update(JSON.stringify(KAMAILIO_ACCEPTANCE_SCENARIOS))
    .digest('hex');
}

export function buildKamailioAcceptanceReport(input: {
  source_commit: string;
  kamailio_image: string;
  rustpbx_image: string;
  environment_id: string;
  artifact_root: string;
  generated_at?: string;
  observations: KamailioAcceptanceObservation[];
}): KamailioAcceptanceReport {
  if (!/^[a-f0-9]{40}$/.test(input.source_commit)) {
    throw new Error('Kamailio acceptance source_commit must be a full Git commit');
  }
  const images = {
    kamailio: immutableImage(input.kamailio_image, 'Kamailio'),
    rustpbx: immutableImage(input.rustpbx_image, 'RustPBX')
  };
  const environmentId = identifier(input.environment_id, 'environment_id');
  const artifactRoot = validatedArtifactRoot(input.artifact_root);
  const generatedAt = isoTime(input.generated_at || new Date().toISOString(), 'generated_at');
  const byId = new Map<string, KamailioAcceptanceObservation>();
  const artifactPaths = new Set<string>();
  for (const raw of input.observations) {
    if (byId.has(raw.scenario_id)) throw new Error('duplicate Kamailio acceptance observation');
    const scenario = KAMAILIO_ACCEPTANCE_SCENARIOS.find((entry) => entry.id === raw.scenario_id);
    if (!scenario) throw new Error(`unknown Kamailio acceptance scenario ${raw.scenario_id}`);
    byId.set(raw.scenario_id, validateObservation(raw, scenario, artifactRoot, artifactPaths));
  }
  const scenarios = KAMAILIO_ACCEPTANCE_SCENARIOS.map((scenario) => {
    const observation = byId.get(scenario.id);
    return {
      id: scenario.id,
      status: observation?.status || 'not_run' as const,
      assertions: [...scenario.assertions],
      artifacts: observation?.artifacts || []
    };
  });
  const status = scenarios.some((scenario) => scenario.status === 'failed')
    ? 'failed'
    : scenarios.every((scenario) => scenario.status === 'passed')
      ? 'ready_for_review'
      : 'not_run';
  return {
    schema_version: 1,
    suite: 'iveKit Kamailio SIP Edge controlled acceptance',
    status,
    generated_at: generatedAt,
    source_commit: input.source_commit,
    environment_id: environmentId,
    images,
    scenario_contract_sha256: scenarioContractSha256(),
    physical_capacity_status: 'not_run',
    scenarios
  };
}

function validateObservation(
  raw: KamailioAcceptanceObservation,
  scenario: KamailioAcceptanceScenario,
  artifactRoot: string,
  artifactPaths: Set<string>
): KamailioAcceptanceObservation {
  if (!['passed', 'failed'].includes(raw.status)) throw new Error('invalid acceptance status');
  const startedAt = isoTime(raw.started_at, 'started_at');
  const completedAt = isoTime(raw.completed_at, 'completed_at');
  if (Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new Error('Kamailio acceptance completion precedes start');
  }
  if (!raw.assertions || typeof raw.assertions !== 'object' || Array.isArray(raw.assertions)) {
    throw new Error('Kamailio acceptance assertions are invalid');
  }
  const actualAssertions = Object.keys(raw.assertions).sort();
  const expectedAssertions = [...scenario.assertions].sort();
  if (JSON.stringify(actualAssertions) !== JSON.stringify(expectedAssertions) ||
      Object.values(raw.assertions).some((value) => typeof value !== 'boolean')) {
    throw new Error(`Kamailio acceptance assertion contract mismatch for ${scenario.id}`);
  }
  if (raw.status === 'passed' && Object.values(raw.assertions).some((value) => !value)) {
    throw new Error(`Kamailio acceptance passed observation has a false assertion for ${scenario.id}`);
  }
  if (!Array.isArray(raw.artifacts) || raw.artifacts.length < 1 || raw.artifacts.length > 64) {
    throw new Error(`Kamailio acceptance artifacts are missing for ${scenario.id}`);
  }
  const artifacts = raw.artifacts.map((artifact) => {
    if (!safeRelativePath(artifact.path) ||
        !artifact.path.startsWith(`${scenario.id}/`) ||
        artifactPaths.has(artifact.path)) {
      throw new Error(`Kamailio acceptance artifact path is invalid for ${scenario.id}`);
    }
    artifactPaths.add(artifact.path);
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 1_073_741_824) {
      throw new Error(`Kamailio acceptance artifact size is invalid for ${scenario.id}`);
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error(`Kamailio acceptance artifact sha256 is invalid for ${scenario.id}`);
    }
    verifyArtifact(artifactRoot, artifact, scenario.id);
    return { ...artifact };
  });
  return {
    scenario_id: scenario.id,
    status: raw.status,
    started_at: startedAt,
    completed_at: completedAt,
    assertions: { ...raw.assertions },
    artifacts
  };
}

function immutableImage(value: string, name: string): string {
  const image = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error(`${name} acceptance image must be pinned by digest`);
  }
  return image;
}

function identifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(value || ''))) {
    throw new Error(`Kamailio acceptance ${name} is invalid`);
  }
  return value;
}

function isoTime(value: string, name: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) {
    throw new Error(`Kamailio acceptance ${name} is invalid`);
  }
  return value;
}

function safeRelativePath(value: string): boolean {
  const parts = typeof value === 'string' ? value.split('/') : [];
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    !isAbsolute(value) && !value.includes('\\') &&
    parts.every((part) => part !== '' && part !== '.' && part !== '..') &&
    !/[\0\r\n]/.test(value);
}

function validatedArtifactRoot(value: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error('Kamailio acceptance artifact_root must be absolute');
  }
  try {
    const metadata = lstatSync(value);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('not a real directory');
    return realpathSync(value);
  } catch {
    throw new Error('Kamailio acceptance artifact_root is invalid');
  }
}

function verifyArtifact(
  artifactRoot: string,
  artifact: KamailioAcceptanceArtifact,
  scenarioId: string
): void {
  try {
    const path = resolve(artifactRoot, artifact.path);
    const metadata = lstatSync(path);
    const realPath = realpathSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() ||
        (realPath !== artifactRoot && !realPath.startsWith(`${artifactRoot}${sep}`))) {
      throw new Error('artifact escapes root');
    }
    const before = statSync(realPath);
    if (before.size !== artifact.bytes) {
      throw new Error('artifact size mismatch');
    }
    const actualSha256 = sha256File(realPath);
    const after = statSync(realPath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('artifact changed while hashing');
    }
    if (actualSha256 !== artifact.sha256) throw new Error('artifact sha256 mismatch');
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'verification failed';
    throw new Error(`Kamailio acceptance artifact verification failed for ${scenarioId}: ${reason}`);
  }
}

function sha256File(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = openSync(path, 'r');
  try {
    while (true) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

function loadObservations(directory: string): KamailioAcceptanceObservation[] {
  const observations: KamailioAcceptanceObservation[] = [];
  for (const scenario of KAMAILIO_ACCEPTANCE_SCENARIOS) {
    const path = resolve(directory, `${scenario.id}.json`);
    if (!existsSync(path)) continue;
    observations.push(JSON.parse(readFileSync(path, 'utf8')) as KamailioAcceptanceObservation);
  }
  return observations;
}

function main(): void {
  const evidenceDirectory = resolve(
    resolveFabricEnv(process.env, 'KAMAILIO_ACCEPTANCE_EVIDENCE_DIR') ||
    '.tmp/kamailio-acceptance/evidence'
  );
  const output = resolve(
    resolveFabricEnv(process.env, 'KAMAILIO_ACCEPTANCE_OUTPUT') ||
    '.tmp/kamailio-acceptance/report.json'
  );
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const report = buildKamailioAcceptanceReport({
    source_commit: String(resolveFabricEnv(process.env, 'KAMAILIO_ACCEPTANCE_SOURCE_COMMIT') || ''),
    kamailio_image: String(process.env.IVEKIT_KAMAILIO_IMAGE || ''),
    rustpbx_image: String(process.env.RUSTPBX_IMAGE || ''),
    environment_id: String(resolveFabricEnv(process.env, 'KAMAILIO_ACCEPTANCE_ENVIRONMENT_ID') || ''),
    artifact_root: evidenceDirectory,
    observations: loadObservations(evidenceDirectory)
  });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: report.status, output })}\n`);
  if (report.status === 'failed') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
