import { resolveBrandEnv } from '../src/config/converact-env.js';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runLiveKitClientAcceptance,
  type LiveKitClientAcceptanceResult
} from './livekit-client-acceptance.js';
import {
  createLiveKitAcceptanceMetadata,
  isLiveKitAcceptanceMetadata,
  sameLiveKitAcceptanceMetadata,
  type LiveKitAcceptanceMetadata
} from './livekit-acceptance-metadata.js';

export type LiveKitEvidenceArtifactStatus = 'present' | 'missing' | 'not_configured';

export interface LiveKitEvidencePackConfig {
  outputFile?: string;
  title: string;
  expectedAcceptance?: LiveKitAcceptanceMetadata;
  expectedDeploymentMode?: 'standalone-vm' | 'external';
  qaPublicKeyFile?: string;
  qaPublicKeyFingerprint?: string;
  artifacts: {
    envChecklistFile?: string;
    preflightReportFile?: string;
    serverEvidenceFile?: string;
    readinessReportFile?: string;
    clientAcceptanceReportFile?: string;
    clientAcceptanceResultFile?: string;
    serverRunbookFile?: string;
    clientRunbookFile?: string;
  };
}

export interface LiveKitEvidenceArtifact {
  key: string;
  label: string;
  required: boolean;
  status: LiveKitEvidenceArtifactStatus;
  path?: string;
  size_bytes?: number;
  lines?: number;
  sha256?: string;
  error?: string;
}

export interface LiveKitEvidencePack {
  ok: boolean;
  title: string;
  status: 'ready_for_customer_review' | 'incomplete';
  missing_required: string[];
  artifacts: LiveKitEvidenceArtifact[];
  preflight?: {
    ok?: boolean;
    pass: number;
    warn: number;
    fail: number;
    error?: string;
  };
  server_evidence?: {
    ok?: boolean;
    failed_checks: string[];
    missing_summary: string[];
    error?: string;
  };
  readiness?: {
    ok?: boolean;
    passed_targets: string[];
    failed_targets: string[];
    missing_targets: string[];
    error?: string;
  };
  client_acceptance?: LiveKitClientAcceptanceResult;
  client_acceptance_error?: string;
  client_result?: {
    ok?: boolean;
    matches_report: boolean;
    error?: string;
  };
  acceptance?: {
    metadata?: LiveKitAcceptanceMetadata;
    consistent: boolean;
    time_window_valid: boolean;
    error?: string;
  };
}

export interface LiveKitEvidencePackWriteResult {
  outputFile: string;
  ok: boolean;
  status: LiveKitEvidencePack['status'];
  missing_required: string[];
  artifacts: number;
}

interface ArtifactSpec {
  key: string;
  label: string;
  required: boolean;
  path?: string;
}

const REQUIRED_READINESS_TARGETS = [
  'media',
  'agent-browser',
  'customer-browser',
  'web-assist-browser',
  'sip-volte'
] as const;

const REQUIRED_SERVER_SUMMARY = [
  'signal_dns_resolved',
  'turn_dns_resolved',
  'signal_tls_valid',
  'turn_tls_valid',
  'signal_health_reachable',
  'internal_health_reachable',
  'rtc_tcp_reachable',
  'turn_udp_probe_sent',
  'rtc_udp_probe_sent'
] as const;

const REQUIRED_SERVER_CHECKS = [
  'signal_dns',
  'turn_dns',
  'signal_tls',
  'turn_tls',
  'signal_health',
  'internal_health',
  'rtc_tcp',
  'turn_udp_probe_sent',
  'rtc_udp_probe_sent'
] as const;

const CORE_PREFLIGHT_CHECKS = [
  'livekit_internal_url', 'livekit_public_url', 'livekit_public_wss', 'livekit_deployment_mode',
  'livekit_api_key', 'livekit_api_secret', 'opc_base_url', 'media_api_token', 'media_invite_secret',
  'media_smoke_tenant', 'minio_access_key', 'minio_secret_key', 'media_recording_retention_days',
  'media_recording_http_timeout', 'media_recording_object_timeout', 'media_recording_object_poll_interval'
] as const;

const STANDALONE_PREFLIGHT_CHECKS = [
  'livekit_signal_domain', 'livekit_turn_domain', 'livekit_acme_email', 'livekit_server_image_tag',
  'livekit_egress_image_tag', 'livekit_sip_image_tag', 'livekit_caddyl4_image_tag', 'livekit_redis_image_tag'
] as const;

const TARGET_PREFLIGHT_CHECKS: Record<string, string[]> = {
  'agent-browser': [
    'agent_browser_frontend_url', 'agent_browser_agent_a_token', 'agent_browser_agent_a_user_id',
    'agent_browser_agent_a_seat_id', 'agent_browser_agent_b_token', 'agent_browser_agent_b_user_id',
    'agent_browser_agent_b_seat_id'
  ],
  'customer-browser': ['customer_browser_frontend_url', 'customer_browser_url_or_room', 'customer_browser_tenant'],
  'web-assist-browser': [
    'web_assist_frontend_url', 'web_assist_customer_url', 'web_assist_engineer_token',
    'web_assist_engineer_user_id', 'web_assist_tenant'
  ],
  'sip-volte': ['sip_bridge_target', 'rustpbx_livekit_trunk', 'rustpbx_rwi_url', 'rustpbx_rwi_token']
};

export function createLiveKitEvidencePackConfigFromEnv(
  env: NodeJS.ProcessEnv
): LiveKitEvidencePackConfig {
  const expectedAcceptance = createLiveKitAcceptanceMetadata(env);
  const expectedDeploymentMode = expectedAcceptance.deployment_mode;
  return {
    outputFile: optional(resolveBrandEnv(env, 'LIVEKIT_EVIDENCE_PACK_FILE')),
    title: optional(resolveBrandEnv(env, 'LIVEKIT_EVIDENCE_TITLE')) || 'LiveKit Evidence Pack',
    expectedAcceptance,
    expectedDeploymentMode,
    qaPublicKeyFile: optional(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_QA_PUBLIC_KEY_FILE')),
    qaPublicKeyFingerprint: optional(resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_QA_PUBLIC_KEY_FINGERPRINT')),
    artifacts: {
      envChecklistFile: optional(
        resolveBrandEnv(env, 'LIVEKIT_EVIDENCE_ENV_CHECKLIST_FILE') || resolveBrandEnv(env, 'LIVEKIT_PREFLIGHT_ENV_CHECKLIST_FILE')
      ),
      preflightReportFile: optional(
        resolveBrandEnv(env, 'LIVEKIT_EVIDENCE_PREFLIGHT_REPORT_FILE') || resolveBrandEnv(env, 'LIVEKIT_PREFLIGHT_REPORT_FILE')
      ),
      serverEvidenceFile: optional(
        resolveBrandEnv(env, 'LIVEKIT_EVIDENCE_SERVER_EVIDENCE_FILE') || resolveBrandEnv(env, 'LIVEKIT_SERVER_EVIDENCE_FILE')
      ),
      readinessReportFile: optional(
        resolveBrandEnv(env, 'LIVEKIT_EVIDENCE_READINESS_REPORT_FILE') || resolveBrandEnv(env, 'VIDEO_READINESS_REPORT_FILE')
      ),
      clientAcceptanceReportFile: optional(
        resolveBrandEnv(env, 'LIVEKIT_EVIDENCE_CLIENT_ACCEPTANCE_REPORT_FILE') || resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_REPORT_FILE')
      ),
      clientAcceptanceResultFile: optional(
        resolveBrandEnv(env, 'LIVEKIT_EVIDENCE_CLIENT_ACCEPTANCE_RESULT_FILE') || resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_OUTPUT_FILE')
      ),
      serverRunbookFile: optional(resolveBrandEnv(env, 'LIVEKIT_EVIDENCE_SERVER_RUNBOOK_FILE')),
      clientRunbookFile: optional(
        resolveBrandEnv(env, 'LIVEKIT_EVIDENCE_CLIENT_RUNBOOK_FILE') || resolveBrandEnv(env, 'LIVEKIT_ACCEPTANCE_RUNBOOK_FILE')
      )
    }
  };
}

export function buildLiveKitEvidencePack(config: LiveKitEvidencePackConfig): LiveKitEvidencePack {
  const artifacts = artifactSpecs(config).map(summarizeArtifact);
  const missing = artifacts
    .filter((artifact) => artifact.required && artifact.status !== 'present')
    .map((artifact) => artifact.key);
  for (const artifact of artifacts.filter((item) => item.required && item.error)) {
    missing.push(`${artifact.key}_unsafe_or_invalid`);
  }
  const preflight = summarizePreflight(config.artifacts.preflightReportFile);
  const serverEvidence = summarizeServerEvidence(config.artifacts.serverEvidenceFile);
  const readiness = summarizeReadiness(config.artifacts.readinessReportFile);
  const client = summarizeClientAcceptance(config);
  const clientResult = summarizeClientResult(
    config.artifacts.clientAcceptanceResultFile,
    client.result
  );
  const acceptance = summarizeAcceptanceMetadata(config);

  if (preflight?.ok !== true || (preflight?.fail || 0) > 0) missing.push('preflight_report_failed');
  if (preflight?.error) missing.push('preflight_report_invalid');
  if (serverEvidence?.ok !== true || serverEvidence?.failed_checks.length || serverEvidence?.missing_summary.length) {
    missing.push('server_evidence_failed');
  }
  if (serverEvidence?.error) missing.push('server_evidence_invalid');
  if (readiness?.ok !== true || readiness?.failed_targets.length) missing.push('readiness_report_failed');
  if (readiness?.missing_targets.length) missing.push('readiness_required_targets_missing');
  if (readiness?.error) missing.push('readiness_report_invalid');
  if (client.result && !client.result.ok) missing.push('client_acceptance_failed');
  if (client.error) missing.push('client_acceptance_invalid');
  if (clientResult?.ok !== true || clientResult?.matches_report !== true) {
    missing.push('client_acceptance_result_failed');
  }
  if (clientResult?.error) missing.push('client_acceptance_result_invalid');
  if (!acceptance.consistent) missing.push('acceptance_metadata_mismatch');
  if (!acceptance.time_window_valid) missing.push('acceptance_time_window_invalid');
  if (acceptance.error) missing.push('acceptance_metadata_invalid');

  const uniqueMissing = [...new Set(missing)];
  const ok = uniqueMissing.length === 0;
  return {
    ok,
    title: config.title,
    status: ok ? 'ready_for_customer_review' : 'incomplete',
    missing_required: uniqueMissing,
    artifacts,
    ...(preflight ? { preflight } : {}),
    ...(serverEvidence ? { server_evidence: serverEvidence } : {}),
    ...(readiness ? { readiness } : {}),
    ...(client.result ? { client_acceptance: client.result } : {}),
    ...(client.error ? { client_acceptance_error: client.error } : {}),
    ...(clientResult ? { client_result: clientResult } : {}),
    acceptance
  };
}

export function renderLiveKitEvidencePack(pack: LiveKitEvidencePack): string {
  const lines = [
    `# ${pack.title}`,
    '',
    `Status: \`${pack.status}\``,
    '',
    'This pack summarizes evidence metadata only. It does not embed raw reports, browser tokens, signed links or secret values.',
    ''
  ];
  if (pack.missing_required.length) {
    lines.push('## Missing Or Failed Required Evidence', '');
    for (const item of pack.missing_required) lines.push(`- \`${item}\``);
    lines.push('');
  }
  lines.push(
    '## Artifacts',
    '',
    '| Key | Required | Status | Size | SHA256 | Path |',
    '| --- | --- | --- | --- | --- | --- |'
  );
  for (const artifact of pack.artifacts) {
    lines.push(`| ${table(artifact.key)} | ${artifact.required ? 'yes' : 'no'} | ${artifact.status} | ${artifact.size_bytes ?? ''} | ${artifact.sha256 || ''} | ${table(artifact.path || '')} |`);
  }
  lines.push('');
  if (pack.preflight) {
    lines.push(
      '## Preflight',
      '',
      `- ok: \`${String(pack.preflight.ok)}\``,
      `- checks: \`pass=${pack.preflight.pass} warn=${pack.preflight.warn} fail=${pack.preflight.fail}\``,
      ''
    );
  }
  if (pack.server_evidence) {
    lines.push(
      '## Server Evidence',
      '',
      `- ok: \`${String(pack.server_evidence.ok)}\``,
      `- failed checks: \`${pack.server_evidence.failed_checks.join(', ') || 'none'}\``,
      `- missing or false summary fields: \`${pack.server_evidence.missing_summary.join(', ') || 'none'}\``,
      ''
    );
  }
  if (pack.readiness) {
    lines.push(
      '## Readiness',
      '',
      `- ok: \`${String(pack.readiness.ok)}\``,
      `- passed targets: \`${pack.readiness.passed_targets.join(', ') || 'none'}\``,
      `- failed targets: \`${pack.readiness.failed_targets.join(', ') || 'none'}\``,
      `- missing required targets: \`${pack.readiness.missing_targets.join(', ') || 'none'}\``,
      ''
    );
  }
  if (pack.client_acceptance) {
    lines.push(
      '## Client Acceptance',
      '',
      `- ok: \`${String(pack.client_acceptance.ok)}\``,
      `- environment: \`${table(pack.client_acceptance.environment_id)}\``,
      `- checks: \`passed=${pack.client_acceptance.summary.passed_checks} failed=${pack.client_acceptance.summary.failed}\``,
      ''
    );
  }
  if (pack.acceptance) {
    lines.push(
      '## Acceptance Run Binding',
      '',
      `- run id: \`${table(pack.acceptance.metadata?.run_id || 'invalid')}\``,
      `- metadata consistent: \`${String(pack.acceptance.consistent)}\``,
      `- time window valid: \`${String(pack.acceptance.time_window_valid)}\``,
      ''
    );
  }
  lines.push(
    '## Interpretation',
    '',
    'The status is ready only when preflight, server runtime probes, required readiness targets and the independently revalidated real-client report all pass. UDP send-only probes never replace ICE candidate-pair or forced TURN evidence.',
    ''
  );
  return lines.join('\n');
}

export function writeLiveKitEvidencePack(
  config: LiveKitEvidencePackConfig
): LiveKitEvidencePackWriteResult {
  if (!config.outputFile) throw new Error('CONVERACT_LIVEKIT_EVIDENCE_PACK_FILE is required');
  const pack = buildLiveKitEvidencePack(config);
  mkdirSync(dirname(config.outputFile), { recursive: true });
  writeFileSync(config.outputFile, renderLiveKitEvidencePack(pack), 'utf8');
  return {
    outputFile: config.outputFile,
    ok: pack.ok,
    status: pack.status,
    missing_required: pack.missing_required,
    artifacts: pack.artifacts.length
  };
}

function artifactSpecs(config: LiveKitEvidencePackConfig): ArtifactSpec[] {
  return [
    spec('env_checklist', 'Deployment environment checklist', true, config.artifacts.envChecklistFile),
    spec('preflight_report', 'LiveKit deployment preflight report', true, config.artifacts.preflightReportFile),
    spec('server_evidence', 'LiveKit server runtime evidence', true, config.artifacts.serverEvidenceFile),
    spec('readiness_report', 'Sanitized video readiness report', true, config.artifacts.readinessReportFile),
    spec('client_acceptance_report', 'Filled real-client acceptance report', true, config.artifacts.clientAcceptanceReportFile),
    spec('client_acceptance_result', 'Validated client acceptance result', true, config.artifacts.clientAcceptanceResultFile),
    spec('server_runbook', 'Server evidence runbook', true, config.artifacts.serverRunbookFile),
    spec('client_runbook', 'Real-client acceptance runbook', true, config.artifacts.clientRunbookFile)
  ];
}

function spec(key: string, label: string, required: boolean, path?: string): ArtifactSpec {
  return { key, label, required, path };
}

function summarizeArtifact(specValue: ArtifactSpec): LiveKitEvidenceArtifact {
  if (!specValue.path) {
    return { key: specValue.key, label: specValue.label, required: specValue.required, status: 'not_configured' };
  }
  try {
    const content = readFileSync(specValue.path, 'utf8');
    const stat = statSync(specValue.path);
    const secretDetected = artifactContainsSecret(content);
    return {
      key: specValue.key,
      label: specValue.label,
      required: specValue.required,
      status: 'present',
      path: specValue.path,
      size_bytes: stat.size,
      lines: content ? content.split(/\r?\n/).length - (content.endsWith('\n') ? 1 : 0) : 0,
      sha256: createHash('sha256').update(content).digest('hex'),
      ...(secretDetected ? { error: 'credential-like content detected' } : {})
    };
  } catch (error) {
    return {
      key: specValue.key,
      label: specValue.label,
      required: specValue.required,
      status: 'missing',
      path: specValue.path,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function artifactContainsSecret(content: string): boolean {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(content) ||
    /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:basic|bearer)\s+\S+/i.test(content) ||
    /\bcookie\s*[:=]\s*\S+/i.test(content) ||
    /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/.test(content) ||
    /\b(?:https?|wss?):\/\/[^\s]+[?#][^\s]+/i.test(content)) return true;
  try {
    return jsonContainsSecret(JSON.parse(content) as unknown);
  } catch {
    return [...content.matchAll(/([A-Za-z][A-Za-z0-9_-]{2,})\s*[:=]\s*(\S+)/g)]
      .some((match) => sensitiveArtifactKey(match[1] || ''));
  }
}

function jsonContainsSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(jsonContainsSecret);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
      (sensitiveArtifactKey(key) && typeof nested === 'string' && nested.trim().length > 0) ||
      jsonContainsSecret(nested)
    );
  }
  return typeof value === 'string' && artifactContainsSecret(value);
}

function sensitiveArtifactKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_').toLowerCase();
  return /(?:^|_)(?:password|passwd|private_key|api_key|api_secret|client_secret|access_token|refresh_token|invite|token|secret|authorization|cookie)$/.test(normalized);
}

function summarizePreflight(file: string | undefined): LiveKitEvidencePack['preflight'] | undefined {
  if (!file) return undefined;
  const parsed = readJson(file);
  if ('error' in parsed) return { pass: 0, warn: 0, fail: 0, error: parsed.error };
  const checks = Array.isArray(parsed.value.checks)
    ? parsed.value.checks as Array<{ id?: unknown; status?: unknown }>
    : [];
  const summary = objectValue(parsed.value.summary);
  const targets = Array.isArray(summary.targets) ? summary.targets.map(String) : [];
  const requiredIds = [
    ...CORE_PREFLIGHT_CHECKS,
    ...(summary.deploymentMode === 'standalone-vm' ? STANDALONE_PREFLIGHT_CHECKS : []),
    ...REQUIRED_READINESS_TARGETS.flatMap((target) => TARGET_PREFLIGHT_CHECKS[target] || [])
  ];
  const checkIds = checks.map((check) => String(check.id || ''));
  const invalid = parsed.value.schema_version !== 1 || parsed.value.ok !== true ||
    !isIsoTimestamp(parsed.value.checked_at) || checks.length === 0 ||
    REQUIRED_READINESS_TARGETS.some((target) => !targets.includes(target)) ||
    requiredIds.some((id) => !checkIds.includes(id)) || new Set(checkIds).size !== checkIds.length ||
    checks.some((check) => check.status !== 'pass' && check.status !== 'warn' && check.status !== 'fail') ||
    checks.some((check) => check.status === 'fail');
  return {
    ok: parsed.value.ok === true,
    pass: checks.filter((check) => check.status === 'pass').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length,
    ...(invalid ? { error: 'preflight schema, ok, timestamp, or checks are invalid' } : {})
  };
}

function summarizeServerEvidence(file: string | undefined): LiveKitEvidencePack['server_evidence'] | undefined {
  if (!file) return undefined;
  const parsed = readJson(file);
  if ('error' in parsed) return { failed_checks: [], missing_summary: [], error: parsed.error };
  const checks = Array.isArray(parsed.value.checks)
    ? parsed.value.checks as Array<{ id?: unknown; status?: unknown }>
    : [];
  const summary = objectValue(parsed.value.summary);
  const checkIds = checks.map((check) => String(check.id || ''));
  const missingChecks = REQUIRED_SERVER_CHECKS.filter((id) => !checkIds.includes(id));
  const invalid = parsed.value.schema_version !== 1 || parsed.value.ok !== true ||
    !isIsoTimestamp(parsed.value.checked_at) || checks.length === 0 || missingChecks.length > 0 ||
    checks.length !== REQUIRED_SERVER_CHECKS.length || new Set(checkIds).size !== checkIds.length ||
    checks.some((check) => check.status !== 'pass');
  return {
    ok: parsed.value.ok === true,
    failed_checks: checks.filter((check) => check.status === 'fail').map((check) => String(check.id || 'unnamed')),
    missing_summary: REQUIRED_SERVER_SUMMARY.filter((key) => summary[key] !== true),
    ...(invalid ? { error: `server evidence schema, ok, timestamp, or checks are invalid${missingChecks.length ? `; missing ${missingChecks.join(',')}` : ''}` } : {})
  };
}

function summarizeReadiness(file: string | undefined): LiveKitEvidencePack['readiness'] | undefined {
  if (!file) return undefined;
  const parsed = readJson(file);
  if ('error' in parsed) return { passed_targets: [], failed_targets: [], missing_targets: [...REQUIRED_READINESS_TARGETS], error: parsed.error };
  const steps = Array.isArray(parsed.value.steps)
    ? parsed.value.steps as Array<Record<string, unknown>>
    : [];
  const passed = [...new Set(steps.filter((step) => step.ok === true).map((step) => String(step.target || '')))].filter(Boolean);
  const failed = [...new Set(steps.filter((step) => step.ok !== true).map((step) => String(step.target || '')))].filter(Boolean);
  const invalid = parsed.value.schema_version !== 1 || parsed.value.ok !== true ||
    !isIsoTimestamp(parsed.value.checked_at) || steps.length === 0 || failed.length > 0 ||
    steps.some((step) => !validReadinessStep(step));
  return {
    ok: parsed.value.ok === true,
    passed_targets: passed,
    failed_targets: failed,
    missing_targets: REQUIRED_READINESS_TARGETS.filter((target) => !passed.includes(target)),
    ...(invalid ? { error: 'readiness schema, ok, timestamp, or steps are invalid' } : {})
  };
}

function validReadinessStep(step: Record<string, unknown>): boolean {
  return typeof step.target === 'string' && step.target.length > 0 &&
    typeof step.command === 'string' && step.command.length > 0 &&
    step.ok === true && step.exit_code === 0 &&
    Number.isFinite(step.duration_ms) && Number(step.duration_ms) >= 0 &&
    typeof step.stdout_present === 'boolean' && /^[a-f0-9]{64}$/.test(String(step.stdout_sha256 || '')) &&
    typeof step.stderr_present === 'boolean' && /^[a-f0-9]{64}$/.test(String(step.stderr_sha256 || '')) &&
    step.error_summary === '';
}

function summarizeClientAcceptance(config: LiveKitEvidencePackConfig): {
  result?: LiveKitClientAcceptanceResult;
  error?: string;
} {
  if (!config.artifacts.clientAcceptanceReportFile) return {};
  try {
    return {
      result: runLiveKitClientAcceptance({
        reportFile: config.artifacts.clientAcceptanceReportFile,
        ...(config.qaPublicKeyFile ? { qaPublicKeyFile: config.qaPublicKeyFile } : {}),
        ...(config.qaPublicKeyFingerprint ? { qaPublicKeyFingerprint: config.qaPublicKeyFingerprint } : {}),
        ...(config.artifacts.preflightReportFile ? { preflightReportFile: config.artifacts.preflightReportFile } : {}),
        ...(config.artifacts.serverEvidenceFile ? { serverEvidenceFile: config.artifacts.serverEvidenceFile } : {}),
        ...(config.artifacts.readinessReportFile ? { readinessReportFile: config.artifacts.readinessReportFile } : {})
      })
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function summarizeClientResult(
  file: string | undefined,
  validated: LiveKitClientAcceptanceResult | undefined
): LiveKitEvidencePack['client_result'] | undefined {
  if (!file) return undefined;
  const parsed = readJson(file);
  if ('error' in parsed) return { matches_report: false, error: parsed.error };
  const matches = Boolean(validated) && canonicalJson(parsed.value) === canonicalJson(validated);
  return {
    ok: parsed.value.schema_version === 1 && parsed.value.ok === true,
    matches_report: matches,
    ...(!matches || parsed.value.schema_version !== 1 || parsed.value.ok !== true
      ? { error: 'client result must exactly match the independently recomputed validator result' }
      : {})
  };
}

function summarizeAcceptanceMetadata(
  config: LiveKitEvidencePackConfig
): NonNullable<LiveKitEvidencePack['acceptance']> {
  const specs = [
    ['preflight', config.artifacts.preflightReportFile, true],
    ['server', config.artifacts.serverEvidenceFile, true],
    ['readiness', config.artifacts.readinessReportFile, true],
    ['client_report', config.artifacts.clientAcceptanceReportFile, false],
    ['client_result', config.artifacts.clientAcceptanceResultFile, false]
  ] as const;
  const metadata: LiveKitAcceptanceMetadata[] = [];
  const timestamps: number[] = [];
  const errors: string[] = [];
  for (const [label, file, nested] of specs) {
    if (!file) {
      errors.push(`${label} is not configured`);
      continue;
    }
    const parsed = readJson(file);
    if ('error' in parsed) {
      errors.push(`${label} is unreadable`);
      continue;
    }
    const candidate = nested ? parsed.value.acceptance : {
      run_id: parsed.value.run_id,
      environment_id: parsed.value.environment_id,
      deployed_commit: parsed.value.deployed_commit,
      deployment_fingerprint: parsed.value.deployment_fingerprint,
      started_at: parsed.value.run_started_at,
      deployment_mode: parsed.value.deployment_mode
    };
    if (!isLiveKitAcceptanceMetadata(candidate)) {
      errors.push(`${label} acceptance metadata is invalid`);
    } else {
      metadata.push(candidate);
    }
    const timestamp = Date.parse(String(parsed.value.checked_at || ''));
    if (!Number.isFinite(timestamp)) errors.push(`${label} checked_at is invalid`);
    else timestamps.push(timestamp);
  }
  const expected = metadata[0];
  if (!config.expectedAcceptance) errors.push('expected acceptance metadata is not configured');
  const consistent = Boolean(expected) && Boolean(config.expectedAcceptance) && metadata.length === specs.length &&
    metadata.every((candidate) => sameLiveKitAcceptanceMetadata(expected, candidate)) &&
    sameLiveKitAcceptanceMetadata(expected!, config.expectedAcceptance!);
  const start = config.expectedAcceptance ? Date.parse(config.expectedAcceptance.started_at) : Number.NaN;
  const now = Date.now();
  const timeWindowValid = Number.isFinite(start) && start <= now + 5 * 60 * 1000 &&
    now - start <= 24 * 60 * 60 * 1000 && timestamps.length === specs.length &&
    timestamps.every((timestamp) => timestamp >= start && timestamp <= start + 24 * 60 * 60 * 1000 && timestamp <= now + 5 * 60 * 1000);
  if (!deploymentModesMatch(config)) errors.push('deployment mode differs across expected, preflight, server, or client reports');
  return {
    ...(expected ? { metadata: expected } : {}),
    consistent,
    time_window_valid: timeWindowValid,
    ...(errors.length ? { error: errors.join('; ') } : {})
  };
}

function deploymentModesMatch(config: LiveKitEvidencePackConfig): boolean {
  if (!config.expectedDeploymentMode) return false;
  const sources = [
    [config.artifacts.preflightReportFile, (value: Record<string, unknown>) => objectValue(value.summary).deploymentMode],
    [config.artifacts.serverEvidenceFile, (value: Record<string, unknown>) => value.topology],
    [config.artifacts.clientAcceptanceReportFile, (value: Record<string, unknown>) => value.deployment_mode],
    [config.artifacts.clientAcceptanceResultFile, (value: Record<string, unknown>) => value.deployment_mode]
  ] as const;
  return sources.every(([file, select]) => {
    if (!file) return false;
    const parsed = readJson(file);
    return !('error' in parsed) && select(parsed.value) === config.expectedDeploymentMode;
  });
}

function readJson(file: string): { value: Record<string, unknown> } | { error: string } {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON root must be an object');
    return { value: parsed as Record<string, unknown> };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function isIsoTimestamp(value: unknown): boolean {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === normalized;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function table(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function optional(value: string | undefined): string | undefined {
  return String(value || '').trim() || undefined;
}

async function main(): Promise<void> {
  const result = writeLiveKitEvidencePack(createLiveKitEvidencePackConfigFromEnv(process.env));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
