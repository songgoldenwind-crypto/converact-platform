import { resolveFabricEnv } from '../src/config/converact-env.js';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONVERACT_FABRIC_PRODUCT,
  isAcceptedFabricProduct,
  type FabricProductContractId
} from './lib/converact-product-contract.js';

export const CONVERACT_V6_REAL_ACCEPTANCE_GROUPS = [
  'providers',
  'tinode',
  'livekit_turn_egress',
  'rustdesk_windows',
  'voice_pstn',
  'notifications',
  'object_storage',
  'kubernetes'
] as const;

export type ConveractFabricV6RealAcceptanceGroupId =
  typeof CONVERACT_V6_REAL_ACCEPTANCE_GROUPS[number];
export type ConveractFabricV6RealAcceptanceStatus = 'passed' | 'failed' | 'not_run';

export interface ConveractFabricV6RealAcceptanceCheck {
  id: string;
  status: 'passed' | 'failed';
  observation_path: string;
  sha256: string;
  size_bytes: number;
}

export interface ConveractFabricV6RealAcceptanceGroup {
  id: ConveractFabricV6RealAcceptanceGroupId;
  status: ConveractFabricV6RealAcceptanceStatus;
  reason_code: string;
  reason: string;
  command: string;
  run: null | {
    run_id: string;
    environment_id: string;
    deployed_source_commit: string;
    artifact_digest: string;
    started_at: string;
    finished_at: string;
    operator: string;
    qa_approver: string;
    redaction_confirmed: true;
  };
  checks: ConveractFabricV6RealAcceptanceCheck[];
}

export interface ConveractFabricV6RealAcceptanceManifest {
  schema_version: 1;
  product: FabricProductContractId;
  foundation_version: 'V6';
  source_commit: string;
  generated_at: string;
  real_environment_only: true;
  groups: ConveractFabricV6RealAcceptanceGroup[];
}

const SOURCE_COMMIT = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const SAFE_EVIDENCE_PATH = /^evidence\/[a-z0-9_]+\/[a-z0-9][a-z0-9._-]{0,127}\.json$/;
const PLACEHOLDER = /\b(?:TBD|TODO|placeholder|replace[_ -]?me|example[_ -]?only)\b/i;
const FORBIDDEN_KEY = /(?:^|_)(?:password|passwd|secret|token|authorization|cookie|private_key|api_key)(?:$|_)/i;

const GROUP_TEMPLATE: Record<ConveractFabricV6RealAcceptanceGroupId, {
  reason_code: string;
  reason: string;
  command: string;
}> = {
  providers: {
    reason_code: 'provider_credentials_unavailable',
    reason: 'Real OCR, ASR, translation, and AI quality Provider credentials or endpoints are unavailable.',
    command: 'npm run converact:intelligence-preflight && npm run converact:provider-governance-acceptance'
  },
  tinode: {
    reason_code: 'tinode_environment_unavailable',
    reason: 'A deployed external or bundled Tinode environment with real desktop clients is unavailable.',
    command: 'npm run tinode:deployment-preflight && npm run smoke:chat:tinode'
  },
  livekit_turn_egress: {
    reason_code: 'livekit_environment_unavailable',
    reason: 'Public LiveKit, TURN, Egress, DNS, and two real browser endpoints are unavailable.',
    command: 'npm run livekit:deployment-preflight && npm run livekit:server-evidence && npm run livekit:client-acceptance'
  },
  rustdesk_windows: {
    reason_code: 'windows_devices_unavailable',
    reason: 'Two physical Windows devices with the pinned Converact Fabric RustDesk build are unavailable.',
    command: 'npm run rustdesk:deployment-preflight && npm run rustdesk:server-evidence && npm run rustdesk:client-acceptance'
  },
  voice_pstn: {
    reason_code: 'pstn_trunk_unavailable',
    reason: 'A real PSTN trunk and routable inbound and outbound telephone numbers are unavailable.',
    command: 'npm run converact:voice-preflight && npm run converact:voice-acceptance && npm run converact:rustpbx-sipp-acceptance'
  },
  notifications: {
    reason_code: 'commercial_notification_provider_unavailable',
    reason: 'Commercial email and SMS accounts with verified sender identities are unavailable.',
    command: 'node --import tsx scripts/converact-v6-real-acceptance.ts --mode validate --manifest "$CONVERACT_FABRIC_V6_REAL_ACCEPTANCE_MANIFEST"'
  },
  object_storage: {
    reason_code: 'production_object_storage_unavailable',
    reason: 'Production S3-compatible object storage, lifecycle policy, and scanner integration are unavailable.',
    command: 'npm run attachment:deployment-preflight && npm run quality:deployment-preflight'
  },
  kubernetes: {
    reason_code: 'kubernetes_cluster_unavailable',
    reason: 'A production-like Kubernetes cluster, ingress, storage class, and monitoring stack are unavailable.',
    command: 'helm lint services/converact-service/helm/converact && helm template converact services/converact-service/helm/converact --set image.repository=registry.example/converact --set image.digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  }
};

export function createConveractFabricV6RealAcceptanceTemplate(input: {
  source_commit: string;
  generated_at?: string;
}): ConveractFabricV6RealAcceptanceManifest {
  const sourceCommit = String(input.source_commit || '').trim().toLowerCase();
  if (!SOURCE_COMMIT.test(sourceCommit)) throw new Error('full source commit is required');
  const generatedAt = canonicalTimestamp(input.generated_at || new Date().toISOString(), 'generated_at');
  return {
    schema_version: 1,
    product: CONVERACT_FABRIC_PRODUCT,
    foundation_version: 'V6',
    source_commit: sourceCommit,
    generated_at: generatedAt,
    real_environment_only: true,
    groups: CONVERACT_V6_REAL_ACCEPTANCE_GROUPS.map((id) => ({
      id,
      status: 'not_run',
      reason_code: GROUP_TEMPLATE[id].reason_code,
      reason: GROUP_TEMPLATE[id].reason,
      command: GROUP_TEMPLATE[id].command,
      run: null,
      checks: []
    }))
  };
}

export function validateConveractFabricV6RealAcceptanceManifest(
  manifest: ConveractFabricV6RealAcceptanceManifest,
  input: { base_dir: string; expected_source_commit?: string }
): void {
  if (
    manifest.schema_version !== 1 || !isAcceptedFabricProduct(manifest.product) ||
    manifest.foundation_version !== 'V6' || manifest.real_environment_only !== true ||
    !SOURCE_COMMIT.test(manifest.source_commit)
  ) throw new Error('invalid Converact Fabric V6 real acceptance identity');
  if (input.expected_source_commit && manifest.source_commit !== input.expected_source_commit) {
    throw new Error('real acceptance source commit mismatch');
  }
  canonicalTimestamp(manifest.generated_at, 'generated_at');
  if (!Array.isArray(manifest.groups) ||
      JSON.stringify(manifest.groups.map((group) => group.id)) !==
        JSON.stringify(CONVERACT_V6_REAL_ACCEPTANCE_GROUPS)) {
    throw new Error('real acceptance must contain the ordered eight-group matrix');
  }
  const baseDir = resolve(input.base_dir);
  const evidencePaths = new Set<string>();
  for (const group of manifest.groups) {
    validateGroup(manifest, group, baseDir, evidencePaths);
  }
}

export function readAndValidateConveractFabricV6RealAcceptance(
  manifestFile: string,
  expectedSourceCommit?: string
): ConveractFabricV6RealAcceptanceManifest {
  const absolute = resolve(manifestFile);
  const item = lstatSync(absolute);
  if (!item.isFile() || item.isSymbolicLink()) {
    throw new Error('real acceptance manifest must be a regular file');
  }
  const manifest = JSON.parse(readFileSync(absolute, 'utf8')) as ConveractFabricV6RealAcceptanceManifest;
  validateConveractFabricV6RealAcceptanceManifest(manifest, {
    base_dir: dirname(absolute),
    expected_source_commit: expectedSourceCommit
  });
  return manifest;
}

function validateGroup(
  manifest: ConveractFabricV6RealAcceptanceManifest,
  group: ConveractFabricV6RealAcceptanceGroup,
  baseDir: string,
  evidencePaths: Set<string>
): void {
  if (!CONVERACT_V6_REAL_ACCEPTANCE_GROUPS.includes(group.id)) {
    throw new Error('real acceptance group id is invalid');
  }
  if (group.command !== GROUP_TEMPLATE[group.id].command) {
    throw new Error(`real acceptance command drift: ${group.id}`);
  }
  if (group.status === 'not_run') {
    if (
      group.reason_code !== GROUP_TEMPLATE[group.id].reason_code ||
      group.reason !== GROUP_TEMPLATE[group.id].reason || group.run !== null ||
      !Array.isArray(group.checks) || group.checks.length !== 0
    ) throw new Error(`not_run acceptance group is incomplete: ${group.id}`);
    return;
  }
  if (group.status !== 'passed' && group.status !== 'failed') {
    throw new Error(`real acceptance status is invalid: ${group.id}`);
  }
  if (group.reason_code || group.reason || !group.run) {
    throw new Error(`executed acceptance group has invalid reason or run: ${group.id}`);
  }
  const run = group.run;
  for (const [name, value] of [
    ['run_id', run.run_id],
    ['environment_id', run.environment_id],
    ['operator', run.operator],
    ['qa_approver', run.qa_approver]
  ] as const) {
    if (!SAFE_ID.test(value) || PLACEHOLDER.test(value)) {
      throw new Error(`real acceptance ${name} is invalid: ${group.id}`);
    }
  }
  if (run.operator === run.qa_approver) {
    throw new Error(`real acceptance requires an independent QA approver: ${group.id}`);
  }
  if (
    run.deployed_source_commit !== manifest.source_commit || !DIGEST.test(run.artifact_digest) ||
    run.redaction_confirmed !== true
  ) throw new Error(`real acceptance deployment binding is invalid: ${group.id}`);
  const started = canonicalTimestamp(run.started_at, 'started_at');
  const finished = canonicalTimestamp(run.finished_at, 'finished_at');
  if (Date.parse(finished) < Date.parse(started)) {
    throw new Error(`real acceptance time window is invalid: ${group.id}`);
  }
  if (!Array.isArray(group.checks) || !group.checks.length) {
    throw new Error(`executed acceptance group has no checks: ${group.id}`);
  }
  const checkIds = new Set<string>();
  for (const check of group.checks) {
    if (!SAFE_ID.test(check.id) || checkIds.has(check.id)) {
      throw new Error(`real acceptance check id is invalid or duplicate: ${group.id}`);
    }
    checkIds.add(check.id);
    if (check.status !== 'passed' && check.status !== 'failed') {
      throw new Error(`real acceptance check status is invalid: ${group.id}/${check.id}`);
    }
    validateObservation(manifest, group, check, baseDir, evidencePaths);
  }
  if (group.status === 'passed' && group.checks.some((check) => check.status !== 'passed')) {
    throw new Error(`passed acceptance group contains a failed check: ${group.id}`);
  }
  if (group.status === 'failed' && group.checks.every((check) => check.status === 'passed')) {
    throw new Error(`failed acceptance group has no failed check: ${group.id}`);
  }
}

function validateObservation(
  manifest: ConveractFabricV6RealAcceptanceManifest,
  group: ConveractFabricV6RealAcceptanceGroup,
  check: ConveractFabricV6RealAcceptanceCheck,
  baseDir: string,
  evidencePaths: Set<string>
): void {
  if (!SAFE_EVIDENCE_PATH.test(check.observation_path) ||
      !check.observation_path.startsWith(`evidence/${group.id}/`) ||
      evidencePaths.has(check.observation_path)) {
    throw new Error(`real acceptance evidence path is invalid or duplicate: ${check.observation_path}`);
  }
  evidencePaths.add(check.observation_path);
  const absolute = resolve(baseDir, check.observation_path);
  if (isAbsolute(check.observation_path) || relative(baseDir, absolute).startsWith('..')) {
    throw new Error(`real acceptance evidence escapes its root: ${check.observation_path}`);
  }
  const item = lstatSync(absolute);
  if (!item.isFile() || item.isSymbolicLink()) {
    throw new Error(`real acceptance evidence must be a regular file: ${check.observation_path}`);
  }
  const content = readFileSync(absolute);
  if (check.size_bytes !== statSync(absolute).size || !SHA256.test(check.sha256) ||
      check.sha256 !== createHash('sha256').update(content).digest('hex')) {
    throw new Error(`real acceptance evidence checksum mismatch: ${check.observation_path}`);
  }
  const observation = JSON.parse(content.toString('utf8')) as Record<string, unknown>;
  const run = group.run!;
  if (
    observation.schema_version !== 1 || observation.real_environment !== true ||
    observation.controlled !== false || observation.redacted !== true ||
    observation.group_id !== group.id || observation.check_id !== check.id ||
    observation.source_commit !== manifest.source_commit ||
    observation.artifact_digest !== run.artifact_digest ||
    observation.run_id !== run.run_id || observation.environment_id !== run.environment_id ||
    observation.result !== check.status
  ) throw new Error(`real acceptance evidence binding mismatch: ${check.observation_path}`);
  canonicalTimestamp(String(observation.observed_at || ''), 'observed_at');
  assertNoSecrets(observation, 'observation');
}

function assertNoSecrets(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error(`secret-like evidence key is forbidden: ${path}.${key}`);
    assertNoSecrets(nested, `${path}.${key}`);
  }
}

function canonicalTimestamp(value: string, name: string): string {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`${name} must be a canonical ISO timestamp`);
  }
  return value;
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? '' : String(process.argv[index + 1] || '').trim();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = argument('--mode') || 'validate';
  const manifestFile = argument('--manifest') || resolveFabricEnv(process.env, 'V6_REAL_ACCEPTANCE_MANIFEST') || '';
  if (!manifestFile) throw new Error('--manifest or CONVERACT_FABRIC_V6_REAL_ACCEPTANCE_MANIFEST is required');
  if (mode === 'template') {
    const sourceCommit = argument('--source-commit') || resolveFabricEnv(process.env, 'ACCEPTANCE_SOURCE_COMMIT') || '';
    const template = createConveractFabricV6RealAcceptanceTemplate({ source_commit: sourceCommit });
    const output = resolve(manifestFile);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ status: 'template_created', manifest: output }));
  } else if (mode === 'validate') {
    const expected = argument('--source-commit') || resolveFabricEnv(process.env, 'ACCEPTANCE_SOURCE_COMMIT');
    const manifest = readAndValidateConveractFabricV6RealAcceptance(manifestFile, expected);
    console.log(JSON.stringify({
      status: 'valid',
      source_commit: manifest.source_commit,
      groups: Object.fromEntries(manifest.groups.map((group) => [group.id, group.status]))
    }));
  } else {
    throw new Error('--mode must be template or validate');
  }
}
