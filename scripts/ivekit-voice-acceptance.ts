import { resolveFabricEnv } from '../src/config/converact-env.js';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type IveKitVoiceAcceptanceDeploymentMode =
  | 'standalone-compose'
  | 'standalone-helm'
  | 'external-provider';

export const VOICE_ACCEPTANCE_DETAIL_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'deployment.image_and_source_binding': ['ivekit_image_digest', 'rustpbx_image_digest', 'source_commit', 'manifest_sha256'],
  'deployment.migrations_rls': ['migration_count', 'ledger_matched', 'rls_forced', 'cross_tenant_denied'],
  'deployment.ivekit_health_preflight': ['health_status', 'preflight_ready', 'profile_id'],
  'deployment.rustpbx_health_preflight': ['rustpbx_version', 'health_status', 'rwi_connected', 'config_sha256'],
  'sip.trunk_registration': ['trunk_id', 'provider', 'registration_status', 'observed_at'],
  'sip.did_inbound_call': ['call_id', 'did_id', 'trunk_id', 'bidirectional_audio_observed'],
  'sip.pstn_outbound_call': ['call_id', 'destination_projection', 'trunk_id', 'bidirectional_audio_observed'],
  'sip.cdr_webhook_idempotency': ['call_id', 'provider_event_id', 'delivery_count', 'recording_row_count', 'idempotent'],
  'webphone.wss_registration': ['extension_id', 'browser', 'wss_url', 'certificate_fingerprint', 'registered'],
  'webphone.sdp_ice_negotiation': ['call_id', 'offer_answer_observed', 'candidate_pair', 'selected_transport'],
  'webphone.bidirectional_rtp_audio': ['call_id', 'caller_audio_observed', 'callee_audio_observed', 'rtp_stats'],
  'webphone.device_switch_reconnect': ['call_id', 'input_devices', 'output_devices', 'reconnect_at', 'audio_recovered'],
  'control.dtmf': ['call_id', 'digits', 'transport', 'remote_detection_observed'],
  'control.hold_resume': ['call_id', 'hold_event_id', 'resume_event_id', 'media_paused_observed', 'media_resumed_observed'],
  'control.blind_transfer': ['source_call_id', 'target_projection', 'transfer_event_id', 'target_connected'],
  'control.warm_transfer': ['source_call_id', 'consult_call_id', 'transfer_event_id', 'target_connected'],
  'control.conference_lifecycle': ['conference_id', 'participant_call_ids', 'operations', 'bidirectional_audio_observed'],
  'control.unsupported_actions_fail_closed': ['actions', 'capability_snapshot_id', 'http_status_code', 'fail_closed_observed'],
  'recording.lifecycle_and_consent': ['call_id', 'recording_id', 'consent_id', 'started_at', 'completed_at'],
  'recording.object_checksum_playback': ['recording_id', 'object_key', 'size_bytes', 'object_sha256', 'playback_audible'],
  'recording.retention_and_export': ['recording_id', 'retention_until', 'export_id', 'export_sha256', 'access_audited'],
  'ivr.inbound_route_playback': ['call_id', 'flow_version_id', 'route_version_id', 'audio_asset_id', 'playback_audible'],
  'ivr.menu_collect_dtmf': ['session_id', 'node_id', 'digits', 'selected_branch', 'step_persisted'],
  'ivr.speech_match_asr': ['session_id', 'node_id', 'provider_profile_id', 'transcript_projection', 'selected_branch'],
  'ivr.http_webhook_subflow': ['session_id', 'http_node_id', 'subflow_version_id', 'request_id', 'result_persisted'],
  'ivr.queue_transfer_audio_queue': ['session_id', 'queue_id', 'audio_queue_observed', 'assignment_id', 'transfer_connected'],
  'ivr.barge_in': ['session_id', 'node_id', 'playback_started_at', 'speech_detected_at', 'playback_interrupted'],
  'ivr.voicemail_recording': ['session_id', 'recording_id', 'object_key', 'size_bytes', 'playback_audible'],
  'ivr.survey_persistence': ['session_id', 'survey_node_id', 'answers', 'terminal_state', 'step_persisted'],
  'ivr.publish_gate_and_recovery': ['flow_id', 'flow_version_id', 'validation_passed', 'restart_at', 'session_recovered'],
  'ai.realtime_asr_vad': ['session_id', 'provider_profile_id', 'vad_events', 'transcript_events', 'latency_ms'],
  'ai.realtime_tts_barge_in': ['session_id', 'provider_profile_id', 'tts_events', 'barge_in_observed', 'latency_ms'],
  'ai.llm_tool_events': ['session_id', 'provider_profile_id', 'tool_calls', 'result_events', 'transcript_persisted'],
  'bridge.pstn_to_livekit': ['voice_call_id', 'media_call_id', 'room_name', 'sip_participant_id', 'bidirectional_audio_observed'],
  'bridge.livekit_to_pstn': ['voice_call_id', 'media_call_id', 'room_name', 'sip_participant_id', 'bidirectional_audio_observed'],
  'contact_center.acd_offer_accept': ['queue_id', 'entry_id', 'assignment_id', 'agent_id', 'offer_accepted'],
  'contact_center.callback_overflow': ['callback_id', 'overflow_action_id', 'voice_call_id', 'attempts', 'terminal_state'],
  'contact_center.supervisor_capability_truth': ['requested_modes', 'effective_modes', 'capability_snapshot_id', 'fail_closed_observed'],
  'resilience.duplicate_out_of_order_events': ['call_id', 'provider_event_ids', 'delivery_count', 'canonical_event_count', 'idempotent'],
  'resilience.command_reconciliation': ['call_id', 'command_id', 'uncertain_at', 'reconciled_at', 'terminal_state'],
  'resilience.restart_recovery': ['restart_started_at', 'restart_completed_at', 'recovered_calls', 'recovered_ivr_sessions', 'leases_reclaimed'],
  'isolation.cross_tenant_rls_denied': ['source_tenant', 'target_tenant', 'resource_types', 'denial_status_code', 'cross_tenant_denied'],
  'performance.call_setup_and_concurrency': ['concurrent_calls', 'duration_seconds', 'call_setup_p95_ms', 'error_rate_pct', 'metrics_artifact'],
  'governance.audit_business_ref_trace': ['business_ref', 'voice_call_id', 'recording_id', 'evidence_id', 'audit_events'],
  'governance.independent_qa_review': ['qa_approver', 'reviewed_artifacts', 'redaction_reviewed', 'reviewed_at']
});

export const VOICE_REQUIRED_ACCEPTANCE_CHECKS = Object.freeze(
  Object.keys(VOICE_ACCEPTANCE_DETAIL_REQUIREMENTS)
);

export interface IveKitVoiceAcceptanceEvidenceReference {
  artifact_file: string;
  sha256: string;
  captured_at: string;
  tool: string;
  run_id: string;
}

export interface IveKitVoiceAcceptanceConfig {
  reportFile: string;
  outputFile?: string;
}

export interface IveKitVoiceAcceptanceTemplateConfig {
  templateFile?: string;
  runId: string;
  environmentId: string;
  deploymentMode: IveKitVoiceAcceptanceDeploymentMode;
  deployedCommit: string;
  deploymentFingerprint: string;
  operator: string;
  qaApprover: string;
  runStartedAt: string;
  checkedAt: string;
}

export interface IveKitVoiceAcceptanceFailure {
  id: string;
  reason: string;
}

export interface IveKitVoiceAcceptanceResult {
  schema_version: 1;
  ok: boolean;
  status: 'ready_for_review' | 'incomplete';
  run_id: string;
  environment_id: string;
  deployed_commit: string;
  deployment_fingerprint: string;
  checked_at: string;
  operator: string;
  qa_approver: string;
  summary: {
    required_checks: number;
    passed_checks: number;
    failed: number;
    missing: number;
  };
  real_environment_evidence: boolean;
  automatically_updates_delivery_acceptance: false;
  failures: IveKitVoiceAcceptanceFailure[];
}

interface EvidenceContext {
  runId: string;
  runStartedAt: string;
  environmentId: string;
  deployedCommit: string;
  deploymentFingerprint: string;
  operator: string;
  qaApprover: string;
  checkedAt: string;
}

const VERSION_KEYS = [
  'ivekit_image',
  'rustpbx_image',
  'rustpbx',
  'postgres',
  'livekit_sip',
  'browser',
  'sip_test_tool'
] as const;
const DEPLOYMENT_MODES = new Set<IveKitVoiceAcceptanceDeploymentMode>([
  'standalone-compose',
  'standalone-helm',
  'external-provider'
]);
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_DIGEST = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}@sha256:[a-f0-9]{64}$/;
const SAFE_ARTIFACT = /^evidence\/[a-z0-9][a-z0-9._-]{0,190}\.json$/;
const PLACEHOLDER = /(?:replace[-_ ]with|placeholder|example|todo|tbd)/i;
const CONTROLLED_TOOL = /(?:playwright|mock|fake|synthetic|controlled|simulat)/i;
const MAX_EVIDENCE_BYTES = 10_485_760;

export function createIveKitVoiceAcceptanceTemplate(
  config: Omit<IveKitVoiceAcceptanceTemplateConfig, 'templateFile'>
): Record<string, unknown> {
  const checks = Object.fromEntries(VOICE_REQUIRED_ACCEPTANCE_CHECKS.map((checkId) => [
    checkId,
    {
      passed: false,
      evidence: {
        artifact_file: `evidence/${checkId.replaceAll('.', '-')}.json`,
        sha256: '',
        captured_at: '',
        tool: '',
        run_id: config.runId,
        required_observation_fields: VOICE_ACCEPTANCE_DETAIL_REQUIREMENTS[checkId]
      }
    }
  ]));
  return {
    schema_version: 1,
    source: 'real_voice_environment',
    status: 'incomplete',
    run_id: config.runId,
    run_started_at: config.runStartedAt,
    environment_id: config.environmentId,
    deployment_mode: config.deploymentMode,
    deployed_commit: config.deployedCommit,
    deployment_fingerprint: config.deploymentFingerprint,
    operator: config.operator,
    qa_approver: config.qaApprover,
    checked_at: config.checkedAt,
    versions: {
      ivekit_image: '',
      rustpbx_image: '',
      rustpbx: '',
      postgres: '',
      livekit_sip: '',
      browser: '',
      sip_test_tool: ''
    },
    checks
  };
}

export function writeIveKitVoiceAcceptanceTemplate(
  config: IveKitVoiceAcceptanceTemplateConfig
): { templateFile: string; checks: number } {
  if (!config.templateFile) throw new Error('CONVERACT_FABRIC_VOICE_ACCEPTANCE_TEMPLATE_FILE is required');
  const template = createIveKitVoiceAcceptanceTemplate(config);
  mkdirSync(dirname(resolve(config.templateFile)), { recursive: true });
  writeFileSync(resolve(config.templateFile), `${JSON.stringify(template, null, 2)}\n`, 'utf8');
  return { templateFile: resolve(config.templateFile), checks: VOICE_REQUIRED_ACCEPTANCE_CHECKS.length };
}

export function runIveKitVoiceAcceptance(
  config: IveKitVoiceAcceptanceConfig
): IveKitVoiceAcceptanceResult {
  const reportFile = resolve(config.reportFile);
  const report = readJsonObject(reportFile);
  const failures: IveKitVoiceAcceptanceFailure[] = [];
  let missing = 0;
  let passedChecks = 0;

  requireEqual(failures, 'report.schema_version', report.schema_version, 1);
  requireEqual(failures, 'report.source', report.source, 'real_voice_environment');
  requireEqual(failures, 'report.status', report.status, 'completed');
  const runId = identity(report.run_id, 'report.run_id', failures);
  const runStartedAt = timestamp(report.run_started_at, 'report.run_started_at', failures);
  const environmentId = identity(report.environment_id, 'report.environment_id', failures);
  const deploymentMode = String(report.deployment_mode || '') as IveKitVoiceAcceptanceDeploymentMode;
  if (!DEPLOYMENT_MODES.has(deploymentMode)) {
    failures.push({ id: 'report.deployment_mode', reason: 'invalid deployment mode' });
  }
  const deployedCommit = String(report.deployed_commit || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(deployedCommit)) {
    failures.push({ id: 'report.deployed_commit', reason: 'deployed_commit must be a full Git SHA' });
  }
  const deploymentFingerprint = String(report.deployment_fingerprint || '').trim().toLowerCase();
  if (!SHA256.test(deploymentFingerprint)) {
    failures.push({ id: 'report.deployment_fingerprint', reason: 'deployment_fingerprint must be SHA-256' });
  }
  const operator = identity(report.operator, 'report.operator', failures);
  const qaApprover = identity(report.qa_approver, 'report.qa_approver', failures);
  if (operator && qaApprover && operator.toLowerCase() === qaApprover.toLowerCase()) {
    failures.push({ id: 'report.qa_approver', reason: 'QA approver must differ from the evidence operator' });
  }
  const checkedAt = timestamp(report.checked_at, 'report.checked_at', failures);
  validateRunWindow(runStartedAt, checkedAt, failures);
  validateVersions(objectValue(report.versions), failures);
  if (containsSecret(report)) {
    failures.push({ id: 'report.secret_scan', reason: 'report contains secret material' });
  }

  const context: EvidenceContext = {
    runId,
    runStartedAt,
    environmentId,
    deployedCommit,
    deploymentFingerprint,
    operator,
    qaApprover,
    checkedAt
  };
  const checks = objectValue(report.checks);
  const actualCheckIds = Object.keys(checks);
  const extras = actualCheckIds.filter((id) => !VOICE_REQUIRED_ACCEPTANCE_CHECKS.includes(id));
  if (extras.length > 0) failures.push({ id: 'report.checks', reason: `unknown checks: ${extras.join(', ')}` });
  const evidenceHashes = new Set<string>();

  for (const checkId of VOICE_REQUIRED_ACCEPTANCE_CHECKS) {
    const raw = checks[checkId];
    if (!isRecord(raw)) {
      failures.push({ id: checkId, reason: 'check is missing' });
      missing += 1;
      continue;
    }
    if (raw.passed !== true) {
      failures.push({ id: checkId, reason: 'check did not pass' });
      continue;
    }
    const before = failures.length;
    const hash = validateEvidenceReference(raw.evidence, checkId, reportFile, context, failures);
    if (hash && evidenceHashes.has(hash)) {
      failures.push({ id: checkId, reason: 'each check requires a distinct evidence artifact' });
    } else if (hash) {
      evidenceHashes.add(hash);
    }
    if (failures.length === before) passedChecks += 1;
  }

  const result: IveKitVoiceAcceptanceResult = {
    schema_version: 1,
    ok: failures.length === 0,
    status: failures.length === 0 ? 'ready_for_review' : 'incomplete',
    run_id: runId,
    environment_id: environmentId,
    deployed_commit: deployedCommit,
    deployment_fingerprint: deploymentFingerprint,
    checked_at: checkedAt,
    operator,
    qa_approver: qaApprover,
    summary: {
      required_checks: VOICE_REQUIRED_ACCEPTANCE_CHECKS.length,
      passed_checks: passedChecks,
      failed: failures.length,
      missing
    },
    real_environment_evidence: failures.length === 0,
    automatically_updates_delivery_acceptance: false,
    failures
  };
  if (config.outputFile) {
    const outputFile = resolve(config.outputFile);
    if (outputFile === reportFile) throw new Error('acceptance output must differ from report input');
    mkdirSync(dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  return result;
}

export function runIveKitVoiceAcceptanceFromEnv(
  env: NodeJS.ProcessEnv = process.env
): IveKitVoiceAcceptanceResult | {
  ok: false;
  status: 'not_run';
  missing_environment: string[];
} {
  const reportFile = String(resolveFabricEnv(env, 'VOICE_ACCEPTANCE_REPORT_FILE') || '').trim();
  if (!reportFile) {
    return {
      ok: false,
      status: 'not_run',
      missing_environment: ['CONVERACT_FABRIC_VOICE_ACCEPTANCE_REPORT_FILE']
    };
  }
  return runIveKitVoiceAcceptance({
    reportFile,
    outputFile: optional(resolveFabricEnv(env, 'VOICE_ACCEPTANCE_OUTPUT_FILE'))
  });
}

export function renderIveKitVoiceAcceptanceRunbook(): string {
  const groups: Array<[string, string]> = [
    ['Deployment', 'deployment.'],
    ['SIP And PSTN', 'sip.'],
    ['WebPhone And RTP', 'webphone.'],
    ['Call Control', 'control.'],
    ['Recording', 'recording.'],
    ['IVR', 'ivr.'],
    ['Realtime Voice AI', 'ai.'],
    ['LiveKit SIP Bridge', 'bridge.'],
    ['Contact Center', 'contact_center.'],
    ['Resilience And Isolation', 'resilience.|isolation.'],
    ['Performance And Governance', 'performance.|governance.']
  ];
  const lines = [
    '# iveKit Voice Real Environment Acceptance Runbook',
    '',
    'Use a fresh isolated release environment, real RustPBX, real SIP trunk/DID or approved SIP test endpoint,',
    'a physical browser audio device, PostgreSQL, and LiveKit SIP where the check requires it.',
    'Controlled providers, injected browser engines, screenshots without runtime data, and command-only success are rejected.',
    ''
  ];
  for (const [heading, prefixes] of groups) {
    const patterns = prefixes.split('|');
    lines.push(`## ${heading}`, '');
    for (const checkId of VOICE_REQUIRED_ACCEPTANCE_CHECKS.filter((id) =>
      patterns.some((prefix) => id.startsWith(prefix))
    )) {
      lines.push(`- \`${checkId}\`: capture ${VOICE_ACCEPTANCE_DETAIL_REQUIREMENTS[checkId].join(', ')}.`);
    }
    lines.push('');
  }
  lines.push(
    '## Validation',
    '',
    'Every check uses a distinct JSON artifact under `evidence/`. Bind each artifact to the same run ID, environment,',
    'full deployed commit, deployment fingerprint, operator and time window, then calculate its SHA-256.',
    '',
    '```bash',
    'CONVERACT_FABRIC_VOICE_ACCEPTANCE_REPORT_FILE=/secure/evidence/voice-report.json \\',
    'CONVERACT_FABRIC_VOICE_ACCEPTANCE_OUTPUT_FILE=/secure/evidence/voice-result.json \\',
    '  npm run ivekit:voice-acceptance',
    '```',
    '',
    'A successful validator returns `ready_for_review`. It does not change any delivery `not_run` result automatically;',
    'an independent reviewer must inspect the real artifacts and approve release evidence.',
    ''
  );
  return lines.join('\n');
}

function validateEvidenceReference(
  value: unknown,
  checkId: string,
  reportFile: string,
  context: EvidenceContext,
  failures: IveKitVoiceAcceptanceFailure[]
): string {
  if (!isRecord(value)) {
    failures.push({ id: checkId, reason: 'evidence reference is missing' });
    return '';
  }
  const artifactFile = String(value.artifact_file || '').trim();
  if (!SAFE_ARTIFACT.test(artifactFile)) {
    failures.push({ id: checkId, reason: 'artifact_file must be a safe evidence/*.json path' });
    return '';
  }
  const reportDir = dirname(reportFile);
  const artifact = resolve(reportDir, artifactFile);
  if (!artifact.startsWith(`${reportDir}${sep}`) || !existsSync(artifact)) {
    failures.push({ id: checkId, reason: 'evidence artifact is missing or outside the report directory' });
    return '';
  }
  const fileStat = lstatSync(artifact);
  if (fileStat.isSymbolicLink() || !fileStat.isFile() || statSync(artifact).size < 1 ||
      statSync(artifact).size > MAX_EVIDENCE_BYTES) {
    failures.push({ id: checkId, reason: 'evidence must be a bounded regular file, not a symlink' });
    return '';
  }
  const realReportDir = realpathSync(reportDir);
  const realArtifact = realpathSync(artifact);
  if (!realArtifact.startsWith(`${realReportDir}${sep}`)) {
    failures.push({ id: checkId, reason: 'evidence real path must remain inside the report directory' });
    return '';
  }
  const expectedHash = String(value.sha256 || '').trim().toLowerCase();
  const actualHash = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  if (!SHA256.test(expectedHash) || expectedHash !== actualHash) {
    failures.push({ id: checkId, reason: 'evidence SHA-256 mismatch' });
    return actualHash;
  }
  const tool = String(value.tool || '').trim();
  const capturedAt = String(value.captured_at || '').trim();
  if (String(value.run_id || '') !== context.runId || !validTool(tool) || !isIsoTimestamp(capturedAt)) {
    failures.push({ id: checkId, reason: 'evidence reference run, tool, or timestamp is invalid' });
  }
  let document: Record<string, unknown>;
  try {
    document = readJsonObject(artifact);
  } catch {
    failures.push({ id: checkId, reason: 'evidence artifact must be valid JSON' });
    return actualHash;
  }
  const bindings: Array<[string, unknown, unknown]> = [
    ['schema_version', document.schema_version, 1],
    ['source', document.source, 'real_voice_environment'],
    ['check_id', document.check_id, checkId],
    ['run_id', document.run_id, context.runId],
    ['environment_id', document.environment_id, context.environmentId],
    ['deployed_commit', document.deployed_commit, context.deployedCommit],
    ['deployment_fingerprint', document.deployment_fingerprint, context.deploymentFingerprint],
    ['operator', document.operator, context.operator],
    ['captured_at', document.captured_at, capturedAt],
    ['tool', document.tool, tool]
  ];
  for (const [field, actual, expected] of bindings) {
    if (actual !== expected) failures.push({ id: checkId, reason: `evidence ${field} does not match the report` });
  }
  if (!validTool(String(document.tool || '')) || !timestampWithinRun(capturedAt, context)) {
    failures.push({ id: checkId, reason: 'evidence is not a real tool observation within the run window' });
  }
  const observation = objectValue(document.observation);
  for (const field of VOICE_ACCEPTANCE_DETAIL_REQUIREMENTS[checkId]) {
    const emptyEffectiveModes = checkId === 'contact_center.supervisor_capability_truth' &&
      field === 'effective_modes' && Array.isArray(observation[field]);
    if (!emptyEffectiveModes && !meaningful(observation[field])) {
      failures.push({ id: checkId, reason: `evidence observation.${field} is missing` });
    }
  }
  validateObservationSemantics(checkId, observation, context, failures);
  if (containsSecret(document)) failures.push({ id: checkId, reason: 'evidence contains secret material' });
  return actualHash;
}

function validateVersions(
  versions: Record<string, unknown>,
  failures: IveKitVoiceAcceptanceFailure[]
): void {
  for (const key of VERSION_KEYS) {
    const value = String(versions[key] || '').trim();
    if (!value || value.length > 256 || PLACEHOLDER.test(value)) {
      failures.push({ id: `versions.${key}`, reason: 'version is missing or a placeholder' });
    }
  }
  for (const key of ['ivekit_image', 'rustpbx_image'] as const) {
    if (!IMAGE_DIGEST.test(String(versions[key] || ''))) {
      failures.push({ id: `versions.${key}`, reason: 'image must use an immutable sha256 digest' });
    }
  }
}

function validateRunWindow(
  startedAt: string,
  checkedAt: string,
  failures: IveKitVoiceAcceptanceFailure[]
): void {
  if (!isIsoTimestamp(startedAt) || !isIsoTimestamp(checkedAt)) return;
  const duration = Date.parse(checkedAt) - Date.parse(startedAt);
  const now = Date.now();
  if (duration < 0 || duration > 24 * 60 * 60 * 1000 ||
      Date.parse(startedAt) < now - 24 * 60 * 60 * 1000 ||
      Date.parse(checkedAt) > now + 5 * 60 * 1000) {
    failures.push({ id: 'report.checked_at', reason: 'acceptance run must be fresh and complete within 24 hours' });
  }
}

function timestampWithinRun(value: string, context: EvidenceContext): boolean {
  if (!isIsoTimestamp(value) || !isIsoTimestamp(context.runStartedAt) || !isIsoTimestamp(context.checkedAt)) return false;
  const timestamp = Date.parse(value);
  return timestamp >= Date.parse(context.runStartedAt) && timestamp <= Date.parse(context.checkedAt);
}

function validTool(value: string): boolean {
  const tool = value.trim();
  return tool.length >= 3 && tool.length <= 256 && !PLACEHOLDER.test(tool) && !CONTROLLED_TOOL.test(tool);
}

function containsSecret(value: unknown, key = ''): boolean {
  if (typeof value === 'string') {
    if (/(?:authorization|cookie|password|private[_-]?key|api[_-]?key|secret|token)$/i.test(key) && value.trim()) return true;
    return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._-]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[?&](?:token|signature|sig|key|secret)=/i.test(value);
  }
  if (Array.isArray(value)) return value.some((entry) => containsSecret(entry, key));
  if (isRecord(value)) return Object.entries(value).some(([childKey, child]) => containsSecret(child, childKey));
  return false;
}

function meaningful(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0 && !PLACEHOLDER.test(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0;
  if (Array.isArray(value)) return value.length > 0 && value.every(meaningful);
  return isRecord(value) && Object.keys(value).length > 0 && Object.values(value).every(meaningful);
}

function validateObservationSemantics(
  checkId: string,
  observation: Record<string, unknown>,
  context: EvidenceContext,
  failures: IveKitVoiceAcceptanceFailure[]
): void {
  for (const [field, value] of Object.entries(observation)) {
    if (/(?:_observed|_ready|_matched|_forced|_connected|_audible|_idempotent|_persisted|_recovered|_reclaimed|_accepted|_reviewed)$/.test(field) ||
        ['idempotent', 'registered', 'validation_passed', 'offer_accepted', 'access_audited', 'playback_interrupted'].includes(field)) {
      if (value !== true) failures.push({ id: checkId, reason: `observation.${field} must be true` });
    }
  }
  if (checkId === 'deployment.image_and_source_binding') {
    if (observation.source_commit !== context.deployedCommit ||
        !SHA256.test(String(observation.ivekit_image_digest || '')) ||
        !SHA256.test(String(observation.rustpbx_image_digest || '')) ||
        !SHA256.test(String(observation.manifest_sha256 || ''))) {
      failures.push({ id: checkId, reason: 'image/source binding must match the deployed commit and SHA-256 values' });
    }
  }
  if (checkId === 'control.unsupported_actions_fail_closed') {
    const actions = Array.isArray(observation.actions) ? observation.actions.map(String) : [];
    if (!['dtmf', 'park', 'pickup', 'supervisor'].every((action) => actions.includes(action)) ||
        observation.http_status_code !== 501) {
      failures.push({ id: checkId, reason: 'DTMF/Park/Pickup/supervisor capability limits must fail closed with 501' });
    }
  }
  if (checkId === 'contact_center.supervisor_capability_truth') {
    const requested = Array.isArray(observation.requested_modes) ? observation.requested_modes.map(String) : [];
    if (!['listen', 'whisper', 'barge', 'takeover'].every((mode) => requested.includes(mode)) ||
        !Array.isArray(observation.effective_modes)) {
      failures.push({ id: checkId, reason: 'supervisor evidence must record requested and effective mode sets' });
    }
  }
  if (checkId === 'isolation.cross_tenant_rls_denied' &&
      ![403, 404].includes(Number(observation.denial_status_code))) {
    failures.push({ id: checkId, reason: 'cross-tenant denial must use status 403 or 404' });
  }
  if (checkId === 'performance.call_setup_and_concurrency') {
    const positive = ['concurrent_calls', 'duration_seconds', 'call_setup_p95_ms']
      .every((field) => Number(observation[field]) > 0);
    const errorRate = Number(observation.error_rate_pct);
    if (!positive || !Number.isFinite(errorRate) || errorRate < 0 || errorRate > 100) {
      failures.push({ id: checkId, reason: 'performance evidence contains invalid load or latency values' });
    }
  }
  if (checkId === 'recording.object_checksum_playback' || checkId === 'ivr.voicemail_recording') {
    const invalidObjectChecksum = checkId === 'recording.object_checksum_playback' &&
      !SHA256.test(String(observation.object_sha256 || ''));
    if (Number(observation.size_bytes) <= 0 || invalidObjectChecksum) {
      failures.push({ id: checkId, reason: 'recording evidence requires non-empty bytes and a valid object checksum' });
    }
  }
  if (checkId === 'governance.independent_qa_review' && observation.qa_approver !== context.qaApprover) {
    failures.push({ id: checkId, reason: 'QA evidence approver must match the report' });
  }
}

function identity(
  value: unknown,
  id: string,
  failures: IveKitVoiceAcceptanceFailure[]
): string {
  const result = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{1,127}$/.test(result) || PLACEHOLDER.test(result)) {
    failures.push({ id, reason: 'identity is missing, unsafe, or a placeholder' });
  }
  return result;
}

function timestamp(
  value: unknown,
  id: string,
  failures: IveKitVoiceAcceptanceFailure[]
): string {
  const result = String(value || '').trim();
  if (!isIsoTimestamp(result)) failures.push({ id, reason: 'timestamp must be ISO-8601' });
  return result;
}

function isIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function requireEqual(
  failures: IveKitVoiceAcceptanceFailure[],
  id: string,
  actual: unknown,
  expected: unknown
): void {
  if (actual !== expected) failures.push({ id, reason: `must equal ${String(expected)}` });
}

function readJsonObject(file: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  if (!isRecord(value)) throw new Error(`expected JSON object: ${file}`);
  return value;
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function optional(value: string | undefined): string | undefined {
  const result = String(value || '').trim();
  return result || undefined;
}

function templateConfigFromEnv(env: NodeJS.ProcessEnv): IveKitVoiceAcceptanceTemplateConfig {
  const mode = String(resolveFabricEnv(env, 'VOICE_ACCEPTANCE_DEPLOYMENT_MODE') || 'standalone-compose') as IveKitVoiceAcceptanceDeploymentMode;
  if (!DEPLOYMENT_MODES.has(mode)) throw new Error('invalid CONVERACT_FABRIC_VOICE_ACCEPTANCE_DEPLOYMENT_MODE');
  return {
    templateFile: optional(resolveFabricEnv(env, 'VOICE_ACCEPTANCE_TEMPLATE_FILE')),
    runId: String(resolveFabricEnv(env, 'VOICE_ACCEPTANCE_RUN_ID') || 'replace-with-run-id'),
    environmentId: String(resolveFabricEnv(env, 'VOICE_ACCEPTANCE_ENVIRONMENT_ID') || 'replace-with-environment-id'),
    deploymentMode: mode,
    deployedCommit: String(resolveFabricEnv(env, 'VOICE_ACCEPTANCE_DEPLOYED_COMMIT') || 'replace-with-40-char-git-sha'),
    deploymentFingerprint: String(resolveFabricEnv(env, 'VOICE_ACCEPTANCE_DEPLOYMENT_FINGERPRINT') || 'replace-with-sha256'),
    operator: String(resolveFabricEnv(env, 'VOICE_ACCEPTANCE_OPERATOR') || 'replace-with-operator'),
    qaApprover: String(resolveFabricEnv(env, 'VOICE_ACCEPTANCE_QA_APPROVER') || 'replace-with-independent-qa'),
    runStartedAt: String(resolveFabricEnv(env, 'VOICE_ACCEPTANCE_RUN_STARTED_AT') || ''),
    checkedAt: String(resolveFabricEnv(env, 'VOICE_ACCEPTANCE_CHECKED_AT') || '')
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    if (resolveFabricEnv(process.env, 'VOICE_ACCEPTANCE_TEMPLATE_FILE')) {
      const config = templateConfigFromEnv(process.env);
      const result = writeIveKitVoiceAcceptanceTemplate(config);
      const runbookFile = optional(resolveFabricEnv(process.env, 'VOICE_ACCEPTANCE_RUNBOOK_FILE'));
      if (runbookFile) {
        mkdirSync(dirname(resolve(runbookFile)), { recursive: true });
        writeFileSync(resolve(runbookFile), renderIveKitVoiceAcceptanceRunbook(), 'utf8');
      }
      process.stdout.write(`${JSON.stringify({ ...result, runbook_file: runbookFile || '' }, null, 2)}\n`);
    } else {
      const result = runIveKitVoiceAcceptanceFromEnv(process.env);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
