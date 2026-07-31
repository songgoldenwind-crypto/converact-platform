import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createRustDeskAuditCoverageConfigFromEnv,
  runRustDeskAuditCoverage
} from '../scripts/rustdesk-audit-coverage.js';

test('RustDesk audit coverage reads audit and report paths from env', () => {
  const config = createRustDeskAuditCoverageConfigFromEnv({
    CONVERACT_RUSTDESK_AUDIT_COVERAGE_FILE: '/tmp/rustdesk-audit.jsonl',
    CONVERACT_RUSTDESK_AUDIT_COVERAGE_EXTERNAL_ID: 'rdgw_1',
    CONVERACT_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE: '/tmp/rustdesk-audit-coverage.json'
  });

  assert.equal(config.auditFile, '/tmp/rustdesk-audit.jsonl');
  assert.equal(config.externalId, 'rdgw_1');
  assert.equal(config.reportFile, '/tmp/rustdesk-audit-coverage.json');
});

test('RustDesk audit coverage passes complete operation audit exports and writes a report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-audit-coverage-'));
  const auditFile = join(dir, 'audit.jsonl');
  const reportFile = join(dir, 'coverage.json');
  writeFileSync(auditFile, auditEvents('rdgw_1').map((event) => JSON.stringify(event)).join('\n'), 'utf8');

  const result = runRustDeskAuditCoverage({ auditFile, externalId: 'rdgw_1', reportFile });

  assert.equal(result.ok, true);
  assert.equal(result.summary.total_events, 7);
  assert.equal(result.summary.matched_events, 7);
  assert.equal(result.missing_event_types.length, 0);
  assert.equal(result.invalid_events.length, 0);
  assert.deepEqual(result.coverage.control_action.observed, true);
  assert.deepEqual(result.coverage.file_transfer_completed.observed, true);
  assert.deepEqual(result.coverage.recording_stopped.observed, true);
  assert.deepEqual(result.coverage.clipboard_synced.observed, true);
  const written = JSON.parse(readFileSync(reportFile, 'utf8'));
  assert.equal(written.ok, true);
  assert.equal(written.external_id, 'rdgw_1');
});

test('RustDesk audit coverage reports missing required event types', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-audit-coverage-missing-'));
  const auditFile = join(dir, 'audit.json');
  writeFileSync(auditFile, JSON.stringify({
    events: auditEvents('rdgw_1').filter((event) => event.event_type !== 'remote.rustdesk.clipboard.synced')
  }), 'utf8');

  const result = runRustDeskAuditCoverage({ auditFile, externalId: 'rdgw_1' });

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing_event_types, ['remote.rustdesk.clipboard.synced']);
  assert.equal(result.coverage.clipboard_synced.observed, false);
});

test('RustDesk audit coverage reports invalid event granularity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-audit-coverage-invalid-'));
  const auditFile = join(dir, 'audit.jsonl');
  const events = auditEvents('rdgw_1').map((event) => {
    if (event.event_type === 'remote.rustdesk.recording.stopped') {
      return { ...event, metadata: { recording_id: 'rec_1', evidence_type: 'video_recording' } };
    }
    if (event.event_type === 'remote.rustdesk.control_action.performed') {
      return { ...event, actor_identity: '', occurred_at: 'not-a-date' };
    }
    return event;
  });
  writeFileSync(auditFile, events.map((event) => JSON.stringify(event)).join('\n'), 'utf8');

  const result = runRustDeskAuditCoverage({ auditFile, externalId: 'rdgw_1' });

  assert.equal(result.ok, false);
  assert.equal(result.invalid_events.length, 3);
  assert.match(result.invalid_events.map((event) => event.reason).join('\n'), /actor_identity is required/);
  assert.match(result.invalid_events.map((event) => event.reason).join('\n'), /occurred_at must be an ISO timestamp/);
  assert.match(result.invalid_events.map((event) => event.reason).join('\n'), /evidence_type must be one of screen_recording/);
});

test('RustDesk audit coverage CLI and env samples are wired', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rustdesk-audit-coverage-cli-'));
  const auditFile = join(dir, 'audit.jsonl');
  const reportFile = join(dir, 'coverage.json');
  writeFileSync(auditFile, auditEvents('rdgw_cli').map((event) => JSON.stringify(event)).join('\n'), 'utf8');

  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/rustdesk-audit-coverage.ts'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: {
      ...process.env,
      CONVERACT_RUSTDESK_AUDIT_COVERAGE_FILE: auditFile,
      CONVERACT_RUSTDESK_AUDIT_COVERAGE_EXTERNAL_ID: 'rdgw_cli',
      CONVERACT_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE: reportFile
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(JSON.parse(readFileSync(reportFile, 'utf8')).ok, true);

  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['rustdesk:audit-coverage'], 'tsx scripts/rustdesk-audit-coverage.ts');

  const rootEnv = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const productionEnv = readFileSync(new URL('../infra/env.example', import.meta.url), 'utf8');
  for (const key of [
    'CONVERACT_RUSTDESK_AUDIT_COVERAGE_FILE=',
    'CONVERACT_RUSTDESK_AUDIT_COVERAGE_EXTERNAL_ID=',
    'CONVERACT_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE='
  ]) {
    assert.match(rootEnv, new RegExp(`^${key}`, 'm'));
    assert.match(productionEnv, new RegExp(`^${key}`, 'm'));
  }
});

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
    }
  ];
}
