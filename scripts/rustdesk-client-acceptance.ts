import { resolveBrandEnv } from '../src/config/converact-env.js';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rustDeskGatewayEventValidationError } from '../src/agent-runtime/collaboration/rustdesk-gateway-event.js';

export interface RustDeskClientAcceptanceConfig {
  reportFile: string;
  auditFile?: string;
  outputFile?: string;
}

export interface RustDeskClientAcceptanceTemplateConfig {
  templateFile: string;
  externalId: string;
  rustdeskId: string;
  operator: string;
  checkedAt: string;
}

export interface RustDeskClientAcceptanceRunbookConfig {
  outputFile: string;
  externalId: string;
  rustdeskId: string;
  operator: string;
  checkedAt: string;
}

export interface RustDeskClientAcceptanceRunbookWriteResult {
  outputFile: string;
  sections: string[];
}

export interface RustDeskClientAcceptanceFailure {
  id: string;
  reason: string;
}

export interface RustDeskAcceptanceCheckTemplate {
  passed: boolean;
  evidence: {
    artifact_file: string;
    sha256: string;
    captured_at: string;
    tool: string;
    run_id: string;
  };
}

export interface RustDeskPhysicalDisconnectAcceptance {
  control_plane_ended: boolean;
  command_id: string;
  device_id: string;
  command_status: string;
  execution_method: string;
  operator_observed_disconnect: boolean;
}

export interface RustDeskClientAcceptanceTemplate {
  schema_version: 2;
  source: 'real_terminal';
  status: 'incomplete';
  run_id: string;
  environment_id: string;
  deployed_commit: string;
  external_id: string;
  rustdesk_id: string;
  operator: string;
  qa_approver: string;
  checked_at: string;
  runtime: Record<string, unknown>;
  physical_disconnect: RustDeskPhysicalDisconnectAcceptance;
  checks: {
    server: {
      hbbs_started: RustDeskAcceptanceCheckTemplate;
      hbbr_started: RustDeskAcceptanceCheckTemplate;
      public_key_readable: RustDeskAcceptanceCheckTemplate;
      tcp_ports_reachable: RustDeskAcceptanceCheckTemplate;
      udp_relay_reachable: RustDeskAcceptanceCheckTemplate;
      dns_tls_ingress_ok: RustDeskAcceptanceCheckTemplate;
    };
    client: {
      installed: RustDeskAcceptanceCheckTemplate;
      manual_fields_match: RustDeskAcceptanceCheckTemplate;
      launch_page_opens: RustDeskAcceptanceCheckTemplate;
      protocol_or_manual_launch_works: RustDeskAcceptanceCheckTemplate;
      target_id_matches: RustDeskAcceptanceCheckTemplate;
      relay_connection_ok: RustDeskAcceptanceCheckTemplate;
    };
    operations: {
      screen_view: RustDeskAcceptanceCheckTemplate;
      keyboard_mouse_control: RustDeskAcceptanceCheckTemplate;
      multi_display: RustDeskAcceptanceCheckTemplate;
      file_transfer: RustDeskAcceptanceCheckTemplate;
      clipboard_sync: RustDeskAcceptanceCheckTemplate;
      recording: RustDeskAcceptanceCheckTemplate;
    };
    resilience: {
      reconnect: RustDeskAcceptanceCheckTemplate;
    };
    revoke: {
      authorization_revoke_disconnects: RustDeskAcceptanceCheckTemplate;
      physical_disconnect: RustDeskAcceptanceCheckTemplate;
      ended_launch_url_rejected: RustDeskAcceptanceCheckTemplate;
    };
    audit: {
      operation_events_forwarded: RustDeskAcceptanceCheckTemplate;
      audit_timeline_visible: RustDeskAcceptanceCheckTemplate;
    };
  };
  audit_events: AcceptanceAuditEvent[];
}

export interface RustDeskClientAcceptanceResult {
  ok: boolean;
  status: 'ready_for_review' | 'incomplete' | 'not_run';
  run_id: string;
  environment_id: string;
  deployed_commit: string;
  external_id: string;
  rustdesk_id: string;
  summary: {
    passed: number;
    failed: number;
    missing: number;
  };
  failures: RustDeskClientAcceptanceFailure[];
  physical_disconnect: RustDeskPhysicalDisconnectAcceptance;
  audit: {
    required_event_types: string[];
    observed_event_types: string[];
    missing_event_types: string[];
    invalid_events: Array<{
      event_type: string;
      reason: string;
    }>;
  };
}

export interface RustDeskClientAcceptanceNotRunResult {
  ok: false;
  status: 'not_run';
  missing_environment: ['CONVERACT_RUSTDESK_ACCEPTANCE_REPORT_FILE'];
}

const CLIENT_ACCEPTANCE_RUNBOOK_SECTIONS = [
  'server-precheck',
  'client-setup',
  'launch',
  'operations',
  'revoke',
  'audit-and-evidence'
];

interface AcceptanceReport {
  schema_version?: unknown;
  source?: unknown;
  status?: unknown;
  run_id?: string;
  environment_id?: string;
  deployed_commit?: string;
  external_id?: string;
  rustdesk_id?: string;
  operator?: string;
  qa_approver?: string;
  checked_at?: string;
  runtime?: unknown;
  physical_disconnect?: unknown;
  checks?: Record<string, unknown>;
  audit_events?: unknown;
}

interface AcceptanceAuditEvent {
  external_id?: string;
  event_type: string;
  metadata?: Record<string, unknown>;
}

const REQUIRED_CHECKS = [
  'server.hbbs_started',
  'server.hbbr_started',
  'server.public_key_readable',
  'server.tcp_ports_reachable',
  'server.udp_relay_reachable',
  'server.dns_tls_ingress_ok',
  'client.installed',
  'client.manual_fields_match',
  'client.launch_page_opens',
  'client.protocol_or_manual_launch_works',
  'client.target_id_matches',
  'client.relay_connection_ok',
  'operations.screen_view',
  'operations.keyboard_mouse_control',
  'operations.multi_display',
  'operations.file_transfer',
  'operations.clipboard_sync',
  'operations.recording',
  'resilience.reconnect',
  'revoke.authorization_revoke_disconnects',
  'revoke.physical_disconnect',
  'revoke.ended_launch_url_rejected',
  'audit.operation_events_forwarded',
  'audit.audit_timeline_visible'
] as const;

const CHECK_OBSERVATION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'operations.screen_view': ['target_display_id', 'frame_change_observed'],
  'operations.keyboard_mouse_control': ['action', 'target_effect_observed'],
  'operations.multi_display': ['display_count', 'selected_display_id', 'switch_observed'],
  'operations.file_transfer': ['direction', 'byte_count', 'checksum_sha256'],
  'operations.clipboard_sync': ['direction', 'target_effect_observed'],
  'operations.recording': ['recording_id', 'duration_ms', 'playback_verified', 'checksum_sha256'],
  'resilience.reconnect': ['disconnected_at', 'reconnected_at', 'target_restored'],
  'revoke.authorization_revoke_disconnects': ['revoked_at', 'screen_stopped', 'control_stopped'],
  'revoke.physical_disconnect': ['observed_at', 'screen_stopped', 'control_stopped', 'command_id'],
  'revoke.ended_launch_url_rejected': ['request_at', 'http_status'],
  'audit.operation_events_forwarded': ['external_id', 'observed_operations'],
  'audit.audit_timeline_visible': ['external_id', 'event_count']
};

const FORBIDDEN_EVIDENCE_SOURCE = /(controlled|playwright|mock|synthetic|test-results|\/e2e\/)/i;

const REQUIRED_AUDIT_EVENT_TYPES = [
  'remote.rustdesk.control_action.performed',
  'remote.rustdesk.file_transfer.started',
  'remote.rustdesk.file_transfer.completed',
  'remote.rustdesk.recording.started',
  'remote.rustdesk.recording.stopped',
  'remote.rustdesk.clipboard.synced',
  'remote.gateway_session.ended',
  'remote.rustdesk.disconnect.requested',
  'remote.rustdesk.disconnect.claimed',
  'remote.rustdesk.disconnect.succeeded'
] as const;

export function createRustDeskClientAcceptanceConfigFromEnv(env: NodeJS.ProcessEnv): RustDeskClientAcceptanceConfig {
  const reportFile = String(resolveBrandEnv(env, 'RUSTDESK_ACCEPTANCE_REPORT_FILE') || '').trim();
  const auditFile = String(resolveBrandEnv(env, 'RUSTDESK_ACCEPTANCE_AUDIT_FILE') || '').trim();
  const outputFile = String(resolveBrandEnv(env, 'RUSTDESK_ACCEPTANCE_OUTPUT_FILE') || '').trim();
  if (!reportFile) throw new Error('CONVERACT_RUSTDESK_ACCEPTANCE_REPORT_FILE is required');
  return {
    reportFile,
    ...(auditFile ? { auditFile } : {}),
    ...(outputFile ? { outputFile } : {})
  };
}

export function createRustDeskClientAcceptanceTemplateConfigFromEnv(
  env: NodeJS.ProcessEnv
): RustDeskClientAcceptanceTemplateConfig {
  const templateFile = String(resolveBrandEnv(env, 'RUSTDESK_ACCEPTANCE_TEMPLATE_FILE') || '').trim();
  if (!templateFile) throw new Error('CONVERACT_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE is required');
  return {
    templateFile,
    externalId: String(resolveBrandEnv(env, 'RUSTDESK_ACCEPTANCE_EXTERNAL_ID') || 'replace-with-rustdesk-gateway-external-id').trim(),
    rustdeskId: String(resolveBrandEnv(env, 'RUSTDESK_ACCEPTANCE_RUSTDESK_ID') || 'replace-with-rustdesk-runtime-id').trim(),
    operator: String(resolveBrandEnv(env, 'RUSTDESK_ACCEPTANCE_OPERATOR') || 'replace-with-operator-identity').trim(),
    checkedAt: String(resolveBrandEnv(env, 'RUSTDESK_ACCEPTANCE_CHECKED_AT') || new Date().toISOString()).trim()
  };
}

export function createRustDeskClientAcceptanceRunbookConfigFromEnv(
  env: NodeJS.ProcessEnv
): RustDeskClientAcceptanceRunbookConfig {
  const outputFile = String(resolveBrandEnv(env, 'RUSTDESK_ACCEPTANCE_RUNBOOK_FILE') || '').trim();
  if (!outputFile) throw new Error('CONVERACT_RUSTDESK_ACCEPTANCE_RUNBOOK_FILE is required');
  return {
    outputFile,
    externalId: String(resolveBrandEnv(env, 'RUSTDESK_ACCEPTANCE_EXTERNAL_ID') || 'replace-with-rustdesk-gateway-external-id').trim(),
    rustdeskId: String(resolveBrandEnv(env, 'RUSTDESK_ACCEPTANCE_RUSTDESK_ID') || 'replace-with-rustdesk-runtime-id').trim(),
    operator: String(resolveBrandEnv(env, 'RUSTDESK_ACCEPTANCE_OPERATOR') || 'replace-with-operator-identity').trim(),
    checkedAt: String(resolveBrandEnv(env, 'RUSTDESK_ACCEPTANCE_CHECKED_AT') || new Date().toISOString()).trim()
  };
}

export function writeRustDeskClientAcceptanceTemplate(
  config: RustDeskClientAcceptanceTemplateConfig
): RustDeskClientAcceptanceTemplate {
  const template = createRustDeskClientAcceptanceTemplate(config);
  writeFileSync(config.templateFile, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
  return template;
}

export function renderRustDeskClientAcceptanceRunbook(config: RustDeskClientAcceptanceRunbookConfig): string {
  return [
    '# RustDesk Real Client Acceptance Runbook',
    '',
    `- external_id: \`${config.externalId}\``,
    `- rustdesk_id: \`${config.rustdeskId}\``,
    `- operator: \`${config.operator}\``,
    `- checked_at: \`${config.checkedAt}\``,
    '',
    'This runbook is for the real server and client environment. Do not mark customer acceptance complete from this file alone.',
    '',
    '## Server Precheck',
    '',
    '1. Start hbbs and hbbr in the target environment.',
    '2. Confirm `id_ed25519.pub` exists and Converact can read the same public key through `CONVERACT_RUSTDESK_PUBLIC_KEY_FILE` or `CONVERACT_RUSTDESK_PUBLIC_KEY`.',
    '3. Confirm TCP 21115/21116/21117/21118/21119 and UDP 21116 are reachable from the smoke host.',
    '4. Run `CONVERACT_RUSTDESK_READINESS_REPORT_FILE=<bundle>/readiness.json npm run rustdesk:readiness`.',
    '',
    '## Client Setup',
    '',
    '1. Install the RustDesk client on the agent machine and the target machine.',
    '2. Open `/api/ivekit/rustdesk/client-config` or the launch plan and copy the manual fields exactly.',
    '3. Fill the RustDesk client ID server, relay server, API server when present, and key. These manual fields must match Converact client-config.',
    '4. Verify the displayed target RustDesk ID equals the launch plan `runtime.rustdesk_id`.',
    '',
    '## Launch',
    '',
    '1. Open the public launch page for the current signed gateway session.',
    '2. Use the protocol URL when the browser/client supports it, otherwise manually launch RustDesk with the configured target ID.',
    '3. Confirm the connection reaches the expected target and uses the expected self-hosted relay/server path.',
    '',
    '## Operations',
    '',
    'Record evidence for every item below before editing `client-acceptance-template.json`:',
    '',
    '- screen view: agent can see the target screen.',
    '- keyboard/mouse: agent can click or type on the target device.',
    '- multi-display: enumerate displays, switch display, and confirm the selected display changes.',
    '- file transfer: upload or download succeeds; record byte count and SHA-256, never file content.',
    '- clipboard: clipboard sync works in the expected direction.',
    '- recording: recording starts, stops, is stored, and is playable.',
    '- reconnect: interrupt the real network path, reconnect, and confirm the same target is restored.',
    '',
    '## Revoke',
    '',
    '1. Trigger authorization revoke or end the RustDesk gateway session.',
    '2. Query the disconnect state for this `external_id` and confirm disconnect command status is `succeeded` with an execution method.',
    '3. Have the operator confirm that screen/control access stopped; automated readiness is not evidence of this observation.',
    '4. Confirm the old signed launch URL returns 409 after the session is ended.',
    '',
    '## Audit And Evidence',
    '',
    '1. Export the RustDesk/Converact audit timeline for this `external_id`.',
    '2. Confirm audit contains control action, file transfer started/completed, recording started/stopped, clipboard synced, gateway ended, and disconnect requested/claimed/succeeded events.',
    '3. Save one unique structured JSON observation per check. Bind every file to the same run_id, environment_id, deployed_commit, external_id and rustdesk_id, then record its SHA-256 in the report.',
    '4. Do not use controlled E2E, Playwright, mock or synthetic artifacts as real-terminal evidence. The validator rejects those sources.',
    '5. Run `CONVERACT_RUSTDESK_ACCEPTANCE_REPORT_FILE=<bundle>/client-acceptance-template.json CONVERACT_RUSTDESK_ACCEPTANCE_AUDIT_FILE=<bundle>/audit-export.jsonl npm run rustdesk:client-acceptance`.',
    '6. Run `CONVERACT_RUSTDESK_AUDIT_COVERAGE_FILE=<bundle>/audit-export.jsonl CONVERACT_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE=<bundle>/audit-coverage.json npm run rustdesk:audit-coverage`.',
    '7. Run `CONVERACT_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE=<bundle>/audit-coverage.json npm run rustdesk:evidence-pack` and require `ready_for_customer_review` before customer handoff.',
    ''
  ].join('\n');
}

export function writeRustDeskClientAcceptanceRunbook(
  config: RustDeskClientAcceptanceRunbookConfig
): RustDeskClientAcceptanceRunbookWriteResult {
  writeFileSync(config.outputFile, renderRustDeskClientAcceptanceRunbook(config), 'utf8');
  return {
    outputFile: config.outputFile,
    sections: [...CLIENT_ACCEPTANCE_RUNBOOK_SECTIONS]
  };
}

export function runRustDeskClientAcceptance(
  config: RustDeskClientAcceptanceConfig
): RustDeskClientAcceptanceResult {
  const reportFile = resolve(config.reportFile);
  if (config.outputFile && resolve(config.outputFile) === reportFile) {
    throw new Error('acceptance report and output files must differ');
  }
  const report = readJsonFile<AcceptanceReport>(reportFile);
  const externalId = String(report.external_id || '').trim();
  const rustdeskId = String(report.rustdesk_id || '').trim();
  const runId = String(report.run_id || '').trim();
  const environmentId = String(report.environment_id || '').trim();
  const deployedCommit = String(report.deployed_commit || '').trim();
  const checkedAt = String(report.checked_at || '').trim();
  const failures: RustDeskClientAcceptanceFailure[] = [];
  let passed = 0;
  let missing = 0;

  if (report.schema_version !== 2) failures.push({ id: 'report.schema_version', reason: 'schema_version must equal 2' });
  if (report.source !== 'real_terminal') failures.push({ id: 'report.source', reason: 'source must equal real_terminal' });
  if (report.status !== 'completed') failures.push({ id: 'report.status', reason: 'status must equal completed' });
  for (const field of ['run_id', 'environment_id', 'external_id', 'rustdesk_id', 'operator', 'qa_approver', 'checked_at']) {
    if (!String((report as Record<string, unknown>)[field] || '').trim()) {
      failures.push({ id: `report.${field}`, reason: `${field} is required` });
      missing += 1;
    }
  }
  if (!/^[a-f0-9]{40}$/i.test(deployedCommit)) failures.push({ id: 'report.deployed_commit', reason: 'deployed_commit must be a full Git SHA' });
  if (!validIso(checkedAt)) failures.push({ id: 'report.checked_at', reason: 'checked_at must be an ISO timestamp' });
  if (String(report.operator || '').trim().toLowerCase() === String(report.qa_approver || '').trim().toLowerCase()) {
    failures.push({ id: 'report.qa_approver', reason: 'QA approver must differ from operator' });
  }
  validateRuntime(report.runtime, rustdeskId, failures);
  if (containsSecret(report)) failures.push({ id: 'report.secrets', reason: 'report must not contain credentials, signed URLs, clipboard/file contents, or private keys' });

  const usedArtifacts = new Set<string>();
  const usedHashes = new Set<string>();
  const observationDetails = new Map<string, Record<string, unknown>>();
  for (const checkId of REQUIRED_CHECKS) {
    const outcome = normalizeCheckOutcome(readCheck(report.checks || {}, checkId));
    if (!outcome.exists) {
      failures.push({ id: checkId, reason: 'check is missing' });
      missing += 1;
      continue;
    }
    if (!outcome.passed) {
      failures.push({ id: checkId, reason: 'check did not pass' });
      continue;
    }
    const before = failures.length;
    const hash = validateObservationEvidence(checkId, outcome.evidence, {
      reportFile, runId, environmentId, deployedCommit, externalId, rustdeskId, checkedAt
    }, usedArtifacts, failures, observationDetails);
    if (hash && usedHashes.has(hash)) failures.push({ id: checkId, reason: 'every check requires a distinct observation artifact' });
    if (hash) usedHashes.add(hash);
    if (failures.length === before) passed += 1;
  }

  const physicalDisconnect = validatePhysicalDisconnect(
    report.physical_disconnect,
    failures
  );
  passed += physicalDisconnect.passed;
  missing += physicalDisconnect.missing;
  const disconnectObservation = observationDetails.get('revoke.physical_disconnect');
  if (disconnectObservation && String(disconnectObservation.command_id || '') !== physicalDisconnect.value.command_id) {
    failures.push({ id: 'revoke.physical_disconnect', reason: 'observation command_id must match physical disconnect command lifecycle' });
  }

  const auditEvents = loadAuditEvents(report, config.auditFile);
  const invalidEvents = validateAuditEvents(auditEvents, externalId);
  const observedEventTypes = [...new Set(
    auditEvents
      .filter((event) => eventBelongsToSession(event, externalId))
      .map((event) => event.event_type)
      .filter(Boolean)
  )].sort();
  const missingEventTypes = REQUIRED_AUDIT_EVENT_TYPES.filter(
    (eventType) => !observedEventTypes.includes(eventType)
  );

  const reportWasRun = report.source === 'real_terminal' && report.status === 'completed';
  const result: RustDeskClientAcceptanceResult = {
    ok: failures.length === 0 && missingEventTypes.length === 0 && invalidEvents.length === 0,
    status: !reportWasRun
      ? 'not_run'
      : failures.length === 0 && missingEventTypes.length === 0 && invalidEvents.length === 0
        ? 'ready_for_review'
        : 'incomplete',
    run_id: runId,
    environment_id: environmentId,
    deployed_commit: deployedCommit,
    external_id: externalId,
    rustdesk_id: rustdeskId,
    summary: {
      passed,
      failed: failures.length,
      missing
    },
    failures,
    physical_disconnect: physicalDisconnect.value,
    audit: {
      required_event_types: [...REQUIRED_AUDIT_EVENT_TYPES],
      observed_event_types: observedEventTypes,
      missing_event_types: missingEventTypes,
      invalid_events: invalidEvents
    }
  };

  if (config.outputFile) {
    writeFileSync(config.outputFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  return result;
}

export function runRustDeskClientAcceptanceFromEnv(
  env: NodeJS.ProcessEnv
): RustDeskClientAcceptanceResult | RustDeskClientAcceptanceNotRunResult {
  const reportFile = String(resolveBrandEnv(env, 'RUSTDESK_ACCEPTANCE_REPORT_FILE') || '').trim();
  if (!reportFile) {
    return { ok: false, status: 'not_run', missing_environment: ['CONVERACT_RUSTDESK_ACCEPTANCE_REPORT_FILE'] };
  }
  return runRustDeskClientAcceptance({
    reportFile,
    auditFile: String(resolveBrandEnv(env, 'RUSTDESK_ACCEPTANCE_AUDIT_FILE') || '').trim() || undefined,
    outputFile: String(resolveBrandEnv(env, 'RUSTDESK_ACCEPTANCE_OUTPUT_FILE') || '').trim() || undefined
  });
}

function createRustDeskClientAcceptanceTemplate(
  config: RustDeskClientAcceptanceTemplateConfig
): RustDeskClientAcceptanceTemplate {
  const externalId = config.externalId;
  const rustdeskId = config.rustdeskId;
  return {
    schema_version: 2,
    source: 'real_terminal',
    status: 'incomplete',
    run_id: 'replace-with-run-id',
    environment_id: 'replace-with-environment-id',
    deployed_commit: 'replace-with-40-character-git-sha',
    external_id: externalId,
    rustdesk_id: rustdeskId,
    operator: config.operator,
    qa_approver: 'replace-with-distinct-qa-identity',
    checked_at: config.checkedAt,
    runtime: {
      server: {
        hbbs_version: 'replace-with-hbbs-version',
        hbbr_version: 'replace-with-hbbr-version',
        key_fingerprint: 'sha256:replace-with-fingerprint',
        id_server: 'replace-with-id-server',
        relay_server: 'replace-with-relay-server'
      },
      agent: { platform: 'replace-with-platform', architecture: 'replace-with-architecture', client_version: 'replace-with-version' },
      target: { platform: 'replace-with-platform', architecture: 'replace-with-architecture', client_version: 'replace-with-version', rustdesk_id: rustdeskId }
    },
    physical_disconnect: {
      control_plane_ended: false,
      command_id: '',
      device_id: '',
      command_status: '',
      execution_method: '',
      operator_observed_disconnect: false
    },
    checks: {
      server: {
        hbbs_started: templateCheck('server.hbbs_started'),
        hbbr_started: templateCheck('server.hbbr_started'),
        public_key_readable: templateCheck('server.public_key_readable'),
        tcp_ports_reachable: templateCheck('server.tcp_ports_reachable'),
        udp_relay_reachable: templateCheck('server.udp_relay_reachable'),
        dns_tls_ingress_ok: templateCheck('server.dns_tls_ingress_ok')
      },
      client: {
        installed: templateCheck('client.installed'),
        manual_fields_match: templateCheck('client.manual_fields_match'),
        launch_page_opens: templateCheck('client.launch_page_opens'),
        protocol_or_manual_launch_works: templateCheck('client.protocol_or_manual_launch_works'),
        target_id_matches: templateCheck('client.target_id_matches'),
        relay_connection_ok: templateCheck('client.relay_connection_ok')
      },
      operations: {
        screen_view: templateCheck('operations.screen_view'),
        keyboard_mouse_control: templateCheck('operations.keyboard_mouse_control'),
        multi_display: templateCheck('operations.multi_display'),
        file_transfer: templateCheck('operations.file_transfer'),
        clipboard_sync: templateCheck('operations.clipboard_sync'),
        recording: templateCheck('operations.recording')
      },
      resilience: {
        reconnect: templateCheck('resilience.reconnect')
      },
      revoke: {
        authorization_revoke_disconnects: templateCheck('revoke.authorization_revoke_disconnects'),
        physical_disconnect: templateCheck('revoke.physical_disconnect'),
        ended_launch_url_rejected: templateCheck('revoke.ended_launch_url_rejected')
      },
      audit: {
        operation_events_forwarded: templateCheck('audit.operation_events_forwarded'),
        audit_timeline_visible: templateCheck('audit.audit_timeline_visible')
      }
    },
    audit_events: templateAuditEvents(externalId, rustdeskId, config.operator, config.checkedAt)
  };
}

function templateCheck(checkId: string): RustDeskAcceptanceCheckTemplate {
  return {
    passed: false,
    evidence: {
      artifact_file: `observations/${checkId.replaceAll('.', '-')}.json`,
      sha256: 'replace-with-sha256',
      captured_at: '',
      tool: 'replace-with-real-terminal-capture-tool',
      run_id: 'replace-with-run-id'
    }
  };
}

function templateAuditEvents(
  externalId: string,
  rustdeskId: string,
  operator: string,
  occurredAt: string
): AcceptanceAuditEvent[] {
  const base = {
    external_id: externalId,
    actor_identity: operator,
    target: rustdeskId,
    occurred_at: occurredAt
  };
  return [
    {
      ...base,
      event_type: 'remote.rustdesk.control_action.performed',
      metadata: {
        operation_id: 'replace-with-operation-id',
        action: 'replace-with-control-action',
        permission: 'control_mouse_keyboard'
      }
    },
    {
      ...base,
      event_type: 'remote.rustdesk.file_transfer.started',
      metadata: {
        transfer_id: 'replace-with-transfer-id',
        direction: 'upload'
      }
    },
    {
      ...base,
      event_type: 'remote.rustdesk.file_transfer.completed',
      metadata: {
        transfer_id: 'replace-with-transfer-id',
        direction: 'upload'
      }
    },
    {
      ...base,
      event_type: 'remote.rustdesk.recording.started',
      metadata: {
        recording_id: 'replace-with-recording-id',
        evidence_type: 'screen_recording'
      }
    },
    {
      ...base,
      event_type: 'remote.rustdesk.recording.stopped',
      metadata: {
        recording_id: 'replace-with-recording-id',
        evidence_type: 'screen_recording'
      }
    },
    {
      ...base,
      event_type: 'remote.rustdesk.clipboard.synced',
      metadata: {
        clipboard_id: 'replace-with-clipboard-id',
        direction: 'agent_to_device'
      }
    },
    {
      ...base,
      event_type: 'remote.gateway_session.ended',
      metadata: {}
    },
    {
      ...base,
      event_type: 'remote.rustdesk.disconnect.requested',
      metadata: {
        command_id: 'replace-with-command-id',
        device_id: 'replace-with-device-id',
        attempt: 0
      }
    },
    {
      ...base,
      event_type: 'remote.rustdesk.disconnect.claimed',
      metadata: {
        command_id: 'replace-with-command-id',
        device_id: 'replace-with-device-id',
        attempt: 1,
        edge_instance_id: 'replace-with-edge-instance-id'
      }
    },
    {
      ...base,
      event_type: 'remote.rustdesk.disconnect.succeeded',
      metadata: {
        command_id: 'replace-with-command-id',
        device_id: 'replace-with-device-id',
        attempt: 1,
        execution_method: 'session_adapter',
        edge_instance_id: 'replace-with-edge-instance-id'
      }
    }
  ];
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T;
}

function readCheck(checks: Record<string, unknown>, checkId: string): unknown {
  let current: unknown = checks;
  for (const part of checkId.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function normalizeCheckOutcome(value: unknown): { exists: boolean; passed: boolean; evidence: unknown } {
  if (value === undefined || value === null) return { exists: false, passed: false, evidence: undefined };
  if (typeof value === 'boolean') return { exists: true, passed: value, evidence: undefined };
  if (typeof value !== 'object' || Array.isArray(value)) return { exists: true, passed: false, evidence: undefined };
  const record = value as Record<string, unknown>;
  return {
    exists: true,
    passed: record.passed === true,
    evidence: record.evidence
  };
}

interface ObservationContext {
  reportFile: string;
  runId: string;
  environmentId: string;
  deployedCommit: string;
  externalId: string;
  rustdeskId: string;
  checkedAt: string;
}

function validateObservationEvidence(
  checkId: string,
  input: unknown,
  context: ObservationContext,
  usedArtifacts: Set<string>,
  failures: RustDeskClientAcceptanceFailure[],
  observations: Map<string, Record<string, unknown>>
): string {
  const evidence = objectValue(input);
  const relative = String(evidence.artifact_file || '').trim();
  if (!relative || !relative.endsWith('.json') || relative.startsWith('/') || relative.includes('..') || FORBIDDEN_EVIDENCE_SOURCE.test(relative)) {
    failures.push({ id: checkId, reason: 'artifact_file must be a non-controlled relative JSON path' });
    return '';
  }
  const reportDirectory = realpathSync(dirname(context.reportFile));
  const candidate = resolve(reportDirectory, relative);
  if (!candidate.startsWith(`${reportDirectory}${sep}`) || !existsSync(candidate)) {
    failures.push({ id: checkId, reason: 'observation artifact is missing or outside the report directory' });
    return '';
  }
  if (lstatSync(candidate).isSymbolicLink()) {
    failures.push({ id: checkId, reason: 'observation artifact must not be a symbolic link' });
    return '';
  }
  const artifact = realpathSync(candidate);
  if (!artifact.startsWith(`${reportDirectory}${sep}`) || usedArtifacts.has(artifact)) {
    failures.push({ id: checkId, reason: 'every check requires one unique in-directory artifact' });
    return '';
  }
  usedArtifacts.add(artifact);
  const content = readFileSync(artifact);
  const actualHash = createHash('sha256').update(content).digest('hex');
  if (String(evidence.sha256 || '').toLowerCase() !== actualHash) {
    failures.push({ id: checkId, reason: 'observation artifact SHA-256 does not match' });
    return '';
  }
  const capturedAt = String(evidence.captured_at || '');
  const tool = String(evidence.tool || '').trim();
  if (!validIso(capturedAt) || !tool || FORBIDDEN_EVIDENCE_SOURCE.test(tool) || String(evidence.run_id || '') !== context.runId) {
    failures.push({ id: checkId, reason: 'evidence captured_at, real capture tool, and run_id are required' });
    return '';
  }
  if (validIso(context.checkedAt)) {
    const delta = Date.parse(context.checkedAt) - Date.parse(capturedAt);
    if (delta < -5 * 60_000 || delta > 24 * 60 * 60_000) {
      failures.push({ id: checkId, reason: 'observation is outside the 24-hour acceptance window' });
      return '';
    }
  }
  let document: Record<string, unknown>;
  try {
    document = objectValue(JSON.parse(content.toString('utf8')));
  } catch {
    failures.push({ id: checkId, reason: 'observation artifact must contain valid JSON' });
    return '';
  }
  if (
    document.schema_version !== 1 || document.source !== 'real_terminal' ||
    String(document.check_id || '') !== checkId || String(document.run_id || '') !== context.runId ||
    String(document.environment_id || '') !== context.environmentId ||
    String(document.deployed_commit || '').toLowerCase() !== context.deployedCommit.toLowerCase() ||
    String(document.external_id || '') !== context.externalId || String(document.rustdesk_id || '') !== context.rustdeskId ||
    String(document.captured_at || '') !== capturedAt || String(document.tool || '') !== tool
  ) {
    failures.push({ id: checkId, reason: 'observation context must match run, environment, commit, session, target, time, and tool' });
    return '';
  }
  const observation = objectValue(document.observation);
  if (!Object.keys(observation).length || containsPlaceholder(observation)) {
    failures.push({ id: checkId, reason: 'structured non-placeholder observation is required' });
    return '';
  }
  for (const field of CHECK_OBSERVATION_FIELDS[checkId] || []) {
    if (observation[field] === undefined || observation[field] === null || observation[field] === '') {
      failures.push({ id: checkId, reason: `observation.${field} is required` });
    }
  }
  validateObservationSemantics(checkId, observation, failures);
  if (containsSecret(document) || containsSecretText(content.toString('utf8'))) {
    failures.push({ id: checkId, reason: 'observation must not contain credentials, signed URLs, clipboard/file content, keystrokes, screen pixels, or recording bytes' });
  }
  observations.set(checkId, observation);
  return actualHash;
}

function validateObservationSemantics(
  checkId: string,
  observation: Record<string, unknown>,
  failures: RustDeskClientAcceptanceFailure[]
): void {
  const trueFields: Readonly<Record<string, readonly string[]>> = {
    'operations.screen_view': ['frame_change_observed'],
    'operations.keyboard_mouse_control': ['target_effect_observed'],
    'operations.multi_display': ['switch_observed'],
    'operations.clipboard_sync': ['target_effect_observed'],
    'operations.recording': ['playback_verified'],
    'resilience.reconnect': ['target_restored'],
    'revoke.authorization_revoke_disconnects': ['screen_stopped', 'control_stopped'],
    'revoke.physical_disconnect': ['screen_stopped', 'control_stopped']
  };
  for (const field of trueFields[checkId] || []) {
    if (observation[field] !== true) failures.push({ id: checkId, reason: `observation.${field} must be true` });
  }
  if (checkId === 'operations.multi_display' && (typeof observation.display_count !== 'number' || !Number.isInteger(observation.display_count) || observation.display_count < 2)) {
    failures.push({ id: checkId, reason: 'observation.display_count must be an integer of at least 2' });
  }
  if (checkId === 'operations.file_transfer') {
    if (!['upload', 'download'].includes(String(observation.direction || ''))) failures.push({ id: checkId, reason: 'file direction must be upload or download' });
    if (typeof observation.byte_count !== 'number' || !Number.isInteger(observation.byte_count) || observation.byte_count <= 0) failures.push({ id: checkId, reason: 'file byte_count must be a positive integer' });
    requireObservationChecksum(checkId, observation.checksum_sha256, failures);
  }
  if (checkId === 'operations.clipboard_sync' && !['agent_to_device', 'device_to_agent'].includes(String(observation.direction || ''))) {
    failures.push({ id: checkId, reason: 'clipboard direction is invalid' });
  }
  if (checkId === 'operations.recording') {
    if (typeof observation.duration_ms !== 'number' || !Number.isInteger(observation.duration_ms) || observation.duration_ms <= 0) failures.push({ id: checkId, reason: 'recording duration_ms must be a positive integer' });
    requireObservationChecksum(checkId, observation.checksum_sha256, failures);
  }
  if (checkId === 'resilience.reconnect') {
    const disconnectedAt = String(observation.disconnected_at || '');
    const reconnectedAt = String(observation.reconnected_at || '');
    if (!validIso(disconnectedAt) || !validIso(reconnectedAt) || Date.parse(reconnectedAt) <= Date.parse(disconnectedAt)) {
      failures.push({ id: checkId, reason: 'reconnect timestamps must be valid and ordered' });
    }
  }
  if (checkId === 'revoke.ended_launch_url_rejected' && ![409, 410].includes(Number(observation.http_status))) {
    failures.push({ id: checkId, reason: 'old launch URL must return 409 or 410' });
  }
  if (checkId === 'audit.operation_events_forwarded') {
    const operations = Array.isArray(observation.observed_operations) ? observation.observed_operations.map(String) : [];
    for (const operation of ['view_screen', 'control_mouse_keyboard', 'multi_display', 'transfer_file', 'clipboard', 'record_screen', 'session_disconnect']) {
      if (!operations.includes(operation)) failures.push({ id: checkId, reason: `observed_operations must include ${operation}` });
    }
  }
  if (checkId === 'audit.audit_timeline_visible' && (typeof observation.event_count !== 'number' || !Number.isInteger(observation.event_count) || observation.event_count <= 0)) {
    failures.push({ id: checkId, reason: 'audit event_count must be a positive integer' });
  }
}

function requireObservationChecksum(
  checkId: string,
  value: unknown,
  failures: RustDeskClientAcceptanceFailure[]
): void {
  if (!/^sha256:[a-f0-9]{64}$/i.test(String(value || ''))) {
    failures.push({ id: checkId, reason: 'observation checksum_sha256 must be a SHA-256' });
  }
}

function validateRuntime(input: unknown, rustdeskId: string, failures: RustDeskClientAcceptanceFailure[]): void {
  const runtime = objectValue(input);
  const server = objectValue(runtime.server);
  const agent = objectValue(runtime.agent);
  const target = objectValue(runtime.target);
  for (const [id, value] of [
    ['runtime.server.hbbs_version', server.hbbs_version], ['runtime.server.hbbr_version', server.hbbr_version],
    ['runtime.server.id_server', server.id_server],
    ['runtime.server.relay_server', server.relay_server], ['runtime.agent.client_version', agent.client_version],
    ['runtime.target.client_version', target.client_version]
  ] as const) {
    if (!requiredRealValue(value)) failures.push({ id, reason: `${id} is required and cannot be a placeholder` });
  }
  if (!/^sha256:[a-f0-9]{16}(?:[a-f0-9]{48})?$/i.test(String(server.key_fingerprint || ''))) {
    failures.push({ id: 'runtime.server.key_fingerprint', reason: 'key_fingerprint must be sha256 with 16 or 64 hex characters' });
  }
  for (const [id, value] of [['runtime.agent.platform', agent.platform], ['runtime.target.platform', target.platform]] as const) {
    if (!['windows', 'macos', 'linux'].includes(String(value || ''))) failures.push({ id, reason: `${id} must be windows, macos, or linux` });
  }
  for (const [id, value] of [['runtime.agent.architecture', agent.architecture], ['runtime.target.architecture', target.architecture]] as const) {
    if (!['x86_64', 'aarch64'].includes(String(value || ''))) failures.push({ id, reason: `${id} must be x86_64 or aarch64` });
  }
  if (String(target.rustdesk_id || '') !== rustdeskId) failures.push({ id: 'runtime.target.rustdesk_id', reason: 'target runtime ID must match report rustdesk_id' });
}

function validatePhysicalDisconnect(
  input: unknown,
  failures: RustDeskClientAcceptanceFailure[]
): {
  value: RustDeskPhysicalDisconnectAcceptance;
  passed: number;
  missing: number;
} {
  const record = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const value: RustDeskPhysicalDisconnectAcceptance = {
    control_plane_ended: record.control_plane_ended === true,
    command_id: String(record.command_id || '').trim(),
    device_id: String(record.device_id || '').trim(),
    command_status: String(record.command_status || '').trim(),
    execution_method: String(record.execution_method || '').trim(),
    operator_observed_disconnect: record.operator_observed_disconnect === true
  };
  let passed = 0;
  let missing = 0;
  const requireField = (field: keyof RustDeskPhysicalDisconnectAcceptance): boolean => {
    if (Object.prototype.hasOwnProperty.call(record, field)) return true;
    failures.push({
      id: `physical_disconnect.${field}`,
      reason: `${field} is required`
    });
    missing += 1;
    return false;
  };
  const requireTrue = (
    field: 'control_plane_ended' | 'operator_observed_disconnect',
    reason: string
  ) => {
    if (!requireField(field)) return;
    if (record[field] !== true) {
      failures.push({ id: `physical_disconnect.${field}`, reason });
      return;
    }
    passed += 1;
  };

  requireTrue('control_plane_ended', 'control plane end was not confirmed');
  for (const field of ['command_id', 'device_id'] as const) {
    if (requireField(field)) {
      if (!value[field] || value[field].includes('replace-with')) failures.push({ id: `physical_disconnect.${field}`, reason: `${field} is required` });
      else passed += 1;
    }
  }
  if (requireField('command_status')) {
    if (value.command_status !== 'succeeded') {
      failures.push({
        id: 'physical_disconnect.command_status',
        reason: 'command_status must be succeeded'
      });
    } else {
      passed += 1;
    }
  }
  if (requireField('execution_method')) {
    if (!['session_adapter', 'service_restart'].includes(value.execution_method)) {
      failures.push({
        id: 'physical_disconnect.execution_method',
        reason: 'execution_method must be session_adapter or service_restart'
      });
    } else {
      passed += 1;
    }
  }
  requireTrue(
    'operator_observed_disconnect',
    'operator must confirm screen/control access stopped'
  );

  return { value, passed, missing };
}

function loadAuditEvents(report: AcceptanceReport, auditFile: string | undefined): AcceptanceAuditEvent[] {
  const events: AcceptanceAuditEvent[] = [];
  events.push(...decodeAuditEvents(report.audit_events, 'report.audit_events'));
  if (auditFile) {
    events.push(...readAuditFile(auditFile));
  }
  return events;
}

function readAuditFile(filePath: string): AcceptanceAuditEvent[] {
  const content = readFileSync(filePath, 'utf8').trim();
  if (!content) return [];
  if (content.startsWith('[')) {
    return decodeAuditEvents(JSON.parse(content), filePath);
  }
  if (content.startsWith('{')) {
    try {
      return decodeAuditEvents(JSON.parse(content), filePath);
    } catch {
      // Fall through to JSONL; many audit exports are one object per line.
    }
  }
  const events: AcceptanceAuditEvent[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    events.push(...decodeAuditEvents(JSON.parse(trimmed), `${filePath}:${index + 1}`));
  }
  return events;
}

function decodeAuditEvents(value: unknown, source: string): AcceptanceAuditEvent[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((entry) => decodeAuditEvent(entry, source));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.events)) return record.events.map((entry) => decodeAuditEvent(entry, source));
    return [decodeAuditEvent(record, source)];
  }
  throw new Error(`${source} must be an audit event, event array, or { events: [...] }`);
}

function decodeAuditEvent(value: unknown, source: string): AcceptanceAuditEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${source} audit event must be a JSON object`);
  }
  const record = value as Record<string, unknown>;
  return {
    external_id: optionalString(record.external_id),
    event_type: String(record.event_type || '').trim(),
    metadata: metadataObject(record.metadata)
  };
}

function validateAuditEvents(
  events: AcceptanceAuditEvent[],
  externalId: string
): Array<{ event_type: string; reason: string }> {
  const invalid: Array<{ event_type: string; reason: string }> = [];
  let disconnectCommandId = '';
  let disconnectDeviceId = '';
  for (const event of events) {
    if (!event.event_type) {
      invalid.push({ event_type: '', reason: 'event_type is required' });
      continue;
    }
    if (externalId && event.external_id !== externalId) {
      invalid.push({ event_type: event.event_type, reason: `external_id must match ${externalId}` });
      continue;
    }
    const metadataError = rustDeskGatewayEventValidationError(event.event_type, event.metadata || {});
    if (metadataError) {
      invalid.push({ event_type: event.event_type, reason: metadataError });
      continue;
    }
    if (event.event_type.startsWith('remote.rustdesk.disconnect.')) {
      const commandId = String(event.metadata?.command_id || '').trim();
      const deviceId = String(event.metadata?.device_id || '').trim();
      if (!commandId) {
        invalid.push({ event_type: event.event_type, reason: 'disconnect command_id is required' });
        continue;
      }
      if (!deviceId) {
        invalid.push({ event_type: event.event_type, reason: 'disconnect device_id is required' });
        continue;
      }
      if (disconnectCommandId && commandId !== disconnectCommandId) {
        invalid.push({
          event_type: event.event_type,
          reason: `disconnect command_id must match ${disconnectCommandId}`
        });
        continue;
      }
      if (disconnectDeviceId && deviceId !== disconnectDeviceId) {
        invalid.push({
          event_type: event.event_type,
          reason: `disconnect device_id must match ${disconnectDeviceId}`
        });
        continue;
      }
      disconnectCommandId ||= commandId;
      disconnectDeviceId ||= deviceId;
    }
  }
  return invalid;
}

function eventBelongsToSession(event: AcceptanceAuditEvent, externalId: string): boolean {
  return Boolean(event.event_type) && Boolean(event.external_id) &&
    (!externalId || event.external_id === externalId);
}

function optionalString(value: unknown): string | undefined {
  const normalized = String(value || '').trim();
  return normalized || undefined;
}

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validIso(value: unknown): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(String(value || '')) && Number.isFinite(Date.parse(String(value)));
}

function requiredRealValue(value: unknown): boolean {
  const normalized = String(value || '').trim();
  return Boolean(normalized) && !/replace-with|example|localhost/i.test(normalized);
}

function containsPlaceholder(value: unknown): boolean {
  return /replace-with|controlled|mock|synthetic/i.test(JSON.stringify(value));
}

function containsSecret(value: unknown): boolean {
  if (typeof value === 'string') return containsSecretText(value);
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsSecret);
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
    if (/^(api[_-]?key|secret|password|private[_-]?key|authorization|token|access[_-]?token|cookie|signed[_-]?url|launch[_-]?url|clipboard[_-]?(?:content|text)|file[_-]?(?:content|bytes)|keystrokes|screen[_-]?pixels|recording[_-]?bytes|content|payload|text|bytes_base64)$/i.test(key)) {
      return item !== undefined && item !== null && item !== '';
    }
    return containsSecret(item);
  });
}

function containsSecretText(value: string): boolean {
  return /Authorization\s*:\s*(?:Bearer|Basic)\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|(?:https?|rustdesk):\/\/[^\s"']+[?&](?:token|signature|expires|password|key)=/i.test(value);
}

async function main(): Promise<void> {
  if (String(resolveBrandEnv(process.env, 'RUSTDESK_ACCEPTANCE_RUNBOOK_FILE') || '').trim()) {
    const runbook = writeRustDeskClientAcceptanceRunbook(
      createRustDeskClientAcceptanceRunbookConfigFromEnv(process.env)
    );
    console.log(JSON.stringify(runbook, null, 2));
    return;
  }
  if (String(resolveBrandEnv(process.env, 'RUSTDESK_ACCEPTANCE_TEMPLATE_FILE') || '').trim()) {
    const template = writeRustDeskClientAcceptanceTemplate(
      createRustDeskClientAcceptanceTemplateConfigFromEnv(process.env)
    );
    console.log(JSON.stringify(template, null, 2));
    return;
  }
  const result = runRustDeskClientAcceptanceFromEnv(process.env);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
