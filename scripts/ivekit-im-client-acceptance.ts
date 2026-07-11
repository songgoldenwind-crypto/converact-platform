import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IVEKIT_IM_REQUIRED_ACCEPTANCE_CHECKS = Object.freeze([
  'tinode.receive_only_acl',
  'session.list',
  'message.send_receive',
  'attachment.upload_progress',
  'receipt.read',
  'realtime.typing_presence',
  'message.edit_delete',
  'message.reply_forward',
  'message.reaction_pin',
  'finding.review_history',
  'network.offline_reconnect',
  'session.close_revoke',
  'layout.desktop',
  'layout.mobile'
] as const);

type CheckId = typeof IVEKIT_IM_REQUIRED_ACCEPTANCE_CHECKS[number];

export interface IveKitImAcceptanceFailure { id: string; reason: string; }
export interface IveKitImAcceptanceResult {
  ok: boolean;
  status: 'ready_for_review' | 'incomplete';
  run_id: string;
  environment_id: string;
  summary: { required: number; passed: number; failed: number };
  failures: IveKitImAcceptanceFailure[];
}

export function createIveKitImAcceptanceTemplate(): {
  schema_version: 1;
  source: 'real_environment';
  status: 'incomplete';
  checks: Record<CheckId, { passed: false; evidence: Record<string, unknown> }>;
  [key: string]: unknown;
} {
  const checks = Object.fromEntries(IVEKIT_IM_REQUIRED_ACCEPTANCE_CHECKS.map((id) => [id, {
    passed: false,
    evidence: {
      artifact_file: `replace-with-${id.replaceAll('.', '-')}-observation.json`,
      sha256: 'replace-with-sha256',
      captured_at: '',
      tool: 'replace-with-real-capture-tool',
      run_id: 'replace-with-run-id',
      details: { observation: 'replace-with-structured-observation' }
    }
  }])) as unknown as Record<CheckId, { passed: false; evidence: Record<string, unknown> }>;
  return {
    schema_version: 1,
    source: 'real_environment',
    status: 'incomplete',
    run_id: 'replace-with-run-id',
    environment_id: 'replace-with-environment-id',
    deployed_commit: 'replace-with-40-character-git-sha',
    checked_at: '',
    identities: { agent: 'replace-with-agent-identity', customer: 'replace-with-customer-identity' },
    endpoints: { ivekit: 'https://replace-with-ivekit-host', tinode: 'wss://replace-with-tinode-host/v0/channels' },
    checks
  };
}

export function writeIveKitImAcceptanceTemplate(templateFile: string): string {
  if (!String(templateFile || '').trim()) throw new Error('template file is required');
  mkdirSync(dirname(resolve(templateFile)), { recursive: true });
  writeFileSync(resolve(templateFile), `${JSON.stringify(createIveKitImAcceptanceTemplate(), null, 2)}\n`, 'utf8');
  return resolve(templateFile);
}

export function runIveKitImAcceptance(config: { reportFile: string; outputFile?: string }): IveKitImAcceptanceResult {
  const reportFile = resolve(config.reportFile);
  if (config.outputFile && resolve(config.outputFile) === reportFile) {
    throw new Error('acceptance report and output files must differ');
  }
  const report = JSON.parse(readFileSync(reportFile, 'utf8')) as Record<string, unknown>;
  const failures: IveKitImAcceptanceFailure[] = [];
  const runId = required(report.run_id, 'report.run_id', failures);
  const environmentId = required(report.environment_id, 'report.environment_id', failures);
  if (report.schema_version !== 1) fail(failures, 'report.schema_version', 'schema_version must equal 1');
  if (report.source !== 'real_environment') fail(failures, 'report.source', 'source must equal real_environment');
  if (report.status !== 'completed') fail(failures, 'report.status', 'status must equal completed');
  if (!/^[a-f0-9]{40}$/i.test(String(report.deployed_commit || ''))) fail(failures, 'report.deployed_commit', 'deployed_commit must be a full Git SHA');
  const checkedAt = String(report.checked_at || '');
  if (!validIso(checkedAt)) fail(failures, 'report.checked_at', 'checked_at must be an ISO timestamp');
  validateIdentities(report.identities, failures);
  validateEndpoints(report.endpoints, failures);
  if (containsSecret(report)) fail(failures, 'report.secrets', 'report must not contain credentials, tokens, passwords, or private keys');

  const checks = objectValue(report.checks);
  const usedArtifacts = new Set<string>();
  let passed = 0;
  for (const id of IVEKIT_IM_REQUIRED_ACCEPTANCE_CHECKS) {
    const check = objectValue(checks[id]);
    if (check.passed !== true) {
      fail(failures, id, 'check must be present and passed=true');
      continue;
    }
    if (validateEvidence(id, objectValue(check.evidence), reportFile, runId, environmentId, checkedAt, usedArtifacts, failures)) passed += 1;
  }
  const result: IveKitImAcceptanceResult = {
    ok: failures.length === 0,
    status: failures.length ? 'incomplete' : 'ready_for_review',
    run_id: runId,
    environment_id: environmentId,
    summary: { required: IVEKIT_IM_REQUIRED_ACCEPTANCE_CHECKS.length, passed, failed: IVEKIT_IM_REQUIRED_ACCEPTANCE_CHECKS.length - passed },
    failures
  };
  if (config.outputFile) {
    mkdirSync(dirname(resolve(config.outputFile)), { recursive: true });
    writeFileSync(resolve(config.outputFile), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  return result;
}

export function runIveKitImAcceptanceFromEnv(env: Record<string, string | undefined>):
  | IveKitImAcceptanceResult
  | { ok: false; status: 'not_run'; missing_environment: string[]; template_file?: string } {
  const templateFile = String(env.OPC_IVEKIT_IM_ACCEPTANCE_TEMPLATE_FILE || '').trim();
  if (templateFile) {
    return {
      ok: false,
      status: 'not_run',
      missing_environment: ['OPC_IVEKIT_IM_ACCEPTANCE_REPORT_FILE'],
      template_file: writeIveKitImAcceptanceTemplate(templateFile)
    };
  }
  const reportFile = String(env.OPC_IVEKIT_IM_ACCEPTANCE_REPORT_FILE || '').trim();
  if (!reportFile) {
    return { ok: false, status: 'not_run', missing_environment: ['OPC_IVEKIT_IM_ACCEPTANCE_REPORT_FILE'] };
  }
  return runIveKitImAcceptance({
    reportFile,
    outputFile: String(env.OPC_IVEKIT_IM_ACCEPTANCE_OUTPUT_FILE || '').trim() || undefined
  });
}

export function renderIveKitImAcceptanceRunbook(): string {
  return `# iveKit IM real-environment acceptance\n\n` +
    `1. Open two real browsers on different user identities: one agent and one customer.\n` +
    `2. Connect both clients to the deployed iveKit facade and real Tinode WSS endpoint.\n` +
    `3. Execute every check in the generated template and save raw screenshots or JSON logs as separate artifacts.\n` +
    `4. Create one unique JSON observation per check with matching check_id, run_id, environment_id, captured_at, tool, and observation fields.\n` +
    `5. For layout evidence, record a human redaction review before referencing screenshots. Do not include any API key, authorization header, token, password, cookie, or private key.\n` +
    `6. Run the validator, then have a human review the referenced captures. The validator checks integrity and binding; it cannot prove the observation happened. Controlled local E2E output is not real-environment evidence.\n`;
}

function validateEvidence(
  id: string,
  evidence: Record<string, unknown>,
  reportFile: string,
  runId: string,
  environmentId: string,
  checkedAt: string,
  usedArtifacts: Set<string>,
  failures: IveKitImAcceptanceFailure[]
): boolean {
  const relative = String(evidence.artifact_file || '').trim();
  if (!relative || !relative.endsWith('.json') || relative.includes('replace-with') || relative.includes('..') || relative.startsWith('/') || relative.includes(`..${sep}`)) {
    fail(failures, id, 'artifact_file must be a non-placeholder relative JSON path');
    return false;
  }
  const reportDirectory = realpathSync(dirname(reportFile));
  const candidate = resolve(reportDirectory, relative);
  if (!candidate.startsWith(`${reportDirectory}${sep}`) || !existsSync(candidate)) {
    fail(failures, id, 'artifact_file is missing or outside the report directory');
    return false;
  }
  if (lstatSync(candidate).isSymbolicLink()) {
    fail(failures, id, 'artifact_file must not be a symbolic link');
    return false;
  }
  const artifactFile = realpathSync(candidate);
  if (!artifactFile.startsWith(`${reportDirectory}${sep}`)) {
    fail(failures, id, 'artifact_file resolves outside the report directory');
    return false;
  }
  if (usedArtifacts.has(artifactFile)) {
    fail(failures, id, 'every acceptance check requires a unique artifact_file');
    return false;
  }
  usedArtifacts.add(artifactFile);
  const content = readFileSync(artifactFile);
  const expected = String(evidence.sha256 || '').toLowerCase();
  const actual = createHash('sha256').update(content).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(expected) || expected !== actual) {
    fail(failures, id, 'artifact SHA-256 does not match');
    return false;
  }
  if (!validIso(evidence.captured_at) || String(evidence.run_id || '') !== runId || !requiredText(evidence.tool)) {
    fail(failures, id, 'evidence timestamp, tool, and run_id are required');
    return false;
  }
  if (validIso(checkedAt) && validIso(evidence.captured_at)) {
    const delta = Date.parse(checkedAt) - Date.parse(String(evidence.captured_at));
    if (delta < -5 * 60_000 || delta > 24 * 60 * 60_000) {
      fail(failures, id, 'evidence captured_at is outside the acceptance time window');
      return false;
    }
  }
  let observation: Record<string, any>;
  try {
    observation = objectValue(JSON.parse(content.toString('utf8')));
  } catch {
    fail(failures, id, 'artifact_file must contain valid JSON observation data');
    return false;
  }
  if (
    observation.schema_version !== 1 ||
    observation.source !== 'real_environment' ||
    String(observation.check_id || '') !== id ||
    String(observation.run_id || '') !== runId ||
    String(observation.environment_id || '') !== environmentId ||
    String(observation.captured_at || '') !== String(evidence.captured_at || '') ||
    String(observation.tool || '') !== String(evidence.tool || '')
  ) {
    fail(failures, id, 'artifact schema, source, check_id, run_id, environment_id, captured_at, and tool must match the report');
    return false;
  }
  if (!Object.keys(objectValue(observation.observation)).length || containsPlaceholder(observation.observation)) {
    fail(failures, id, 'artifact observation must contain structured non-placeholder data');
    return false;
  }
  if (id.startsWith('layout.') && !validRedactionReview(observation.redaction_review)) {
    fail(failures, id, 'layout evidence requires a human redaction review');
    return false;
  }
  const details = objectValue(evidence.details);
  if (!Object.keys(details).length || containsPlaceholder(details)) {
    fail(failures, id, 'structured evidence details are required');
    return false;
  }
  if (containsSecret(evidence) || containsSecretText(content.toString('utf8'))) {
    fail(failures, id, 'evidence must not contain secrets');
    return false;
  }
  return true;
}

function validateIdentities(value: unknown, failures: IveKitImAcceptanceFailure[]) {
  const identities = objectValue(value);
  const agent = String(identities.agent || '').trim();
  const customer = String(identities.customer || '').trim();
  if (!agent || !customer || agent === customer || containsPlaceholder(identities)) {
    fail(failures, 'report.identities', 'distinct real agent and customer identities are required');
  }
}

function validateEndpoints(value: unknown, failures: IveKitImAcceptanceFailure[]) {
  const endpoints = objectValue(value);
  if (!/^https:\/\//.test(String(endpoints.ivekit || '')) || !/^wss:\/\//.test(String(endpoints.tinode || '')) || containsPlaceholder(endpoints)) {
    fail(failures, 'report.endpoints', 'HTTPS iveKit and WSS Tinode endpoints are required');
  }
}

function containsSecret(value: unknown): boolean {
  if (typeof value === 'string') return containsSecretText(value);
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsSecret);
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
    const sensitiveKey = /(api[_-]?key|secret|password|private[_-]?key|auth(?:orization)?|auth[_-]?token|access[_-]?token|cookie|set[_-]?cookie)/i.test(key);
    if (sensitiveKey && requiredText(item) && !String(item).includes('replace-with')) return true;
    return containsSecret(item);
  });
}

function containsSecretText(value: string): boolean {
  return /Authorization\s*:\s*(?:Bearer\s+[A-Za-z0-9._~+/-]{8,}|Basic\s+[A-Za-z0-9+/]{8,}={0,2})|(?:Cookie|Set-Cookie)\s*:\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\bsk-[A-Za-z0-9_-]{8,}\b|(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{8,}/i.test(value);
}

function validRedactionReview(value: unknown): boolean {
  const review = objectValue(value);
  return requiredText(review.reviewed_by) && validIso(review.reviewed_at) && review.sensitive_data_absent === true;
}

function containsPlaceholder(value: unknown): boolean {
  return JSON.stringify(value).includes('replace-with');
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

function required(value: unknown, id: string, failures: IveKitImAcceptanceFailure[]): string {
  const text = String(value || '').trim();
  if (!text || text.includes('replace-with')) fail(failures, id, `${id} is required and cannot be a placeholder`);
  return text;
}

function requiredText(value: unknown): boolean { return Boolean(String(value || '').trim()); }
function validIso(value: unknown): boolean { return /^\d{4}-\d{2}-\d{2}T/.test(String(value || '')) && Number.isFinite(Date.parse(String(value))); }
function fail(failures: IveKitImAcceptanceFailure[], id: string, reason: string) { failures.push({ id, reason }); }

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] || '')) {
  const result = runIveKitImAcceptanceFromEnv(process.env);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 2;
}
