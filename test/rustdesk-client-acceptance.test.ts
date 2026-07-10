import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createRustDeskClientAcceptanceConfigFromEnv,
  createRustDeskClientAcceptanceRunbookConfigFromEnv,
  createRustDeskClientAcceptanceTemplateConfigFromEnv,
  runRustDeskClientAcceptance
  ,
  writeRustDeskClientAcceptanceRunbook,
  writeRustDeskClientAcceptanceTemplate
} from '../scripts/rustdesk-client-acceptance.js';

test('RustDesk client acceptance reads report and optional output paths from env', () => {
  const config = createRustDeskClientAcceptanceConfigFromEnv({
    OPC_RUSTDESK_ACCEPTANCE_REPORT_FILE: '/tmp/rustdesk-acceptance.json',
    OPC_RUSTDESK_ACCEPTANCE_AUDIT_FILE: '/tmp/rustdesk-audit.jsonl',
    OPC_RUSTDESK_ACCEPTANCE_OUTPUT_FILE: '/tmp/rustdesk-acceptance-result.json'
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
  writeFileSync(reportFile, JSON.stringify({
    external_id: 'rdgw_1',
    rustdesk_id: '987654321',
    operator: 'agent_1',
    checked_at: '2026-07-06T00:00:00.000Z',
    physical_disconnect: completePhysicalDisconnect(),
    checks: completeChecks()
  }), 'utf8');
  writeFileSync(auditFile, auditEvents('rdgw_1').map((event) => JSON.stringify(event)).join('\n'), 'utf8');

  const result = runRustDeskClientAcceptance({ reportFile, auditFile, outputFile });

  assert.equal(result.ok, true);
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
  writeFileSync(reportFile, JSON.stringify({
    external_id: 'rdgw_1',
    rustdesk_id: '987654321',
    operator: 'agent_1',
    checked_at: '2026-07-06T00:00:00.000Z',
    physical_disconnect: {
      ...completePhysicalDisconnect(),
      operator_observed_disconnect: false
    },
    checks: {
      ...completeChecks(),
      operations: {
        ...completeChecks().operations,
        file_transfer: { passed: true, evidence: '' }
      },
      revoke: {
        authorization_revoke_disconnects: { passed: false, evidence: 'revoke clicked but remote stayed connected' },
        ended_launch_url_rejected: { passed: true, evidence: 'old launch URL returned 409' }
      }
    },
    audit_events: auditEvents('rdgw_1').filter((event) => event.event_type !== 'remote.rustdesk.clipboard.synced')
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
  writeFileSync(reportFile, JSON.stringify({
    external_id: 'rdgw_1',
    rustdesk_id: '987654321',
    operator: 'agent_1',
    checked_at: '2026-07-06T00:00:00.000Z',
    physical_disconnect: completePhysicalDisconnect(),
    checks: completeChecks(),
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
  writeFileSync(reportFile, JSON.stringify({
    external_id: 'rdgw_1',
    rustdesk_id: '987654321',
    operator: 'agent_1',
    checked_at: '2026-07-06T00:00:00.000Z',
    physical_disconnect: completePhysicalDisconnect(),
    checks: completeChecks(),
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
    OPC_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE: templateFile,
    OPC_RUSTDESK_ACCEPTANCE_EXTERNAL_ID: 'rdgw_template',
    OPC_RUSTDESK_ACCEPTANCE_RUSTDESK_ID: '987654321',
    OPC_RUSTDESK_ACCEPTANCE_OPERATOR: 'agent_template'
  });

  const template = writeRustDeskClientAcceptanceTemplate(config);

  assert.equal(template.external_id, 'rdgw_template');
  assert.equal(template.rustdesk_id, '987654321');
  assert.equal(template.operator, 'agent_template');
  assert.equal(template.checks.server.hbbs_started.passed, false);
  assert.match(template.checks.server.hbbs_started.evidence, /hbbs/);
  assert.equal(template.checks.operations.keyboard_mouse_control.passed, false);
  assert.match(template.checks.operations.keyboard_mouse_control.evidence, /keyboard\/mouse/);
  assert.deepEqual(template.physical_disconnect, {
    control_plane_ended: false,
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

test('RustDesk client acceptance can generate a real-client operation runbook', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-acceptance-runbook-'));
  const runbookFile = join(dir, 'client-acceptance-runbook.md');
  const config = createRustDeskClientAcceptanceRunbookConfigFromEnv({
    OPC_RUSTDESK_ACCEPTANCE_RUNBOOK_FILE: runbookFile,
    OPC_RUSTDESK_ACCEPTANCE_EXTERNAL_ID: 'rdgw_runbook',
    OPC_RUSTDESK_ACCEPTANCE_RUSTDESK_ID: '987654321',
    OPC_RUSTDESK_ACCEPTANCE_OPERATOR: 'agent_runbook'
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
  assert.match(markdown, /OPC_RUSTDESK_ACCEPTANCE_REPORT_FILE/);
  assert.match(markdown, /OPC_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE/);
  assert.match(markdown, /rustdesk:audit-coverage/);
  assert.match(markdown, /OPC_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE/);
  assert.match(markdown, /rustdesk:evidence-pack/);
});

test('RustDesk client acceptance is exposed as a package script with env samples', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(packageJson.scripts['rustdesk:client-acceptance'], 'tsx scripts/rustdesk-client-acceptance.ts');

  const rootEnv = readFileSync('.env.example', 'utf8');
  assert.match(rootEnv, /OPC_RUSTDESK_ACCEPTANCE_REPORT_FILE=/);
  assert.match(rootEnv, /OPC_RUSTDESK_ACCEPTANCE_AUDIT_FILE=/);
  assert.match(rootEnv, /OPC_RUSTDESK_ACCEPTANCE_OUTPUT_FILE=/);
  assert.match(rootEnv, /OPC_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE=/);
  assert.match(rootEnv, /OPC_RUSTDESK_ACCEPTANCE_RUNBOOK_FILE=/);
  assert.match(rootEnv, /OPC_RUSTDESK_ACCEPTANCE_EXTERNAL_ID=/);
  assert.match(rootEnv, /OPC_RUSTDESK_ACCEPTANCE_RUSTDESK_ID=/);

  const productionEnv = readFileSync('infra/env.example', 'utf8');
  assert.match(productionEnv, /OPC_RUSTDESK_ACCEPTANCE_REPORT_FILE=/);
  assert.match(productionEnv, /OPC_RUSTDESK_ACCEPTANCE_AUDIT_FILE=/);
  assert.match(productionEnv, /OPC_RUSTDESK_ACCEPTANCE_OUTPUT_FILE=/);
  assert.match(productionEnv, /OPC_RUSTDESK_ACCEPTANCE_TEMPLATE_FILE=/);
  assert.match(productionEnv, /OPC_RUSTDESK_ACCEPTANCE_RUNBOOK_FILE=/);
  assert.match(productionEnv, /OPC_RUSTDESK_ACCEPTANCE_EXTERNAL_ID=/);
  assert.match(productionEnv, /OPC_RUSTDESK_ACCEPTANCE_RUSTDESK_ID=/);
});

function completeChecks() {
  const check = (evidence: string) => ({ passed: true, evidence });
  return {
    server: {
      hbbs_started: check('hbbs container is running and logs show listening'),
      hbbr_started: check('hbbr container is running and logs show relay listening'),
      public_key_readable: check('/rustdesk/id_ed25519.pub is readable by OPC'),
      tcp_ports_reachable: check('21115-21119 TCP checked from smoke host'),
      udp_relay_reachable: check('21116 UDP checked from smoke host'),
      dns_tls_ingress_ok: check('public launch page opens through HTTPS ingress')
    },
    client: {
      installed: check('RustDesk client installed on agent and target device'),
      manual_fields_match: check('ID server, relay, API server, key match client-config'),
      launch_page_opens: check('signed launch page opens current rdgw_1'),
      protocol_or_manual_launch_works: check('RustDesk opens target 987654321'),
      target_id_matches: check('client target ID equals launch plan runtime id'),
      relay_connection_ok: check('session uses expected self-hosted relay')
    },
    operations: {
      screen_view: check('agent can see target screen'),
      keyboard_mouse_control: check('agent clicked test button on target'),
      file_transfer: check('agent uploaded and downloaded acceptance file'),
      clipboard_sync: check('clipboard sync works both directions'),
      recording: check('screen recording created and is playable')
    },
    revoke: {
      authorization_revoke_disconnects: check('consent revoke disconnects session'),
      ended_launch_url_rejected: check('old launch URL returns 409 after end')
    },
    audit: {
      operation_events_forwarded: check('event forwarder sent all required operation events'),
      audit_timeline_visible: check('OPC/iveKit timeline shows operation events')
    }
  };
}

function completePhysicalDisconnect() {
  return {
    control_plane_ended: true,
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
