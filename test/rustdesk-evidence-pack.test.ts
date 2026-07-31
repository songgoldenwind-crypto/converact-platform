import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildRustDeskEvidencePack,
  createRustDeskEvidencePackConfigFromEnv,
  renderRustDeskEvidencePack,
  writeRustDeskEvidencePack
} from '../scripts/rustdesk-evidence-pack.js';

test('RustDesk evidence pack marks a complete server and client evidence set as ready', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-evidence-complete-'));
  const files = writeCompleteEvidenceFiles(dir);

  const pack = buildRustDeskEvidencePack(createRustDeskEvidencePackConfigFromEnv({
    OPC_RUSTDESK_EVIDENCE_TITLE: 'RustDesk customer acceptance',
    OPC_RUSTDESK_EVIDENCE_DEPLOYMENT_COMMANDS_FILE: files.deploymentCommands,
    OPC_RUSTDESK_EVIDENCE_ENV_CHECKLIST_FILE: files.envChecklist,
    OPC_RUSTDESK_EVIDENCE_PREFLIGHT_REPORT_FILE: files.preflight,
    OPC_RUSTDESK_EVIDENCE_SERVER_EVIDENCE_FILE: files.serverEvidence,
    OPC_RUSTDESK_EVIDENCE_READINESS_REPORT_FILE: files.readiness,
    OPC_RUSTDESK_EVIDENCE_HANDOFF_FILE: files.handoff,
    OPC_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE: files.clientConfigPack,
    OPC_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_REPORT_FILE: files.acceptance,
    OPC_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE: files.auditCoverage,
    OPC_RUSTDESK_EVIDENCE_EVENT_TEMPLATE_FILE: files.eventTemplate,
    OPC_RUSTDESK_API_TOKEN: 'secret-token',
    OPC_COLLABORATION_API_KEY: 'collaboration-secret'
  }));

  assert.equal(pack.ok, true);
  assert.equal(pack.missing_required.length, 0);
  assert.equal(pack.server_evidence?.ok, true);
  assert.equal(pack.client_acceptance?.ok, true);
  assert.equal(pack.audit_coverage?.ok, true);
  assert.equal(pack.artifacts.filter((artifact) => artifact.required).every((artifact) => artifact.status === 'present'), true);
  assert.equal(JSON.stringify(pack).includes('secret-token'), false);
  assert.equal(JSON.stringify(pack).includes('collaboration-secret'), false);

  const markdown = renderRustDeskEvidencePack(pack);
  assert.match(markdown, /^# RustDesk customer acceptance/m);
  assert.match(markdown, /Status: `ready_for_customer_review`/);
  assert.match(markdown, /server evidence: `pass`/);
  assert.match(markdown, /client_config_pack/);
  assert.match(markdown, /client acceptance: `ready_for_review`/);
  assert.match(markdown, /audit coverage: `pass`/);
  assert.match(markdown, /remote\.rustdesk\.clipboard\.synced/);
  assert.match(markdown, /id_ed25519\.pub/);
  assert.equal(markdown.includes('secret-token'), false);
});

test('RustDesk evidence pack reports missing required artifacts without claiming readiness', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-evidence-missing-'));
  const outputFile = join(dir, 'rustdesk-evidence.md');

  const result = writeRustDeskEvidencePack({
    outputFile,
    title: 'RustDesk incomplete evidence',
    artifacts: {
      deploymentCommandsFile: join(dir, 'missing-deployment.md'),
      envChecklistFile: join(dir, 'missing-env.md'),
      preflightReportFile: join(dir, 'missing-preflight.json'),
      serverEvidenceFile: join(dir, 'missing-server-evidence.json'),
      readinessReportFile: join(dir, 'missing-readiness.json'),
      clientAcceptanceReportFile: join(dir, 'missing-acceptance.json'),
      auditCoverageReportFile: join(dir, 'missing-audit-coverage.json')
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.missing_required.includes('deployment_commands'), true);
  assert.equal(result.missing_required.includes('env_checklist'), true);
  assert.equal(result.missing_required.includes('preflight_report'), true);
  assert.equal(result.missing_required.includes('server_evidence'), true);
  assert.equal(result.missing_required.includes('readiness_report'), true);
  assert.equal(result.missing_required.includes('client_acceptance_report'), true);
  assert.equal(result.missing_required.includes('audit_coverage_report'), true);

  const markdown = readFileSync(outputFile, 'utf8');
  assert.match(markdown, /Status: `not_run`/);
  assert.match(markdown, /deployment_commands/);
  assert.match(markdown, /client_acceptance_report/);
  assert.match(markdown, /audit_coverage_report/);
});

test('RustDesk evidence pack fails when audit coverage report is missing or failed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-evidence-audit-coverage-'));
  const files = writeCompleteEvidenceFiles(dir);

  const missing = buildRustDeskEvidencePack(createRustDeskEvidencePackConfigFromEnv({
    OPC_RUSTDESK_EVIDENCE_DEPLOYMENT_COMMANDS_FILE: files.deploymentCommands,
    OPC_RUSTDESK_EVIDENCE_ENV_CHECKLIST_FILE: files.envChecklist,
    OPC_RUSTDESK_EVIDENCE_PREFLIGHT_REPORT_FILE: files.preflight,
    OPC_RUSTDESK_EVIDENCE_SERVER_EVIDENCE_FILE: files.serverEvidence,
    OPC_RUSTDESK_EVIDENCE_READINESS_REPORT_FILE: files.readiness,
    OPC_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE: files.clientConfigPack,
    OPC_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_REPORT_FILE: files.acceptance
  }));
  assert.equal(missing.ok, false);
  assert.equal(missing.missing_required.includes('audit_coverage_report'), true);

  writeJson(files.auditCoverage, {
    ok: false,
    summary: {
      required_event_types: 7,
      observed_required_event_types: 6,
      missing_event_types: 1,
      invalid_events: 0
    },
    missing_event_types: ['remote.rustdesk.clipboard.synced'],
    invalid_events: []
  });
  const failed = buildRustDeskEvidencePack(createRustDeskEvidencePackConfigFromEnv({
    OPC_RUSTDESK_EVIDENCE_DEPLOYMENT_COMMANDS_FILE: files.deploymentCommands,
    OPC_RUSTDESK_EVIDENCE_ENV_CHECKLIST_FILE: files.envChecklist,
    OPC_RUSTDESK_EVIDENCE_PREFLIGHT_REPORT_FILE: files.preflight,
    OPC_RUSTDESK_EVIDENCE_SERVER_EVIDENCE_FILE: files.serverEvidence,
    OPC_RUSTDESK_EVIDENCE_READINESS_REPORT_FILE: files.readiness,
    OPC_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE: files.clientConfigPack,
    OPC_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_REPORT_FILE: files.acceptance,
    OPC_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE: files.auditCoverage
  }));

  assert.equal(failed.ok, false);
  assert.equal(failed.missing_required.includes('audit_coverage_failed'), true);
  assert.equal(failed.audit_coverage?.ok, false);
});

test('RustDesk evidence pack accepts npm stdout wrappers around JSON artifacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-evidence-json-'));
  const files = writeCompleteEvidenceFiles(dir);
  writeFileSync(files.readiness, [
    '> converact-platform@0.1.0 rustdesk:readiness',
    '> tsx scripts/rustdesk-readiness.ts',
    '',
    JSON.stringify({ ok: true, steps: [{ name: 'remote-gateway', status: 'pass' }] }, null, 2)
  ].join('\n'));

  const pack = buildRustDeskEvidencePack(createRustDeskEvidencePackConfigFromEnv({
    OPC_RUSTDESK_EVIDENCE_DEPLOYMENT_COMMANDS_FILE: files.deploymentCommands,
    OPC_RUSTDESK_EVIDENCE_ENV_CHECKLIST_FILE: files.envChecklist,
    OPC_RUSTDESK_EVIDENCE_PREFLIGHT_REPORT_FILE: files.preflight,
    OPC_RUSTDESK_EVIDENCE_SERVER_EVIDENCE_FILE: files.serverEvidence,
    OPC_RUSTDESK_EVIDENCE_READINESS_REPORT_FILE: files.readiness,
    OPC_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE: files.clientConfigPack,
    OPC_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_REPORT_FILE: files.acceptance,
    OPC_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE: files.auditCoverage
  }));

  assert.equal(pack.ok, true);
  assert.equal(pack.readiness?.ok, true);
});

test('RustDesk evidence pack uses standard preflight and readiness report files as fallbacks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-evidence-fallback-'));
  const files = writeCompleteEvidenceFiles(dir);

  const config = createRustDeskEvidencePackConfigFromEnv({
    OPC_RUSTDESK_EVIDENCE_DEPLOYMENT_COMMANDS_FILE: files.deploymentCommands,
    OPC_RUSTDESK_EVIDENCE_ENV_CHECKLIST_FILE: files.envChecklist,
    OPC_RUSTDESK_PREFLIGHT_REPORT_FILE: files.preflight,
    OPC_RUSTDESK_SERVER_EVIDENCE_FILE: files.serverEvidence,
    OPC_RUSTDESK_READINESS_REPORT_FILE: files.readiness,
    OPC_RUSTDESK_CLIENT_CONFIG_PACK_FILE: files.clientConfigPack,
    OPC_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE: files.auditCoverage,
    OPC_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_REPORT_FILE: files.acceptance
  });

  assert.equal(config.artifacts.preflightReportFile, files.preflight);
  assert.equal(config.artifacts.serverEvidenceFile, files.serverEvidence);
  assert.equal(config.artifacts.readinessReportFile, files.readiness);
  assert.equal(config.artifacts.clientConfigPackFile, files.clientConfigPack);
  assert.equal(config.artifacts.auditCoverageReportFile, files.auditCoverage);
  assert.equal(buildRustDeskEvidencePack(config).ok, true);
});

test('RustDesk evidence pack CLI writes a markdown artifact and exposes package/env wiring', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-evidence-cli-'));
  const files = writeCompleteEvidenceFiles(dir);
  const outputFile = join(dir, 'rustdesk-evidence-pack.md');
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/rustdesk-evidence-pack.ts'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      OPC_RUSTDESK_EVIDENCE_PACK_FILE: outputFile,
      OPC_RUSTDESK_EVIDENCE_DEPLOYMENT_COMMANDS_FILE: files.deploymentCommands,
      OPC_RUSTDESK_EVIDENCE_ENV_CHECKLIST_FILE: files.envChecklist,
      OPC_RUSTDESK_EVIDENCE_PREFLIGHT_REPORT_FILE: files.preflight,
      OPC_RUSTDESK_EVIDENCE_SERVER_EVIDENCE_FILE: files.serverEvidence,
      OPC_RUSTDESK_EVIDENCE_READINESS_REPORT_FILE: files.readiness,
      OPC_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE: files.clientConfigPack,
      OPC_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_REPORT_FILE: files.acceptance,
      OPC_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE: files.auditCoverage
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.outputFile, outputFile);
  assert.equal(payload.ok, true);
  assert.match(readFileSync(outputFile, 'utf8'), /RustDesk Evidence Pack/);

  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['rustdesk:evidence-pack'], 'tsx scripts/rustdesk-evidence-pack.ts');

  const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const infraEnvExample = readFileSync(new URL('../infra/env.example', import.meta.url), 'utf8');
  for (const key of [
    'OPC_RUSTDESK_EVIDENCE_PACK_FILE=',
    'OPC_RUSTDESK_EVIDENCE_DEPLOYMENT_COMMANDS_FILE=',
    'OPC_RUSTDESK_EVIDENCE_ENV_CHECKLIST_FILE=',
    'OPC_RUSTDESK_EVIDENCE_PREFLIGHT_REPORT_FILE=',
    'OPC_RUSTDESK_EVIDENCE_SERVER_EVIDENCE_FILE=',
    'OPC_RUSTDESK_EVIDENCE_READINESS_REPORT_FILE=',
    'OPC_RUSTDESK_EVIDENCE_CLIENT_CONFIG_PACK_FILE=',
    'OPC_RUSTDESK_EVIDENCE_CLIENT_ACCEPTANCE_REPORT_FILE=',
    'OPC_RUSTDESK_EVIDENCE_AUDIT_COVERAGE_REPORT_FILE='
  ]) {
    assert.match(envExample, new RegExp(`^${key}`, 'm'));
    assert.match(infraEnvExample, new RegExp(`^${key}`, 'm'));
  }
});

function writeCompleteEvidenceFiles(dir: string): Record<string, string> {
  const files = {
    deploymentCommands: join(dir, 'deployment-commands.md'),
    envChecklist: join(dir, 'env-checklist.md'),
    preflight: join(dir, 'preflight.json'),
    serverEvidence: join(dir, 'server-evidence.json'),
    readiness: join(dir, 'readiness.json'),
    clientConfigPack: join(dir, 'client-config-pack.md'),
    handoff: join(dir, 'handoff.md'),
    eventTemplate: join(dir, 'events-template.jsonl'),
    acceptance: join(dir, 'client-acceptance.json'),
    auditCoverage: join(dir, 'audit-coverage.json')
  };

  writeFileSync(files.deploymentCommands, '# RustDesk Deployment Commands\n\nCheck `/rustdesk/id_ed25519.pub`.\n');
  writeFileSync(files.envChecklist, '# RustDesk Deployment Env Checklist\n\nOPC_RUSTDESK_PUBLIC_KEY_FILE=/rustdesk/id_ed25519.pub\n');
  writeJson(files.preflight, {
    ok: true,
    checks: [
      { id: 'public_key', status: 'pass', message: 'RustDesk public key file is readable: /rustdesk/id_ed25519.pub' },
      { id: 'id_server', status: 'pass', message: 'OPC_RUSTDESK_ID_SERVER is configured' }
    ]
  });
  writeJson(files.serverEvidence, {
    ok: true,
    summary: {
      public_key_readable: true,
      hbbs_started: true,
      hbbr_started: true,
      udp_probe_sent: true,
      dns_resolved: true,
      tls_valid: true,
      ingress_reachable: true
    },
    checks: [
      { id: 'public_key_file', status: 'pass' },
      { id: 'hbbs_tcp_ports', status: 'pass' },
      { id: 'hbbr_tcp_ports', status: 'pass' },
      { id: 'launch_tls', status: 'pass' }
    ]
  });
  writeJson(files.readiness, {
    ok: true,
    steps: [
      { name: 'preflight', status: 'pass' },
      { name: 'remote-gateway', status: 'pass' },
      { name: 'physical-disconnect', status: 'pass' }
    ],
    remoteGateway: {
      externalId: 'rdgw_1',
      launchUrl: 'https://opc.example.com/remote/rustdesk/launch?session_id=rdgw_1'
    },
    physicalDisconnect: {
      externalId: 'rdgw_1',
      commandId: 'rdcmd_1',
      status: 'succeeded',
      executionMethod: 'session_adapter',
      edgeInstanceId: 'edge-led-1',
      operatorObservedDisconnect: false
    }
  });
  writeFileSync(files.handoff, '# RustDesk Integration Handoff\n');
  writeFileSync(files.clientConfigPack, '# RustDesk Client Config Pack\n\nManual fields ready.\n');
  writeFileSync(files.eventTemplate, '{"event_type":"remote.rustdesk.control_action.performed"}\n');
  writeJson(files.acceptance, completeAcceptanceReport(dir));
  writeJson(files.auditCoverage, completeAuditCoverageReport());
  return files;
}

function completeAuditCoverageReport(): Record<string, unknown> {
  return {
    ok: true,
    external_id: 'rdgw_1',
    summary: {
      total_events: 7,
      matched_events: 7,
      required_event_types: 7,
      observed_required_event_types: 7,
      missing_event_types: 0,
      invalid_events: 0
    },
    observed_event_types: [
      'remote.gateway_session.ended',
      'remote.rustdesk.clipboard.synced',
      'remote.rustdesk.control_action.performed',
      'remote.rustdesk.file_transfer.completed',
      'remote.rustdesk.file_transfer.started',
      'remote.rustdesk.recording.started',
      'remote.rustdesk.recording.stopped'
    ],
    missing_event_types: [],
    invalid_events: []
  };
}

function completeAcceptanceReport(dir: string): Record<string, unknown> {
  const checks: Record<string, Record<string, { passed: boolean; evidence: Record<string, unknown> }>> = {};
  for (const checkId of [
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
  ]) {
    const [group, key] = checkId.split('.');
    checks[group] ||= {};
    checks[group][key] = { passed: true, evidence: writeAcceptanceObservation(dir, checkId) };
  }

  return {
    schema_version: 2,
    source: 'real_terminal',
    status: 'completed',
    run_id: 'run-rustdesk-pack-1',
    environment_id: 'led-staging-sfo2',
    deployed_commit: 'a'.repeat(40),
    external_id: 'rdgw_1',
    rustdesk_id: '123456789', operator: 'operator-1', qa_approver: 'qa-1',
    checked_at: '2026-07-08T10:10:00.000Z',
    runtime: {
      server: { hbbs_version: '1.1.16', hbbr_version: '1.1.16', key_fingerprint: `sha256:${'b'.repeat(64)}`, id_server: 'rd-id.internal.company', relay_server: 'rd-relay.internal.company' },
      agent: { platform: 'macos', architecture: 'aarch64', client_version: '1.4.9' },
      target: { platform: 'windows', architecture: 'x86_64', client_version: '1.4.9', rustdesk_id: '123456789' }
    },
    physical_disconnect: {
      control_plane_ended: true,
      command_id: 'rdcmd_1',
      device_id: 'rdesk_1',
      command_status: 'succeeded',
      execution_method: 'session_adapter',
      operator_observed_disconnect: true
    },
    checks,
    audit_events: [
      event('remote.rustdesk.control_action.performed', { operation_id: 'op_1', action: 'click', permission: 'control_mouse_keyboard' }),
      event('remote.rustdesk.file_transfer.started', { transfer_id: 'ft_1', direction: 'upload' }),
      event('remote.rustdesk.file_transfer.completed', { transfer_id: 'ft_1', direction: 'upload' }),
      event('remote.rustdesk.recording.started', { recording_id: 'rec_1', evidence_type: 'screen_recording' }),
      event('remote.rustdesk.recording.stopped', { recording_id: 'rec_1', evidence_type: 'screen_recording' }),
      event('remote.rustdesk.clipboard.synced', { clipboard_id: 'clip_1', direction: 'agent_to_device' }),
      event('remote.gateway_session.ended', {}),
      event('remote.rustdesk.disconnect.requested', {
        command_id: 'rdcmd_1',
        device_id: 'rdesk_1',
        attempt: 0
      }),
      event('remote.rustdesk.disconnect.claimed', {
        command_id: 'rdcmd_1',
        device_id: 'rdesk_1',
        attempt: 1,
        edge_instance_id: 'edge-led-1'
      }),
      event('remote.rustdesk.disconnect.succeeded', {
        command_id: 'rdcmd_1',
        device_id: 'rdesk_1',
        attempt: 1,
        execution_method: 'session_adapter',
        edge_instance_id: 'edge-led-1'
      })
    ]
  };
}

function writeAcceptanceObservation(dir: string, checkId: string): Record<string, unknown> {
  const observationDir = join(dir, 'observations');
  mkdirSync(observationDir, { recursive: true });
  const filename = `${checkId.replaceAll('.', '-')}.json`;
  const file = join(observationDir, filename);
  const details: Record<string, Record<string, unknown>> = {
    'operations.screen_view': { target_display_id: 'display-1', frame_change_observed: true },
    'operations.keyboard_mouse_control': { action: 'mouse.click', target_effect_observed: true },
    'operations.multi_display': { display_count: 2, selected_display_id: 'display-2', switch_observed: true },
    'operations.file_transfer': { direction: 'upload', byte_count: 1024, checksum_sha256: `sha256:${'c'.repeat(64)}` },
    'operations.clipboard_sync': { direction: 'agent_to_device', target_effect_observed: true },
    'operations.recording': { recording_id: 'rec-1', duration_ms: 3000, playback_verified: true, checksum_sha256: `sha256:${'d'.repeat(64)}` },
    'resilience.reconnect': { disconnected_at: '2026-07-08T10:01:00.000Z', reconnected_at: '2026-07-08T10:02:00.000Z', target_restored: true },
    'revoke.authorization_revoke_disconnects': { revoked_at: '2026-07-08T10:03:00.000Z', screen_stopped: true, control_stopped: true },
    'revoke.physical_disconnect': { observed_at: '2026-07-08T10:04:00.000Z', screen_stopped: true, control_stopped: true, command_id: 'rdcmd_1' },
    'revoke.ended_launch_url_rejected': { request_at: '2026-07-08T10:04:30.000Z', http_status: 409 },
    'audit.operation_events_forwarded': { external_id: 'rdgw_1', observed_operations: ['view_screen', 'control_mouse_keyboard', 'multi_display', 'transfer_file', 'clipboard', 'record_screen', 'session_disconnect'] },
    'audit.audit_timeline_visible': { external_id: 'rdgw_1', event_count: 10 }
  };
  const document = {
    schema_version: 1, source: 'real_terminal', check_id: checkId,
    run_id: 'run-rustdesk-pack-1', environment_id: 'led-staging-sfo2', deployed_commit: 'a'.repeat(40),
    external_id: 'rdgw_1', rustdesk_id: '123456789', captured_at: '2026-07-08T10:05:00.000Z',
    tool: 'rustdesk-native-qa-recorder', observation: details[checkId] || { verified: true, check_id: checkId }
  };
  writeFileSync(file, `${JSON.stringify(document)}\n`);
  return {
    artifact_file: `observations/${filename}`,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    captured_at: document.captured_at,
    tool: document.tool,
    run_id: document.run_id
  };
}

function event(eventType: string, metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    external_id: 'rdgw_1',
    event_type: eventType,
    metadata
  };
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
