import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createRustDeskClientAcceptanceConfigFromEnv,
  createRustDeskClientAcceptanceRunbookConfigFromEnv,
  createRustDeskClientAcceptanceTemplateConfigFromEnv,
  runRustDeskClientAcceptance
  ,
  runRustDeskClientAcceptanceFromEnv,
  writeRustDeskClientAcceptanceRunbook,
  writeRustDeskClientAcceptanceTemplate
} from '../scripts/rustdesk-client-acceptance.js';

test('RustDesk client acceptance reads report and optional output paths from env', () => {
  const config = createRustDeskClientAcceptanceConfigFromEnv({
    CONVERACT_RUSTDESK_ACCEPTANCE_REPORT_FILE: '/tmp/rustdesk-acceptance.json',
    CONVERACT_RUSTDESK_ACCEPTANCE_AUDIT_FILE: '/tmp/rustdesk-audit.jsonl',
    CONVERACT_RUSTDESK_ACCEPTANCE_OUTPUT_FILE: '/tmp/rustdesk-acceptance-result.json'
  });

  assert.equal(config.reportFile, '/tmp/rustdesk-acceptance.json');
  assert.equal(config.auditFile, '/tmp/rustdesk-audit.jsonl');
  assert.equal(config.outputFile, '/tmp/rustdesk-acceptance-result.json');
});

test('RustDesk client acceptance passes a complete real-operation report and writes a summary artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-acceptance-'));
  const reportFile = join(dir, 'report.json');
  const auditFile = join(dir, 'audit.jsonl');
  const outputFile = join(dir, 'result.json');
  writeFileSync(reportFile, JSON.stringify(completeReport(dir)), 'utf8');
  writeFileSync(auditFile, auditEvents('rdgw_1').map((event) => JSON.stringify(event)).join('\n'), 'utf8');

  const result = runRustDeskClientAcceptance({ reportFile, auditFile, outputFile });

  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.summary.failed, 0);
  assert.equal(result.summary.missing, 0);
  assert.equal(result.audit.missing_event_types.length, 0);
  assert.equal(result.audit.invalid_events.length, 0);
  assert.deepEqual(result.physical_disconnect, completePhysicalDisconnect());
  const written = JSON.parse(readFileSync(outputFile, 'utf8'));
  assert.equal(written.ok, true);
  assert.equal(written.external_id, 'rdgw_1');
});

test('RustDesk client acceptance fails missing operation evidence and audit events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-acceptance-'));
  const reportFile = join(dir, 'report.json');
  const report = completeReport(dir);
  writeFileSync(reportFile, JSON.stringify({
    ...report,
    physical_disconnect: {
      ...completePhysicalDisconnect(),
      operator_observed_disconnect: false
    },
    checks: {
      ...report.checks,
      operations: {
        ...report.checks.operations,
        file_transfer: { passed: true, evidence: {} }
      },
      revoke: {
        authorization_revoke_disconnects: { passed: false, evidence: 'revoke clicked but remote stayed connected' },
        ended_launch_url_rejected: { passed: true, evidence: 'old launch URL returned 409' }
      }
    },
    audit_events: report.audit_events.filter((event) => event.event_type !== 'remote.rustdesk.clipboard.synced')
  }), 'utf8');

  const result = runRustDeskClientAcceptance({ reportFile });

  assert.equal(result.ok, false);
  assert.match(result.failures.map((failure) => failure.id).join(','), /operations\.file_transfer/);
  assert.match(result.failures.map((failure) => failure.id).join(','), /revoke\.authorization_revoke_disconnects/);
  assert.match(result.failures.map((failure) => failure.id).join(','), /physical_disconnect\.operator_observed_disconnect/);
  assert.deepEqual(result.audit.missing_event_types, ['remote.rustdesk.clipboard.synced']);
});

test('RustDesk client acceptance reports invalid known audit event metadata', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-acceptance-'));
  const reportFile = join(dir, 'report.json');
  const report = completeReport(dir);
  writeFileSync(reportFile, JSON.stringify({
    ...report,
    audit_events: auditEvents('rdgw_1').map((event) =>
      event.event_type === 'remote.rustdesk.recording.stopped'
        ? { ...event, metadata: { recording_id: 'rec_1', evidence_type: 'video_recording' } }
        : event
    )
  }), 'utf8');

  const result = runRustDeskClientAcceptance({ reportFile });

  assert.equal(result.ok, false);
  assert.equal(result.audit.invalid_events.length, 1);
  assert.match(result.audit.invalid_events[0].reason, /evidence_type must be one of screen_recording/);
});

test('RustDesk client acceptance binds every event and disconnect phase to one session command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-acceptance-binding-'));
  const reportFile = join(dir, 'report.json');
  const report = completeReport(dir);
  writeFileSync(reportFile, JSON.stringify({
    ...report,
    audit_events: auditEvents('rdgw_1').map((event) => {
      if (event.event_type === 'remote.rustdesk.control_action.performed') {
        const { external_id: _externalId, ...withoutExternalId } = event;
        return withoutExternalId;
      }
      if (event.event_type === 'remote.rustdesk.disconnect.claimed') {
        return { ...event, metadata: { ...event.metadata, command_id: 'rdcmd_other' } };
      }
      return event;
    })
  }), 'utf8');

  const result = runRustDeskClientAcceptance({ reportFile });

  assert.equal(result.ok, false);
  assert.equal(
    result.audit.invalid_events.some((event) => /external_id must match rdgw_1/.test(event.reason)),
    true
  );
  assert.equal(
    result.audit.invalid_events.some((event) => /disconnect command_id must match rdcmd_1/.test(event.reason)),
    true
  );
});

test('RustDesk client acceptance can generate a complete report template', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-acceptance-template-'));
  const templateFile = join(dir, 'template.json');
  const config = createRustDeskClientAcceptanceTemplateConfigFromEnv({
    CONVERACT_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE: templateFile,
    CONVERACT_RUSTDESK_ACCEPTANCE_EXTERNAL_ID: 'rdgw_template',
    CONVERACT_RUSTDESK_ACCEPTANCE_RUSTDESK_ID: '987654321',
    CONVERACT_RUSTDESK_ACCEPTANCE_OPERATOR: 'agent_template'
  });

  const template = writeRustDeskClientAcceptanceTemplate(config);

  assert.equal(template.external_id, 'rdgw_template');
  assert.equal(template.rustdesk_id, '987654321');
  assert.equal(template.operator, 'agent_template');
  assert.equal(template.checks.server.hbbs_started.passed, false);
  assert.match(template.checks.server.hbbs_started.evidence.artifact_file, /hbbs/);
  assert.equal(template.checks.operations.keyboard_mouse_control.passed, false);
  assert.match(template.checks.operations.keyboard_mouse_control.evidence.artifact_file, /keyboard_mouse/);
  assert.equal(template.checks.operations.multi_display.passed, false);
  assert.equal(template.checks.resilience.reconnect.passed, false);
  assert.equal(template.checks.revoke.physical_disconnect.passed, false);
  assert.deepEqual(template.physical_disconnect, {
    control_plane_ended: false,
    command_id: '',
    device_id: '',
    command_status: '',
    execution_method: '',
    operator_observed_disconnect: false
  });
  assert.equal(template.audit_events.length, 10);
  assert.deepEqual(
    template.audit_events.map((event) => event.event_type),
    [
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
    ]
  );
  assert.deepEqual(template.audit_events[3].metadata, {
    recording_id: 'replace-with-recording-id',
    evidence_type: 'screen_recording'
  });

  const written = JSON.parse(readFileSync(templateFile, 'utf8'));
  assert.equal(written.external_id, 'rdgw_template');
  assert.equal(written.checks.revoke.ended_launch_url_rejected.passed, false);
});

test('RustDesk client acceptance reports not_run when no real report is supplied', () => {
  assert.deepEqual(runRustDeskClientAcceptanceFromEnv({}), {
    ok: false,
    status: 'not_run',
    missing_environment: ['CONVERACT_RUSTDESK_ACCEPTANCE_REPORT_FILE']
  });
});

test('RustDesk client acceptance rejects controlled browser evidence even with a matching hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-acceptance-controlled-'));
  const report = completeReport(dir);
  const evidence = report.checks.operations.screen_view.evidence;
  const artifact = join(dir, evidence.artifact_file);
  const document = JSON.parse(readFileSync(artifact, 'utf8'));
  document.source = 'controlled_e2e';
  document.tool = 'Playwright controlled RustDesk';
  writeFileSync(artifact, `${JSON.stringify(document)}\n`);
  evidence.sha256 = sha256(artifact);
  evidence.tool = document.tool;
  const reportFile = join(dir, 'report.json');
  writeFileSync(reportFile, JSON.stringify(report));

  const result = runRustDeskClientAcceptance({ reportFile });

  assert.equal(result.ok, false);
  assert.equal(result.failures.some((failure) => failure.id === 'operations.screen_view'), true);
});

test('RustDesk client acceptance enforces runtime identity and real observation semantics', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-acceptance-semantics-'));
  const report = completeReport(dir);
  report.qa_approver = report.operator;
  report.runtime.server.hbbs_version = 'replace-with-version';
  report.runtime.target.platform = 'browser';
  const evidence = report.checks.operations.screen_view.evidence;
  const artifact = join(dir, evidence.artifact_file);
  const document = JSON.parse(readFileSync(artifact, 'utf8'));
  document.observation.frame_change_observed = false;
  writeFileSync(artifact, `${JSON.stringify(document)}\n`);
  evidence.sha256 = sha256(artifact);
  const reportFile = join(dir, 'report.json');
  writeFileSync(reportFile, JSON.stringify(report));

  const result = runRustDeskClientAcceptance({ reportFile });
  const ids = result.failures.map((failure) => failure.id);

  assert.equal(result.ok, false);
  assert.ok(ids.includes('report.qa_approver'));
  assert.ok(ids.includes('runtime.server.hbbs_version'));
  assert.ok(ids.includes('runtime.target.platform'));
  assert.ok(ids.includes('operations.screen_view'));
});

test('RustDesk client acceptance can generate a real-client operation runbook', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-acceptance-runbook-'));
  const runbookFile = join(dir, 'client-acceptance-runbook.md');
  const config = createRustDeskClientAcceptanceRunbookConfigFromEnv({
    CONVERACT_RUSTDESK_ACCEPTANCE_RUNBOOK_FILE: runbookFile,
    CONVERACT_RUSTDESK_ACCEPTANCE_EXTERNAL_ID: 'rdgw_runbook',
    CONVERACT_RUSTDESK_ACCEPTANCE_RUSTDESK_ID: '987654321',
    CONVERACT_RUSTDESK_ACCEPTANCE_OPERATOR: 'agent_runbook'
  });

  const result = writeRustDeskClientAcceptanceRunbook(config);
  const markdown = readFileSync(runbookFile, 'utf8');

  assert.equal(result.outputFile, runbookFile);
  assert.equal(result.sections.includes('client-setup'), true);
  assert.match(markdown, /^# RustDesk Real Client Acceptance Runbook/m);
  assert.match(markdown, /external_id: `rdgw_runbook`/);
  assert.match(markdown, /rustdesk_id: `987654321`/);
  assert.match(markdown, /ID server/);
  assert.match(markdown, /manual fields/i);
  assert.match(markdown, /protocol URL/);
  assert.match(markdown, /public launch page/);
  assert.match(markdown, /screen view/);
  assert.match(markdown, /keyboard\/mouse/);
  assert.match(markdown, /file transfer/);
  assert.match(markdown, /clipboard/);
  assert.match(markdown, /recording/);
  assert.match(markdown, /authorization revoke/);
  assert.match(markdown, /disconnect command status/i);
  assert.match(markdown, /operator.*screen\/control access stopped/i);
  assert.match(markdown, /old signed launch URL returns 409/);
  assert.match(markdown, /CONVERACT_RUSTDESK_ACCEPTANCE_REPORT_FILE/);
  assert.match(markdown, /CONVERACT_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE/);
  assert.match(markdown, /rustdesk:audit-coverage/);
  assert.match(markdown, /CONVERACT_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE/);
  assert.match(markdown, /rustdesk:evidence-pack/);
});

test('RustDesk client acceptance is exposed as a package script with env samples', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(packageJson.scripts['rustdesk:client-acceptance'], 'tsx scripts/rustdesk-client-acceptance.ts');

  const rootEnv = readFileSync('.env.example', 'utf8');
  assert.match(rootEnv, /CONVERACT_RUSTDESK_ACCEPTANCE_REPORT_FILE=/);
  assert.match(rootEnv, /CONVERACT_RUSTDESK_ACCEPTANCE_AUDIT_FILE=/);
  assert.match(rootEnv, /CONVERACT_RUSTDESK_ACCEPTANCE_OUTPUT_FILE=/);
  assert.match(rootEnv, /CONVERACT_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE=/);
  assert.match(rootEnv, /CONVERACT_RUSTDESK_ACCEPTANCE_RUNBOOK_FILE=/);
  assert.match(rootEnv, /CONVERACT_RUSTDESK_ACCEPTANCE_EXTERNAL_ID=/);
  assert.match(rootEnv, /CONVERACT_RUSTDESK_ACCEPTANCE_RUSTDESK_ID=/);

  const productionEnv = readFileSync('infra/env.example', 'utf8');
  assert.match(productionEnv, /CONVERACT_RUSTDESK_ACCEPTANCE_REPORT_FILE=/);
  assert.match(productionEnv, /CONVERACT_RUSTDESK_ACCEPTANCE_AUDIT_FILE=/);
  assert.match(productionEnv, /CONVERACT_RUSTDESK_ACCEPTANCE_OUTPUT_FILE=/);
  assert.match(productionEnv, /CONVERACT_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE=/);
  assert.match(productionEnv, /CONVERACT_RUSTDESK_ACCEPTANCE_RUNBOOK_FILE=/);
  assert.match(productionEnv, /CONVERACT_RUSTDESK_ACCEPTANCE_EXTERNAL_ID=/);
  assert.match(productionEnv, /CONVERACT_RUSTDESK_ACCEPTANCE_RUSTDESK_ID=/);
});

function completeReport(dir: string) {
  return {
    schema_version: 2,
    source: 'real_terminal',
    status: 'completed',
    run_id: 'run-rustdesk-20260706',
    environment_id: 'led-staging-sfo2',
    deployed_commit: 'a'.repeat(40),
    external_id: 'rdgw_1',
    rustdesk_id: '987654321',
    operator: 'agent_1',
    qa_approver: 'qa_1',
    checked_at: '2026-07-06T00:10:00.000Z',
    runtime: {
      server: {
        hbbs_version: '1.1.16', hbbr_version: '1.1.16', key_fingerprint: `sha256:${'b'.repeat(64)}`,
        id_server: 'rd-id.internal.company', relay_server: 'rd-relay.internal.company'
      },
      agent: { platform: 'macos', architecture: 'aarch64', client_version: '1.4.9' },
      target: { platform: 'windows', architecture: 'x86_64', client_version: '1.4.9', rustdesk_id: '987654321' }
    },
    physical_disconnect: completePhysicalDisconnect(),
    checks: completeChecks(dir),
    audit_events: auditEvents('rdgw_1')
  };
}

function completeChecks(dir: string) {
  const check = (id: string) => ({ passed: true, evidence: writeObservation(dir, id, observationFor(id)) });
  return {
    server: {
      hbbs_started: check('server.hbbs_started'),
      hbbr_started: check('server.hbbr_started'),
      public_key_readable: check('server.public_key_readable'),
      tcp_ports_reachable: check('server.tcp_ports_reachable'),
      udp_relay_reachable: check('server.udp_relay_reachable'),
      dns_tls_ingress_ok: check('server.dns_tls_ingress_ok')
    },
    client: {
      installed: check('client.installed'),
      manual_fields_match: check('client.manual_fields_match'),
      launch_page_opens: check('client.launch_page_opens'),
      protocol_or_manual_launch_works: check('client.protocol_or_manual_launch_works'),
      target_id_matches: check('client.target_id_matches'),
      relay_connection_ok: check('client.relay_connection_ok')
    },
    operations: {
      screen_view: check('operations.screen_view'),
      keyboard_mouse_control: check('operations.keyboard_mouse_control'),
      multi_display: check('operations.multi_display'),
      file_transfer: check('operations.file_transfer'),
      clipboard_sync: check('operations.clipboard_sync'),
      recording: check('operations.recording')
    },
    resilience: {
      reconnect: check('resilience.reconnect')
    },
    revoke: {
      authorization_revoke_disconnects: check('revoke.authorization_revoke_disconnects'),
      physical_disconnect: check('revoke.physical_disconnect'),
      ended_launch_url_rejected: check('revoke.ended_launch_url_rejected')
    },
    audit: {
      operation_events_forwarded: check('audit.operation_events_forwarded'),
      audit_timeline_visible: check('audit.audit_timeline_visible')
    }
  };
}

function writeObservation(dir: string, checkId: string, observation: Record<string, unknown>) {
  const observations = join(dir, 'observations');
  mkdirSync(observations, { recursive: true });
  const filename = `${checkId.replaceAll('.', '-')}.json`;
  const file = join(observations, filename);
  const document = {
    schema_version: 1,
    source: 'real_terminal',
    check_id: checkId,
    run_id: 'run-rustdesk-20260706',
    environment_id: 'led-staging-sfo2',
    deployed_commit: 'a'.repeat(40),
    external_id: 'rdgw_1',
    rustdesk_id: '987654321',
    captured_at: '2026-07-06T00:05:00.000Z',
    tool: 'rustdesk-native-qa-recorder',
    observation
  };
  writeFileSync(file, `${JSON.stringify(document)}\n`);
  return {
    artifact_file: `observations/${filename}`,
    sha256: sha256(file),
    captured_at: document.captured_at,
    tool: document.tool,
    run_id: document.run_id
  };
}

function observationFor(id: string): Record<string, unknown> {
  const specialized: Record<string, Record<string, unknown>> = {
    'operations.screen_view': { target_display_id: 'display-1', frame_change_observed: true },
    'operations.keyboard_mouse_control': { action: 'mouse.click', target_effect_observed: true },
    'operations.multi_display': { display_count: 2, selected_display_id: 'display-2', switch_observed: true },
    'operations.file_transfer': { direction: 'upload', byte_count: 1024, checksum_sha256: `sha256:${'c'.repeat(64)}` },
    'operations.clipboard_sync': { direction: 'agent_to_device', target_effect_observed: true },
    'operations.recording': { recording_id: 'recording-1', duration_ms: 3000, playback_verified: true, checksum_sha256: `sha256:${'d'.repeat(64)}` },
    'resilience.reconnect': { disconnected_at: '2026-07-06T00:01:00.000Z', reconnected_at: '2026-07-06T00:02:00.000Z', target_restored: true },
    'revoke.authorization_revoke_disconnects': { revoked_at: '2026-07-06T00:03:00.000Z', screen_stopped: true, control_stopped: true },
    'revoke.physical_disconnect': { observed_at: '2026-07-06T00:04:00.000Z', screen_stopped: true, control_stopped: true, command_id: 'rdcmd_1' },
    'revoke.ended_launch_url_rejected': { request_at: '2026-07-06T00:04:30.000Z', http_status: 409 },
    'audit.operation_events_forwarded': { external_id: 'rdgw_1', observed_operations: ['view_screen', 'control_mouse_keyboard', 'multi_display', 'transfer_file', 'clipboard', 'record_screen', 'session_disconnect'] },
    'audit.audit_timeline_visible': { external_id: 'rdgw_1', event_count: 10 }
  };
  return specialized[id] || { verified: true, check_id: id };
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function completePhysicalDisconnect() {
  return {
    control_plane_ended: true,
    command_id: 'rdcmd_1',
    device_id: 'rdesk_1',
    command_status: 'succeeded',
    execution_method: 'session_adapter',
    operator_observed_disconnect: true
  };
}

function auditEvents(externalId: string) {
  const base = {
    external_id: externalId,
    actor_identity: 'agent_1',
    target: '987654321',
    occurred_at: '2026-07-06T00:00:00.000Z'
  };
  return [
    {
      ...base,
      event_type: 'remote.rustdesk.control_action.performed',
      metadata: { operation_id: 'op_1', action: 'mouse.click', permission: 'control_mouse_keyboard' }
    },
    {
      ...base,
      event_type: 'remote.rustdesk.file_transfer.started',
      metadata: { transfer_id: 'transfer_1', direction: 'upload' }
    },
    {
      ...base,
      event_type: 'remote.rustdesk.file_transfer.completed',
      metadata: { transfer_id: 'transfer_1', direction: 'upload' }
    },
    {
      ...base,
      event_type: 'remote.rustdesk.recording.started',
      metadata: { recording_id: 'rec_1', evidence_type: 'screen_recording' }
    },
    {
      ...base,
      event_type: 'remote.rustdesk.recording.stopped',
      metadata: { recording_id: 'rec_1', evidence_type: 'screen_recording' }
    },
    {
      ...base,
      event_type: 'remote.rustdesk.clipboard.synced',
      metadata: { clipboard_id: 'clip_1', direction: 'agent_to_device' }
    },
    {
      ...base,
      event_type: 'remote.gateway_session.ended',
      metadata: {}
    },
    {
      ...base,
      event_type: 'remote.rustdesk.disconnect.requested',
      metadata: { command_id: 'rdcmd_1', device_id: 'rdesk_1', attempt: 0 }
    },
    {
      ...base,
      event_type: 'remote.rustdesk.disconnect.claimed',
      metadata: { command_id: 'rdcmd_1', device_id: 'rdesk_1', attempt: 1 }
    },
    {
      ...base,
      event_type: 'remote.rustdesk.disconnect.succeeded',
      metadata: {
        command_id: 'rdcmd_1',
        device_id: 'rdesk_1',
        attempt: 1,
        execution_method: 'session_adapter',
        edge_instance_id: 'edge-1'
      }
    }
  ];
}
