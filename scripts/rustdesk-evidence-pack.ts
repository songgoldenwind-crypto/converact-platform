import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  runRustDeskClientAcceptance,
  type RustDeskClientAcceptanceResult
} from './rustdesk-client-acceptance.js';

export type RustDeskEvidenceArtifactStatus = 'present' | 'missing' | 'not_configured' | 'invalid';

export interface RustDeskEvidencePackConfig {
  outputFile?: string;
  title: string;
  artifacts: {
    deploymentCommandsFile?: string;
    envChecklistFile?: string;
    preflightReportFile?: string;
    serverEvidenceFile?: string;
    readinessReportFile?: string;
    handoffFile?: string;
    clientConfigPackFile?: string;
    clientAcceptanceReportFile?: string;
    clientAcceptanceAuditFile?: string;
    auditCoverageReportFile?: string;
    eventTemplateFile?: string;
    ledExampleOutputFile?: string;
  };
}

export interface RustDeskEvidenceArtifact {
  key: string;
  label: string;
  required: boolean;
  status: RustDeskEvidenceArtifactStatus;
  path?: string;
  size_bytes?: number;
  lines?: number;
  sha256?: string;
  error?: string;
}

export interface RustDeskEvidencePack {
  ok: boolean;
  title: string;
  status: 'ready_for_customer_review' | 'incomplete' | 'not_run';
  missing_required: string[];
  artifacts: RustDeskEvidenceArtifact[];
  preflight?: {
    ok?: boolean;
    pass: number;
    warn: number;
    fail: number;
    error?: string;
  };
  readiness?: {
    ok?: boolean;
    steps: string[];
    error?: string;
  };
  server_evidence?: {
    ok?: boolean;
    failed_checks: string[];
    summary: Record<string, boolean>;
    error?: string;
  };
  client_acceptance?: RustDeskClientAcceptanceResult;
  client_acceptance_error?: string;
  audit_coverage?: {
    ok?: boolean;
    required_event_types: number;
    observed_required_event_types: number;
    missing_event_types: string[];
    invalid_events: number;
    error?: string;
  };
}

export interface RustDeskEvidencePackWriteResult {
  outputFile: string;
  ok: boolean;
  missing_required: string[];
  artifacts: number;
}

interface ArtifactSpec {
  key: string;
  label: string;
  required: boolean;
  path?: string;
}

export function createRustDeskEvidencePackConfigFromEnv(env: NodeJS.ProcessEnv): RustDeskEvidencePackConfig {
  return {
    outputFile: optionalString(env.OPC_RUSTDESK_EVIDENCE_PACK_FILE),
    title: optionalString(env.OPC_RUSTDESK_EVIDENCE_TITLE) || 'RustDesk Evidence Pack',
    artifacts: {
      deploymentCommandsFile: optionalString(
        env.OPC_RUSTDESK_EVIDENCE_DEPLOYMENT_COMMANDS_FILE ||
        env.OPC_RUSTDESK_DEPLOYMENT_COMMANDS_FILE
      ),
      envChecklistFile: optionalString(
        env.OPC_RUSTDESK_EVIDENCE_ENV_CHECKLIST_FILE ||
        env.OPC_RUSTDESK_PREFLIGHT_ENV_CHECKLIST_FILE
      ),
      preflightReportFile: optionalString(
        env.OPC_RUSTDESK_EVIDENCE_PREFLIGHT_REPORT_FILE ||
        env.OPC_RUSTDESK_PREFLIGHT_REPORT_FILE
      ),
      serverEvidenceFile: optionalString(
        env.OPC_RUSTDESK_EVIDENCE_SERVER_EVIDENCE_FILE ||
        env.OPC_RUSTDESK_SERVER_EVIDENCE_FILE
      ),
      readinessReportFile: optionalString(
        env.OPC_RUSTDESK_EVIDENCE_READINESS_REPORT_FILE ||
        env.OPC_RUSTDESK_READINESS_REPORT_FILE
      ),
      handoffFile: optionalString(
        env.OPC_RUSTDESK_EVIDENCE_HANDOFF_FILE ||
        env.OPC_RUSTDESK_HANDOFF_FILE
      ),
      clientConfigPackFile: optionalString(
        env.OPC_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE ||
        env.OPC_RUSTDESK_CLIENT_CONFIG_PACK_FILE
      ),
      clientAcceptanceReportFile: optionalString(
        env.OPC_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_REPORT_FILE ||
        env.OPC_RUSTDESK_ACCEPTANCE_REPORT_FILE
      ),
      clientAcceptanceAuditFile: optionalString(
        env.OPC_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_AUDIT_FILE ||
        env.OPC_RUSTDESK_ACCEPTANCE_AUDIT_FILE
      ),
      auditCoverageReportFile: optionalString(
        env.OPC_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE ||
        env.OPC_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE
      ),
      eventTemplateFile: optionalString(
        env.OPC_RUSTDESK_EVIDENCE_EVENT_TEMPLATE_FILE ||
        env.OPC_RUSTDESK_EVENT_TEMPLATE_FILE
      ),
      ledExampleOutputFile: optionalString(env.OPC_RUSTDESK_EVIDENCE_LED_EXAMPLE_OUTPUT_FILE)
    }
  };
}

export function buildRustDeskEvidencePack(config: RustDeskEvidencePackConfig): RustDeskEvidencePack {
  const specs = artifactSpecs(config);
  const artifacts = specs.map(summarizeArtifact);
  const missingRequired = artifacts
    .filter((artifact) => artifact.required && artifact.status !== 'present')
    .map((artifact) => artifact.key);
  const preflight = summarizePreflight(config.artifacts.preflightReportFile);
  const serverEvidence = summarizeServerEvidence(config.artifacts.serverEvidenceFile);
  const readiness = summarizeReadiness(config.artifacts.readinessReportFile);
  const clientAcceptance = summarizeClientAcceptance(config);
  const clientAcceptanceResult = 'result' in clientAcceptance ? clientAcceptance.result : undefined;
  const clientAcceptanceError = 'error' in clientAcceptance ? clientAcceptance.error : undefined;
  const auditCoverage = summarizeAuditCoverage(config.artifacts.auditCoverageReportFile);

  if (preflight?.ok === false) missingRequired.push('preflight_report_failed');
  if (preflight?.error) missingRequired.push('preflight_report_invalid');
  if (serverEvidence?.ok === false) missingRequired.push('server_evidence_failed');
  if (serverEvidence?.error) missingRequired.push('server_evidence_invalid');
  if (readiness?.ok === false) missingRequired.push('readiness_report_failed');
  if (readiness?.error) missingRequired.push('readiness_report_invalid');
  if (clientAcceptanceResult && !clientAcceptanceResult.ok) missingRequired.push('client_acceptance_failed');
  if (clientAcceptanceError) missingRequired.push('client_acceptance_invalid');
  if (auditCoverage?.ok === false) missingRequired.push('audit_coverage_failed');
  if (auditCoverage?.error) missingRequired.push('audit_coverage_invalid');

  const uniqueMissing = [...new Set(missingRequired)];
  const ok = uniqueMissing.length === 0;
  const status = ok
    ? 'ready_for_customer_review'
    : !clientAcceptanceResult || clientAcceptanceResult.status === 'not_run'
      ? 'not_run'
      : 'incomplete';
  return {
    ok,
    title: config.title,
    status,
    missing_required: uniqueMissing,
    artifacts,
    ...(preflight ? { preflight } : {}),
    ...(serverEvidence ? { server_evidence: serverEvidence } : {}),
    ...(readiness ? { readiness } : {}),
    ...(clientAcceptanceResult ? { client_acceptance: clientAcceptanceResult } : {}),
    ...(clientAcceptanceError ? { client_acceptance_error: clientAcceptanceError } : {}),
    ...(auditCoverage ? { audit_coverage: auditCoverage } : {})
  };
}

export function renderRustDeskEvidencePack(pack: RustDeskEvidencePack): string {
  const lines = [
    `# ${pack.title}`,
    '',
    `Status: \`${pack.status}\``,
    '',
    'This pack summarizes evidence files only. It does not embed raw artifact contents or secret values.',
    ''
  ];

  if (pack.missing_required.length) {
    lines.push('## Missing Or Failed Required Evidence', '');
    for (const item of pack.missing_required) lines.push(`- \`${item}\``);
    lines.push('');
  }

  lines.push('## Artifacts', '');
  lines.push('| Key | Required | Status | Size | SHA256 | Path |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const artifact of pack.artifacts) {
    lines.push([
      artifact.key,
      artifact.required ? 'yes' : 'no',
      artifact.status,
      artifact.size_bytes === undefined ? '' : String(artifact.size_bytes),
      artifact.sha256 ? artifact.sha256.slice(0, 16) : '',
      artifact.path || ''
    ].map((value) => ` ${escapeTable(value)} `).join('|').replace(/^/, '|').replace(/$/, '|'));
  }
  lines.push('');

  if (pack.preflight) {
    lines.push('## Preflight', '');
    lines.push(`- preflight ok: \`${pack.preflight.ok === undefined ? 'unknown' : String(pack.preflight.ok)}\``);
    lines.push(`- checks: \`pass=${pack.preflight.pass} warn=${pack.preflight.warn} fail=${pack.preflight.fail}\``);
    if (pack.preflight.error) lines.push(`- error: \`${pack.preflight.error}\``);
    lines.push('');
  }

  if (pack.readiness) {
    lines.push('## Readiness', '');
    lines.push(`- readiness ok: \`${pack.readiness.ok === undefined ? 'unknown' : String(pack.readiness.ok)}\``);
    lines.push(`- steps: \`${pack.readiness.steps.join(', ') || 'none'}\``);
    if (pack.readiness.error) lines.push(`- error: \`${pack.readiness.error}\``);
    lines.push('');
  }

  if (pack.server_evidence) {
    lines.push('## Server Evidence', '');
    lines.push(`- server evidence: \`${pack.server_evidence.ok ? 'pass' : 'fail'}\``);
    lines.push(`- failed checks: \`${pack.server_evidence.failed_checks.join(', ') || 'none'}\``);
    if (pack.server_evidence.error) lines.push(`- error: \`${pack.server_evidence.error}\``);
    lines.push('');
  }

  if (pack.client_acceptance) {
    lines.push('## Client Acceptance', '');
    lines.push(`- client acceptance: \`${pack.client_acceptance.status}\``);
    lines.push(`- external_id: \`${pack.client_acceptance.external_id || 'missing'}\``);
    lines.push(`- rustdesk_id: \`${pack.client_acceptance.rustdesk_id || 'missing'}\``);
    lines.push(`- checks: \`passed=${pack.client_acceptance.summary.passed} failed=${pack.client_acceptance.summary.failed} missing=${pack.client_acceptance.summary.missing}\``);
    lines.push(`- observed audit events: \`${pack.client_acceptance.audit.observed_event_types.join(', ') || 'none'}\``);
    if (pack.client_acceptance.audit.missing_event_types.length) {
      lines.push(`- missing audit events: \`${pack.client_acceptance.audit.missing_event_types.join(', ')}\``);
    }
    lines.push('');
  } else if (pack.client_acceptance_error) {
    lines.push('## Client Acceptance', '', `- error: \`${pack.client_acceptance_error}\``, '');
  }

  if (pack.audit_coverage) {
    lines.push('## Audit Coverage', '');
    lines.push(`- audit coverage: \`${pack.audit_coverage.ok ? 'pass' : 'fail'}\``);
    lines.push(`- required event types: \`${pack.audit_coverage.observed_required_event_types}/${pack.audit_coverage.required_event_types}\``);
    lines.push(`- invalid events: \`${pack.audit_coverage.invalid_events}\``);
    if (pack.audit_coverage.missing_event_types.length) {
      lines.push(`- missing event types: \`${pack.audit_coverage.missing_event_types.join(', ')}\``);
    }
    if (pack.audit_coverage.error) lines.push(`- error: \`${pack.audit_coverage.error}\``);
    lines.push('');
  }

  lines.push('## Remaining Real-World Gate', '');
  lines.push('This pack is ready only when the included evidence was produced from a real RustDesk server and client session: hbbs/hbbr running, TCP/UDP/DNS/TLS/Ingress reachable, `id_ed25519.pub` readable by OPC, RustDesk client configured, screen view/control/file/clipboard/recording verified, revoke disconnect verified, old launch URL rejected, and operation audit events reviewed for customer-grade granularity.');
  lines.push('');
  return lines.join('\n');
}

export function writeRustDeskEvidencePack(config: RustDeskEvidencePackConfig): RustDeskEvidencePackWriteResult {
  if (!config.outputFile) throw new Error('OPC_RUSTDESK_EVIDENCE_PACK_FILE is required when writing an evidence pack');
  const pack = buildRustDeskEvidencePack(config);
  mkdirSync(dirname(config.outputFile), { recursive: true });
  writeFileSync(config.outputFile, renderRustDeskEvidencePack(pack), 'utf8');
  return {
    outputFile: config.outputFile,
    ok: pack.ok,
    missing_required: pack.missing_required,
    artifacts: pack.artifacts.length
  };
}

function artifactSpecs(config: RustDeskEvidencePackConfig): ArtifactSpec[] {
  return [
    spec('deployment_commands', 'Deployment command runbook', true, config.artifacts.deploymentCommandsFile),
    spec('env_checklist', 'Deployment env checklist', true, config.artifacts.envChecklistFile),
    spec('preflight_report', 'Deployment preflight JSON report', true, config.artifacts.preflightReportFile),
    spec('server_evidence', 'RustDesk server runtime evidence JSON report', true, config.artifacts.serverEvidenceFile),
    spec('readiness_report', 'RustDesk readiness JSON report', true, config.artifacts.readinessReportFile),
    spec('client_acceptance_report', 'Real client acceptance report', true, config.artifacts.clientAcceptanceReportFile),
    spec('audit_coverage_report', 'RustDesk audit coverage JSON report', true, config.artifacts.auditCoverageReportFile),
    spec('client_config_pack', 'RustDesk client install/config handoff pack', false, config.artifacts.clientConfigPackFile),
    spec('client_acceptance_audit', 'Real client audit export', false, config.artifacts.clientAcceptanceAuditFile),
    spec('handoff_pack', 'Handoff runbook', false, config.artifacts.handoffFile),
    spec('event_template', 'Operation event JSONL template', false, config.artifacts.eventTemplateFile),
    spec('led_example_output', 'LED example output', false, config.artifacts.ledExampleOutputFile)
  ];
}

function spec(key: string, label: string, required: boolean, path?: string): ArtifactSpec {
  return { key, label, required, path };
}

function summarizeArtifact(spec: ArtifactSpec): RustDeskEvidenceArtifact {
  if (!spec.path) {
    return {
      key: spec.key,
      label: spec.label,
      required: spec.required,
      status: 'not_configured'
    };
  }

  try {
    const content = readFileSync(spec.path, 'utf8');
    const stat = statSync(spec.path);
    return {
      key: spec.key,
      label: spec.label,
      required: spec.required,
      status: 'present',
      path: spec.path,
      size_bytes: stat.size,
      lines: content ? content.split(/\r?\n/).length - (content.endsWith('\n') ? 1 : 0) : 0,
      sha256: createHash('sha256').update(content).digest('hex')
    };
  } catch (error) {
    return {
      key: spec.key,
      label: spec.label,
      required: spec.required,
      status: 'missing',
      path: spec.path,
      error: (error as Error).message
    };
  }
}

function summarizeServerEvidence(file: string | undefined): RustDeskEvidencePack['server_evidence'] | undefined {
  if (!file) return undefined;
  const parsed = readJsonArtifact(file);
  if (parsed.ok === false) return { failed_checks: [], summary: {}, error: parsed.error };
  const value = parsed.value && typeof parsed.value === 'object'
    ? parsed.value as Record<string, unknown>
    : {};
  const checks = Array.isArray(value.checks)
    ? value.checks as Array<{ id?: unknown; status?: unknown }>
    : [];
  const summary = value.summary && typeof value.summary === 'object' && !Array.isArray(value.summary)
    ? Object.fromEntries(Object.entries(value.summary as Record<string, unknown>).map(([key, item]) => [key, Boolean(item)]))
    : {};
  return {
    ok: typeof value.ok === 'boolean' ? value.ok : undefined,
    failed_checks: checks
      .filter((check) => check.status === 'fail')
      .map((check) => String(check.id || 'unnamed')),
    summary
  };
}

function summarizePreflight(file: string | undefined): RustDeskEvidencePack['preflight'] | undefined {
  if (!file) return undefined;
  const parsed = readJsonArtifact(file);
  if (parsed.ok === false) return { pass: 0, warn: 0, fail: 0, error: parsed.error };
  const checks = Array.isArray((parsed.value as { checks?: unknown }).checks)
    ? (parsed.value as { checks: Array<{ status?: string }> }).checks
    : [];
  return {
    ok: typeof (parsed.value as { ok?: unknown }).ok === 'boolean' ? (parsed.value as { ok: boolean }).ok : undefined,
    pass: checks.filter((check) => check.status === 'pass').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length
  };
}

function summarizeReadiness(file: string | undefined): RustDeskEvidencePack['readiness'] | undefined {
  if (!file) return undefined;
  const parsed = readJsonArtifact(file);
  if (parsed.ok === false) return { steps: [], error: parsed.error };
  const steps = Array.isArray((parsed.value as { steps?: unknown }).steps)
    ? (parsed.value as { steps: Array<{ name?: string; status?: string }> }).steps
    : [];
  return {
    ok: typeof (parsed.value as { ok?: unknown }).ok === 'boolean' ? (parsed.value as { ok: boolean }).ok : undefined,
    steps: steps.map((step) => `${step.name || 'unnamed'}:${step.status || 'unknown'}`)
  };
}

function summarizeAuditCoverage(file: string | undefined): RustDeskEvidencePack['audit_coverage'] | undefined {
  if (!file) return undefined;
  const parsed = readJsonArtifact(file);
  if (parsed.ok === false) {
    return {
      required_event_types: 0,
      observed_required_event_types: 0,
      missing_event_types: [],
      invalid_events: 0,
      error: parsed.error
    };
  }
  const value = parsed.value && typeof parsed.value === 'object'
    ? parsed.value as Record<string, unknown>
    : {};
  const summary = value.summary && typeof value.summary === 'object'
    ? value.summary as Record<string, unknown>
    : {};
  const missingEventTypes = Array.isArray(value.missing_event_types)
    ? value.missing_event_types.map(String).filter(Boolean)
    : [];
  const invalidEvents = Array.isArray(value.invalid_events)
    ? value.invalid_events.length
    : numberValue(summary.invalid_events);

  return {
    ok: typeof value.ok === 'boolean' ? value.ok : undefined,
    required_event_types: numberValue(summary.required_event_types),
    observed_required_event_types: numberValue(summary.observed_required_event_types),
    missing_event_types: missingEventTypes,
    invalid_events: invalidEvents
  };
}

function summarizeClientAcceptance(
  config: RustDeskEvidencePackConfig
): { result: RustDeskClientAcceptanceResult } | { error: string } | Record<string, never> {
  const reportFile = config.artifacts.clientAcceptanceReportFile;
  if (!reportFile) return {};
  try {
    return {
      result: runRustDeskClientAcceptance({
        reportFile,
        auditFile: config.artifacts.clientAcceptanceAuditFile
      })
    };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

function numberValue(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : 0;
}

function readJsonArtifact(file: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    const content = readFileSync(file, 'utf8');
    return { ok: true, value: parsePossiblyWrappedJson(content) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

function parsePossiblyWrappedJson(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) throw new Error('artifact is empty');
  try {
    return JSON.parse(trimmed);
  } catch {
    const extracted = extractFirstJsonObject(trimmed);
    if (!extracted) throw new Error('artifact does not contain a JSON object');
    return JSON.parse(extracted);
  }
}

function extractFirstJsonObject(content: string): string {
  for (let start = 0; start < content.length; start += 1) {
    if (content[start] !== '{') continue;
    const candidate = extractBalancedObject(content, start);
    if (!candidate) continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return '';
}

function extractBalancedObject(content: string, start: number): string {
  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === '\\') {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return content.slice(start, index + 1);
    }
  }
  return '';
}

function escapeTable(value: string): string {
  return value.replaceAll('|', '\\|');
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim();
  return trimmed || undefined;
}

async function main(): Promise<void> {
  const config = createRustDeskEvidencePackConfigFromEnv(process.env);
  if (config.outputFile) {
    const result = writeRustDeskEvidencePack(config);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }

  const pack = buildRustDeskEvidencePack(config);
  console.log(renderRustDeskEvidencePack(pack));
  if (!pack.ok) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exit(1);
  });
}
