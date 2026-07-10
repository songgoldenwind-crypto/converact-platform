import { readFileSync, writeFileSync } from 'node:fs';
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
  evidence: string;
}

export interface RustDeskPhysicalDisconnectAcceptance {
  control_plane_ended: boolean;
  command_status: string;
  execution_method: string;
  operator_observed_disconnect: boolean;
}

export interface RustDeskClientAcceptanceTemplate {
  external_id: string;
  rustdesk_id: string;
  operator: string;
  checked_at: string;
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
      file_transfer: RustDeskAcceptanceCheckTemplate;
      clipboard_sync: RustDeskAcceptanceCheckTemplate;
      recording: RustDeskAcceptanceCheckTemplate;
    };
    revoke: {
      authorization_revoke_disconnects: RustDeskAcceptanceCheckTemplate;
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

const CLIENT_ACCEPTANCE_RUNBOOK_SECTIONS = [
  'server-precheck',
  'client-setup',
  'launch',
  'operations',
  'revoke',
  'audit-and-evidence'
];

interface AcceptanceReport {
  external_id?: string;
  rustdesk_id?: string;
  operator?: string;
  checked_at?: string;
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
  'operations.file_transfer',
  'operations.clipboard_sync',
  'operations.recording',
  'revoke.authorization_revoke_disconnects',
  'revoke.ended_launch_url_rejected',
  'audit.operation_events_forwarded',
  'audit.audit_timeline_visible'
] as const;

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
  const reportFile = String(env.OPC_RUSTDESK_ACCEPTANCE_REPORT_FILE || '').trim();
  const auditFile = String(env.OPC_RUSTDESK_ACCEPTANCE_AUDIT_FILE || '').trim();
  const outputFile = String(env.OPC_RUSTDESK_ACCEPTANCE_OUTPUT_FILE || '').trim();
  if (!reportFile) throw new Error('OPC_RUSTDESK_ACCEPTANCE_REPORT_FILE is required');
  return {
    reportFile,
    ...(auditFile ? { auditFile } : {}),
    ...(outputFile ? { outputFile } : {})
  };
}

export function createRustDeskClientAcceptanceTemplateConfigFromEnv(
  env: NodeJS.ProcessEnv
): RustDeskClientAcceptanceTemplateConfig {
  const templateFile = String(env.OPC_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE || '').trim();
  if (!templateFile) throw new Error('OPC_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE is required');
  return {
    templateFile,
    externalId: String(env.OPC_RUSTDESK_ACCEPTANCE_EXTERNAL_ID || 'replace-with-rustdesk-gateway-external-id').trim(),
    rustdeskId: String(env.OPC_RUSTDESK_ACCEPTANCE_RUSTDESK_ID || 'replace-with-rustdesk-runtime-id').trim(),
    operator: String(env.OPC_RUSTDESK_ACCEPTANCE_OPERATOR || 'replace-with-operator-identity').trim(),
    checkedAt: String(env.OPC_RUSTDESK_ACCEPTANCE_CHECKED_AT || new Date().toISOString()).trim()
  };
}

export function createRustDeskClientAcceptanceRunbookConfigFromEnv(
  env: NodeJS.ProcessEnv
): RustDeskClientAcceptanceRunbookConfig {
  const outputFile = String(env.OPC_RUSTDESK_ACCEPTANCE_RUNBOOK_FILE || '').trim();
  if (!outputFile) throw new Error('OPC_RUSTDESK_ACCEPTANCE_RUNBOOK_FILE is required');
  return {
    outputFile,
    externalId: String(env.OPC_RUSTDESK_ACCEPTANCE_EXTERNAL_ID || 'replace-with-rustdesk-gateway-external-id').trim(),
    rustdeskId: String(env.OPC_RUSTDESK_ACCEPTANCE_RUSTDESK_ID || 'replace-with-rustdesk-runtime-id').trim(),
    operator: String(env.OPC_RUSTDESK_ACCEPTANCE_OPERATOR || 'replace-with-operator-identity').trim(),
    checkedAt: String(env.OPC_RUSTDESK_ACCEPTANCE_CHECKED_AT || new Date().toISOString()).trim()
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
    '2. Confirm `id_ed25519.pub` exists and OPC can read the same public key through `OPC_RUSTDESK_PUBLIC_KEY_FILE` or `OPC_RUSTDESK_PUBLIC_KEY`.',
    '3. Confirm TCP 21115/21116/21117/21118/21119 and UDP 21116 are reachable from the smoke host.',
    '4. Run `OPC_RUSTDESK_READINESS_REPORT_FILE=<bundle>/readiness.json npm run rustdesk:readiness`.',
    '',
    '## Client Setup',
    '',
    '1. Install the RustDesk client on the agent machine and the target machine.',
    '2. Open `/api/ivekit/rustdesk/client-config` or the launch plan and copy the manual fields exactly.',
    '3. Fill the RustDesk client ID server, relay server, API server when present, and key. These manual fields must match OPC client-config.',
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
    '- file transfer: upload or download succeeds; record filename or checksum.',
    '- clipboard: clipboard sync works in the expected direction.',
    '- recording: recording starts, stops, is stored, and is playable.',
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
    '1. Export the RustDesk/OPC audit timeline for this `external_id`.',
    '2. Confirm audit contains control action, file transfer started/completed, recording started/stopped, clipboard synced, gateway ended, and disconnect requested/claimed/succeeded events.',
    '3. Copy concrete evidence into `client-acceptance-template.json`; every passed item must have non-empty evidence.',
    '4. Run `OPC_RUSTDESK_ACCEPTANCE_REPORT_FILE=<bundle>/client-acceptance-template.json OPC_RUSTDESK_ACCEPTANCE_AUDIT_FILE=<bundle>/audit-export.jsonl npm run rustdesk:client-acceptance`.',
    '5. Run `OPC_RUSTDESK_AUDIT_COVERAGE_FILE=<bundle>/audit-export.jsonl OPC_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE=<bundle>/audit-coverage.json npm run rustdesk:audit-coverage`.',
    '6. Run `OPC_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE=<bundle>/audit-coverage.json npm run rustdesk:evidence-pack` and require `ready_for_customer_review` before customer handoff.',
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
  const report = readJsonFile<AcceptanceReport>(config.reportFile);
  const externalId = String(report.external_id || '').trim();
  const rustdeskId = String(report.rustdesk_id || '').trim();
  const failures: RustDeskClientAcceptanceFailure[] = [];
  let passed = 0;
  let missing = 0;

  for (const field of ['external_id', 'rustdesk_id', 'operator', 'checked_at']) {
    if (!String((report as Record<string, unknown>)[field] || '').trim()) {
      failures.push({ id: `report.${field}`, reason: `${field} is required` });
      missing += 1;
    }
  }

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
    if (!outcome.evidence) {
      failures.push({ id: checkId, reason: 'passed check requires non-empty evidence' });
      continue;
    }
    passed += 1;
  }

  const physicalDisconnect = validatePhysicalDisconnect(
    report.physical_disconnect,
    failures
  );
  passed += physicalDisconnect.passed;
  missing += physicalDisconnect.missing;

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

  const result: RustDeskClientAcceptanceResult = {
    ok: failures.length === 0 && missingEventTypes.length === 0 && invalidEvents.length === 0,
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

function createRustDeskClientAcceptanceTemplate(
  config: RustDeskClientAcceptanceTemplateConfig
): RustDeskClientAcceptanceTemplate {
  const externalId = config.externalId;
  const rustdeskId = config.rustdeskId;
  return {
    external_id: externalId,
    rustdesk_id: rustdeskId,
    operator: config.operator,
    checked_at: config.checkedAt,
    physical_disconnect: {
      control_plane_ended: false,
      command_status: '',
      execution_method: '',
      operator_observed_disconnect: false
    },
    checks: {
      server: {
        hbbs_started: templateCheck('Confirm hbbs is running and listening on the configured RustDesk ID server ports.'),
        hbbr_started: templateCheck('Confirm hbbr relay is running and listening on the configured relay ports.'),
        public_key_readable: templateCheck('Confirm OPC can read id_ed25519.pub from the configured RustDesk public key path.'),
        tcp_ports_reachable: templateCheck('Record TCP checks for RustDesk 21115, 21116, 21117, 21118, and 21119 from the smoke host.'),
        udp_relay_reachable: templateCheck('Record UDP 21116 relay reachability from the smoke host.'),
        dns_tls_ingress_ok: templateCheck('Confirm DNS, TLS, and Ingress expose the signed RustDesk launch page over HTTPS.')
      },
      client: {
        installed: templateCheck('Confirm RustDesk client is installed on both agent and target devices.'),
        manual_fields_match: templateCheck('Confirm ID server, relay server, API server, and key match /api/ivekit/rustdesk/client-config.'),
        launch_page_opens: templateCheck('Confirm the signed launch page opens this gateway session.'),
        protocol_or_manual_launch_works: templateCheck('Confirm protocol URL or manual RustDesk launch reaches the target device.'),
        target_id_matches: templateCheck('Confirm the RustDesk target ID matches the launch plan runtime rustdesk_id.'),
        relay_connection_ok: templateCheck('Confirm the client uses the expected self-hosted RustDesk relay/server path.')
      },
      operations: {
        screen_view: templateCheck('Confirm the agent can view the target screen.'),
        keyboard_mouse_control: templateCheck('Confirm keyboard/mouse control works on the target device.'),
        file_transfer: templateCheck('Confirm file upload/download succeeds and record the file name or checksum.'),
        clipboard_sync: templateCheck('Confirm clipboard sync works in the expected direction(s).'),
        recording: templateCheck('Confirm screen recording starts, stops, is stored, and is playable.')
      },
      revoke: {
        authorization_revoke_disconnects: templateCheck('Confirm authorization revoke or session end disconnects the RustDesk session.'),
        ended_launch_url_rejected: templateCheck('Confirm the old signed launch URL returns 409 after the session is ended.')
      },
      audit: {
        operation_events_forwarded: templateCheck('Confirm control/file/recording/clipboard events are forwarded to OPC/iveKit.'),
        audit_timeline_visible: templateCheck('Confirm operation events are visible in the OPC/iveKit remote assistance timeline.')
      }
    },
    audit_events: templateAuditEvents(externalId, rustdeskId, config.operator, config.checkedAt)
  };
}

function templateCheck(evidence: string): RustDeskAcceptanceCheckTemplate {
  return { passed: false, evidence };
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

function normalizeCheckOutcome(value: unknown): { exists: boolean; passed: boolean; evidence: string } {
  if (value === undefined || value === null) return { exists: false, passed: false, evidence: '' };
  if (typeof value === 'boolean') return { exists: true, passed: value, evidence: '' };
  if (typeof value !== 'object' || Array.isArray(value)) return { exists: true, passed: false, evidence: '' };
  const record = value as Record<string, unknown>;
  const evidence = String(record.evidence || record.artifact || record.notes || '').trim();
  return {
    exists: true,
    passed: record.passed === true,
    evidence
  };
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

async function main(): Promise<void> {
  if (String(process.env.OPC_RUSTDESK_ACCEPTANCE_RUNBOOK_FILE || '').trim()) {
    const runbook = writeRustDeskClientAcceptanceRunbook(
      createRustDeskClientAcceptanceRunbookConfigFromEnv(process.env)
    );
    console.log(JSON.stringify(runbook, null, 2));
    return;
  }
  if (String(process.env.OPC_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE || '').trim()) {
    const template = writeRustDeskClientAcceptanceTemplate(
      createRustDeskClientAcceptanceTemplateConfigFromEnv(process.env)
    );
    console.log(JSON.stringify(template, null, 2));
    return;
  }
  const result = runRustDeskClientAcceptance(createRustDeskClientAcceptanceConfigFromEnv(process.env));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
